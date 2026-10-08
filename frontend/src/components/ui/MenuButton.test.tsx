/**
 * MenuButton as the WAI-ARIA menu button pattern: what it is to a screen
 * reader, and every key of it (roving.ts menuMove and typeaheadTarget are
 * the rules; this is them applied).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/Button";
import { MenuButton } from "@/components/ui/MenuButton";
import { expectAccessible } from "@/test/axe";

const LANGUAGES = [
  { key: "en", label: "English" },
  { key: "fr", label: "Français" },
  { key: "de", label: "Deutsch" },
  { key: "es", label: "Español" },
];

function Language({ start = "fr", onSelect }: { start?: string; onSelect?: (key: string) => void }) {
  const [lang, setLang] = useState(start);
  return (
    <main>
      <Button>Before</Button>
      <MenuButton
        label="Language"
        icon="globe"
        choices={LANGUAGES.map(({ key, label }) => ({
          key,
          label,
          checked: lang === key,
          onSelect: () => {
            onSelect?.(key);
            setLang(key);
          },
        }))}
      />
      <Button>After</Button>
      <p>Elsewhere</p>
    </main>
  );
}

const trigger = () => screen.getByRole("button", { name: "Language" });
const item = (name: string) => screen.getByRole("menuitemradio", { name });

describe("MenuButton", () => {
  it("is a button that says it opens a menu, and controls it once open", async () => {
    render(<Language />);
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(trigger());
    const menu = screen.getByRole("menu", { name: "Language" });
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(trigger()).toHaveAttribute("aria-controls", menu.id);
    expect(item("Français")).toHaveAttribute("aria-checked", "true");
    expect(item("English")).toHaveAttribute("aria-checked", "false");
  });

  it("puts the focus on the chosen item as it opens, and no item is a tab stop", async () => {
    render(<Language />);
    await userEvent.click(trigger());
    expect(item("Français")).toHaveFocus();
    for (const option of screen.getAllByRole("menuitemradio")) expect(option).toHaveAttribute("tabindex", "-1");
  });

  it("opens from the keyboard: Enter, Space and Down on the chosen item, Up on the last", async () => {
    render(<Language start="de" />);
    for (const key of ["{Enter}", " ", "{ArrowDown}"]) {
      trigger().focus();
      await userEvent.keyboard(key);
      expect(item("Deutsch")).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    }
    trigger().focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(item("Español")).toHaveFocus();
  });

  it("Down and Up move the focus and wrap; Home and End go to the ends", async () => {
    render(<Language />);
    await userEvent.click(trigger());
    await userEvent.keyboard("{ArrowDown}");
    expect(item("Deutsch")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(item("English")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(item("Español")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(item("English")).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(item("Español")).toHaveFocus();
    // Moving is not choosing.
    expect(item("Français")).toHaveAttribute("aria-checked", "true");
  });

  it("typing a letter goes to the next item that starts with it; again, to the one after", async () => {
    render(<Language start="en" />);
    await userEvent.click(trigger());
    await userEvent.keyboard("d");
    expect(item("Deutsch")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(trigger());
    await userEvent.keyboard("e");
    expect(item("Español")).toHaveFocus();
    await userEvent.keyboard("e");
    expect(item("English")).toHaveFocus();
  });

  it("typing a word goes to the item it spells, accents aside; letters that match nothing stay put", async () => {
    render(<Language start="en" />);
    await userEvent.click(trigger());
    await userEvent.keyboard("fra");
    expect(item("Français")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(trigger());
    await userEvent.keyboard("espa");
    expect(item("Español")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(trigger());
    await userEvent.keyboard("z");
    expect(item("English")).toHaveFocus();
  });

  it("Enter chooses the focused item, closes the menu and gives the focus back to the button", async () => {
    const onSelect = vi.fn();
    render(<Language onSelect={onSelect} />);
    await userEvent.click(trigger());
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("de");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{Enter}");
    expect(item("Deutsch")).toHaveAttribute("aria-checked", "true");
  });

  it("Space chooses too", async () => {
    const onSelect = vi.fn();
    render(<Language onSelect={onSelect} />);
    await userEvent.click(trigger());
    await userEvent.keyboard("{ArrowUp} ");
    expect(onSelect).toHaveBeenCalledWith("en");
    expect(trigger()).toHaveFocus();
  });

  it("a click chooses, closes and gives the focus back to the button", async () => {
    render(<Language />);
    await userEvent.click(trigger());
    await userEvent.click(item("Español"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    await userEvent.click(trigger());
    expect(item("Español")).toHaveAttribute("aria-checked", "true");
  });

  it("Escape closes it without choosing, and the focus goes back to the button", async () => {
    const onSelect = vi.fn();
    render(<Language onSelect={onSelect} />);
    await userEvent.click(trigger());
    await userEvent.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Tab closes it and moves on from the button; Shift+Tab moves back from it", async () => {
    render(<Language />);
    await userEvent.click(trigger());
    await userEvent.tab();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    await userEvent.click(trigger());
    await userEvent.tab({ shift: true });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
  });

  it("a click elsewhere closes it, and leaves the focus where the click went", async () => {
    render(<Language />);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("button", { name: "After" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("the button toggles it shut", async () => {
    render(<Language />);
    await userEvent.click(trigger());
    await userEvent.click(trigger());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("passes axe open and closed", async () => {
    const { container } = render(<Language />);
    await expectAccessible(container);
    await userEvent.click(trigger());
    await expectAccessible(container);
  });
});
