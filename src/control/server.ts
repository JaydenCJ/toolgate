/**
 * Control API: a small localhost HTTP server used by operators to inspect
 * and resolve pending approvals (`toolgate pending|approve|deny`).
 *
 * Binds 127.0.0.1 only. An optional bearer token (TOOLGATE_CONTROL_TOKEN)
 * hardens multi-user hosts; on a single-user machine loopback-only binding
 * is the default protection.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ApprovalManager } from "../approval/manager.js";
import type { PolicyEngine } from "../policy/engine.js";

export interface ControlServerOptions {
  approvals: ApprovalManager;
  engine: PolicyEngine;
  host?: string;
  /** TCP port; 0 selects an ephemeral port. */
  port: number;
  /** Optional bearer token required on every request. */
  token?: string;
  log?: (line: string) => void;
}

export class ControlServer {
  private readonly options: ControlServerOptions;
  private server: Server | undefined;
  /** Actual bound port (useful when `port: 0`). */
  boundPort = 0;

  constructor(options: ControlServerOptions) {
    this.options = options;
  }

  get url(): string {
    return `http://${this.options.host ?? "127.0.0.1"}:${this.boundPort}`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    const host = this.options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : this.options.port;
    (this.options.log ?? (() => {}))(`[toolgate] control api listening on ${this.url}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private authorized(req: IncomingMessage): boolean {
    const token = this.options.token;
    if (!token) return true;
    const header = req.headers.authorization ?? "";
    const expected = `Bearer ${token}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown): void => {
      const json = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(json);
    };

    if (url.pathname === "/health" && req.method === "GET") {
      send(200, { status: "ok" });
      return;
    }
    if (!this.authorized(req)) {
      send(401, { error: "missing or invalid bearer token" });
      return;
    }
    if (url.pathname === "/approvals" && req.method === "GET") {
      send(200, { approvals: this.options.approvals.list() });
      return;
    }
    const match = url.pathname.match(/^\/approvals\/([A-Za-z0-9_-]+)$/);
    if (match && req.method === "POST") {
      void this.readBody(req)
        .then((body) => {
          let decision: unknown;
          try {
            decision = (JSON.parse(body || "{}") as { decision?: unknown }).decision;
          } catch {
            send(400, { error: "body must be JSON" });
            return;
          }
          if (decision !== "approve" && decision !== "deny") {
            send(400, { error: 'body must be {"decision": "approve"} or {"decision": "deny"}' });
            return;
          }
          const resolvedBy = req.headers["x-toolgate-actor"];
          const ok = this.options.approvals.resolveById(
            match[1]!,
            decision,
            typeof resolvedBy === "string" ? resolvedBy : "control-api",
          );
          if (!ok) {
            send(404, { error: `no pending approval with id ${match[1]}` });
            return;
          }
          send(200, { id: match[1], decision });
        })
        .catch(() => send(500, { error: "failed to read request body" }));
      return;
    }
    if (url.pathname.match(/^\/sessions\/[^/]+\/usage$/) && req.method === "GET") {
      const sessionId = decodeURIComponent(url.pathname.split("/")[2]!);
      send(200, { session_id: sessionId, usage: this.options.engine.sessionUsage(sessionId) });
      return;
    }
    send(404, { error: "not found" });
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }
}
