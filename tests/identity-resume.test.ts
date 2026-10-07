import { describe, expect, it } from "vitest";
import { completedIdentityFromResume } from "@/shared/identity-resume";

describe("completedIdentityFromResume", () => {
  it("restores only a fully completed, server-backed identity", () => {
    expect(completedIdentityFromResume({ completed: true, username: "direct-line", userId: "user-1" })).toEqual({ username: "direct-line", userId: "user-1" });
  });

  it("does not treat a candidate or incomplete completed record as a workspace identity", () => {
    expect(completedIdentityFromResume({ candidateUsername: "direct-line", userId: "user-1" })).toBeNull();
    expect(completedIdentityFromResume({ completed: true, username: "direct-line" })).toBeNull();
  });
});
