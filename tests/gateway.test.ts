import { describe, expect, it } from "vitest";
import { makeGateway, resultIsError, resultText, toolCall } from "./helpers.js";
import type { ToolCallEvent } from "../src/audit/events.js";
import type { JsonRpcRequest, JsonRpcSuccess } from "../src/proxy/jsonrpc.js";

const demoPolicy = {
  version: 1,
  budget: { max_calls: 10, max_cost: 1.0 },
  costs: { send_payment: 0.5, default: 0.01 },
  rules: [
    {
      name: "block-secret-egress",
      match: { tools: ["*"] },
      egress: { scan: ["request"], deny: ["aws-access-key"], redact: ["email"] },
    },
    { name: "deny-deletes", match: { tools: ["delete_*"] }, action: "deny", reason: "no deletes" },
    {
      name: "approve-payments",
      match: { tools: ["send_payment"] },
      action: "approve",
      approval: { timeout_seconds: 60, on_timeout: "deny" },
    },
    {
      name: "redact-response-pii",
      match: { tools: ["read_customer_record"] },
      egress: { scan: ["response"], redact: ["email"] },
    },
  ],
};

describe("Gateway passthrough", () => {
  it("forwards initialize untouched and restores the client id", async () => {
    const t = makeGateway(demoPolicy);
    const reply = await t.call({ jsonrpc: "2.0", id: "init-1", method: "initialize", params: {} });
    expect(reply).toMatchObject({ id: "init-1" });
    expect((reply as JsonRpcSuccess).result).toMatchObject({ serverInfo: { name: "fake-downstream" } });
    // The downstream saw a remapped internal id, not the client's.
    expect((t.downstream.sent[0] as JsonRpcRequest).id).not.toBe("init-1");
  });

  it("forwards notifications without expecting replies", () => {
    const t = makeGateway(demoPolicy);
    t.gateway.handleClientMessage(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      "s1",
      () => {
        throw new Error("notifications must not produce replies");
      },
    );
    expect(t.downstream.sent).toHaveLength(1);
  });

  it("relays downstream-initiated messages to the client channel", () => {
    const t = makeGateway(demoPolicy);
    const broadcast: unknown[] = [];
    t.gateway.setClientBroadcast((msg) => broadcast.push(msg));
    t.downstream.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect(broadcast).toHaveLength(1);
  });
});

describe("Gateway tools/call enforcement", () => {
  it("allows harmless calls end to end", async () => {
    const t = makeGateway(demoPolicy);
    const reply = await t.call(toolCall(1, "get_weather", { city: "Tokyo" }));
    expect(resultIsError(reply)).toBe(false);
    expect(resultText(reply)).toContain("ok:get_weather");
    await t.audit.flush();
    const event = t.sink.events.find((e) => e.event === "tool_call") as ToolCallEvent;
    expect(event).toMatchObject({ tool: "get_weather", decision: "allow" });
    expect(event.args_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(event.args).toBeUndefined(); // include_args defaults to false
  });

  it("answers denied calls locally as isError tool results", async () => {
    const t = makeGateway(demoPolicy);
    const reply = await t.call(toolCall(2, "delete_file", { path: "/etc/passwd" }));
    expect(resultIsError(reply)).toBe(true);
    expect(resultText(reply)).toContain("rule_deny");
    expect(resultText(reply)).toContain("no deletes");
    // Nothing was forwarded downstream.
    expect(t.downstream.sent).toHaveLength(0);
    await t.audit.flush();
    const event = t.sink.events.find((e) => e.event === "tool_call") as ToolCallEvent;
    expect(event).toMatchObject({ decision: "deny", deny_code: "rule_deny", rule: "deny-deletes" });
  });

  it("blocks secret egress in arguments before anything leaves", async () => {
    const t = makeGateway(demoPolicy);
    const reply = await t.call(toolCall(3, "get_weather", { note: "AKIAIOSFODNN7EXAMPLE" }));
    expect(resultIsError(reply)).toBe(true);
    expect(resultText(reply)).toContain("egress_blocked");
    expect(t.downstream.sent).toHaveLength(0);
  });

  it("forwards redacted arguments, never the originals", async () => {
    const t = makeGateway(demoPolicy);
    const reply = await t.call(toolCall(4, "get_weather", { contact: "jane@corp.example" }));
    expect(resultIsError(reply)).toBe(false);
    const forwarded = t.downstream.sent[0] as JsonRpcRequest;
    const args = (forwarded.params as { arguments: Record<string, string> }).arguments;
    expect(args["contact"]).toBe("[REDACTED:email]");
  });

  it("rejects tools/call without a string name via JSON-RPC error", async () => {
    const t = makeGateway(demoPolicy);
    const reply = await t.call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} });
    expect(reply).toMatchObject({ error: { code: -32602 } });
  });

  it("trips the budget circuit breaker and reports it", async () => {
    const t = makeGateway({ version: 1, budget: { max_calls: 2 } });
    await t.call(toolCall(1, "a"));
    await t.call(toolCall(2, "a"));
    const third = await t.call(toolCall(3, "a"));
    expect(resultText(third)).toContain("budget_exceeded");
    const fourth = await t.call(toolCall(4, "a"));
    expect(resultText(fourth)).toContain("circuit_open");
    await t.audit.flush();
    const decisions = t.sink.events
      .filter((e): e is ToolCallEvent => e.event === "tool_call")
      .map((e) => e.decision);
    expect(decisions).toEqual(["allow", "allow", "deny", "deny"]);
  });
});

describe("Gateway approvals", () => {
  it("holds the call until a human approves, then forwards it", async () => {
    const t = makeGateway(demoPolicy);
    const pendingReply = t.call(toolCall(6, "send_payment", { to: "acme", amount_usd: 42 }));
    // The call is parked, nothing forwarded yet.
    expect(t.downstream.sent).toHaveLength(0);
    const pending = t.approvals.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ tool: "send_payment", rule: "approve-payments" });

    t.approvals.resolveById(pending[0]!.id, "approve", "alice");
    const reply = await pendingReply;
    expect(resultIsError(reply)).toBe(false);
    expect(resultText(reply)).toContain("ok:send_payment");

    await t.audit.flush();
    const kinds = t.sink.events.map((e) => e.event);
    expect(kinds).toContain("approval_requested");
    expect(kinds).toContain("approval_resolved");
    const resolved = t.sink.events.find((e) => e.event === "approval_resolved");
    expect(resolved).toMatchObject({ outcome: "approved", resolved_by: "alice" });
  });

  it("denies the call when the human says no", async () => {
    const t = makeGateway(demoPolicy);
    const pendingReply = t.call(toolCall(7, "send_payment", { to: "acme", amount_usd: 42 }));
    const pending = t.approvals.list();
    t.approvals.resolveById(pending[0]!.id, "deny", "bob");
    const reply = await pendingReply;
    expect(resultIsError(reply)).toBe(true);
    expect(resultText(reply)).toContain("denied by human reviewer");
    expect(t.downstream.sent).toHaveLength(0);
  });
});

describe("Gateway response egress", () => {
  it("redacts PII in tool results before the agent sees them", async () => {
    const t = makeGateway(demoPolicy);
    t.downstream.respondWith = () => ({
      content: [{ type: "text", text: "Customer: Taro Yamada, email taro@example.co.jp" }],
      isError: false,
    });
    const reply = await t.call(toolCall(8, "read_customer_record", { customer_id: "c1" }));
    expect(resultText(reply)).toContain("[REDACTED:email]");
    expect(resultText(reply)).not.toContain("taro@example.co.jp");
    await t.audit.flush();
    const egress = t.sink.events.find((e) => e.event === "response_egress");
    expect(egress).toMatchObject({ action: "redact", tool: "read_customer_record" });
  });

  it("blocks responses matching deny patterns", async () => {
    const t = makeGateway({
      version: 1,
      rules: [
        {
          name: "no-keys-in",
          match: { tools: ["*"] },
          egress: { scan: ["response"], deny: ["private-key"] },
        },
      ],
    });
    t.downstream.respondWith = () => ({
      content: [{ type: "text", text: "-----BEGIN RSA PRIVATE KEY----- stuff" }],
      isError: false,
    });
    const reply = await t.call(toolCall(9, "read_file", { path: "id_rsa" }));
    expect(resultIsError(reply)).toBe(true);
    expect(resultText(reply)).toContain("egress_blocked");
    expect(resultText(reply)).not.toContain("BEGIN RSA");
  });

  it("redacts structuredContent as well", async () => {
    const t = makeGateway(demoPolicy);
    t.downstream.respondWith = () => ({
      content: [],
      structuredContent: { email: "taro@example.co.jp" },
      isError: false,
    });
    const reply = await t.call(toolCall(10, "read_customer_record", {}));
    const structured = ((reply as JsonRpcSuccess).result as { structuredContent: { email: string } })
      .structuredContent;
    expect(structured.email).toBe("[REDACTED:email]");
  });
});

describe("Gateway tools/list filtering", () => {
  it("hides statically denied tools when the option is on", async () => {
    const t = makeGateway({
      version: 1,
      options: { hide_denied_tools: true },
      rules: [{ name: "deny-deletes", match: { tools: ["delete_*"] }, action: "deny" }],
    });
    const reply = await t.call({ jsonrpc: "2.0", id: 11, method: "tools/list" });
    const tools = ((reply as JsonRpcSuccess).result as { tools: { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["get_weather"]);
  });

  it("keeps the full list when the option is off", async () => {
    const t = makeGateway(demoPolicy);
    const reply = await t.call({ jsonrpc: "2.0", id: 12, method: "tools/list" });
    const tools = ((reply as JsonRpcSuccess).result as { tools: { name: string }[] }).tools;
    expect(tools).toHaveLength(2);
  });
});

describe("Gateway downstream failure", () => {
  it("fails pending requests and denies pending approvals on close", async () => {
    const t = makeGateway(demoPolicy);
    t.downstream.autoRespond = false;
    const pendingForward = t.call(toolCall(13, "get_weather", { city: "Osaka" }));
    const pendingApproval = t.call(toolCall(14, "send_payment", { to: "x", amount_usd: 1 }));
    t.downstream.close("crashed");
    const forwardReply = await pendingForward;
    expect(forwardReply).toMatchObject({ error: { code: -32603 } });
    const approvalReply = await pendingApproval;
    expect(resultIsError(approvalReply)).toBe(true);
  });
});
