/**
 * The toolgate policy engine.
 *
 * Every MCP `tools/call` is evaluated against the loaded policy in a fixed,
 * deterministic order:
 *
 *   1. circuit breaker  - a session whose budget tripped stays denied
 *   2. egress (request) - deny/redact sensitive data in the arguments
 *   3. rate limits      - sliding-window limits from matching rules
 *   4. budget           - per-session call-count and cost ceilings
 *   5. action           - first matching rule's allow/deny/approve, else the
 *                         policy default (allow)
 *
 * The engine is pure logic: the clock is injectable and no I/O happens here,
 * which keeps it fully unit-testable.
 */

import type {
  ApprovalTimeoutAction,
  EgressRuleConfig,
  PolicyDocument,
  PolicyRule,
} from "./types.js";
import { globMatch, globMatchAny } from "./glob.js";
import {
  compileEgressPattern,
  redactValue,
  scanValue,
  type CompiledPattern,
  type EgressHit,
} from "./egress.js";

/** Reasons a call can be denied. Mirrored into audit events verbatim. */
export type DenyCode =
  | "rule_deny"
  | "egress_blocked"
  | "rate_limited"
  | "budget_exceeded"
  | "circuit_open";

/** Snapshot of a session's budget consumption, included in decisions. */
export interface BudgetSnapshot {
  calls_used: number;
  cost_used: number;
  max_calls?: number;
  max_cost?: number;
  tripped: boolean;
}

/** Result of evaluating a `tools/call` request. */
export type Decision =
  | {
      kind: "allow";
      /** Name of the rule that allowed the call, if any matched. */
      rule?: string;
      /** Arguments with redactions applied (deep copy) when egress redacted. */
      args: unknown;
      redactions: EgressHit[];
      cost: number;
      budget: BudgetSnapshot;
    }
  | {
      kind: "deny";
      code: DenyCode;
      rule?: string;
      reason: string;
      budget: BudgetSnapshot;
    }
  | {
      kind: "approve";
      rule: string;
      reason?: string;
      timeoutSeconds: number;
      onTimeout: ApprovalTimeoutAction;
      args: unknown;
      redactions: EgressHit[];
      cost: number;
      budget: BudgetSnapshot;
    };

/** Result of scanning a tool response before it reaches the agent. */
export type ResponseVerdict =
  | { kind: "pass"; text: string; redactions: EgressHit[]; rule?: string }
  | { kind: "deny"; rule: string; reason: string; detector: string };

/** Result of scanning a structured tool response value. */
export type ResponseValueVerdict =
  | { kind: "pass"; value: unknown; redactions: EgressHit[]; rule?: string }
  | { kind: "deny"; rule: string; reason: string; detector: string };

interface CompiledEgress {
  ruleName: string;
  scan: ("request" | "response")[];
  deny: CompiledPattern[];
  redact: CompiledPattern[];
}

interface CompiledRule {
  rule: PolicyRule;
  argMatchers?: Map<string, RegExp>;
  egress?: CompiledEgress;
}

interface SessionState {
  callsUsed: number;
  costUsed: number;
  tripped: boolean;
  /** Per rule-name timestamps (ms) of recent allowed calls, for rate limits. */
  rateWindows: Map<string, number[]>;
}

const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300;

function compileEgressConfig(ruleName: string, config: EgressRuleConfig): CompiledEgress {
  return {
    ruleName,
    scan: config.scan ?? ["request"],
    deny: (config.deny ?? []).map(compileEgressPattern),
    redact: (config.redact ?? []).map(compileEgressPattern),
  };
}

/** Stateful policy evaluator. One instance serves many sessions. */
export class PolicyEngine {
  private readonly policy: PolicyDocument;
  private readonly rules: CompiledRule[];
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => number;

  constructor(policy: PolicyDocument, options?: { now?: () => number }) {
    this.policy = policy;
    this.now = options?.now ?? Date.now;
    this.rules = (policy.rules ?? []).map((rule) => {
      const compiled: CompiledRule = { rule };
      if (rule.match.args) {
        compiled.argMatchers = new Map(
          Object.entries(rule.match.args).map(([key, source]) => [key, new RegExp(source)]),
        );
      }
      if (rule.egress) {
        compiled.egress = compileEgressConfig(rule.name, rule.egress);
      }
      return compiled;
    });
  }

  /** The default action applied when no rule matches. */
  get defaultAction(): "allow" | "deny" {
    const action = this.policy.defaults?.action ?? "allow";
    // validate.ts rejects approve as a default.
    return action === "deny" ? "deny" : "allow";
  }

  /** Whether tools/list responses should hide statically denied tools. */
  get hideDeniedTools(): boolean {
    return this.policy.options?.hide_denied_tools ?? false;
  }

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { callsUsed: 0, costUsed: 0, tripped: false, rateWindows: new Map() };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Forget a session's counters (e.g. when an MCP session ends). */
  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Cost of one call to `tool` according to the policy cost table. */
  costOf(tool: string): number {
    const costs = this.policy.costs;
    if (!costs) return 0;
    if (Object.prototype.hasOwnProperty.call(costs, tool)) return costs[tool] ?? 0;
    for (const [glob, cost] of Object.entries(costs)) {
      if (glob !== "default" && globMatch(glob, tool)) return cost;
    }
    return costs["default"] ?? 0;
  }

  private budgetSnapshot(state: SessionState): BudgetSnapshot {
    const snapshot: BudgetSnapshot = {
      calls_used: state.callsUsed,
      cost_used: round(state.costUsed),
      tripped: state.tripped,
    };
    if (this.policy.budget?.max_calls !== undefined) snapshot.max_calls = this.policy.budget.max_calls;
    if (this.policy.budget?.max_cost !== undefined) snapshot.max_cost = this.policy.budget.max_cost;
    return snapshot;
  }

  private matchingRules(tool: string, args: unknown): CompiledRule[] {
    return this.rules.filter((compiled) => {
      if (!globMatchAny(compiled.rule.match.tools, tool)) return false;
      if (!compiled.argMatchers) return true;
      if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
      const record = args as Record<string, unknown>;
      for (const [key, regex] of compiled.argMatchers) {
        if (!(key in record)) return false;
        const value = record[key];
        const text = typeof value === "string" ? value : JSON.stringify(value);
        if (text === undefined || !regex.test(text)) return false;
      }
      return true;
    });
  }

  /**
   * Evaluate a tool call and, when it is allowed (or sent to approval),
   * consume budget and rate-limit quota for the session.
   */
  evaluateCall(input: { tool: string; args: unknown; sessionId: string }): Decision {
    const state = this.session(input.sessionId);
    const budget = () => this.budgetSnapshot(state);

    // 1. Circuit breaker: once the budget trips, the whole task stays blocked.
    if (state.tripped) {
      return {
        kind: "deny",
        code: "circuit_open",
        reason: "session budget circuit breaker is open; no further tool calls are allowed for this task",
        budget: budget(),
      };
    }

    const matching = this.matchingRules(input.tool, input.args);

    // 2. Egress on the request direction.
    let args = input.args;
    const redactions: EgressHit[] = [];
    for (const compiled of matching) {
      const egress = compiled.egress;
      if (!egress || !egress.scan.includes("request")) continue;
      if (egress.deny.length > 0) {
        const hits = scanValue(args, egress.deny);
        if (hits.length > 0) {
          const first = hits[0]!;
          return {
            kind: "deny",
            code: "egress_blocked",
            rule: egress.ruleName,
            reason:
              compiled.rule.reason ??
              `arguments contain data blocked by egress rule "${egress.ruleName}" (detector: ${first.detector})`,
            budget: budget(),
          };
        }
      }
      if (egress.redact.length > 0) {
        const result = redactValue(args, egress.redact);
        args = result.value;
        redactions.push(...result.hits);
      }
    }

    // 3. Rate limits from every matching rule that declares one.
    const nowMs = this.now();
    for (const compiled of matching) {
      const limit = compiled.rule.rate_limit;
      if (!limit) continue;
      const windowMs = limit.per_seconds * 1000;
      const timestamps = (state.rateWindows.get(compiled.rule.name) ?? []).filter(
        (t) => nowMs - t < windowMs,
      );
      state.rateWindows.set(compiled.rule.name, timestamps);
      if (timestamps.length >= limit.max_calls) {
        return {
          kind: "deny",
          code: "rate_limited",
          rule: compiled.rule.name,
          reason:
            compiled.rule.reason ??
            `rate limit exceeded for rule "${compiled.rule.name}" (${limit.max_calls} calls per ${limit.per_seconds}s)`,
          budget: budget(),
        };
      }
    }

    // 4. Budget ceilings; exceeding either trips the circuit breaker.
    const cost = this.costOf(input.tool);
    const maxCalls = this.policy.budget?.max_calls;
    const maxCost = this.policy.budget?.max_cost;
    if (
      (maxCalls !== undefined && state.callsUsed + 1 > maxCalls) ||
      (maxCost !== undefined && state.costUsed + cost > maxCost)
    ) {
      state.tripped = true;
      const which =
        maxCalls !== undefined && state.callsUsed + 1 > maxCalls
          ? `max_calls=${maxCalls}`
          : `max_cost=${maxCost}`;
      return {
        kind: "deny",
        code: "budget_exceeded",
        reason: `session budget exhausted (${which}); circuit breaker tripped for this task`,
        budget: budget(),
      };
    }

    // 5. Terminal action: first matching rule that declares one wins.
    const actionRule = matching.find((c) => c.rule.action !== undefined);
    const action = actionRule?.rule.action ?? this.defaultAction;

    if (action === "deny") {
      return {
        kind: "deny",
        code: "rule_deny",
        ...(actionRule ? { rule: actionRule.rule.name } : {}),
        reason:
          actionRule?.rule.reason ??
          (actionRule
            ? `denied by rule "${actionRule.rule.name}"`
            : "denied by policy default (defaults.action: deny)"),
        budget: budget(),
      };
    }

    // Consume quota for calls that proceed (allowed or pending approval).
    state.callsUsed += 1;
    state.costUsed += cost;
    for (const compiled of matching) {
      if (!compiled.rule.rate_limit) continue;
      const timestamps = state.rateWindows.get(compiled.rule.name) ?? [];
      timestamps.push(nowMs);
      state.rateWindows.set(compiled.rule.name, timestamps);
    }

    if (action === "approve") {
      const rule = actionRule!.rule;
      const timeoutSeconds =
        rule.approval?.timeout_seconds ??
        this.policy.approvals?.timeout_seconds ??
        DEFAULT_APPROVAL_TIMEOUT_SECONDS;
      const onTimeout = rule.approval?.on_timeout ?? this.policy.approvals?.on_timeout ?? "deny";
      return {
        kind: "approve",
        rule: rule.name,
        ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
        timeoutSeconds,
        onTimeout,
        args,
        redactions,
        cost,
        budget: budget(),
      };
    }

    return {
      kind: "allow",
      ...(actionRule ? { rule: actionRule.rule.name } : {}),
      args,
      redactions,
      cost,
      budget: budget(),
    };
  }

  /**
   * Scan a structured tool-response value (text blocks, structuredContent...)
   * before it is returned to the agent. Applies every matching rule whose
   * egress config scans the response direction: deny patterns block the
   * response, redact patterns mask matches in place (deep copy).
   */
  evaluateResponseValue(tool: string, sessionId: string, value: unknown): ResponseValueVerdict {
    void sessionId; // Reserved for future per-session response rules.
    let out = value;
    const redactions: EgressHit[] = [];
    let matchedRule: string | undefined;
    for (const compiled of this.matchingRules(tool, undefined)) {
      const egress = compiled.egress;
      if (!egress || !egress.scan.includes("response")) continue;
      if (egress.deny.length > 0) {
        const hits = scanValue(out, egress.deny);
        if (hits.length > 0) {
          const first = hits[0]!;
          return {
            kind: "deny",
            rule: egress.ruleName,
            reason:
              compiled.rule.reason ??
              `tool response blocked by egress rule "${egress.ruleName}" (detector: ${first.detector})`,
            detector: first.detector,
          };
        }
      }
      if (egress.redact.length > 0) {
        const result = redactValue(out, egress.redact);
        out = result.value;
        if (result.hits.length > 0) {
          redactions.push(...result.hits);
          matchedRule = egress.ruleName;
        }
      }
    }
    return { kind: "pass", value: out, redactions, ...(matchedRule ? { rule: matchedRule } : {}) };
  }

  /**
   * Convenience wrapper of {@link evaluateResponseValue} for plain text.
   */
  evaluateResponseText(tool: string, sessionId: string, text: string): ResponseVerdict {
    const verdict = this.evaluateResponseValue(tool, sessionId, text);
    if (verdict.kind === "deny") return verdict;
    return {
      kind: "pass",
      text: verdict.value as string,
      redactions: verdict.redactions,
      ...(verdict.rule ? { rule: verdict.rule } : {}),
    };
  }

  /**
   * True when a tool is statically denied: the first action rule whose name
   * glob matches decides, and it must not depend on call arguments. When an
   * argument-dependent action rule is reached first, the tool cannot be
   * statically classified and is kept visible. Used by `tools/list`
   * filtering when `hide_denied_tools` is on.
   */
  isStaticallyDenied(tool: string): boolean {
    for (const compiled of this.rules) {
      if (compiled.rule.action === undefined) continue;
      if (!globMatchAny(compiled.rule.match.tools, tool)) continue;
      // An arg-dependent rule makes the outcome depend on the call itself.
      if (compiled.argMatchers) return false;
      return compiled.rule.action === "deny";
    }
    return this.defaultAction === "deny";
  }

  /** Current budget usage for a session (for the control API). */
  sessionUsage(sessionId: string): BudgetSnapshot {
    return this.budgetSnapshot(this.session(sessionId));
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
