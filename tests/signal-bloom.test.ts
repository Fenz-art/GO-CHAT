import { describe, expect, it } from "vitest";
import { connectionSignalCopy, receiptSignalState, signalSignature } from "@/shared/signal-bloom";

describe("Signal Bloom state helpers", () => {
  it("creates a deterministic signal signature from an anonymous username", () => {
    expect(signalSignature("night-orbit")).toEqual(signalSignature("Night-Orbit"));
    expect(signalSignature("night-orbit").accent).not.toEqual(signalSignature("dawn-relay").accent);
  });

  it("maps realtime connection states to explicit user-facing semantics", () => {
    expect(connectionSignalCopy("connected").label).toBe("Signal live");
    expect(connectionSignalCopy("reconnecting").detail).toContain("reconcile");
    expect(connectionSignalCopy("disconnected").label).toBe("Signal paused");
  });

  it("keeps receipt resolution tied to actual message lifecycle values", () => {
    expect(receiptSignalState("pending")).toBe("pending");
    expect(receiptSignalState("delivered")).toBe("delivered");
    expect(receiptSignalState("sent", true)).toBe("read");
    expect(receiptSignalState("failed")).toBe("failed");
  });
});
