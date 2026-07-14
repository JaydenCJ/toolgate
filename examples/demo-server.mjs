#!/usr/bin/env node
/**
 * Demo downstream MCP server (stdio, newline-delimited JSON-RPC).
 *
 * A deliberately tiny stand-in for "a tool server your agent already uses",
 * used by the quickstart, the smoke test, and docker-compose. It exposes four
 * tools that exercise every toolgate policy feature:
 *
 *   get_weather          - harmless read-only call (allowed)
 *   search_docs          - noisy call (rate-limited by the example policy)
 *   send_payment         - dangerous call (requires human approval)
 *   read_customer_record - returns PII (response redaction) — the record for
 *                          id "cust_1001" is fixture data local to this demo
 *   delete_file          - destructive call (denied by the example policy)
 *
 * No external services are contacted; everything is deterministic.
 */

import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "get_weather",
    description: "Get current weather for a city (demo data).",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  {
    name: "search_docs",
    description: "Search internal documentation (demo data).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "send_payment",
    description: "Send a payment to a recipient (demo, no real money moves).",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        amount_usd: { type: "number" },
      },
      required: ["to", "amount_usd"],
    },
  },
  {
    name: "read_customer_record",
    description: "Read a customer record including contact details (demo data).",
    inputSchema: {
      type: "object",
      properties: { customer_id: { type: "string" } },
      required: ["customer_id"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file by path (demo, nothing is deleted).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

function textResult(text) {
  return { content: [{ type: "text", text }], isError: false };
}

function callTool(name, args) {
  switch (name) {
    case "get_weather":
      return textResult(`Weather in ${args.city}: 24C, clear skies, wind 8 km/h (demo data).`);
    case "search_docs":
      return textResult(`Found 3 documents matching "${args.query}" (demo data).`);
    case "send_payment":
      return textResult(`Payment of $${args.amount_usd} to ${args.to} submitted (demo, no real transfer).`);
    case "read_customer_record":
      return textResult(
        `Customer ${args.customer_id}: Taro Yamada, email taro.yamada@example.com, plan: enterprise.`,
      );
    case "delete_file":
      return textResult(`Deleted ${args.path} (demo, nothing was actually deleted).`);
    default:
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.method === undefined || msg.id === undefined) return; // Ignore notifications.

  const reply = (result) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
  const replyError = (code, message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } })}\n`);

  switch (msg.method) {
    case "initialize":
      reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "toolgate-demo-server", version: "0.1.0" },
      });
      break;
    case "tools/list":
      reply({ tools: TOOLS });
      break;
    case "tools/call": {
      const { name, arguments: args } = msg.params ?? {};
      if (typeof name !== "string") {
        replyError(-32602, "params.name must be a string");
        break;
      }
      reply(callTool(name, args ?? {}));
      break;
    }
    case "ping":
      reply({});
      break;
    default:
      replyError(-32601, `method not found: ${msg.method}`);
  }
});
