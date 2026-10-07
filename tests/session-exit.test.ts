import { describe, expect, it } from "vitest";
import { sessionExitSummary } from "@/shared/session-exit";

describe("sessionExitSummary", () => {
  it("keeps the anonymous identity explicit when only the account session ends", () => {
    expect(sessionExitSummary("account", "signal-line")).toEqual({
      title: "Account signed out",
      detail: "@signal-line remains active on this browser. Your chats and identity were not deleted.",
    });
  });

  it("does not imply data deletion when the browser identity session ends", () => {
    expect(sessionExitSummary("identity", "signal-line").detail).toContain("were not deleted");
  });
});
