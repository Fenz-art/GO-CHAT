import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceConsoleStyles } from "@/components/workspace-console-styles";

afterEach(() => cleanup());

describe("WorkspaceConsoleStyles", () => {
  it("defines distinct live-workspace treatments for the line index, conversation stage, policy capsule, action shelf, message rail, and ledger", () => {
    const { container } = render(<WorkspaceConsoleStyles />);
    const css = container.querySelector("style")?.textContent ?? "";

    expect(css).toContain(".workspace-console .chat-index__item.is-active");
    expect(css).toContain(".workspace-console .conversation-stage");
    expect(css).toContain(".workspace-console .line-policy-capsule");
    expect(css).toContain(".workspace-console .message-action-shelf");
    expect(css).toContain(".workspace-console .message-rail");
    expect(css).toContain(".workspace-console .peer-context");
  });

  it("keeps the console red distinct from the delivery-purple message surface and honors reduced motion", () => {
    const { container } = render(<WorkspaceConsoleStyles />);
    const css = container.querySelector("style")?.textContent ?? "";

    expect(css).toContain("--console-red:#e54255");
    expect(css).toContain("rgba(118,99,224,.96)");
    expect(css).toContain("@media(prefers-reduced-motion:reduce)");
  });

  it("carries the landing Signal Console backdrop and rounded containment into the workspace shell", () => {
    const { container } = render(<WorkspaceConsoleStyles />);
    const css = container.querySelector("style")?.textContent ?? "";

    expect(css).toContain("radial-gradient(circle at 88% 8%,rgba(221,38,60,.14)");
    expect(css).toContain(".workspace-console__frame");
    expect(css).toContain("border-radius:24px!important");
    expect(css).toContain("backdrop-filter:blur(20px)!important");
  });

  it("keeps the live conversation stage within the desktop frame and uses content-sized flex message rows", () => {
    const { container } = render(<WorkspaceConsoleStyles />);
    const css = container.querySelector("style")?.textContent ?? "";

    expect(css).toContain("height:max(640px,calc(100dvh - 116px))!important");
    expect(css).toContain(".workspace-console__frame>.relay-stream,.workspace-console__frame>.private-field{height:100%!important;min-height:0!important}");
    expect(css).toContain(".workspace-console .message-row{display:flex!important;width:100%!important}");
    expect(css).toContain(".workspace-console .message-row>div{width:fit-content!important;min-width:0}");
  });

  it("styles incoming private-line requests as a distinct consent control rather than an opened conversation", () => {
    const { container } = render(<WorkspaceConsoleStyles />);
    const css = container.querySelector("style")?.textContent ?? "";

    expect(css).toContain(".workspace-console .chat-index__requests");
    expect(css).toContain(".workspace-console .chat-index__request-actions");
    expect(css).toContain(".workspace-console .direct-stage--pending");
  });
});
