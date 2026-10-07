import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPanel } from "@/components/search-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SearchPanel username lookup", () => {
  it("accepts a shared handle with a leading at-sign without querying for the at-sign itself", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ kind: "user", username: "quiet-handle" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SearchPanel open onClose={vi.fn()} onSelectUsername={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search Go Chat" }), { target: { value: "@quiet-handle" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/search?q=quiet-handle&type=users", expect.any(Object)));
    expect(screen.getByRole("button", { name: /quiet-handle/i })).toBeInTheDocument();
  });
});
