/**
 * Downstream transports: how the gateway talks to the real MCP server.
 *
 * - {@link StdioDownstream} spawns the server as a child process and speaks
 *   newline-delimited JSON-RPC over its stdio (the common local case).
 * - {@link HttpDownstream} POSTs JSON-RPC messages to a Streamable HTTP
 *   endpoint and understands both JSON and single-response SSE replies.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { frameMessage, NdjsonParser, type JsonRpcMessage } from "./jsonrpc.js";

/** Transport-agnostic downstream connection. */
export interface Downstream {
  /** Deliver one message to the downstream server. */
  send(msg: JsonRpcMessage): void;
  /** Register the handler for messages coming back from the server. */
  onMessage(handler: (msg: JsonRpcMessage) => void): void;
  /** Register the handler for fatal transport errors / exits. */
  onClose(handler: (reason: string) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Spawn the downstream MCP server as a child process (stdio transport). */
export class StdioDownstream implements Downstream {
  private readonly command: string;
  private readonly args: string[];
  private child: ChildProcess | undefined;
  private messageHandler: (msg: JsonRpcMessage) => void = () => {};
  private closeHandler: (reason: string) => void = () => {};

  constructor(command: string, args: string[] = []) {
    this.command = command;
    this.args = args;
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  async start(): Promise<void> {
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child = child;
    const parser = new NdjsonParser(
      (msg) => this.messageHandler(msg),
      () => {
        // Non-JSON output from the downstream is ignored (some servers log
        // to stdout by accident); protocol messages must be valid JSON lines.
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => parser.feed(chunk));
    child.on("error", (err) => this.closeHandler(`downstream failed to start: ${err.message}`));
    child.on("exit", (code, signal) =>
      this.closeHandler(`downstream exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => reject(new Error(`cannot spawn "${this.command}": ${err.message}`)));
    });
  }

  send(msg: JsonRpcMessage): void {
    if (!this.child?.stdin?.writable) {
      throw new Error("downstream process is not running");
    }
    this.child.stdin.write(frameMessage(msg));
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    child.removeAllListeners("exit");
    child.stdin?.end();
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child.kill("SIGTERM");
    await exited;
  }
}

/** Talk to a downstream MCP server over Streamable HTTP. */
export class HttpDownstream implements Downstream {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private messageHandler: (msg: JsonRpcMessage) => void = () => {};
  private closeHandler: (reason: string) => void = () => {};
  private sessionId: string | undefined;

  constructor(url: string, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.fetchImpl = fetchImpl;
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  async start(): Promise<void> {
    // Nothing to do: connections are per-request.
  }

  send(msg: JsonRpcMessage): void {
    void this.post(msg).catch((err: Error) => {
      this.closeHandler(`downstream HTTP error: ${err.message}`);
    });
  }

  private async post(msg: JsonRpcMessage): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
    });
    const newSession = response.headers.get("mcp-session-id");
    if (newSession) this.sessionId = newSession;
    if (response.status === 202) return; // Accepted notification.
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${this.url}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    if (contentType.includes("text/event-stream")) {
      for (const parsed of parseSseMessages(body)) {
        this.messageHandler(parsed);
      }
    } else if (body.trim().length > 0) {
      this.messageHandler(JSON.parse(body) as JsonRpcMessage);
    }
  }

  async stop(): Promise<void> {
    // Nothing persistent to close.
  }
}

/** Extract JSON-RPC messages from an SSE body (data: lines). */
export function parseSseMessages(body: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const rawEvent of body.split("\n\n")) {
    const dataLines = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());
    if (dataLines.length === 0) continue;
    try {
      messages.push(JSON.parse(dataLines.join("\n")) as JsonRpcMessage);
    } catch {
      // Skip non-JSON SSE events (e.g. keep-alives).
    }
  }
  return messages;
}
