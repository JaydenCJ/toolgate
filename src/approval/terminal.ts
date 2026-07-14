/**
 * Terminal approval channel: prints an actionable card to stderr.
 *
 * stderr is used because stdout carries MCP protocol traffic in stdio proxy
 * mode. The operator resolves the request from any other terminal with
 * `toolgate approve <id>` / `toolgate deny <id>` (backed by the control API).
 */

import type { ApprovalNotifier, ApprovalResult, PendingApproval } from "./manager.js";

export class TerminalNotifier implements ApprovalNotifier {
  readonly name = "terminal";
  private readonly write: (line: string) => void;
  private readonly controlUrl: string;

  constructor(controlUrl: string, write?: (line: string) => void) {
    this.controlUrl = controlUrl;
    this.write = write ?? ((line) => process.stderr.write(`${line}\n`));
  }

  async notify(approval: PendingApproval): Promise<void> {
    const expiresIn = Math.max(0, Math.round((approval.expiresAt - Date.now()) / 1000));
    const lines = [
      "",
      "+--------------------------- APPROVAL REQUIRED ---------------------------+",
      `| tool:    ${approval.tool}`,
      `| args:    ${approval.argsPreview}`,
      `| rule:    ${approval.rule}${approval.reason ? ` (${approval.reason})` : ""}`,
      `| session: ${approval.sessionId}`,
      `| expires: in ${expiresIn}s`,
      "|",
      `|   toolgate approve ${approval.id} --control-url ${this.controlUrl}`,
      `|   toolgate deny ${approval.id} --control-url ${this.controlUrl}`,
      "+--------------------------------------------------------------------------+",
    ];
    for (const line of lines) this.write(line);
  }

  async notifyResolved(approval: PendingApproval, result: ApprovalResult): Promise<void> {
    this.write(
      `[toolgate] approval ${approval.id} (${approval.tool}) -> ${result.outcome}` +
        (result.resolvedBy ? ` by ${result.resolvedBy}` : ""),
    );
  }
}
