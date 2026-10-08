import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { IconButton } from "@/components/ui/IconButton";

describe("Button", () => {
  it("is a plain button, not a form's submit, unless it says so", () => {
    render(
      <form>
        <Button>Save</Button>
        <Button type="submit">Send</Button>
      </form>
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("type", "submit");
  });

  it("does what it says when pressed, and gives its element to a ref", async () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} onClick={onClick}>
        Save
      </Button>
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(screen.getByRole("button"));
  });

  it("while loading: says it is busy, shows a spinner and takes no second press", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button loading icon="plus" onClick={onClick}>
        Save
      </Button>
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    // The spinner takes the icon's place; both are hidden from a screen reader.
    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabled: not pressable and not busy", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("aria-busy");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("draws its icons beside the words, hidden from a screen reader", () => {
    const { container } = render(
      <Button icon="plus" iconEnd="arrow">
        New
      </Button>
    );
    const icons = container.querySelectorAll("svg");
    expect(icons).toHaveLength(2);
    for (const icon of icons) expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button")).toHaveAccessibleName("New");
  });

  it("takes its look from the variant and size, and a className last", () => {
    render(
      <Button variant="danger" size="lg" className="px-9">
        Delete
      </Button>
    );
    expect(screen.getByRole("button")).toHaveClass("btn-danger", "btn-lg", "px-9");
  });
});

describe("ButtonLink", () => {
  it("is a link to an app route that looks like a button", () => {
    render(
      <MemoryRouter>
        <ButtonLink to="/avatars/new" variant="secondary" icon="plus">
          New avatar
        </ButtonLink>
      </MemoryRouter>
    );
    const link = screen.getByRole("link", { name: "New avatar" });
    expect(link).toHaveAttribute("href", "/avatars/new");
    expect(link).toHaveClass("btn-secondary");
  });

  it("with href, is a plain anchor (a page outside the app)", () => {
    render(
      <MemoryRouter>
        <ButtonLink href="https://example.com/s/abc" target="_blank" rel="noreferrer">
          Open
        </ButtonLink>
      </MemoryRouter>
    );
    const link = screen.getByRole("link", { name: "Open" });
    expect(link).toHaveAttribute("href", "https://example.com/s/abc");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveClass("btn-primary");
  });
});

describe("IconButton", () => {
  it("is named by its label, the icon alone being silent", () => {
    const { container } = render(<IconButton label="Delete the key" icon="trash" />);
    const button = screen.getByRole("button", { name: "Delete the key" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).not.toHaveAttribute("title");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows its label as a tooltip when asked", () => {
    render(<IconButton label="Fullscreen" icon="expand" tooltip />);
    expect(screen.getByRole("button", { name: "Fullscreen" })).toHaveAttribute("title", "Fullscreen");
  });
});
