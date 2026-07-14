/**
 * Audit logger: fans events out to configured sinks.
 *
 * Sinks are best-effort and asynchronous; a failing sink never blocks or
 * breaks the gateway data path. `flush()` awaits all in-flight writes so
 * tests and shutdown paths can assert the full stream landed.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditSinkConfig } from "../policy/types.js";
import type { AuditEvent } from "./events.js";

/** A destination for audit events. */
export interface AuditSink {
  readonly name: string;
  write(event: AuditEvent): Promise<void>;
}

/** Appends one JSON object per line to a local file. */
export class JsonlSink implements AuditSink {
  readonly name = "jsonl";
  private readonly path: string;
  private dirReady = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  write(event: AuditEvent): Promise<void> {
    // Serialize appends so lines never interleave.
    this.chain = this.chain.then(async () => {
      if (!this.dirReady) {
        await mkdir(dirname(this.path), { recursive: true });
        this.dirReady = true;
      }
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    });
    return this.chain;
  }
}

/** POSTs each event as JSON to an HTTP collector (SIEM webhook). */
export class HttpSink implements AuditSink {
  readonly name = "http";
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  /** Count of failed deliveries, exposed for diagnostics. */
  failures = 0;

  constructor(url: string, headers: Record<string, string> = {}, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.headers = headers;
    this.fetchImpl = fetchImpl;
  }

  async write(event: AuditEvent): Promise<void> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify(event),
      });
      if (!response.ok) this.failures += 1;
    } catch {
      this.failures += 1;
    }
  }
}

/** Writes one JSON line per event to stderr (stdout carries MCP traffic). */
export class StderrSink implements AuditSink {
  readonly name = "stderr";
  private readonly write_: (line: string) => void;

  constructor(write?: (line: string) => void) {
    this.write_ = write ?? ((line) => process.stderr.write(`${line}\n`));
  }

  async write(event: AuditEvent): Promise<void> {
    this.write_(JSON.stringify(event));
  }
}

/** Build sinks from the policy `audit.sinks` configuration. */
export function sinksFromConfig(configs: AuditSinkConfig[], fetchImpl?: typeof fetch): AuditSink[] {
  return configs.map((config) => {
    switch (config.type) {
      case "jsonl":
        return new JsonlSink(config.path);
      case "http":
        return new HttpSink(config.url, config.headers ?? {}, fetchImpl);
      case "stderr":
        return new StderrSink();
    }
  });
}

/** Fan-out logger used by the gateway. */
export class AuditLogger {
  private readonly sinks: AuditSink[];
  private inFlight: Promise<void>[] = [];

  constructor(sinks: AuditSink[]) {
    this.sinks = sinks;
  }

  /** Emit an event to every sink without blocking the caller. */
  emit(event: AuditEvent): void {
    for (const sink of this.sinks) {
      const p = sink.write(event).catch(() => {
        // Sink failures are intentionally swallowed; see module doc.
      });
      this.inFlight.push(p);
    }
    // Keep the in-flight list from growing unbounded.
    if (this.inFlight.length > 256) {
      this.inFlight = [Promise.allSettled(this.inFlight).then(() => undefined)];
    }
  }

  /** Await all writes issued so far. */
  async flush(): Promise<void> {
    const pending = this.inFlight;
    this.inFlight = [];
    await Promise.allSettled(pending);
  }
}
