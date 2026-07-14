/**
 * Runtime assembly: build a fully wired gateway (engine + approvals +
 * notifiers + audit sinks + control API + downstream) from a policy document
 * and CLI options. Shared by `toolgate run` and `toolgate serve`.
 */

import { randomBytes } from "node:crypto";
import type { PolicyDocument } from "./policy/types.js";
import { ApprovalManager, type ApprovalNotifier } from "./approval/manager.js";
import { TerminalNotifier } from "./approval/terminal.js";
import { SlackNotifier } from "./approval/slack.js";
import { AuditLogger, JsonlSink, sinksFromConfig, type AuditSink } from "./audit/logger.js";
import { nowIso } from "./audit/events.js";
import { Gateway } from "./proxy/gateway.js";
import { HttpDownstream, StdioDownstream, type Downstream } from "./proxy/downstream.js";
import { ControlServer } from "./control/server.js";

export interface RuntimeOptions {
  policy: PolicyDocument;
  policyPath?: string;
  mode: "stdio" | "http";
  /** Downstream stdio command (argv), mutually exclusive with downstreamUrl. */
  downstreamCommand?: string[];
  /** Downstream Streamable HTTP URL. */
  downstreamUrl?: string;
  /** Extra audit JSONL path from --audit-log (added to policy sinks). */
  auditLogPath?: string;
  controlHost?: string;
  controlPort?: number;
  controlToken?: string;
  sessionId?: string;
  log?: (line: string) => void;
}

export interface Runtime {
  gateway: Gateway;
  downstream: Downstream;
  control: ControlServer;
  audit: AuditLogger;
  approvals: ApprovalManager;
  sessionId: string;
  /** Start downstream + control API and emit the start event. */
  start(): Promise<void>;
  /** Stop everything and flush audit sinks. */
  stop(): Promise<void>;
}

/** Generate a short random session id for stdio mode. */
export function newSessionId(): string {
  return `sess_${randomBytes(4).toString("hex")}`;
}

/** Resolve the Slack webhook URL from a notifier config. */
function slackWebhookUrl(config: { webhook_url?: string; webhook_url_env?: string }): string | undefined {
  if (config.webhook_url) return config.webhook_url;
  if (config.webhook_url_env) return process.env[config.webhook_url_env];
  return process.env["TOOLGATE_SLACK_WEBHOOK_URL"];
}

/** Build the full gateway runtime. */
export function createRuntime(options: RuntimeOptions): Runtime {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  let downstream: Downstream;
  if (options.downstreamUrl) {
    downstream = new HttpDownstream(options.downstreamUrl);
  } else if (options.downstreamCommand && options.downstreamCommand.length > 0) {
    downstream = new StdioDownstream(options.downstreamCommand[0]!, options.downstreamCommand.slice(1));
  } else {
    throw new Error("a downstream is required: pass `-- <command...>` or --downstream-url");
  }

  const sinks: AuditSink[] = sinksFromConfig(options.policy.audit?.sinks ?? []);
  if (options.auditLogPath) sinks.push(new JsonlSink(options.auditLogPath));
  const audit = new AuditLogger(sinks);

  // The control server URL is needed by notifiers before start(); build the
  // pieces in dependency order and wire the URL lazily via a getter closure.
  const notifiers: ApprovalNotifier[] = [];
  const approvals = new ApprovalManager(notifiers);

  const gateway = new Gateway({
    policy: options.policy,
    downstream,
    audit,
    approvals,
    mode: options.mode,
    log,
  });

  const control = new ControlServer({
    approvals,
    engine: gateway.engine,
    host: options.controlHost ?? "127.0.0.1",
    port: options.controlPort ?? 9848,
    ...(options.controlToken !== undefined ? { token: options.controlToken } : {}),
    log,
  });

  const sessionId = options.sessionId ?? newSessionId();

  const start = async (): Promise<void> => {
    await downstream.start();
    await control.start();
    // Notifiers need the final control URL (port may have been ephemeral).
    const notifierConfigs = options.policy.approvals?.notify ?? [{ type: "terminal" as const }];
    for (const config of notifierConfigs) {
      if (config.type === "terminal") {
        notifiers.push(new TerminalNotifier(control.url));
      } else {
        const webhookUrl = slackWebhookUrl(config);
        if (webhookUrl) {
          notifiers.push(new SlackNotifier({ webhookUrl, controlUrl: control.url }));
        } else {
          log("[toolgate] slack notifier configured but no webhook URL found; skipping");
        }
      }
    }
    audit.emit({
      schema: "toolgate.audit.v1",
      ts: nowIso(),
      event: "gateway_started",
      mode: options.mode,
      ...(options.policyPath !== undefined ? { policy_path: options.policyPath } : {}),
    });
  };

  const stop = async (): Promise<void> => {
    approvals.denyAll("gateway shutdown");
    audit.emit({
      schema: "toolgate.audit.v1",
      ts: nowIso(),
      event: "gateway_stopped",
      mode: options.mode,
    });
    await control.stop();
    await downstream.stop();
    await audit.flush();
  };

  return { gateway, downstream, control, audit, approvals, sessionId, start, stop };
}
