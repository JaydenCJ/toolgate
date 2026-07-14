/**
 * The gateway core: sits between an MCP client and a downstream MCP server,
 * passes every message through untouched except `tools/call` (policy
 * enforcement) and `tools/list` (optional filtering of denied tools).
 *
 * Denials are returned as MCP tool results with `isError: true` so agents
 * receive a readable explanation instead of a broken protocol stream.
 */

import { PolicyEngine, type Decision } from "../policy/engine.js";
import type { PolicyDocument } from "../policy/types.js";
import { ApprovalManager } from "../approval/manager.js";
import { AuditLogger } from "../audit/logger.js";
import { hashArgs, nowIso, type ToolCallEvent } from "../audit/events.js";
import type { Downstream } from "./downstream.js";
import {
  isNotification,
  isRequest,
  isResponse,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from "./jsonrpc.js";

/** Delivery callback for messages addressed to the client. */
export type Respond = (msg: JsonRpcMessage) => void;

interface PendingForward {
  clientId: JsonRpcId;
  respond: Respond;
  sessionId: string;
  /** Set for intercepted tools/call forwards. */
  tool?: string;
  /** Set for intercepted tools/list forwards. */
  isToolsList?: boolean;
}

export interface GatewayOptions {
  policy: PolicyDocument;
  downstream: Downstream;
  audit: AuditLogger;
  approvals: ApprovalManager;
  mode: "stdio" | "http";
  /** Injectable clock for tests. */
  now?: () => number;
  /** Diagnostic logger (defaults to stderr). */
  log?: (line: string) => void;
}

/** Shape of an MCP tool result content block we may need to rewrite. */
interface ContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export class Gateway {
  readonly engine: PolicyEngine;
  readonly approvals: ApprovalManager;
  private readonly audit: AuditLogger;
  private readonly downstream: Downstream;
  private readonly mode: "stdio" | "http";
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly pending = new Map<number, PendingForward>();
  private nextInternalId = 1;
  /**
   * Client channel for downstream-initiated requests/notifications
   * (sampling, log notifications...). Registered by the stdio server; the
   * stateless HTTP server cannot deliver these.
   */
  private clientBroadcast: Respond | undefined;
  private closed = false;
  private closeHandler: (reason: string) => void = () => {};
  private readonly includeArgsInAudit: boolean;

  constructor(options: GatewayOptions) {
    this.engine = new PolicyEngine(options.policy, { now: options.now });
    this.approvals = options.approvals;
    this.audit = options.audit;
    this.downstream = options.downstream;
    this.mode = options.mode;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.includeArgsInAudit = options.policy.audit?.include_args ?? false;

    this.downstream.onMessage((msg) => this.handleDownstreamMessage(msg));
    this.downstream.onClose((reason) => this.handleDownstreamClose(reason));
  }

  /** Register the channel used for downstream-initiated traffic (stdio). */
  setClientBroadcast(respond: Respond): void {
    this.clientBroadcast = respond;
  }

  /** Register a handler invoked when the downstream connection dies. */
  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  /** Entry point for every message arriving from the MCP client. */
  handleClientMessage(msg: JsonRpcMessage, sessionId: string, respond: Respond): void {
    if (isRequest(msg)) {
      if (msg.method === "tools/call") {
        void this.interceptToolCall(msg, sessionId, respond);
        return;
      }
      this.forward(msg, sessionId, respond, msg.method === "tools/list" ? { isToolsList: true } : {});
      return;
    }
    if (isNotification(msg)) {
      this.downstream.send(msg);
      return;
    }
    if (isResponse(msg)) {
      // Reply to a downstream-initiated request: pass through.
      this.downstream.send(msg);
      return;
    }
    // Structurally invalid message: nothing sane to do but drop and log.
    this.log(`[toolgate] dropped malformed client message: ${JSON.stringify(msg).slice(0, 200)}`);
  }

  private forward(
    msg: JsonRpcRequest,
    sessionId: string,
    respond: Respond,
    extra: Partial<PendingForward> = {},
  ): void {
    const internalId = this.nextInternalId++;
    this.pending.set(internalId, { clientId: msg.id, respond, sessionId, ...extra });
    this.downstream.send({ ...msg, id: internalId });
  }

  private async interceptToolCall(msg: JsonRpcRequest, sessionId: string, respond: Respond): Promise<void> {
    const params = msg.params as { name?: unknown; arguments?: unknown } | undefined;
    if (!params || typeof params.name !== "string" || params.name.length === 0) {
      respond({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: JSONRPC_INVALID_PARAMS, message: "tools/call requires a string params.name" },
      });
      return;
    }
    const tool = params.name;
    const args = params.arguments ?? {};
    const startedAt = this.now();
    const argsSha = hashArgs(args);

    let decision: Decision;
    try {
      decision = this.engine.evaluateCall({ tool, args, sessionId });
    } catch (err) {
      respond({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: JSONRPC_INTERNAL_ERROR, message: `policy evaluation failed: ${(err as Error).message}` },
      });
      return;
    }

    if (decision.kind === "deny") {
      this.emitToolCall(sessionId, tool, "deny", decision, argsSha, args, this.now() - startedAt);
      respond(this.denialResult(msg.id, decision.reason, decision.code, decision.rule));
      return;
    }

    if (decision.kind === "approve") {
      const { id: approvalId, result } = this.approvals.request({
        tool,
        args: decision.args,
        sessionId,
        rule: decision.rule,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        timeoutSeconds: decision.timeoutSeconds,
      });
      this.audit.emit({
        schema: "toolgate.audit.v1",
        ts: nowIso(this.now),
        event: "approval_requested",
        session_id: sessionId,
        approval_id: approvalId,
        tool,
        rule: decision.rule,
        timeout_seconds: decision.timeoutSeconds,
      });
      const outcome = await result;
      this.audit.emit({
        schema: "toolgate.audit.v1",
        ts: nowIso(this.now),
        event: "approval_resolved",
        session_id: sessionId,
        approval_id: approvalId,
        tool,
        outcome: outcome.outcome,
        ...(outcome.resolvedBy !== undefined ? { resolved_by: outcome.resolvedBy } : {}),
      });
      const proceeds =
        outcome.outcome === "approved" || (outcome.outcome === "timeout" && decision.onTimeout === "allow");
      if (!proceeds) {
        const reason =
          outcome.outcome === "timeout"
            ? `approval request timed out after ${decision.timeoutSeconds}s (rule "${decision.rule}")`
            : `denied by human reviewer (rule "${decision.rule}")`;
        this.emitToolCall(sessionId, tool, "deny", decision, argsSha, decision.args, this.now() - startedAt, reason);
        respond(this.denialResult(msg.id, reason, "rule_deny", decision.rule));
        return;
      }
      this.emitToolCall(sessionId, tool, "allow", decision, argsSha, decision.args, this.now() - startedAt);
      this.forwardToolCall(msg, tool, decision.args, sessionId, respond);
      return;
    }

    this.emitToolCall(sessionId, tool, "allow", decision, argsSha, decision.args, this.now() - startedAt);
    this.forwardToolCall(msg, tool, decision.args, sessionId, respond);
  }

  private forwardToolCall(
    msg: JsonRpcRequest,
    tool: string,
    args: unknown,
    sessionId: string,
    respond: Respond,
  ): void {
    const params = { ...(msg.params as Record<string, unknown>), name: tool, arguments: args };
    this.forward({ ...msg, params }, sessionId, respond, { tool });
  }

  private emitToolCall(
    sessionId: string,
    tool: string,
    decision: "allow" | "deny" | "approve_pending",
    d: Decision,
    argsSha: string,
    args: unknown,
    durationMs: number,
    reasonOverride?: string,
  ): void {
    const event: ToolCallEvent = {
      schema: "toolgate.audit.v1",
      ts: nowIso(this.now),
      event: "tool_call",
      session_id: sessionId,
      tool,
      decision,
      args_sha256: argsSha,
      duration_ms: Math.max(0, durationMs),
      budget: {
        calls_used: d.budget.calls_used,
        cost_used: d.budget.cost_used,
        ...(d.budget.max_calls !== undefined ? { max_calls: d.budget.max_calls } : {}),
        ...(d.budget.max_cost !== undefined ? { max_cost: d.budget.max_cost } : {}),
      },
    };
    if ("rule" in d && d.rule !== undefined) event.rule = d.rule;
    if (d.kind === "deny") {
      event.deny_code = d.code;
      event.reason = reasonOverride ?? d.reason;
    } else {
      event.cost = d.cost;
      if (d.redactions.length > 0) event.redactions = d.redactions;
      if (reasonOverride !== undefined) event.reason = reasonOverride;
    }
    if (this.includeArgsInAudit) event.args = args;
    this.audit.emit(event);
  }

  private denialResult(id: JsonRpcId, reason: string, code: string, rule?: string): JsonRpcSuccess {
    const label = rule ? ` [rule: ${rule}]` : "";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: `Toolgate blocked this call (${code})${label}: ${reason}`,
          },
        ],
        isError: true,
      },
    };
  }

  private handleDownstreamMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const internalId = typeof msg.id === "number" ? msg.id : Number.NaN;
      const entry = this.pending.get(internalId);
      if (!entry) {
        this.log(`[toolgate] dropped downstream response with unknown id ${String(msg.id)}`);
        return;
      }
      this.pending.delete(internalId);
      let restored: JsonRpcMessage = { ...msg, id: entry.clientId };
      if (entry.tool && "result" in restored) {
        restored = this.rewriteToolResult(restored as JsonRpcSuccess, entry.tool, entry.sessionId);
      } else if (entry.isToolsList && "result" in restored) {
        restored = this.filterToolsList(restored as JsonRpcSuccess);
      }
      entry.respond(restored);
      return;
    }
    // Downstream-initiated request or notification.
    if (this.clientBroadcast) {
      this.clientBroadcast(msg);
      return;
    }
    if (isRequest(msg)) {
      // No client channel (stateless HTTP mode): refuse politely.
      this.downstream.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: JSONRPC_INTERNAL_ERROR,
          message: "toolgate http mode cannot route server-initiated requests to the client",
        },
      });
    }
  }

  /** Apply response-direction egress rules to a tools/call result. */
  private rewriteToolResult(msg: JsonRpcSuccess, tool: string, sessionId: string): JsonRpcMessage {
    const result = msg.result as { content?: unknown; structuredContent?: unknown } | null;
    if (!result || typeof result !== "object") return msg;

    let totalRedactions: { detector: string; count: number }[] = [];
    let rule: string | undefined;

    const denyMessage = (reason: string, denyRule: string): JsonRpcMessage => {
      this.audit.emit({
        schema: "toolgate.audit.v1",
        ts: nowIso(this.now),
        event: "response_egress",
        session_id: sessionId,
        tool,
        action: "deny",
        rule: denyRule,
      });
      return this.denialResult(msg.id, reason, "egress_blocked", denyRule);
    };

    let content = result.content;
    if (Array.isArray(content)) {
      const rewritten: unknown[] = [];
      for (const block of content as ContentBlock[]) {
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          const verdict = this.engine.evaluateResponseText(tool, sessionId, block.text);
          if (verdict.kind === "deny") return denyMessage(verdict.reason, verdict.rule);
          if (verdict.redactions.length > 0) {
            totalRedactions = totalRedactions.concat(verdict.redactions);
            if (verdict.rule) rule = verdict.rule;
          }
          rewritten.push({ ...block, text: verdict.text });
        } else {
          rewritten.push(block);
        }
      }
      content = rewritten;
    }

    let structured = result.structuredContent;
    if (structured !== undefined) {
      const verdict = this.engine.evaluateResponseValue(tool, sessionId, structured);
      if (verdict.kind === "deny") return denyMessage(verdict.reason, verdict.rule);
      if (verdict.redactions.length > 0) {
        totalRedactions = totalRedactions.concat(verdict.redactions);
        if (verdict.rule) rule = verdict.rule;
      }
      structured = verdict.value;
    }

    if (totalRedactions.length > 0) {
      this.audit.emit({
        schema: "toolgate.audit.v1",
        ts: nowIso(this.now),
        event: "response_egress",
        session_id: sessionId,
        tool,
        action: "redact",
        ...(rule !== undefined ? { rule } : {}),
        redactions: totalRedactions,
      });
    }

    const newResult = { ...(msg.result as Record<string, unknown>) };
    if (content !== undefined) newResult["content"] = content;
    if (structured !== undefined) newResult["structuredContent"] = structured;
    return { ...msg, result: newResult };
  }

  /** Remove statically denied tools from a tools/list result. */
  private filterToolsList(msg: JsonRpcSuccess): JsonRpcMessage {
    if (!this.engine.hideDeniedTools) return msg;
    const result = msg.result as { tools?: unknown } | null;
    if (!result || typeof result !== "object" || !Array.isArray(result.tools)) return msg;
    const tools = result.tools.filter((tool) => {
      const name = (tool as { name?: unknown })?.name;
      return typeof name !== "string" || !this.engine.isStaticallyDenied(name);
    });
    return { ...msg, result: { ...(msg.result as Record<string, unknown>), tools } };
  }

  private handleDownstreamClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.approvals.denyAll("gateway shutdown");
    for (const [internalId, entry] of this.pending) {
      this.pending.delete(internalId);
      entry.respond({
        jsonrpc: "2.0",
        id: entry.clientId,
        error: { code: JSONRPC_INTERNAL_ERROR, message: `downstream connection lost: ${reason}` },
      });
    }
    this.closeHandler(reason);
  }
}
