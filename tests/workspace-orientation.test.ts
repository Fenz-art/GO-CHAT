import { describe, expect, it } from "vitest";
import { shouldOpenWorkspaceOrientation, workspaceOrientationKey } from "@/shared/workspace-orientation";

describe("workspace orientation state", () => {
  it("keeps the orientation preference scoped to a single anonymous identity", () => {
    expect(workspaceOrientationKey("identity-one")).not.toBe(workspaceOrientationKey("identity-two"));
  });

  it("opens only for the explicit post-lock pending state", () => {
    expect(shouldOpenWorkspaceOrientation("pending")).toBe(true);
    expect(shouldOpenWorkspaceOrientation("dismissed")).toBe(false);
    expect(shouldOpenWorkspaceOrientation(null)).toBe(false);
  });
});
