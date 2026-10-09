import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Drawer } from "@/components/ui/Drawer";
import { setMedia } from "@/test/dom-shims";

function DialogHarness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Delete avatar</Button>
      <Dialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        labelledBy="dlg-title"
        describedBy="dlg-body"
      >
        <h2 id="dlg-title">Delete Maya?</h2>
        <p id="dlg-body">Embeds stop working.</p>
        <Button>Delete</Button>
        <Button data-autofocus onClick={() => setOpen(false)}>
          Keep
        </Button>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("renders nothing inside until opened", () => {
    render(<DialogHarness />);
    expect(screen.queryByText("Delete Maya?")).not.toBeInTheDocument();
  });

  it("opens modal, named and described by its heading and words, the marked answer focused", async () => {
    render(<DialogHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Delete avatar" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Maya?" });
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Embeds stop working.");
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
  });

  it("keeps Tab and Shift+Tab inside, wrapping at both ends", async () => {
    render(<DialogHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Delete avatar" }));
    const keep = screen.getByRole("button", { name: "Keep" });
    const remove = screen.getByRole("button", { name: "Delete" });
    await userEvent.tab();
    expect(remove).toHaveFocus();
    await userEvent.tab();
    expect(keep).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(remove).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(keep).toHaveFocus();
  });

  it("Escape asks the parent to close it, and focus goes back to the opener", async () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Delete avatar" });
    await userEvent.click(opener);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closed by an answer, gives the focus back too", async () => {
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "Delete avatar" });
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByText("Delete Maya?")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("waits for an opener that is disabled to be enabled before giving it the focus", async () => {
    function Busy() {
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      return (
        <>
          <Button
            disabled={busy}
            onClick={() => {
              setOpen(true);
              setBusy(true);
            }}
          >
            Publish
          </Button>
          <Button onClick={() => setBusy(false)}>Done</Button>
          <Dialog open={open} onClose={() => setOpen(false)} labelledBy="busy-title">
            <h2 id="busy-title">Agree?</h2>
            <Button onClick={() => setOpen(false)}>Not now</Button>
          </Dialog>
        </>
      );
    }
    render(<Busy />);
    const opener = screen.getByRole("button", { name: "Publish" });
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(opener).toBeDisabled();
    expect(opener).not.toHaveFocus();
    // The request ends: the button is enabled again, and gets the focus.
    act(() => screen.getByRole("button", { name: "Done" }).click());
    (document.activeElement as HTMLElement | null)?.blur();
    await vi.waitFor(() => expect(opener).toHaveFocus());
  });
});

function DrawerHarness({ closeAt }: { closeAt?: string }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={opener} onClick={() => setOpen(true)}>
        Menu
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        label="Navigation"
        closeLabel="Close the menu"
        opener={opener}
        closeAt={closeAt}
      >
        <a href="/app">Avatars</a>
        <a href="/voices" aria-current="page">
          Voices
        </a>
        <a href="/settings">Settings</a>
      </Drawer>
    </>
  );
}

describe("Drawer", () => {
  it("is not there until opened", () => {
    render(<DrawerHarness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens as a named modal panel, focus on the current page's link, the page under it locked", async () => {
    render(<DrawerHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const panel = screen.getByRole("dialog", { name: "Navigation" });
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("link", { name: "Voices" })).toHaveFocus();
    expect(document.documentElement.style.overflow).toBe("hidden");
  });

  it("keeps Tab inside the panel, wrapping", async () => {
    render(<DrawerHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Avatars" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("link", { name: "Settings" })).toHaveFocus();
  });

  it("Escape closes it, unlocks the page and gives the focus back to the opener", async () => {
    render(<DrawerHarness />);
    const opener = screen.getByRole("button", { name: "Menu" });
    await userEvent.click(opener);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.documentElement.style.overflow).toBe("");
    expect(opener).toHaveFocus();
  });

  it("the backdrop closes it", async () => {
    render(<DrawerHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Close the menu" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes when the window grows to where it has no reason to be open", async () => {
    render(<DrawerHarness closeAt="(min-width: 1024px)" />);
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    act(() => setMedia("(min-width: 1024px)", true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.documentElement.style.overflow).toBe("");
  });
});
