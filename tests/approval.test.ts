import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager, previewArgs, type PendingApproval } from "../src/approval/manager.js";

describe("ApprovalManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves approve decisions to the waiting caller", async () => {
    const manager = new ApprovalManager();
    const { id, result } = manager.request({
      tool: "send_payment",
      args: { amount_usd: 120 },
      sessionId: "s1",
      rule: "approve-payments",
      timeoutSeconds: 60,
    });
    expect(manager.list()).toHaveLength(1);
    expect(manager.resolveById(id, "approve", "alice")).toBe(true);
    await expect(result).resolves.toEqual({ outcome: "approved", resolvedBy: "alice" });
    expect(manager.list()).toHaveLength(0);
  });

  it("resolves deny decisions", async () => {
    const manager = new ApprovalManager();
    const { id, result } = manager.request({
      tool: "send_payment",
      args: {},
      sessionId: "s1",
      rule: "r",
      timeoutSeconds: 60,
    });
    manager.resolveById(id, "deny");
    await expect(result).resolves.toEqual({ outcome: "denied" });
  });

  it("times out when nobody answers", async () => {
    const manager = new ApprovalManager();
    const { result } = manager.request({
      tool: "send_payment",
      args: {},
      sessionId: "s1",
      rule: "r",
      timeoutSeconds: 30,
    });
    vi.advanceTimersByTime(30_000);
    await expect(result).resolves.toEqual({ outcome: "timeout" });
    expect(manager.list()).toHaveLength(0);
  });

  it("returns false for unknown or already-resolved ids", () => {
    const manager = new ApprovalManager();
    expect(manager.resolveById("apr_nope", "approve")).toBe(false);
    const { id } = manager.request({ tool: "t", args: {}, sessionId: "s", rule: "r", timeoutSeconds: 60 });
    expect(manager.resolveById(id, "approve")).toBe(true);
    expect(manager.resolveById(id, "approve")).toBe(false);
  });

  it("notifies channels on request and resolution, tolerating failures", async () => {
    const seen: string[] = [];
    const manager = new ApprovalManager([
      {
        name: "boom",
        notify: async () => {
          throw new Error("channel down");
        },
      },
      {
        name: "ok",
        notify: async (approval: PendingApproval) => {
          seen.push(`notify:${approval.tool}`);
        },
        notifyResolved: async (approval, result) => {
          seen.push(`resolved:${approval.tool}:${result.outcome}`);
        },
      },
    ]);
    const { id } = manager.request({ tool: "t", args: {}, sessionId: "s", rule: "r", timeoutSeconds: 60 });
    manager.resolveById(id, "approve");
    await vi.runAllTimersAsync();
    expect(seen).toEqual(["notify:t", "resolved:t:approved"]);
  });

  it("denyAll denies everything pending", async () => {
    const manager = new ApprovalManager();
    const a = manager.request({ tool: "a", args: {}, sessionId: "s", rule: "r", timeoutSeconds: 60 });
    const b = manager.request({ tool: "b", args: {}, sessionId: "s", rule: "r", timeoutSeconds: 60 });
    manager.denyAll("shutdown");
    await expect(a.result).resolves.toMatchObject({ outcome: "denied" });
    await expect(b.result).resolves.toMatchObject({ outcome: "denied" });
  });
});

describe("previewArgs", () => {
  it("truncates long payloads", () => {
    const preview = previewArgs({ text: "x".repeat(500) }, 50);
    expect(preview.length).toBe(53); // 50 chars + "..."
    expect(preview.endsWith("...")).toBe(true);
  });
});
