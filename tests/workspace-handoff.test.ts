import { describe, expect, it, vi } from "vitest";
import { completeWorkspaceHandoff } from "@/shared/workspace-handoff";

describe("completeWorkspaceHandoff", () => {
  it("replaces the onboarding URL with the workspace URL without triggering a document navigation", () => {
    const replaceState = vi.fn();
    completeWorkspaceHandoff({ replaceState });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });
});
