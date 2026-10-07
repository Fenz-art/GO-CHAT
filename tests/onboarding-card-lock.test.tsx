import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingCard } from "@/components/onboarding-card";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("OnboardingCard lock completion", () => {
	it("clears stale browser identity state and keeps an unauthorized resume at a clean identity start", async () => {
		const onComplete = vi.fn();
		window.localStorage.setItem("gochat.onboarding.username", "expired-handle");
		window.localStorage.setItem("gochat.identity.userId", "expired-user");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ message: "Start an anonymous identity first" }, 401)));

		render(<OnboardingCard onComplete={onComplete} />);

		await waitFor(() => expect(screen.getByRole("button", { name: "Create identity" })).toBeInTheDocument());
		expect(screen.queryByText("Your previous anonymous session is no longer available. Start a new identity to continue.")).not.toBeInTheDocument();
		expect(window.localStorage.getItem("gochat.onboarding.username")).toBeNull();
		expect(window.localStorage.getItem("gochat.identity.userId")).toBeNull();
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("never revives a stale local checkpoint after a non-authoritative resume failure", async () => {
		const onComplete = vi.fn();
		window.localStorage.setItem("gochat.onboarding.username", "locked-elsewhere");
		window.localStorage.setItem("gochat.identity.userId", "stale-user");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ message: "Resume unavailable" }, 503)));

		render(<OnboardingCard onComplete={onComplete} />);

		await waitFor(() => expect(screen.getByText("We could not restore an existing identity. Reload to try again.")).toBeInTheDocument());
		expect(screen.getByRole("button", { name: "Create identity" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Review lock" })).not.toBeInTheDocument();
		expect(window.localStorage.getItem("gochat.onboarding.username")).toBeNull();
		expect(window.localStorage.getItem("gochat.identity.userId")).toBeNull();
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("hands off immediately from the completed lock response without depending on a second resume request", async () => {
		const onComplete = vi.fn();
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(json({ userId: "bootstrap-user", candidateUsername: "verified-handle" }))
			.mockResolvedValueOnce(json({ available: true }))
			.mockResolvedValueOnce(json({ locked: true, onboardingStep: "complete", username: "verified-handle", userId: "server-user" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<OnboardingCard onComplete={onComplete} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Review lock" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Review lock" }));
    fireEvent.click(screen.getByRole("button", { name: "Lock username" }));

		await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ userId: "server-user", username: "verified-handle" }));
		expect(window.localStorage.getItem("gochat.onboarding.username")).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns an expired lock session to a fresh identity start instead of looping a stale candidate", async () => {
    const onComplete = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ userId: "bootstrap-user", candidateUsername: "stale-handle" }))
      .mockResolvedValueOnce(json({ available: true }))
      .mockResolvedValueOnce(json({ message: "Start an anonymous identity first" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    render(<OnboardingCard onComplete={onComplete} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Review lock" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Review lock" }));
    fireEvent.click(screen.getByRole("button", { name: "Lock username" }));

    await waitFor(() => expect(screen.getByText("Your anonymous session expired before the name could be locked. Start a new identity to continue.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Create identity" })).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
