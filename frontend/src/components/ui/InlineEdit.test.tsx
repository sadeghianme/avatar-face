import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InlineEdit } from "@/components/ui/InlineEdit";

const labels = {
  field: "Avatar name",
  edit: "Rename",
  hint: "Enter saves, Escape cancels",
  failed: "Not saved. Try again.",
  saved: "Saved",
};

function setup(onSave: (next: string) => Promise<void> = () => Promise.resolve()) {
  render(<InlineEdit value="Maya" onSave={onSave} labels={labels} />);
  return screen.getByRole("button", { name: "Maya. Rename" });
}

describe("InlineEdit", () => {
  it("is the title, as a button named by it and what pressing does", () => {
    const trigger = setup();
    expect(trigger).toHaveAttribute("title", "Rename");
    expect(screen.getByRole("heading", { level: 1, name: "Maya" })).toBeInTheDocument();
  });

  it("pressed: a labelled field with the text selected, described by the hint", async () => {
    await userEvent.click(setup());
    const field = screen.getByRole("textbox", { name: "Avatar name" });
    expect(field).toHaveValue("Maya");
    expect(field).toHaveAccessibleDescription(labels.hint);
    expect(field).toHaveFocus();
  });

  it("Enter saves the new text, says Saved and gives the title back the focus", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    await userEvent.click(setup(onSave));
    const field = screen.getByRole("textbox", { name: "Avatar name" });
    await userEvent.clear(field);
    await userEvent.type(field, "  Maya Lopez  {Enter}");
    expect(onSave).toHaveBeenCalledWith("Maya Lopez");
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    await vi.waitFor(() => expect(screen.getByRole("button", { name: /Rename/ })).toHaveFocus());
  });

  it("Escape puts the old text back and saves nothing", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    await userEvent.click(setup(onSave));
    await userEvent.type(screen.getByRole("textbox"), " B{Escape}");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Maya" })).toBeInTheDocument();
  });

  it("an empty or unchanged text saves nothing", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    await userEvent.click(setup(onSave));
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.keyboard("{Enter}");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("a failed save keeps the field open with the words typed, invalid, and says so", async () => {
    const onSave = vi.fn(() => Promise.reject(new Error("409")));
    await userEvent.click(setup(onSave));
    const field = screen.getByRole("textbox");
    await userEvent.type(field, "!{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(labels.failed);
    expect(field).toHaveValue("Maya!");
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("leaving the field saves", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    await userEvent.click(setup(onSave));
    await userEvent.type(screen.getByRole("textbox"), "!");
    await userEvent.tab();
    expect(onSave).toHaveBeenCalledWith("Maya!");
  });
});
