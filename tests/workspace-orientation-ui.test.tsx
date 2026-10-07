import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceOrientation } from "@/components/workspace-orientation";

afterEach(() => cleanup());

describe("WorkspaceOrientation", () => {
  it("lets a user skip the guide without opening a chat or changing product data", () => {
    const onDismiss = vi.fn();
    render(<WorkspaceOrientation open onDismiss={onDismiss} onOpenDiscover={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Skip guide" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("routes the first guide action to the real Discover control", () => {
    const onOpenDiscover = vi.fn();
    render(<WorkspaceOrientation open onDismiss={vi.fn()} onOpenDiscover={onOpenDiscover} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Discover" }));

    expect(onOpenDiscover).toHaveBeenCalledTimes(1);
  });
});
