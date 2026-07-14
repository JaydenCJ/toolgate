/**
 * HTTP proxy mode (`toolgate serve`): exposes the gateway as a Streamable
 * HTTP MCP endpoint.
 *
 *   POST /mcp    - one JSON-RPC message per request; requests get a JSON
 *                  reply, notifications/responses are acknowledged with 202.
 *   GET  /health - liveness endpoint for smoke tests and orchestrators.
 *
 * The session id is taken from the `mcp-session-id` header when present so
 * per-task budgets survive across requests; otherwise a shared "default"
 * session is used. Binds 127.0.0.1 unless --host says otherwise.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isRequest, type JsonRpcMessage } from "./jsonrpc.js";
import type { Gateway } from "./gateway.js";

export interface McpHttpServerOptions {
  gateway: Gateway;
  host?: string;
  port: number;
  log?: (line: string) => void;
}

export class McpHttpServer {
  private readonly options: McpHttpServerOptions;
  private server: Server | undefined;
  boundPort = 0;

  constructor(options: McpHttpServerOptions) {
    this.options = options;
  }

  get url(): string {
    return `http://${this.options.host ?? "127.0.0.1"}:${this.boundPort}`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    const host = this.options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : this.options.port;
    (this.options.log ?? (() => {}))(`[toolgate] mcp endpoint listening on ${this.url}/mcp`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname !== "/mcp" || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "use POST /mcp (JSON-RPC) or GET /health" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "body too large" }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcMessage;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "body is not valid JSON" },
          }),
        );
        return;
      }
      const headerSession = req.headers["mcp-session-id"];
      const sessionId = typeof headerSession === "string" && headerSession.length > 0 ? headerSession : "default";

      if (isRequest(msg)) {
        const timeout = setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(504, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32000, message: "downstream did not answer in time" },
              }),
            );
          }
        }, 120_000);
        timeout.unref?.();
        this.options.gateway.handleClientMessage(msg, sessionId, (reply) => {
          clearTimeout(timeout);
          if (res.writableEnded) return;
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": sessionId });
          res.end(JSON.stringify(reply));
        });
        return;
      }
      // Notification or client->server response: accept and move on.
      this.options.gateway.handleClientMessage(msg, sessionId, () => {});
      res.writeHead(202, { "mcp-session-id": sessionId });
      res.end();
    });
  }
}
