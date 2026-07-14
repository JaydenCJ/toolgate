/**
 * Hand-written structural validation for policy documents.
 *
 * Produces precise, human-readable error paths (e.g. `rules[2].match.tools`)
 * instead of generic schema dumps, so a broken policy is quick to fix.
 */

import type { PolicyDocument } from "./types.js";
import { isKnownDetector, compileEgressPattern } from "./egress.js";

/** A single validation problem with a JSON-path-like location. */
export interface PolicyIssue {
  path: string;
  message: string;
}

const RULE_ACTIONS = ["allow", "deny", "approve"];
const TIMEOUT_ACTIONS = ["deny", "allow"];
const EGRESS_DIRECTIONS = ["request", "response"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkUnknownKeys(
  obj: Record<string, unknown>,
  allowed: string[],
  path: string,
  issues: PolicyIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      issues.push({ path: path ? `${path}.${key}` : key, message: `unknown key (allowed: ${allowed.join(", ")})` });
    }
  }
}

function checkPositiveNumber(v: unknown, path: string, issues: PolicyIssue[]): void {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    issues.push({ path, message: "must be a positive number" });
  }
}

function checkEgressPatterns(list: unknown, path: string, issues: PolicyIssue[]): void {
  if (!Array.isArray(list)) {
    issues.push({ path, message: "must be a list of detector names or regex:<pattern> entries" });
    return;
  }
  list.forEach((entry, i) => {
    if (typeof entry !== "string") {
      issues.push({ path: `${path}[${i}]`, message: "must be a string" });
      return;
    }
    if (entry.startsWith("regex:")) {
      try {
        compileEgressPattern(entry);
      } catch (err) {
        issues.push({ path: `${path}[${i}]`, message: `invalid regular expression: ${(err as Error).message}` });
      }
    } else if (!isKnownDetector(entry)) {
      issues.push({ path: `${path}[${i}]`, message: `unknown detector "${entry}"` });
    }
  });
}

/**
 * Validate an already-parsed policy document.
 * Returns an empty array when the document is valid.
 */
export function validatePolicy(doc: unknown): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  if (!isPlainObject(doc)) {
    return [{ path: "", message: "policy must be a mapping (YAML object) at the top level" }];
  }
  checkUnknownKeys(doc, ["version", "defaults", "budget", "costs", "rules", "approvals", "audit", "options"], "", issues);

  if (doc["version"] !== 1) {
    issues.push({ path: "version", message: "must be 1 (the only supported schema version)" });
  }

  if (doc["defaults"] !== undefined) {
    if (!isPlainObject(doc["defaults"])) {
      issues.push({ path: "defaults", message: "must be a mapping" });
    } else {
      checkUnknownKeys(doc["defaults"], ["action"], "defaults", issues);
      const action = doc["defaults"]["action"];
      if (action !== undefined && !RULE_ACTIONS.includes(action as string)) {
        issues.push({ path: "defaults.action", message: `must be one of ${RULE_ACTIONS.join(", ")}` });
      }
      if (action === "approve") {
        issues.push({ path: "defaults.action", message: "approve is not allowed as a default; use an explicit rule" });
      }
    }
  }

  if (doc["budget"] !== undefined) {
    if (!isPlainObject(doc["budget"])) {
      issues.push({ path: "budget", message: "must be a mapping" });
    } else {
      checkUnknownKeys(doc["budget"], ["max_calls", "max_cost"], "budget", issues);
      if (doc["budget"]["max_calls"] !== undefined) checkPositiveNumber(doc["budget"]["max_calls"], "budget.max_calls", issues);
      if (doc["budget"]["max_cost"] !== undefined) checkPositiveNumber(doc["budget"]["max_cost"], "budget.max_cost", issues);
    }
  }

  if (doc["costs"] !== undefined) {
    if (!isPlainObject(doc["costs"])) {
      issues.push({ path: "costs", message: "must be a mapping of tool glob to cost" });
    } else {
      for (const [key, value] of Object.entries(doc["costs"])) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          issues.push({ path: `costs.${key}`, message: "must be a non-negative number" });
        }
      }
    }
  }

  if (doc["rules"] !== undefined) {
    if (!Array.isArray(doc["rules"])) {
      issues.push({ path: "rules", message: "must be a list" });
    } else {
      const seenNames = new Set<string>();
      doc["rules"].forEach((rule, i) => validateRule(rule, i, seenNames, issues));
    }
  }

  if (doc["approvals"] !== undefined) {
    validateApprovals(doc["approvals"], issues);
  }

  if (doc["audit"] !== undefined) {
    validateAudit(doc["audit"], issues);
  }

  if (doc["options"] !== undefined) {
    if (!isPlainObject(doc["options"])) {
      issues.push({ path: "options", message: "must be a mapping" });
    } else {
      checkUnknownKeys(doc["options"], ["hide_denied_tools"], "options", issues);
      const hide = doc["options"]["hide_denied_tools"];
      if (hide !== undefined && typeof hide !== "boolean") {
        issues.push({ path: "options.hide_denied_tools", message: "must be a boolean" });
      }
    }
  }

  return issues;
}

function validateRule(rule: unknown, index: number, seenNames: Set<string>, issues: PolicyIssue[]): void {
  const path = `rules[${index}]`;
  if (!isPlainObject(rule)) {
    issues.push({ path, message: "must be a mapping" });
    return;
  }
  checkUnknownKeys(rule, ["name", "match", "action", "reason", "rate_limit", "egress", "approval"], path, issues);

  if (typeof rule["name"] !== "string" || rule["name"].length === 0) {
    issues.push({ path: `${path}.name`, message: "must be a non-empty string" });
  } else if (seenNames.has(rule["name"])) {
    issues.push({ path: `${path}.name`, message: `duplicate rule name "${rule["name"]}"` });
  } else {
    seenNames.add(rule["name"]);
  }

  if (!isPlainObject(rule["match"])) {
    issues.push({ path: `${path}.match`, message: "must be a mapping with a tools list" });
  } else {
    checkUnknownKeys(rule["match"], ["tools", "args"], `${path}.match`, issues);
    const tools = rule["match"]["tools"];
    if (!Array.isArray(tools) || tools.length === 0 || tools.some((t) => typeof t !== "string" || t.length === 0)) {
      issues.push({ path: `${path}.match.tools`, message: "must be a non-empty list of tool-name globs" });
    }
    const args = rule["match"]["args"];
    if (args !== undefined) {
      if (!isPlainObject(args)) {
        issues.push({ path: `${path}.match.args`, message: "must be a mapping of argument key to regex" });
      } else {
        for (const [key, value] of Object.entries(args)) {
          if (typeof value !== "string") {
            issues.push({ path: `${path}.match.args.${key}`, message: "must be a regex string" });
            continue;
          }
          try {
            new RegExp(value);
          } catch (err) {
            issues.push({ path: `${path}.match.args.${key}`, message: `invalid regular expression: ${(err as Error).message}` });
          }
        }
      }
    }
  }

  if (rule["action"] !== undefined && !RULE_ACTIONS.includes(rule["action"] as string)) {
    issues.push({ path: `${path}.action`, message: `must be one of ${RULE_ACTIONS.join(", ")}` });
  }
  const hasChecks = rule["rate_limit"] !== undefined || rule["egress"] !== undefined;
  if (rule["action"] === undefined && !hasChecks) {
    issues.push({ path, message: "rule has no effect: set an action, a rate_limit, or an egress block" });
  }

  if (rule["reason"] !== undefined && typeof rule["reason"] !== "string") {
    issues.push({ path: `${path}.reason`, message: "must be a string" });
  }

  if (rule["rate_limit"] !== undefined) {
    if (!isPlainObject(rule["rate_limit"])) {
      issues.push({ path: `${path}.rate_limit`, message: "must be a mapping with max_calls and per_seconds" });
    } else {
      checkUnknownKeys(rule["rate_limit"], ["max_calls", "per_seconds"], `${path}.rate_limit`, issues);
      checkPositiveNumber(rule["rate_limit"]["max_calls"], `${path}.rate_limit.max_calls`, issues);
      checkPositiveNumber(rule["rate_limit"]["per_seconds"], `${path}.rate_limit.per_seconds`, issues);
    }
  }

  if (rule["egress"] !== undefined) {
    const egress = rule["egress"];
    if (!isPlainObject(egress)) {
      issues.push({ path: `${path}.egress`, message: "must be a mapping" });
    } else {
      checkUnknownKeys(egress, ["scan", "deny", "redact"], `${path}.egress`, issues);
      if (egress["scan"] !== undefined) {
        const scan = egress["scan"];
        if (!Array.isArray(scan) || scan.some((d) => !EGRESS_DIRECTIONS.includes(d as string))) {
          issues.push({ path: `${path}.egress.scan`, message: `must be a list drawn from ${EGRESS_DIRECTIONS.join(", ")}` });
        }
      }
      if (egress["deny"] !== undefined) checkEgressPatterns(egress["deny"], `${path}.egress.deny`, issues);
      if (egress["redact"] !== undefined) checkEgressPatterns(egress["redact"], `${path}.egress.redact`, issues);
      if (egress["deny"] === undefined && egress["redact"] === undefined) {
        issues.push({ path: `${path}.egress`, message: "must define deny and/or redact patterns" });
      }
    }
  }

  if (rule["approval"] !== undefined) {
    if (rule["action"] !== "approve") {
      issues.push({ path: `${path}.approval`, message: "only valid when action is approve" });
    }
    if (!isPlainObject(rule["approval"])) {
      issues.push({ path: `${path}.approval`, message: "must be a mapping" });
    } else {
      checkUnknownKeys(rule["approval"], ["timeout_seconds", "on_timeout"], `${path}.approval`, issues);
      if (rule["approval"]["timeout_seconds"] !== undefined) {
        checkPositiveNumber(rule["approval"]["timeout_seconds"], `${path}.approval.timeout_seconds`, issues);
      }
      const onTimeout = rule["approval"]["on_timeout"];
      if (onTimeout !== undefined && !TIMEOUT_ACTIONS.includes(onTimeout as string)) {
        issues.push({ path: `${path}.approval.on_timeout`, message: `must be one of ${TIMEOUT_ACTIONS.join(", ")}` });
      }
    }
  }
}

function validateApprovals(approvals: unknown, issues: PolicyIssue[]): void {
  if (!isPlainObject(approvals)) {
    issues.push({ path: "approvals", message: "must be a mapping" });
    return;
  }
  checkUnknownKeys(approvals, ["timeout_seconds", "on_timeout", "notify"], "approvals", issues);
  if (approvals["timeout_seconds"] !== undefined) {
    checkPositiveNumber(approvals["timeout_seconds"], "approvals.timeout_seconds", issues);
  }
  if (approvals["on_timeout"] !== undefined && !TIMEOUT_ACTIONS.includes(approvals["on_timeout"] as string)) {
    issues.push({ path: "approvals.on_timeout", message: `must be one of ${TIMEOUT_ACTIONS.join(", ")}` });
  }
  if (approvals["notify"] !== undefined) {
    if (!Array.isArray(approvals["notify"])) {
      issues.push({ path: "approvals.notify", message: "must be a list of notifiers" });
      return;
    }
    approvals["notify"].forEach((n, i) => {
      const path = `approvals.notify[${i}]`;
      if (!isPlainObject(n)) {
        issues.push({ path, message: "must be a mapping with a type" });
        return;
      }
      if (n["type"] === "terminal") {
        checkUnknownKeys(n, ["type"], path, issues);
      } else if (n["type"] === "slack") {
        checkUnknownKeys(n, ["type", "webhook_url", "webhook_url_env"], path, issues);
        if (typeof n["webhook_url"] !== "string" && typeof n["webhook_url_env"] !== "string") {
          issues.push({ path, message: "slack notifier needs webhook_url or webhook_url_env" });
        }
      } else {
        issues.push({ path: `${path}.type`, message: "must be terminal or slack" });
      }
    });
  }
}

function validateAudit(audit: unknown, issues: PolicyIssue[]): void {
  if (!isPlainObject(audit)) {
    issues.push({ path: "audit", message: "must be a mapping" });
    return;
  }
  checkUnknownKeys(audit, ["sinks", "include_args"], "audit", issues);
  if (audit["include_args"] !== undefined && typeof audit["include_args"] !== "boolean") {
    issues.push({ path: "audit.include_args", message: "must be a boolean" });
  }
  if (audit["sinks"] !== undefined) {
    if (!Array.isArray(audit["sinks"])) {
      issues.push({ path: "audit.sinks", message: "must be a list of sinks" });
      return;
    }
    audit["sinks"].forEach((sink, i) => {
      const path = `audit.sinks[${i}]`;
      if (!isPlainObject(sink)) {
        issues.push({ path, message: "must be a mapping with a type" });
        return;
      }
      if (sink["type"] === "jsonl") {
        checkUnknownKeys(sink, ["type", "path"], path, issues);
        if (typeof sink["path"] !== "string" || sink["path"].length === 0) {
          issues.push({ path: `${path}.path`, message: "must be a non-empty file path" });
        }
      } else if (sink["type"] === "http") {
        checkUnknownKeys(sink, ["type", "url", "headers"], path, issues);
        if (typeof sink["url"] !== "string" || !/^https?:\/\//.test(sink["url"])) {
          issues.push({ path: `${path}.url`, message: "must be an http(s) URL" });
        }
        if (sink["headers"] !== undefined && !isPlainObject(sink["headers"])) {
          issues.push({ path: `${path}.headers`, message: "must be a mapping of header name to value" });
        }
      } else if (sink["type"] === "stderr") {
        checkUnknownKeys(sink, ["type"], path, issues);
      } else {
        issues.push({ path: `${path}.type`, message: "must be jsonl, http, or stderr" });
      }
    });
  }
}

/** Format issues into a printable, one-per-line report. */
export function formatIssues(issues: PolicyIssue[]): string {
  return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("\n");
}

/** Narrow an unknown document to {@link PolicyDocument} after validation. */
export function assertPolicy(doc: unknown): PolicyDocument {
  const issues = validatePolicy(doc);
  if (issues.length > 0) {
    throw new Error(`invalid policy:\n${formatIssues(issues)}`);
  }
  return doc as PolicyDocument;
}
