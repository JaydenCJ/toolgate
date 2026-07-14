import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { AuditLogger, HttpSink, JsonlSink, StderrSink } from "../src/audit/logger.js";
import { hashArgs, type AuditEvent } from "../src/audit/events.js";

function sampleEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    schema: "toolgate.audit.v1",
    ts: "2026-07-08T00:00:00.000Z",
    event: "tool_call",
    session_id: "s1",
    tool: "get_weather",
    decision: "allow",
    args_sha256: hashArgs({ city: "Tokyo" }),
    ...overrides,
  } as AuditEvent;
}

describe("JsonlSink", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSON object per line, creating parent directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "toolgate-audit-"));
    dirs.push(dir);
    const path = join(dir, "nested", "audit.jsonl");
    const sink = new JsonlSink(path);
    const logger = new AuditLogger([sink]);
    logger.emit(sampleEvent());
    logger.emit(sampleEvent({ tool: "search_docs" } as Partial<AuditEvent>));
    await logger.flush();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as { schema: string; tool: string });
    expect(parsed[0]?.schema).toBe("toolgate.audit.v1");
    expect(parsed[1]?.tool).toBe("search_docs");
  });
});

describe("HttpSink", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("POSTs each event as JSON to the collector", async () => {
    const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const sink = new HttpSink(`http://127.0.0.1:${port}/ingest`, { "x-api-key": "k" });
    const logger = new AuditLogger([sink]);
    logger.emit(sampleEvent());
    await logger.flush();

    expect(received).toHaveLength(1);
    expect(received[0]?.headers["x-api-key"]).toBe("k");
    const body = JSON.parse(received[0]!.body) as { event: string; tool: string };
    expect(body.event).toBe("tool_call");
    expect(body.tool).toBe("get_weather");
    expect(sink.failures).toBe(0);
  });

  it("counts failures without throwing", async () => {
    const sink = new HttpSink("http://127.0.0.1:1/unreachable");
    const logger = new AuditLogger([sink]);
    logger.emit(sampleEvent());
    await logger.flush();
    expect(sink.failures).toBe(1);
  });
});

describe("StderrSink", () => {
  it("writes one JSON line per event", async () => {
    const lines: string[] = [];
    const sink = new StderrSink((line) => lines.push(line));
    await sink.write(sampleEvent());
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { event: string }).event).toBe("tool_call");
  });
});

describe("hashArgs", () => {
  it("is deterministic and shape-sensitive", () => {
    expect(hashArgs({ a: 1 })).toBe(hashArgs({ a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(hashArgs(undefined)).toBe(hashArgs(undefined));
  });
});
