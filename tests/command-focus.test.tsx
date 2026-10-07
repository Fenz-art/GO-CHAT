import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SearchPanel } from "@/components/search-panel";
import { SettingsPanel } from "@/components/settings-panel";

function SearchHarness() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>Open Find</button><SearchPanel open={open} onClose={() => setOpen(false)} onSelectUsername={() => undefined} /></>;
}

function SettingsHarness() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>Open Settings</button><SettingsPanel open={open} onClose={() => setOpen(false)} /></>;
}

const settings = { theme: "system", reducedMotion: false, sendOnEnter: true, readReceipts: true, notifications: true, presenceVisibility: "direct_contacts", avatarVisibility: "direct_contacts", statusVisibility: "direct_contacts", notificationPreview: "sender", notificationSound: true, quietHoursEnabled: false, quietHoursStart: "", quietHoursEnd: "", mediaAutoDownload: "manual", linkPreviewsEnabled: false, privacyCheckupCompleted: false };

describe("command surface focus", () => {
  it("focuses Find, closes it with Escape, and restores the invoking control", async () => {
    render(<SearchHarness />);
    const opener = screen.getByRole("button", { name: "Open Find" });
    opener.focus();
    fireEvent.click(opener);
    expect(await screen.findByRole("dialog", { name: "Find in Go Chat" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Search Go Chat" })).toHaveFocus());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Find in Go Chat" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("focuses Settings, closes it with Escape, and restores the invoking control", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const body = url.includes("storage/usage") ? { usedBytes: 0, fileCount: 0, maxBytes: 524288000 } : url.includes("profile") ? { username: "private-user", statusMessage: "", avatarUrl: "" } : url.includes("deletion-requests") ? { items: [] } : settings;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    }));
    render(<SettingsHarness />);
    const opener = screen.getByRole("button", { name: "Open Settings" });
    opener.focus();
    fireEvent.click(opener);
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Close settings" })).toHaveFocus());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    vi.unstubAllGlobals();
  });
});
