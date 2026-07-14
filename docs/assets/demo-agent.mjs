#!/usr/bin/env node
/**
 * Scripted "agent" that drives the demo recording (docs/assets/demo.tape).
 *
 * It plays the MCP client side on stdout: initialize handshake, then a
 * send_payment call that the example policy parks for human approval. The
 * process then keeps the pipe open long enough for a human to deny the call
 * from another terminal before exiting. No network, no external services.
 */

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

write({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "demo-agent", version: "0.1.0" },
  },
});
await sleep(500);
write({ jsonrpc: "2.0", method: "notifications/initialized" });
await sleep(1500);
write({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "send_payment", arguments: { to: "acme-corp", amount_usd: 120 } },
});
// Keep the gateway's stdin open while the human decides, then let it shut down.
await sleep(25000);
