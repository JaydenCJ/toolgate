/**
 * Slack approval channel via incoming webhooks.
 *
 * Posts a Block Kit card describing the pending call together with the exact
 * `toolgate approve/deny` commands. Interactive buttons need a public
 * endpoint, so the decision itself flows through the local control API; the
 * webhook keeps the reviewer in the loop wherever they are.
 */

import type { ApprovalNotifier, ApprovalResult, PendingApproval } from "./manager.js";

export interface SlackNotifierOptions {
  webhookUrl: string;
  controlUrl: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class SlackNotifier implements ApprovalNotifier {
  readonly name = "slack";
  private readonly webhookUrl: string;
  private readonly controlUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SlackNotifierOptions) {
    this.webhookUrl = options.webhookUrl;
    this.controlUrl = options.controlUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async notify(approval: PendingApproval): Promise<void> {
    const expiresIn = Math.max(0, Math.round((approval.expiresAt - Date.now()) / 1000));
    const body = {
      text: `Approval required: agent wants to call \`${approval.tool}\``,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `:rotating_light: *Approval required* — agent wants to call \`${approval.tool}\`\n` +
              `*rule:* \`${approval.rule}\`${approval.reason ? ` — ${approval.reason}` : ""}\n` +
              `*args:* \`${approval.argsPreview}\`\n` +
              `*session:* \`${approval.sessionId}\` · *expires in* ${expiresIn}s`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "Decide from a terminal with access to the gateway:\n" +
              `\`toolgate approve ${approval.id} --control-url ${this.controlUrl}\`\n` +
              `\`toolgate deny ${approval.id} --control-url ${this.controlUrl}\``,
          },
        },
      ],
    };
    await this.post(body);
  }

  async notifyResolved(approval: PendingApproval, result: ApprovalResult): Promise<void> {
    const emoji = result.outcome === "approved" ? ":white_check_mark:" : ":no_entry:";
    await this.post({
      text: `${emoji} approval ${approval.id} (\`${approval.tool}\`) -> ${result.outcome}${
        result.resolvedBy ? ` by ${result.resolvedBy}` : ""
      }`,
    });
  }

  private async post(body: unknown): Promise<void> {
    const response = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`slack webhook returned HTTP ${response.status}`);
    }
  }
}
