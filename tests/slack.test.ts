import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { SlackNotifier } from "../src/approval/slack.js";
import type { PendingApproval } from "../src/approval/manager.js";

function approval(): PendingApproval {
  return {
    id: "apr_123abc",
    tool: "send_payment",
    argsPreview: '{"to":"acme","amount_usd":120}',
    sessionId: "s1",
    rule: "approve-payments",
    reason: "payments need a human",
    createdAt: Date.now(),
    expiresAt: Date.now() + 120_000,
  };
}

describe("SlackNotifier", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("posts a Block Kit card with the approve/deny commands", async () => {
    const bodies: string[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString());
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const notifier = new SlackNotifier({
      webhookUrl: `http://127.0.0.1:${port}/webhook`,
      controlUrl: "http://127.0.0.1:9848",
    });
    await notifier.notify(approval());

    expect(bodies).toHaveLength(1);
    const payload = JSON.parse(bodies[0]!) as { text: string; blocks: { text: { text: string } }[] };
    expect(payload.text).toContain("send_payment");
    expect(payload.blocks[0]?.text.text).toContain("approve-payments");
    expect(payload.blocks[1]?.text.text).toContain("toolgate approve apr_123abc");
    expect(payload.blocks[1]?.text.text).toContain("toolgate deny apr_123abc");
  });

  it("throws on non-2xx webhook responses (manager swallows it)", async () => {
    server = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const notifier = new SlackNotifier({
      webhookUrl: `http://127.0.0.1:${port}/webhook`,
      controlUrl: "http://127.0.0.1:9848",
    });
    await expect(notifier.notify(approval())).rejects.toThrow(/HTTP 500/);
  });
});
