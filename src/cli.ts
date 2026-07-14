#!/usr/bin/env node
/**
 * toolgate CLI.
 *
 * Exit codes:
 *   0  success (for `check`: the call is allowed)
 *   1  runtime error (bad policy file, downstream failure, ...)
 *   2  usage error (unknown command/flag)
 *   3  `check` verdict: denied
 *   4  `check` verdict: human approval required
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { loadPolicyFile } from "./policy/loader.js";
import { validatePolicy, formatIssues } from "./policy/validate.js";
import { PolicyEngine } from "./policy/engine.js";
import { createRuntime } from "./runtime.js";
import { attachStdio } from "./proxy/stdio-server.js";
import { McpHttpServer } from "./proxy/http-server.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const USAGE = `toolgate ${pkg.version} — policy-as-code authorization gateway for AI agent tool calls

Usage:
  toolgate run --policy <file> [options] -- <downstream command...>
  toolgate serve --policy <file> [--port 8848] [options] -- <downstream command...>
  toolgate check --policy <file> --tool <name> [--args <json>] [--session <id>]
  toolgate validate <policy-file>
  toolgate pending [--control-url <url>]
  toolgate approve <approval-id> [--control-url <url>]
  toolgate deny <approval-id> [--control-url <url>]
  toolgate init [<path>]

Commands:
  run        Proxy MCP over stdio: the client talks to toolgate, toolgate
             enforces the policy and forwards allowed calls downstream.
  serve      Same gateway exposed as a Streamable HTTP endpoint
             (POST /mcp, GET /health). Binds 127.0.0.1 by default.
  check      Evaluate one hypothetical tool call against a policy and print
             the decision (exit 0 allow / 3 deny / 4 approval required).
  validate   Validate a policy file and report every problem.
  pending    List tool calls waiting for human approval.
  approve    Approve a pending call by id.
  deny       Deny a pending call by id.
  init       Write a starter policy file (default: toolgate.yaml).

Common options:
  --policy <file>        Policy YAML file (required for run/serve/check).
  --audit-log <file>     Append audit events to this JSONL file
                         (in addition to policy-defined sinks).
  --downstream-url <url> Talk to a Streamable HTTP downstream instead of
                         spawning a stdio command.
  --session-id <id>      Session (task) id for budget accounting in run mode.
  --control-host <host>  Control API host (default 127.0.0.1).
  --control-port <port>  Control API port (default 9848; 0 = ephemeral).
  --control-url <url>    Control API base URL for pending/approve/deny
                         (default http://127.0.0.1:9848).
  --token <token>        Bearer token for the control API
                         (default: $TOOLGATE_CONTROL_TOKEN).
  --host <host>          serve: MCP endpoint host (default 127.0.0.1).
  --port <port>          serve: MCP endpoint port (default 8848).
  -h, --help             Show this help.
  -v, --version          Show the version.

Documentation: https://github.com/JaydenCJ/toolgate`;

function fail(message: string, code: number): never {
  process.stderr.write(`toolgate: ${message}\n`);
  process.exit(code);
}

function splitDashDash(argv: string[]): { own: string[]; rest: string[] } {
  const index = argv.indexOf("--");
  if (index === -1) return { own: argv, rest: [] };
  return { own: argv.slice(0, index), rest: argv.slice(index + 1) };
}

function parsePort(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`${flag} must be an integer between 0 and 65535`, 2);
  }
  return port;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(command ? 0 : 2);
  }
  if (command === "-v" || command === "--version" || command === "version") {
    process.stdout.write(`toolgate ${pkg.version}\n`);
    process.exit(0);
  }

  switch (command) {
    case "run":
      await commandRun(argv.slice(1), "stdio");
      return;
    case "serve":
      await commandRun(argv.slice(1), "http");
      return;
    case "check":
      commandCheck(argv.slice(1));
      return;
    case "validate":
      commandValidate(argv.slice(1));
      return;
    case "pending":
      await commandPending(argv.slice(1));
      return;
    case "approve":
    case "deny":
      await commandResolve(command, argv.slice(1));
      return;
    case "init":
      commandInit(argv.slice(1));
      return;
    default:
      fail(`unknown command "${command}" (see toolgate --help)`, 2);
  }
}

async function commandRun(argv: string[], mode: "stdio" | "http"): Promise<void> {
  const { own, rest } = splitDashDash(argv);
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: own,
      options: {
        "policy": { type: "string" },
        "audit-log": { type: "string" },
        "downstream-url": { type: "string" },
        "session-id": { type: "string" },
        "control-host": { type: "string" },
        "control-port": { type: "string" },
        "token": { type: "string" },
        "host": { type: "string" },
        "port": { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    fail((err as Error).message, 2);
  }

  const policyPath = values["policy"] as string | undefined;
  if (!policyPath) fail(`${mode === "stdio" ? "run" : "serve"} requires --policy <file>`, 2);
  let policy;
  try {
    policy = loadPolicyFile(policyPath);
  } catch (err) {
    fail((err as Error).message, 1);
  }

  const downstreamUrl = values["downstream-url"] as string | undefined;
  if (!downstreamUrl && rest.length === 0) {
    fail("no downstream given: append `-- <command...>` or use --downstream-url", 2);
  }

  const controlToken = (values["token"] as string | undefined) ?? process.env["TOOLGATE_CONTROL_TOKEN"];
  let runtime;
  try {
    runtime = createRuntime({
      policy,
      policyPath,
      mode,
      ...(downstreamUrl ? { downstreamUrl } : { downstreamCommand: rest }),
      ...(values["audit-log"] !== undefined ? { auditLogPath: values["audit-log"] as string } : {}),
      ...(values["control-host"] !== undefined ? { controlHost: values["control-host"] as string } : {}),
      controlPort: parsePort(values["control-port"] as string | undefined, "--control-port", 9848),
      ...(controlToken !== undefined ? { controlToken } : {}),
      ...(values["session-id"] !== undefined ? { sessionId: values["session-id"] as string } : {}),
    });
  } catch (err) {
    fail((err as Error).message, 1);
  }

  try {
    await runtime.start();
  } catch (err) {
    fail(`failed to start gateway: ${(err as Error).message}`, 1);
  }

  let httpServer: McpHttpServer | undefined;
  const shutdown = async (exitCode: number): Promise<never> => {
    try {
      await httpServer?.stop();
      await runtime.stop();
    } catch {
      // Best effort during shutdown.
    }
    process.exit(exitCode);
  };

  runtime.gateway.onClose((reason) => {
    process.stderr.write(`[toolgate] ${reason}\n`);
    void shutdown(1);
  });
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  if (mode === "stdio") {
    process.stderr.write(
      `[toolgate] gateway ready (policy: ${policyPath}, session: ${runtime.sessionId}, control: ${runtime.control.url})\n`,
    );
    attachStdio({ gateway: runtime.gateway, sessionId: runtime.sessionId });
    process.stdin.on("end", () => void shutdown(0));
  } else {
    httpServer = new McpHttpServer({
      gateway: runtime.gateway,
      host: (values["host"] as string | undefined) ?? "127.0.0.1",
      port: parsePort(values["port"] as string | undefined, "--port", 8848),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    try {
      await httpServer.start();
    } catch (err) {
      fail(`failed to start MCP endpoint: ${(err as Error).message}`, 1);
    }
    process.stderr.write(`[toolgate] gateway ready (policy: ${policyPath}, control: ${runtime.control.url})\n`);
  }
}

function commandCheck(argv: string[]): void {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "policy": { type: "string" },
        "tool": { type: "string" },
        "args": { type: "string" },
        "session": { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    fail((err as Error).message, 2);
  }
  const policyPath = values["policy"] as string | undefined;
  const tool = values["tool"] as string | undefined;
  if (!policyPath || !tool) fail("check requires --policy <file> and --tool <name>", 2);

  let args: unknown = {};
  if (values["args"] !== undefined) {
    try {
      args = JSON.parse(values["args"] as string);
    } catch (err) {
      fail(`--args must be valid JSON: ${(err as Error).message}`, 2);
    }
  }

  let policy;
  try {
    policy = loadPolicyFile(policyPath);
  } catch (err) {
    fail((err as Error).message, 1);
  }

  const engine = new PolicyEngine(policy);
  const decision = engine.evaluateCall({
    tool,
    args,
    sessionId: (values["session"] as string | undefined) ?? "check",
  });
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  if (decision.kind === "deny") process.exit(3);
  if (decision.kind === "approve") process.exit(4);
  process.exit(0);
}

function commandValidate(argv: string[]): void {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { "policy": { type: "string" } },
      allowPositionals: true,
    }));
  } catch (err) {
    fail((err as Error).message, 2);
  }
  const path = (values["policy"] as string | undefined) ?? positionals[0];
  if (!path) fail("validate requires a policy file argument", 2);

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    fail(`cannot read ${path}: ${(err as Error).message}`, 1);
  }
  let doc: unknown;
  try {
    const { parse } = require("yaml") as typeof import("yaml");
    doc = parse(source);
  } catch (err) {
    fail(`${path} is not valid YAML: ${(err as Error).message}`, 1);
  }
  const issues = validatePolicy(doc);
  if (issues.length > 0) {
    process.stderr.write(`${path}: ${issues.length} problem(s)\n${formatIssues(issues)}\n`);
    process.exit(1);
  }
  const ruleCount = ((doc as { rules?: unknown[] })?.rules ?? []).length;
  process.stdout.write(`${path}: OK (version 1, ${ruleCount} rule(s))\n`);
  process.exit(0);
}

interface ControlFlags {
  controlUrl: string;
  token?: string;
}

function parseControlFlags(argv: string[], allowPositional: boolean): { flags: ControlFlags; positionals: string[] } {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        "control-url": { type: "string" },
        "token": { type: "string" },
      },
      allowPositionals: allowPositional,
    }));
  } catch (err) {
    fail((err as Error).message, 2);
  }
  const controlUrl =
    (values["control-url"] as string | undefined) ??
    process.env["TOOLGATE_CONTROL_URL"] ??
    "http://127.0.0.1:9848";
  const token = (values["token"] as string | undefined) ?? process.env["TOOLGATE_CONTROL_TOKEN"];
  return { flags: { controlUrl: controlUrl.replace(/\/$/, ""), ...(token !== undefined ? { token } : {}) }, positionals };
}

function controlHeaders(flags: ControlFlags): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (flags.token) headers["authorization"] = `Bearer ${flags.token}`;
  return headers;
}

async function commandPending(argv: string[]): Promise<void> {
  const { flags } = parseControlFlags(argv, false);
  let response: Response;
  try {
    response = await fetch(`${flags.controlUrl}/approvals`, { headers: controlHeaders(flags) });
  } catch {
    fail(`cannot reach control API at ${flags.controlUrl} — is a gateway running?`, 1);
  }
  if (!response.ok) fail(`control API returned HTTP ${response.status}`, 1);
  const body = (await response.json()) as { approvals: { id: string; tool: string; argsPreview: string; expiresAt: number }[] };
  if (body.approvals.length === 0) {
    process.stdout.write("no pending approvals\n");
    return;
  }
  for (const approval of body.approvals) {
    const expiresIn = Math.max(0, Math.round((approval.expiresAt - Date.now()) / 1000));
    process.stdout.write(`${approval.id}  ${approval.tool}  expires in ${expiresIn}s  args ${approval.argsPreview}\n`);
  }
}

async function commandResolve(decision: "approve" | "deny", argv: string[]): Promise<void> {
  const { flags, positionals } = parseControlFlags(argv, true);
  const id = positionals[0];
  if (!id) fail(`${decision} requires an approval id (see: toolgate pending)`, 2);
  let response: Response;
  try {
    response = await fetch(`${flags.controlUrl}/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: controlHeaders(flags),
      body: JSON.stringify({ decision }),
    });
  } catch {
    fail(`cannot reach control API at ${flags.controlUrl} — is a gateway running?`, 1);
  }
  if (response.status === 404) fail(`no pending approval with id ${id} (it may have expired)`, 1);
  if (!response.ok) fail(`control API returned HTTP ${response.status}`, 1);
  process.stdout.write(`${id}: ${decision === "approve" ? "approved" : "denied"}\n`);
}

const STARTER_POLICY = `# toolgate policy — every MCP tools/call is evaluated against this file.
# Reference: https://github.com/JaydenCJ/toolgate#policy-reference
version: 1

defaults:
  action: allow          # allow | deny — applied when no rule matches

# Per-task budget circuit breaker (one MCP session = one task).
budget:
  max_calls: 200
  max_cost: 5.0

# Cost units per call, matched by tool-name glob. "default" is the fallback.
costs:
  default: 0.01

rules:
  # Sensitive data never leaves via tool arguments.
  - name: block-secret-egress
    match: { tools: ["*"] }
    egress:
      scan: [request]
      deny: [aws-access-key, private-key, api-key, github-token]

  # Destructive tools require a human decision.
  - name: approve-destructive
    match: { tools: ["delete_*", "drop_*", "*payment*", "transfer_*"] }
    action: approve
    approval:
      timeout_seconds: 300
      on_timeout: deny

  # Keep noisy tools under control.
  - name: rate-limit-search
    match: { tools: ["*search*"] }
    rate_limit: { max_calls: 30, per_seconds: 60 }

approvals:
  notify:
    - type: terminal
    # - type: slack
    #   webhook_url_env: TOOLGATE_SLACK_WEBHOOK_URL

audit:
  sinks:
    - type: jsonl
      path: ./toolgate-audit.jsonl
    # - type: http
    #   url: https://siem.example.com/ingest
`;

function commandInit(argv: string[]): void {
  let positionals: string[];
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ positionals, values } = parseArgs({
      args: argv,
      options: { "force": { type: "boolean" } },
      allowPositionals: true,
    }));
  } catch (err) {
    fail((err as Error).message, 2);
  }
  const path = positionals[0] ?? "toolgate.yaml";
  if (existsSync(path) && values["force"] !== true) {
    fail(`${path} already exists (use --force to overwrite)`, 1);
  }
  writeFileSync(path, STARTER_POLICY, "utf8");
  process.stdout.write(`wrote ${path}\n`);
}

main().catch((err: Error) => {
  process.stderr.write(`toolgate: ${err.message}\n`);
  process.exit(1);
});
