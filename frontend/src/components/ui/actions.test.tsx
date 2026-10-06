import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CodeBlock } from "@/components/ui/CodeBlock";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { CopyButton } from "@/components/ui/CopyButton";

const labels = { label: "Delete", question: "Delete this avatar?", confirmLabel: "Delete it", cancelLabel: "Cancel" };

describe("ConfirmButton", () => {
  it("asks in place: the question with Cancel focused, then the action", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton {...labels} onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const group = screen.getByRole("group", { name: "Delete this avatar?" });
    expect(within(group).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "Delete it" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Enter twice deletes nothing: the first answers Cancel", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton {...labels} onConfirm={onConfirm} />);
    screen.getByRole("button", { name: "Delete" }).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
  });

  it("Escape cancels and gives the focus back to the trigger", async () => {
    render(<ConfirmButton {...labels} onConfirm={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
  });

  it("busy: both answers wait, the action shows a spinner", async () => {
    const { rerender } = render(<ConfirmButton {...labels} onConfirm={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    rerender(<ConfirmButton {...labels} busy onConfirm={() => undefined} />);
    const [cancel, action] = within(screen.getByRole("group")).getAllByRole("button");
    expect(cancel).toBeDisabled();
    expect(action).toBeDisabled();
    expect(action.querySelector("svg.animate-spin")).toBeInTheDocument();
  });

  it("names its trigger by triggerLabel when the words need context, and can be disabled", () => {
    render(<ConfirmButton {...labels} triggerLabel="Delete the draft of 3 Oct" disabled onConfirm={() => undefined} />);
    expect(screen.getByRole("button", { name: "Delete the draft of 3 Oct" })).toBeDisabled();
  });
});

describe("CopyButton", () => {
  it("copies its text and says so for a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onCopied = vi.fn();
    render(<CopyButton text="lf_live_123" label="Copy" copiedLabel="Copied" onCopied={onCopied} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(onCopied).toHaveBeenCalled();
    await expect(navigator.clipboard.readText()).resolves.toBe("lf_live_123");
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});

describe("CodeBlock", () => {
  it("shows its code in a block that scrolls inside itself", () => {
    render(<CodeBlock code={'<script src="liveface.js"></script>'} />);
    const pre = screen.getByText('<script src="liveface.js"></script>');
    expect(pre.tagName).toBe("PRE");
    expect(pre).toHaveClass("code-block");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("with copy: a header row and a Copy button that copies the code", async () => {
    const user = userEvent.setup();
    render(<CodeBlock code="npm i" header={<span>Install</span>} copy={{ label: "Copy", copiedLabel: "Copied" }} />);
    expect(screen.getByText("Install")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await expect(navigator.clipboard.readText()).resolves.toBe("npm i");
  });
});
