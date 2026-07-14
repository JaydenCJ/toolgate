import { describe, expect, it } from "vitest";
import { validatePolicy } from "../src/policy/validate.js";
import { parsePolicy } from "../src/policy/loader.js";

describe("validatePolicy", () => {
  it("accepts a full-featured document", () => {
    const issues = validatePolicy({
      version: 1,
      defaults: { action: "deny" },
      budget: { max_calls: 10, max_cost: 1.5 },
      costs: { "a_*": 0.2, default: 0.01 },
      rules: [
        {
          name: "r1",
          match: { tools: ["a_*"], args: { key: "^x" } },
          action: "approve",
          approval: { timeout_seconds: 10, on_timeout: "allow" },
        },
        { name: "r2", match: { tools: ["*"] }, egress: { deny: ["email", "regex:foo\\d+"] } },
        { name: "r3", match: { tools: ["b"] }, rate_limit: { max_calls: 5, per_seconds: 60 } },
      ],
      approvals: { timeout_seconds: 300, on_timeout: "deny", notify: [{ type: "terminal" }] },
      audit: { include_args: true, sinks: [{ type: "jsonl", path: "/tmp/x.jsonl" }, { type: "stderr" }] },
      options: { hide_denied_tools: true },
    });
    expect(issues).toEqual([]);
  });

  it("rejects non-object documents and wrong versions", () => {
    expect(validatePolicy(null)[0]?.message).toContain("mapping");
    expect(validatePolicy({ version: 2 })[0]?.path).toBe("version");
  });

  it("pinpoints unknown keys and bad values with paths", () => {
    const issues = validatePolicy({
      version: 1,
      budget: { max_calls: -1, surprise: true },
      rules: [{ name: "", match: { tools: [] }, action: "explode" }],
    });
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("budget.max_calls");
    expect(paths).toContain("budget.surprise");
    expect(paths).toContain("rules[0].name");
    expect(paths).toContain("rules[0].match.tools");
    expect(paths).toContain("rules[0].action");
  });

  it("rejects duplicate rule names and no-effect rules", () => {
    const issues = validatePolicy({
      version: 1,
      rules: [
        { name: "dup", match: { tools: ["a"] }, action: "allow" },
        { name: "dup", match: { tools: ["b"] }, action: "deny" },
        { name: "noop", match: { tools: ["c"] } },
      ],
    });
    expect(issues.some((i) => i.message.includes("duplicate rule name"))).toBe(true);
    expect(issues.some((i) => i.message.includes("no effect"))).toBe(true);
  });

  it("rejects unknown detectors and invalid custom regexes", () => {
    const issues = validatePolicy({
      version: 1,
      rules: [
        { name: "r", match: { tools: ["*"] }, egress: { deny: ["not-a-detector", "regex:("] } },
      ],
    });
    expect(issues.some((i) => i.message.includes('unknown detector "not-a-detector"'))).toBe(true);
    expect(issues.some((i) => i.message.includes("invalid regular expression"))).toBe(true);
  });

  it("rejects approve as a default action", () => {
    const issues = validatePolicy({ version: 1, defaults: { action: "approve" } });
    expect(issues.some((i) => i.path === "defaults.action")).toBe(true);
  });

  it("requires slack notifiers to name a webhook source", () => {
    const issues = validatePolicy({
      version: 1,
      approvals: { notify: [{ type: "slack" }] },
    });
    expect(issues.some((i) => i.message.includes("webhook_url"))).toBe(true);
  });
});

describe("parsePolicy", () => {
  it("parses YAML and validates in one step", () => {
    const doc = parsePolicy(
      ["version: 1", "rules:", "  - name: r", "    match: { tools: ['*'] }", "    action: deny"].join("\n"),
    );
    expect(doc.rules?.[0]?.name).toBe("r");
  });

  it("reports YAML syntax errors clearly", () => {
    expect(() => parsePolicy("version: [")).toThrow(/not valid YAML/);
  });

  it("reports validation problems with paths", () => {
    expect(() => parsePolicy("version: 3")).toThrow(/version/);
  });
});
