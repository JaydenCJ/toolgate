/**
 * In-memory registry of pending human approvals.
 *
 * When a policy rule says `action: approve`, the gateway parks the tool call
 * here, notifies the configured channels (terminal / Slack), and waits until
 * a human resolves it via the control API (`toolgate approve <id>`) or the
 * timeout fires.
 */

import { randomBytes } from "node:crypto";

/** Final state of an approval request. */
export type ApprovalOutcome = "approved" | "denied" | "timeout";

/** A tool call waiting for a human decision. */
export interface PendingApproval {
  id: string;
  tool: string;
  /** Compact single-line preview of the (redacted) arguments. */
  argsPreview: string;
  sessionId: string;
  rule: string;
  reason?: string;
  createdAt: number;
  expiresAt: number;
}

/** Result handed back to the gateway once resolved. */
export interface ApprovalResult {
  outcome: ApprovalOutcome;
  /** Who resolved it (free-form label from the control API), if anyone. */
  resolvedBy?: string;
}

interface PendingEntry extends PendingApproval {
  resolve: (result: ApprovalResult) => void;
  timer: NodeJS.Timeout;
}

/** Interface implemented by approval notification channels. */
export interface ApprovalNotifier {
  /** Human-readable channel name used in logs. */
  readonly name: string;
  /** Announce a new pending approval. Must not throw. */
  notify(approval: PendingApproval): Promise<void>;
  /** Announce the resolution of an approval. Must not throw. */
  notifyResolved?(approval: PendingApproval, result: ApprovalResult): Promise<void>;
}

/** Render a compact, length-capped preview of call arguments. */
export function previewArgs(args: unknown, maxLength = 200): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? "null";
  } catch {
    text = String(args);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/** Registry plus notification fan-out for pending approvals. */
export class ApprovalManager {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly notifiers: ApprovalNotifier[];
  private readonly now: () => number;

  constructor(notifiers: ApprovalNotifier[] = [], options?: { now?: () => number }) {
    this.notifiers = notifiers;
    this.now = options?.now ?? Date.now;
  }

  /** Pending approvals, oldest first (for the control API / CLI). */
  list(): PendingApproval[] {
    return [...this.pending.values()]
      .map(({ resolve: _resolve, timer: _timer, ...rest }) => rest)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Park a call and wait for a decision. Resolves with the outcome; never
   * rejects. On timeout the outcome is `timeout` and the caller applies the
   * rule's `on_timeout` action.
   */
  request(input: {
    tool: string;
    args: unknown;
    sessionId: string;
    rule: string;
    reason?: string;
    timeoutSeconds: number;
  }): { id: string; result: Promise<ApprovalResult> } {
    const id = `apr_${randomBytes(6).toString("hex")}`;
    const createdAt = this.now();
    const approval: PendingApproval = {
      id,
      tool: input.tool,
      argsPreview: previewArgs(input.args),
      sessionId: input.sessionId,
      rule: input.rule,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      createdAt,
      expiresAt: createdAt + input.timeoutSeconds * 1000,
    };

    const result = new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const timeoutResult: ApprovalResult = { outcome: "timeout" };
        void this.fanOutResolved(approval, timeoutResult);
        resolve(timeoutResult);
      }, input.timeoutSeconds * 1000);
      timer.unref?.();
      this.pending.set(id, { ...approval, resolve, timer });
    });

    void this.fanOutNotify(approval);
    return { id, result };
  }

  /**
   * Resolve a pending approval. Returns false when the id is unknown
   * (already resolved, timed out, or mistyped).
   */
  resolveById(id: string, decision: "approve" | "deny", resolvedBy?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const result: ApprovalResult = {
      outcome: decision === "approve" ? "approved" : "denied",
      ...(resolvedBy !== undefined ? { resolvedBy } : {}),
    };
    const { resolve: _resolve, timer: _timer, ...approval } = entry;
    void this.fanOutResolved(approval, result);
    entry.resolve(result);
    return true;
  }

  /** Deny everything still pending (used during shutdown). */
  denyAll(reason: string): void {
    for (const id of [...this.pending.keys()]) {
      this.resolveById(id, "deny", reason);
    }
  }

  private async fanOutNotify(approval: PendingApproval): Promise<void> {
    for (const notifier of this.notifiers) {
      try {
        await notifier.notify(approval);
      } catch {
        // Notification failures must never break the gateway data path.
      }
    }
  }

  private async fanOutResolved(approval: PendingApproval, result: ApprovalResult): Promise<void> {
    for (const notifier of this.notifiers) {
      try {
        await notifier.notifyResolved?.(approval, result);
      } catch {
        // Notification failures must never break the gateway data path.
      }
    }
  }
}
