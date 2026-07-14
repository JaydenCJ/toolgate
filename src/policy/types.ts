/**
 * Policy document model for toolgate.
 *
 * A policy is written as YAML (policy-as-code), validated at load time and
 * evaluated by {@link PolicyEngine} for every MCP `tools/call` request.
 */

/** Terminal decision a rule (or the default) can produce for a tool call. */
export type RuleAction = "allow" | "deny" | "approve";

/** What to do when an approval request times out. */
export type ApprovalTimeoutAction = "deny" | "allow";

/** Which side of a tool call an egress rule scans. */
export type EgressDirection = "request" | "response";

/** Matcher deciding which tool calls a rule applies to. */
export interface RuleMatch {
  /** Glob patterns matched against the tool name (`*` and `?` wildcards). */
  tools: string[];
  /**
   * Optional argument matchers: a map of top-level argument key to a regular
   * expression source. The rule only matches when every listed key exists in
   * the call arguments and its stringified value matches the expression.
   */
  args?: Record<string, string>;
}

/** Sliding-window rate limit attached to a rule. */
export interface RateLimitConfig {
  /** Maximum number of calls allowed inside the window. */
  max_calls: number;
  /** Window length in seconds. */
  per_seconds: number;
}

/** Data-egress scanning configuration attached to a rule. */
export interface EgressRuleConfig {
  /** Directions to scan. Defaults to `["request"]` when omitted. */
  scan?: EgressDirection[];
  /** Detector names or `regex:<source>` patterns that block the call. */
  deny?: string[];
  /** Detector names or `regex:<source>` patterns that are masked in place. */
  redact?: string[];
}

/** Per-rule approval settings (only used when `action: approve`). */
export interface RuleApprovalConfig {
  /** Seconds to wait for a human decision. Defaults to the global setting. */
  timeout_seconds?: number;
  /** Decision applied when nobody responds in time. Defaults to `deny`. */
  on_timeout?: ApprovalTimeoutAction;
}

/** A single ordered policy rule. First matching `action` wins. */
export interface PolicyRule {
  /** Unique rule name; referenced in decisions and audit events. */
  name: string;
  /** Which calls this rule applies to. */
  match: RuleMatch;
  /** Terminal action. Omit for check-only rules (rate limit / egress). */
  action?: RuleAction;
  /** Human-readable reason included in deny responses and audit events. */
  reason?: string;
  /** Optional sliding-window rate limit enforced for matching calls. */
  rate_limit?: RateLimitConfig;
  /** Optional data-egress scanning for matching calls. */
  egress?: EgressRuleConfig;
  /** Approval tuning for `action: approve` rules. */
  approval?: RuleApprovalConfig;
}

/** Budget limits applied per task (one MCP session = one task). */
export interface BudgetConfig {
  /** Maximum number of allowed tool calls per session. */
  max_calls?: number;
  /** Maximum accumulated cost per session (see `costs`). */
  max_cost?: number;
}

/** Notifier for pending approvals. */
export type ApprovalNotifierConfig =
  | { type: "terminal" }
  | {
      type: "slack";
      /** Slack incoming-webhook URL. Prefer `webhook_url_env` for secrets. */
      webhook_url?: string;
      /** Name of an environment variable holding the webhook URL. */
      webhook_url_env?: string;
    };

/** Global approval settings. */
export interface ApprovalsConfig {
  /** Default seconds to wait for a decision. Defaults to 300. */
  timeout_seconds?: number;
  /** Default timeout action. Defaults to `deny`. */
  on_timeout?: ApprovalTimeoutAction;
  /** Channels notified when an approval is requested. */
  notify?: ApprovalNotifierConfig[];
}

/** A single audit sink. */
export type AuditSinkConfig =
  | { type: "jsonl"; path: string }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "stderr" };

/** Audit/event-export settings. */
export interface AuditConfig {
  sinks?: AuditSinkConfig[];
  /**
   * When true, audit events include the (redacted) call arguments.
   * Defaults to false: only a SHA-256 hash of the arguments is logged.
   */
  include_args?: boolean;
}

/** Gateway behaviour toggles. */
export interface PolicyOptions {
  /**
   * When true, tools that are statically denied (a deny rule that matches the
   * tool name with no argument matcher) are removed from `tools/list`
   * responses so agents never see them. Defaults to false.
   */
  hide_denied_tools?: boolean;
}

/** Root policy document. */
export interface PolicyDocument {
  /** Schema version. Only `1` is supported. */
  version: 1;
  /** Fallback behaviour when no rule matches. */
  defaults?: {
    /** Action when no rule matches. Defaults to `allow`. */
    action?: RuleAction;
  };
  /** Per-session (per-task) budget circuit breaker. */
  budget?: BudgetConfig;
  /**
   * Cost table: tool-name glob to cost units. The reserved key `default`
   * applies when nothing else matches (falls back to 0 when absent).
   */
  costs?: Record<string, number>;
  /** Ordered rules; first matching terminal action wins. */
  rules?: PolicyRule[];
  approvals?: ApprovalsConfig;
  audit?: AuditConfig;
  options?: PolicyOptions;
}
