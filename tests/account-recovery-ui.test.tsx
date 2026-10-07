import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountAccessPanel } from "@/components/account-access-panel";
import { SettingsPanel } from "@/components/settings-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("account recovery and session controls", () => {
  it("requests password recovery without revealing whether an account exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: "If a verified account uses that email, password reset instructions will be sent.",
    }), { status: 202, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AccountAccessPanel open mode="login" onClose={vi.fn()} onAuthenticated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByLabelText("Recovery email"), { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    await screen.findByRole("status");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/account/password/reset", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "person@example.com" }),
    }));
  });

  it("lists and revokes an individual account session", async () => {
    const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/v1/account/sessions" && options?.method === "DELETE") {
        return new Response(JSON.stringify({ revoked: true, currentSession: false }), { status: 200 });
      }
      if (path === "/api/v1/account/sessions") {
        return new Response(JSON.stringify({ items: [{ id: "session-2", createdAt: "2026-10-07T10:00:00Z", lastSeenAt: "2026-10-07T11:00:00Z", expiresAt: "2026-11-06T10:00:00Z", isCurrent: false }] }), { status: 200 });
      }
      if (path === "/api/v1/settings") return new Response(JSON.stringify({}), { status: 200 });
      if (path === "/api/v1/storage/usage") return new Response(JSON.stringify({ usedBytes: 0, fileCount: 0, maxBytes: 1 }), { status: 200 });
      if (path === "/api/v1/profile") return new Response(JSON.stringify({ userId: "user-1", username: "quiet-one", statusMessage: "", avatarUrl: "" }), { status: 200 });
      if (path === "/api/v1/data/deletion-requests") return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsPanel open onClose={vi.fn()} account={{ username: "quiet-one", email: "person@example.com", emailVerified: true }} onCurrentSessionRevoked={vi.fn()} />);
    await screen.findByText("Other browser");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/account/sessions/session-2", expect.objectContaining({ method: "DELETE" })));
    await waitFor(() => expect(screen.queryByText("Other browser")).not.toBeInTheDocument());
  });
});
