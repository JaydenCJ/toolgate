import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/policy/engine.js";
import { policy } from "./helpers.js";

const base = {
  version: 1,
  rules: [
    { name: "deny-deletes", match: { tools: ["delete_*"] }, action: "deny", reason: "no deletes" },
    { name: "approve-payments", match: { tools: ["send_payment"] }, action: "approve" },
    { name: "allow-weather", match: { tools: ["get_weather"] }, action: "allow" },
  ],
};

describe("PolicyEngine action rules", () => {
  it("allows by default when no rule matches", () => {
    const engine = new PolicyEngine(policy({ version: 1 }));
    const decision = engine.evaluateCall({ tool: "anything", args: {}, sessionId: "s" });
    expect(decision.kind).toBe("allow");
  });

  it("denies by default when defaults.action is deny", () => {
    const engine = new PolicyEngine(policy({ version: 1, defaults: { action: "deny" } }));
    const decision = engine.evaluateCall({ tool: "anything", args: {}, sessionId: "s" });
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.code).toBe("rule_deny");
      expect(decision.reason).toContain("defaults.action");
    }
  });

  it("matches tool-name globs and reports the rule", () => {
    const engine = new PolicyEngine(policy(base));
    const decision = engine.evaluateCall({ tool: "delete_file", args: {}, sessionId: "s" });
    expect(decision).toMatchObject({ kind: "deny", code: "rule_deny", rule: "deny-deletes", reason: "no deletes" });
  });

  it("first matching action rule wins over later rules", () => {
    const engine = new PolicyEngine(
      policy({
        version: 1,
        rules: [
          { name: "allow-first", match: { tools: ["x"] }, action: "allow" },
          { name: "deny-later", match: { tools: ["*"] }, action: "deny" },
        ],
      }),
    );
    expect(engine.evaluateCall({ tool: "x", args: {}, sessionId: "s" }).kind).toBe("allow");
    expect(engine.evaluateCall({ tool: "y", args: {}, sessionId: "s" }).kind).toBe("deny");
  });

  it("produces approve decisions with timeout settings", () => {
    const engine = new PolicyEngine(
      policy({
        version: 1,
        approvals: { timeout_seconds: 60, on_timeout: "deny" },
        rules: [
          {
            name: "approve-payments",
            match: { tools: ["send_payment"] },
            action: "approve",
            approval: { timeout_seconds: 30, on_timeout: "allow" },
          },
        ],
      }),
    );
    const decision = engine.evaluateCall({ tool: "send_payment", args: {}, sessionId: "s" });
    expect(decision).toMatchObject({ kind: "approve", rule: "approve-payments", timeoutSeconds: 30, onTimeout: "allow" });
  });

  it("matches on argument values with regexes", () => {
    const engine = new PolicyEngine(
      policy({
        version: 1,
        rules: [
          {
            name: "deny-prod-writes",
            match: { tools: ["run_sql"], args: { database: "^prod" } },
            action: "deny",
          },
        ],
      }),
    );
    expect(
      engine.evaluateCall({ tool: "run_sql", args: { database: "prod-eu" }, sessionId: "s" }).kind,
    ).toBe("deny");
    expect(
      engine.evaluateCall({ tool: "run_sql", args: { database: "staging" }, sessionId: "s" }).kind,
    ).toBe("allow");
    // Missing key means the arg matcher does not match.
    expect(engine.evaluateCall({ tool: "run_sql", args: {}, sessionId: "s" }).kind).toBe("allow");
  });
});

describe("PolicyEngine budget circuit breaker", () => {
  it("denies once max_calls is exceeded and trips the circuit", () => {
    const engine = new PolicyEngine(policy({ version: 1, budget: { max_calls: 2 } }));
    expect(engine.evaluateCall({ tool: "a", args: {}, sessionId: "s" }).kind).toBe("allow");
    expect(engine.evaluateCall({ tool: "a", args: {}, sessionId: "s" }).kind).toBe("allow");
    const third = engine.evaluateCall({ tool: "a", args: {}, sessionId: "s" });
    expect(third).toMatchObject({ kind: "deny", code: "budget_exceeded" });
    // Circuit stays open: even a cheap call is now refused.
    const fourth = engine.evaluateCall({ tool: "other", args: {}, sessionId: "s" });
    expect(fourth).toMatchObject({ kind: "deny", code: "circuit_open" });
  });

  it("tracks cost per tool and trips on max_cost", () => {
    const engine = new PolicyEngine(
      policy({
        version: 1,
        budget: { max_cost: 1.0 },
        costs: { send_payment: 0.6, default: 0.1 },
      }),
    );
    expect(engine.evaluateCall({ tool: "send_payment", args: {}, sessionId: "s" }).kind).toBe("allow");
    expect(engine.evaluateCall({ tool: "cheap", args: {}, sessionId: "s" }).kind).toBe("allow");
    // 0.6 + 0.1 + 0.6 > 1.0 -> breaker trips.
    const decision = engine.evaluateCall({ tool: "send_payment", args: {}, sessionId: "s" });
    expect(decision).toMatchObject({ kind: "deny", code: "budget_exceeded" });
    expect(engine.sessionUsage("s").tripped).toBe(true);
  });

  it("keeps budgets isolated per session and supports reset", () => {
    const engine = new PolicyEngine(policy({ version: 1, budget: { max_calls: 1 } }));
    expect(engine.evaluateCall({ tool: "a", args: {}, sessionId: "s1" }).kind).toBe("allow");
    expect(engine.evaluateCall({ tool: "a", args: {}, sessionId: "s2" }).kind).toBe("allow");
    expect(engine.evaluateCall({ tool: "a", args: {}, sessionId: "s1" }).kind).toBe("deny");
    engine.resetSession("s1");
    expect(engine.evaluateCall({ tool: "a", args: {}, sessionId: "s1" }).kind).toBe("allow");
  });

  it("matches costs by glob with default fallback", () => {
    const engine = new PolicyEngine(
      policy({ version: 1, costs: { "llm_*": 0.25, exact: 2, default: 0.01 } }),
    );
    expect(engine.costOf("llm_complete")).toBe(0.25);
    expect(engine.costOf("exact")).toBe(2);
    expect(engine.costOf("other")).toBe(0.01);
  });
});

describe("PolicyEngine rate limits", () => {
  it("enforces a sliding window using the injected clock", () => {
    let nowMs = 0;
    const engine = new PolicyEngine(
      policy({
        version: 1,
        rules: [
          { name: "rl", match: { tools: ["search"] }, rate_limit: { max_calls: 2, per_seconds: 60 } },
        ],
      }),
      { now: () => nowMs },
    );
    expect(engine.evaluateCall({ tool: "search", args: {}, sessionId: "s" }).kind).toBe("allow");
    nowMs += 1000;
    expect(engine.evaluateCall({ tool: "search", args: {}, sessionId: "s" }).kind).toBe("allow");
    nowMs += 1000;
    const third = engine.evaluateCall({ tool: "search", args: {}, sessionId: "s" });
    expect(third).toMatchObject({ kind: "deny", code: "rate_limited", rule: "rl" });
    // Window slides: after the first call ages out, one slot frees up.
    nowMs = 61_000;
    expect(engine.evaluateCall({ tool: "search", args: {}, sessionId: "s" }).kind).toBe("allow");
  });

  it("does not consume rate quota for denied calls", () => {
    const nowMs = 0;
    const engine = new PolicyEngine(
      policy({
        version: 1,
        rules: [
          { name: "rl", match: { tools: ["*"] }, rate_limit: { max_calls: 1, per_seconds: 60 } },
          { name: "deny-x", match: { tools: ["x"] }, action: "deny" },
        ],
      }),
      { now: () => nowMs },
    );
    expect(engine.evaluateCall({ tool: "x", args: {}, sessionId: "s" }).kind).toBe("deny");
    expect(engine.evaluateCall({ tool: "y", args: {}, sessionId: "s" }).kind).toBe("allow");
  });
});

describe("PolicyEngine egress", () => {
  const egressPolicy = {
    version: 1,
    rules: [
      {
        name: "no-secrets-out",
        match: { tools: ["*"] },
        egress: { scan: ["request"], deny: ["aws-access-key"], redact: ["email"] },
      },
      {
        name: "mask-response-pii",
        match: { tools: ["read_*"] },
        egress: { scan: ["response"], redact: ["email"] },
      },
    ],
  };

  it("blocks requests whose arguments contain denied patterns", () => {
    const engine = new PolicyEngine(policy(egressPolicy));
    const decision = engine.evaluateCall({
      tool: "post_message",
      args: { body: "key is AKIAIOSFODNN7EXAMPLE" },
      sessionId: "s",
    });
    expect(decision).toMatchObject({ kind: "deny", code: "egress_blocked", rule: "no-secrets-out" });
  });

  it("redacts matched patterns in arguments while allowing the call", () => {
    const engine = new PolicyEngine(policy(egressPolicy));
    const decision = engine.evaluateCall({
      tool: "post_message",
      args: { body: "contact jane.doe@example.com please", nested: { cc: "bob@corp.example" } },
      sessionId: "s",
    });
    expect(decision.kind).toBe("allow");
    if (decision.kind === "allow") {
      expect(JSON.stringify(decision.args)).not.toContain("jane.doe@example.com");
      expect(JSON.stringify(decision.args)).toContain("[REDACTED:email]");
      expect(decision.redactions).toEqual([{ detector: "email", count: 2 }]);
    }
  });

  it("redacts response text for matching tools only", () => {
    const engine = new PolicyEngine(policy(egressPolicy));
    const hit = engine.evaluateResponseText("read_customer", "s", "email: a@b.example");
    expect(hit.kind).toBe("pass");
    if (hit.kind === "pass") expect(hit.text).toContain("[REDACTED:email]");
    const miss = engine.evaluateResponseText("get_weather", "s", "email: a@b.example");
    if (miss.kind === "pass") expect(miss.text).toContain("a@b.example");
  });

  it("denies responses containing deny patterns", () => {
    const engine = new PolicyEngine(
      policy({
        version: 1,
        rules: [
          {
            name: "no-keys-in",
            match: { tools: ["*"] },
            egress: { scan: ["response"], deny: ["private-key"] },
          },
        ],
      }),
    );
    const verdict = engine.evaluateResponseText("read_file", "s", "-----BEGIN RSA PRIVATE KEY-----");
    expect(verdict).toMatchObject({ kind: "deny", rule: "no-keys-in", detector: "private-key" });
  });
});

describe("PolicyEngine static denial (tools/list filtering)", () => {
  it("classifies name-only deny rules as static", () => {
    const engine = new PolicyEngine(policy(base));
    expect(engine.isStaticallyDenied("delete_file")).toBe(true);
    expect(engine.isStaticallyDenied("get_weather")).toBe(false);
    expect(engine.isStaticallyDenied("send_payment")).toBe(false);
  });

  it("keeps arg-dependent tools visible", () => {
    const engine = new PolicyEngine(
      policy({
        version: 1,
        rules: [
          { name: "cond", match: { tools: ["run_sql"], args: { db: "^prod" } }, action: "deny" },
          { name: "blanket", match: { tools: ["run_sql"] }, action: "deny" },
        ],
      }),
    );
    // The first matching action rule is arg-dependent -> not static.
    expect(engine.isStaticallyDenied("run_sql")).toBe(false);
  });
});
