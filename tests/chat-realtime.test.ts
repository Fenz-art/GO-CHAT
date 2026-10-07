import { describe, expect, it } from "vitest";
import { applyReadReceipt, filterMessageHistory, mergeRealtimeMessage } from "@/shared/chat-state";
import { avatarCropGeometry } from "@/shared/avatar-crop";
import { startsMessageDay, startsPeerMessageGroup } from "@/shared/conversation-presentation";
import { expiryLabel, expiryState } from "@/shared/retention-presentation";

type Message = { id: string; body: string; senderId: string; state: string; createdAt: string; cursor: number; clientOperationId?: string; read?: boolean };

const messages: Message[] = [
  { id: "old", body: "older constellation note", senderId: "peer", state: "delivered", createdAt: "2026-08-01T10:00:00.000Z", cursor: 1 },
  { id: "new", body: "new constellation note", senderId: "peer", state: "delivered", createdAt: "2026-08-16T10:00:00.000Z", cursor: 2 },
];

describe("chat realtime state", () => {
  it("filters durable message history by keyword and inclusive date range", () => {
    expect(filterMessageHistory(messages, "constellation", "2026-08-15", "2026-08-16").map((message) => message.id)).toEqual(["new"]);
    expect(filterMessageHistory(messages, "", "2026-08-01", "2026-08-01").map((message) => message.id)).toEqual(["old"]);
  });

  it("reconciles an incoming message idempotently and keeps cursor order", () => {
    const pending: Message = { id: "client-op", body: "hello", senderId: "me", state: "pending", createdAt: "2026-08-16T10:01:00.000Z", cursor: 3, clientOperationId: "client-op" };
    const confirmed = { ...pending, id: "server-id", state: "sent" };
    expect(mergeRealtimeMessage([pending, messages[0]], confirmed).map((message) => message.id)).toEqual(["old", "server-id"]);
  });

  it("marks the sender’s message read when a receipt arrives", () => {
    expect(applyReadReceipt([{ ...messages[1], state: "delivered" }], "new")[0]).toMatchObject({ id: "new", state: "read", read: true });
  });

  it("centers a square crop and expands it predictably with zoom", () => {
    expect(avatarCropGeometry(1200, 800, 512, 1)).toMatchObject({ width: 768, height: 512, x: -128, y: 0 });
    expect(avatarCropGeometry(1200, 800, 512, 1.5).width).toBe(1152);
  });

  it("creates date dividers only when the durable timeline crosses a local calendar day", () => {
    expect(startsMessageDay(messages[0])).toBe(true);
    expect(startsMessageDay(messages[1], messages[0])).toBe(true);
    expect(startsMessageDay({ ...messages[1], id: "same-day", createdAt: "2026-08-16T12:00:00.000Z" }, messages[1])).toBe(false);
  });

  it("exposes peer context only at a real inbound message-group boundary", () => {
    expect(startsPeerMessageGroup(messages[0], undefined, "me")).toBe(true);
    expect(startsPeerMessageGroup({ ...messages[0], id: "next-peer" }, messages[0], "me")).toBe(false);
    expect(startsPeerMessageGroup({ ...messages[0], senderId: "me" }, messages[0], "me")).toBe(false);
  });

  it("marks messages within one hour as near expiry and keeps the countdown direct", () => {
    const now = Date.parse("2026-08-19T12:00:00.000Z");
    expect(expiryState("2026-08-19T12:45:00.000Z", now)).toBe("near");
    expect(expiryLabel("2026-08-19T12:45:00.000Z", now)).toBe("Expires in 45m");
    expect(expiryState("2026-08-19T14:00:00.000Z", now)).toBe("active");
    expect(expiryState("2026-08-19T12:00:00.000Z", now)).toBe("due");
  });
});
