/** Shared test helpers: an in-memory downstream and small factories. */

import type { Downstream } from "../src/proxy/downstream.js";
import { isRequest, type JsonRpcMessage, type JsonRpcRequest } from "../src/proxy/jsonrpc.js";
import type { PolicyDocument } from "../src/policy/types.js";
import { assertPolicy } from "../src/policy/validate.js";
import { Gateway } from "../src/proxy/gateway.js";
import { ApprovalManager } from "../src/approval/manager.js";
import { AuditLogger, type AuditSink } from "../src/audit/logger.js";
import type { AuditEvent } from "../src/audit/events.js";

/** In-memory downstream that answers like a tiny MCP server. */
export class FakeDownstream implements Downstream {
  /** Every message the gateway forwarded downstream. */
  sent: JsonRpcMessage[] = [];
  /** Override the default reply for tools/call and friends. */
  respondWith: ((msg: JsonRpcRequest) => unknown) | undefined;
  /** When false, requests are swallowed (for close/timeout tests). */
  autoRespond = true;

  private handler: (msg: JsonRpcMessage) => void = () => {};
  private closeHandler: (reason: string) => void = () => {};

  onMessage(handler: (msg: JsonRpcMessage) => void): void {
    this.handler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  send(msg: JsonRpcMessage): void {
    this.sent.push(msg);
    if (!isRequest(msg) || !this.autoRespond) return;
    const result = this.respondWith ? this.respondWith(msg) : this.defaultResult(msg);
    queueMicrotask(() => this.handler({ jsonrpc: "2.0", id: msg.id, result }));
  }

  /** Push a downstream-initiated message toward the gateway. */
  emit(msg: JsonRpcMessage): void {
    this.handler(msg);
  }

  /** Simulate the downstream dying. */
  close(reason: string): void {
    this.closeHandler(reason);
  }

  private defaultResult(msg: JsonRpcRequest): unknown {
    if (msg.method === "initialize") {
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-downstream", version: "0.0.0" },
      };
    }
    if (msg.method === "tools/list") {
      return {
        tools: [
          { name: "get_weather", inputSchema: { type: "object" } },
          { name: "delete_file", inputSchema: { type: "object" } },
        ],
      };
    }
    if (msg.method === "tools/call") {
      const params = msg.params as { name: string; arguments?: Record<string, unknown> };
      return {
        content: [{ type: "text", text: `ok:${params.name}:${JSON.stringify(params.arguments ?? {})}` }],
        isError: false,
      };
    }
    return {};
  }
}

/** Audit sink that stores every event in memory. */
export class MemorySink implements AuditSink {
  readonly name = "memory";
  events: AuditEvent[] = [];
  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

/** Build a validated policy from a plain object literal. */
export function policy(doc: unknown): PolicyDocument {
  return assertPolicy(doc);
}

export interface TestGateway {
  gateway: Gateway;
  downstream: FakeDownstream;
  sink: MemorySink;
  approvals: ApprovalManager;
  audit: AuditLogger;
  /** Send a client message and await the gateway's reply. */
  call(msg: JsonRpcMessage, sessionId?: string): Promise<JsonRpcMessage>;
}

/** Wire a gateway around a FakeDownstream and a memory audit sink. */
export function makeGateway(doc: unknown, options?: { now?: () => number }): TestGateway {
  const downstream = new FakeDownstream();
  const sink = new MemorySink();
  const audit = new AuditLogger([sink]);
  const approvals = new ApprovalManager();
  const gateway = new Gateway({
    policy: policy(doc),
    downstream,
    audit,
    approvals,
    mode: "stdio",
    log: () => {},
    ...(options?.now ? { now: options.now } : {}),
  });
  const call = (msg: JsonRpcMessage, sessionId = "s1"): Promise<JsonRpcMessage> =>
    new Promise((resolve) => gateway.handleClientMessage(msg, sessionId, resolve));
  return { gateway, downstream, sink, approvals, audit, call };
}

/** Convenience factory for a tools/call request. */
export function toolCall(id: number, name: string, args: Record<string, unknown> = {}): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** Extract the text of the first content block of a tool result. */
export function resultText(msg: JsonRpcMessage): string {
  const result = (msg as { result?: { content?: { text?: string }[] } }).result;
  return result?.content?.[0]?.text ?? "";
}

/** Whether a tool result is flagged as an error. */
export function resultIsError(msg: JsonRpcMessage): boolean {
  return Boolean((msg as { result?: { isError?: boolean } }).result?.isError);
}
