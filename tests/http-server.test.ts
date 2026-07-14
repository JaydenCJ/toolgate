import { afterEach, describe, expect, it } from "vitest";
import { McpHttpServer } from "../src/proxy/http-server.js";
import { ControlServer } from "../src/control/server.js";
import { makeGateway, type TestGateway } from "./helpers.js";

const demoPolicy = {
  version: 1,
  rules: [
    { name: "deny-deletes", match: { tools: ["delete_*"] }, action: "deny" },
    { name: "approve-payments", match: { tools: ["send_payment"] }, action: "approve" },
  ],
};

describe("McpHttpServer", () => {
  let server: McpHttpServer | undefined;
  let control: ControlServer | undefined;
  let t: TestGateway;

  afterEach(async () => {
    await server?.stop();
    await control?.stop();
    server = undefined;
    control = undefined;
  });

  async function startServers(): Promise<{ mcpUrl: string; controlUrl: string }> {
    t = makeGateway(demoPolicy);
    server = new McpHttpServer({ gateway: t.gateway, port: 0, log: () => {} });
    await server.start();
    control = new ControlServer({ approvals: t.approvals, engine: t.gateway.engine, port: 0, log: () => {} });
    await control.start();
    return { mcpUrl: `${server.url}/mcp`, controlUrl: control.url };
  }

  it("serves /health and a full initialize -> tools/call round trip", async () => {
    const { mcpUrl } = await startServers();

    const health = await fetch(`${server!.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const initReply = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "task-1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(initReply.status).toBe(200);
    const init = (await initReply.json()) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe("fake-downstream");

    const callReply = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "task-1" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_weather", arguments: { city: "Kyoto" } },
      }),
    });
    const call = (await callReply.json()) as { result: { content: { text: string }[] } };
    expect(call.result.content[0]?.text).toContain("ok:get_weather");
  });

  it("enforces the policy over HTTP and answers 202 for notifications", async () => {
    const { mcpUrl } = await startServers();

    const denied = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "delete_file", arguments: { path: "/x" } },
      }),
    });
    const deniedBody = (await denied.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(deniedBody.result.isError).toBe(true);
    expect(deniedBody.result.content[0]?.text).toContain("rule_deny");

    const notification = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notification.status).toBe(202);

    const badJson = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
  });

  it("runs the approval flow end to end through the control API", async () => {
    const { mcpUrl, controlUrl } = await startServers();

    const pendingCall = fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "task-2" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "send_payment", arguments: { to: "acme", amount_usd: 10 } },
      }),
    });

    // Wait until the approval shows up in the control API.
    let approvalId = "";
    for (let i = 0; i < 50 && !approvalId; i++) {
      const list = await fetch(`${controlUrl}/approvals`);
      const body = (await list.json()) as { approvals: { id: string }[] };
      approvalId = body.approvals[0]?.id ?? "";
      if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(approvalId).not.toBe("");

    const resolveReply = await fetch(`${controlUrl}/approvals/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-toolgate-actor": "alice" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(resolveReply.status).toBe(200);

    const reply = (await (await pendingCall).json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(reply.result.isError).toBeFalsy();
    expect(reply.result.content[0]?.text).toContain("ok:send_payment");

    // Unknown ids are a 404.
    const missing = await fetch(`${controlUrl}/approvals/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(missing.status).toBe(404);
  });

  it("guards the control API with a bearer token when configured", async () => {
    t = makeGateway(demoPolicy);
    control = new ControlServer({
      approvals: t.approvals,
      engine: t.gateway.engine,
      port: 0,
      token: "sekrit-token",
      log: () => {},
    });
    await control.start();

    const unauthorized = await fetch(`${control.url}/approvals`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${control.url}/approvals`, {
      headers: { authorization: "Bearer sekrit-token" },
    });
    expect(authorized.status).toBe(200);

    // /health stays open for liveness probes.
    const health = await fetch(`${control.url}/health`);
    expect(health.status).toBe(200);
  });

  it("reports session usage through the control API", async () => {
    const { mcpUrl, controlUrl } = await startServers();
    await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "task-3" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "get_weather", arguments: {} },
      }),
    });
    const usage = await fetch(`${controlUrl}/sessions/task-3/usage`);
    const body = (await usage.json()) as { usage: { calls_used: number } };
    expect(body.usage.calls_used).toBe(1);
  });
});
