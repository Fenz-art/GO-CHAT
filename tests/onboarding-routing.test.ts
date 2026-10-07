import { describe, expect, it } from "vitest";
import { goChatRoutes } from "@/shared/onboarding-routing";

describe("Go Chat onboarding routing", () => {
  it("keeps identity setup on its own route rather than the landing route", () => {
    expect(goChatRoutes.home).toBe("/");
    expect(goChatRoutes.onboarding).toBe("/onboarding/");
    expect(goChatRoutes.onboarding).not.toBe(goChatRoutes.home);
  });
});
