#!/usr/bin/env node
/**
 * Smoke client: drives a real `toolgate run` process over stdio exactly like
 * an MCP client would, and asserts every policy feature end to end:
 *
 *   initialize -> tools/list -> tools/call (allow / deny / rate limit /
 *   request egress / response redaction / human approval via control API)
 *
 * plus the audit JSONL written by the gateway. Exits non-zero on the first
 * failed assertion. Usage: node scripts/smoke-client.mjs <audit-jsonl-path>
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const auditPath = process.argv[2];
if (!auditPath) {
  console.error("usage: node scripts/smoke-client.mjs <audit-jsonl-path>");
  process.exit(2);
}

function assert(condition, label) {
  if (!condition) {
    console.error(`ASSERTION FAILED: ${label}`);
    process.exit(1);
  }
  console.log(`  ok: ${label}`);
}

const child = spawn(
  process.execPath,
  [
    "dist/cli.js",
    "run",
    "--policy",
    "examples/policy.yaml",
    "--audit-log",
    auditPath,
    "--control-port",
    "0",
    "--session-id",
    "smoke-session",
    "--",
    process.execPath,
    "examples/demo-server.mjs",
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);

const overall = setTimeout(() => {
  console.error("smoke client timed out after 60s");
  child.kill("SIGKILL");
  process.exit(1);
}, 60_000);
overall.unref();

// --- capture the ephemeral control API URL from stderr ---
let stderrBuf = "";
let controlUrl = "";
child.stderr.on("data", (chunk) => {
  stderrBuf += chunk.toString();
  const match = stderrBuf.match(/control api listening on (http:\/\/127\.0\.0\.1:\d+)/);
  if (match) controlUrl = match[1];
});

// --- minimal JSON-RPC client over the child's stdio ---
let nextId = 1;
const pendingReplies = new Map();
let stdoutBuf = "";
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let index = stdoutBuf.indexOf("\n");
  while (index >= 0) {
    const line = stdoutBuf.slice(0, index).trim();
    stdoutBuf = stdoutBuf.slice(index + 1);
    if (line.length > 0) {
      const msg = JSON.parse(line);
      const resolve = pendingReplies.get(msg.id);
      if (resolve) {
        pendingReplies.delete(msg.id);
        resolve(msg);
      }
    }
    index = stdoutBuf.indexOf("\n");
  }
});

function request(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve) => pendingReplies.set(id, resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return promise;
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function text(reply) {
  return reply.result?.content?.[0]?.text ?? "";
}

async function waitForControlUrl() {
  for (let i = 0; i < 200 && !controlUrl; i++) await sleep(25);
  assert(controlUrl !== "", "control API announced its URL on stderr");
}

async function main() {
  await waitForControlUrl();

  // 1. initialize round trip.
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-client", version: "0.0.0" },
  });
  assert(init.result?.serverInfo?.name === "toolgate-demo-server", "initialize reaches the downstream server");
  notify("notifications/initialized");

  // 2. tools/list passes through.
  const list = await request("tools/list", {});
  const names = (list.result?.tools ?? []).map((tool) => tool.name);
  assert(names.includes("get_weather") && names.includes("send_payment"), "tools/list returns downstream tools");

  // 3. Allowed call goes end to end.
  const weather = await request("tools/call", { name: "get_weather", arguments: { city: "Tokyo" } });
  assert(text(weather).includes("Weather in Tokyo"), "allowed call returns the downstream result");

  // 4. Denied call is answered by the gateway, not the server.
  const deleted = await request("tools/call", { name: "delete_file", arguments: { path: "/etc/passwd" } });
  assert(deleted.result?.isError === true, "denied call is flagged isError");
  assert(text(deleted).includes("deny-deletes"), "denial names the policy rule");

  // 5. Request egress: an AWS key in the arguments is blocked.
  const leaked = await request("tools/call", {
    name: "search_docs",
    arguments: { query: "creds AKIAIOSFODNN7EXAMPLE" },
  });
  assert(text(leaked).includes("egress_blocked"), "secret in arguments is blocked before egress");

  // 6. Rate limit: search_docs allows 3 calls per 60s.
  for (let i = 0; i < 3; i++) {
    const okSearch = await request("tools/call", { name: "search_docs", arguments: { query: `q${i}` } });
    assert(!okSearch.result?.isError, `search call ${i + 1}/3 within the rate limit`);
  }
  const limited = await request("tools/call", { name: "search_docs", arguments: { query: "q4" } });
  assert(text(limited).includes("rate_limited"), "4th search call inside the window is rate limited");

  // 7. Response redaction: customer email is masked before the agent sees it.
  const record = await request("tools/call", {
    name: "read_customer_record",
    arguments: { customer_id: "cust_1001" },
  });
  assert(text(record).includes("[REDACTED:email]"), "response PII is redacted");
  assert(!text(record).includes("taro.yamada@example.com"), "raw email never reaches the client");

  // 8. Human approval through the control API.
  const paymentPromise = request("tools/call", {
    name: "send_payment",
    arguments: { to: "acme-corp", amount_usd: 120 },
  });
  let approvalId = "";
  for (let i = 0; i < 100 && !approvalId; i++) {
    const response = await fetch(`${controlUrl}/approvals`);
    const body = await response.json();
    approvalId = body.approvals?.[0]?.id ?? "";
    if (!approvalId) await sleep(25);
  }
  assert(approvalId !== "", "payment call shows up as a pending approval");
  const resolveResponse = await fetch(`${controlUrl}/approvals/${approvalId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-toolgate-actor": "smoke" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert(resolveResponse.status === 200, "control API accepts the approve decision");
  const payment = await paymentPromise;
  assert(text(payment).includes("Payment of $120"), "approved call is forwarded downstream");

  // 9. Audit trail: structured events for everything above.
  await sleep(200); // Give async sinks a moment to flush.
  const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert(lines.every((event) => event.schema === "toolgate.audit.v1"), "every audit line carries the schema id");
  const eventTypes = new Set(lines.map((event) => event.event));
  for (const expected of ["gateway_started", "tool_call", "approval_requested", "approval_resolved", "response_egress"]) {
    assert(eventTypes.has(expected), `audit log contains a ${expected} event`);
  }
  const denials = lines.filter((event) => event.event === "tool_call" && event.decision === "deny");
  assert(denials.some((event) => event.deny_code === "rule_deny"), "audit records the rule denial");
  assert(denials.some((event) => event.deny_code === "rate_limited"), "audit records the rate limit denial");
  assert(denials.some((event) => event.deny_code === "egress_blocked"), "audit records the egress denial");
  assert(
    lines.some((event) => event.event === "approval_resolved" && event.outcome === "approved"),
    "audit records the human approval",
  );
  assert(
    lines.filter((event) => event.event === "tool_call").every((event) => /^[0-9a-f]{64}$/.test(event.args_sha256)),
    "tool_call events hash arguments instead of logging them",
  );

  console.log("smoke-client: all assertions passed");
  child.kill("SIGTERM");
  clearTimeout(overall);
  process.exit(0);
}

main().catch((err) => {
  console.error(`smoke client failed: ${err.stack ?? err}`);
  child.kill("SIGKILL");
  process.exit(1);
});
