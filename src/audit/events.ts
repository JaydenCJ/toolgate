/**
 * Structured audit events emitted by the gateway.
 *
 * Every decision is exported as one JSON object with a stable schema id
 * (`toolgate.audit.v1`) so SIEM pipelines can ingest the stream directly.
 * By default arguments are logged only as a SHA-256 hash; set
 * `audit.include_args: true` to include the redacted arguments.
 */

import { createHash } from "node:crypto";

/** Discriminator for audit event types. */
export type AuditEventType =
  | "gateway_started"
  | "gateway_stopped"
  | "tool_call"
  | "approval_requested"
  | "approval_resolved"
  | "response_egress";

/** Fields shared by every audit event. */
export interface AuditEventBase {
  /** Stable schema identifier for SIEM ingestion. */
  schema: "toolgate.audit.v1";
  /** RFC 3339 timestamp. */
  ts: string;
  event: AuditEventType;
  session_id?: string;
}

export interface GatewayLifecycleEvent extends AuditEventBase {
  event: "gateway_started" | "gateway_stopped";
  mode: "stdio" | "http";
  policy_path?: string;
}

export interface ToolCallEvent extends AuditEventBase {
  event: "tool_call";
  tool: string;
  decision: "allow" | "deny" | "approve_pending";
  rule?: string;
  deny_code?: string;
  reason?: string;
  cost?: number;
  budget?: { calls_used: number; cost_used: number; max_calls?: number; max_cost?: number };
  /** SHA-256 of the canonical JSON of the original arguments. */
  args_sha256: string;
  /** Redacted arguments; present only when `audit.include_args` is true. */
  args?: unknown;
  redactions?: { detector: string; count: number }[];
  duration_ms?: number;
}

export interface ApprovalRequestedEvent extends AuditEventBase {
  event: "approval_requested";
  approval_id: string;
  tool: string;
  rule: string;
  timeout_seconds: number;
}

export interface ApprovalResolvedEvent extends AuditEventBase {
  event: "approval_resolved";
  approval_id: string;
  tool: string;
  outcome: "approved" | "denied" | "timeout";
  resolved_by?: string;
}

export interface ResponseEgressEvent extends AuditEventBase {
  event: "response_egress";
  tool: string;
  action: "redact" | "deny";
  rule?: string;
  redactions?: { detector: string; count: number }[];
}

export type AuditEvent =
  | GatewayLifecycleEvent
  | ToolCallEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ResponseEgressEvent;

/** SHA-256 hex digest of a JSON-serializable value. */
export function hashArgs(args: unknown): string {
  const json = JSON.stringify(args) ?? "null";
  return createHash("sha256").update(json).digest("hex");
}

/** Current time as an RFC 3339 string. */
export function nowIso(now: () => number = Date.now): string {
  return new Date(now()).toISOString();
}
