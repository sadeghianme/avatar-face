import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { Card, CardHeader } from "@/components/ui/Card";
import { Disclosure, DisclosureGroup } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Spinner } from "@/components/ui/Spinner";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { StackCell, StackRow, StackTable, TableAction } from "@/components/ui/Table";

describe("Card", () => {
  it("is a div by default, or the element it is told, with its tone and padding", () => {
    const ref = createRef<HTMLElement>();
    render(
      <>
        <Card data-testid="plain">Plain</Card>
        <Card ref={ref} as="section" aria-labelledby="c-title" tone="warning" padding="sm">
          <CardHeader id="c-title" title="Usage" description="This month" actions={<button>More</button>} />
        </Card>
      </>
    );
    expect(screen.getByTestId("plain").tagName).toBe("DIV");
    expect(screen.getByTestId("plain")).toHaveClass("card");
    const section = screen.getByRole("region", { name: "Usage" });
    expect(section).toBe(ref.current);
    expect(section).toHaveClass("card", "px-4", "py-3", "border-amber-300/60");
    expect(within(section).getByRole("heading", { level: 2, name: "Usage" })).toBeInTheDocument();
    expect(within(section).getByText("This month")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "More" })).toBeInTheDocument();
  });

  it("CardHeader can be an h3", () => {
    render(<CardHeader as="h3" title="Keys" />);
    expect(screen.getByRole("heading", { level: 3, name: "Keys" })).toBeInTheDocument();
  });

  it("is a list item, a figure or a details when it is one; muted is a flat grey well", () => {
    render(
      <>
        <ul>
          <Card as="li">A draft</Card>
        </ul>
        <Card as="figure" aria-label="Baseline">
          <figcaption>Baseline</figcaption>
        </Card>
        <Card as="details" data-testid="more">
          <summary>Other ways</summary>
        </Card>
        <Card tone="muted" data-testid="well">
          Working
        </Card>
      </>
    );
    expect(screen.getByRole("listitem")).toHaveClass("card");
    expect(screen.getByRole("figure", { name: "Baseline" })).toHaveClass("card");
    expect(screen.getByTestId("more").tagName).toBe("DETAILS");
    expect(screen.getByTestId("well")).toHaveClass("card", "bg-gray-50", "shadow-none");
  });
});

describe("Banner", () => {
  it("as a card strip: its title, its explanation, its actions, its footer", () => {
    render(
      <Banner
        tone="warning"
        icon="alert"
        title="Not published"
        actions={<button>Publish</button>}
        footer={<p>Could not publish.</p>}
        role="status"
      >
        Visitors see the last version.
      </Banner>
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveClass("card", "border-amber-300/60");
    expect(within(banner).getByText("Not published")).toBeInTheDocument();
    expect(within(banner).getByText("Visitors see the last version.")).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Publish" })).toBeInTheDocument();
    expect(within(banner).getByText("Could not publish.")).toBeInTheDocument();
  });

  it("soft, inside a form: a tinted box that can be an alert", () => {
    render(
      <Banner appearance="soft" tone="danger" role="alert" actions={<button>Retry</button>}>
        Wrong password.
      </Banner>
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Wrong password.");
    expect(alert).toHaveClass("bg-red-50");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("can be a section labelled by its own heading", () => {
    render(
      <Banner as="section" aria-labelledby="b-title">
        <h2 id="b-title">Preparing</h2>
      </Banner>
    );
    expect(screen.getByRole("region", { name: "Preparing" })).toBeInTheDocument();
  });
});

describe("Disclosure", () => {
  function Section() {
    const [open, setOpen] = useState(false);
    return (
      <DisclosureGroup label="Look">
        <Disclosure
          id="mouth"
          icon="faces"
          title="Mouth"
          summary="Photographic"
          open={open}
          onToggle={() => setOpen(!open)}
        >
          <p>The mouth settings</p>
        </Disclosure>
      </DisclosureGroup>
    );
  }

  it("is a section named by its heading, whose button says whether it is open and what it controls", async () => {
    render(<Section />);
    expect(screen.getByText("Look")).toBeInTheDocument();
    const section = screen.getByRole("region", { name: "Mouth Photographic" });
    const toggle = within(section).getByRole("button", { name: /Mouth/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "mouth-section");
    // Folded: the body stays mounted, only hidden.
    expect(document.getElementById("mouth-section")).not.toBeVisible();
    expect(screen.getByText("The mouth settings", { selector: "p" })).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("mouth-section")).toBeVisible();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

describe("EmptyState", () => {
  it("says what is missing and offers the action", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        variant="dashed"
        icon="faces"
        title="No avatars yet"
        body="Make your first one."
        action={<button onClick={onClick}>New avatar</button>}
      />
    );
    expect(screen.getByRole("heading", { level: 3, name: "No avatars yet" })).toBeInTheDocument();
    expect(screen.getByText("Make your first one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New avatar" })).toBeInTheDocument();
  });
});

describe("small marks", () => {
  it("Badge and StatusBadge: the tone as a class, the state in words", () => {
    render(
      <>
        <Badge tone="brand" icon="sparkles">
          AI-edited
        </Badge>
        <StatusBadge status="failed" />
      </>
    );
    expect(screen.getByText("AI-edited")).toHaveClass("badge", "badge-brand");
    expect(screen.getByText("Failed")).toHaveClass("badge-danger");
  });

  it("ProgressBar: a named progressbar with its value, or none while the amount is unknown", () => {
    render(
      <>
        <ProgressBar value={142} label="Characters used" />
        <ProgressBar value={null} label="Rendering" />
      </>
    );
    const used = screen.getByRole("progressbar", { name: "Characters used" });
    expect(used).toHaveAttribute("aria-valuenow", "100");
    expect(used).toHaveAttribute("aria-valuemin", "0");
    expect(used).toHaveAttribute("aria-valuemax", "100");
    expect(screen.getByRole("progressbar", { name: "Rendering" })).not.toHaveAttribute("aria-valuenow");
  });

  it("Spinner and Icon are hidden from a screen reader", () => {
    const { container } = render(
      <>
        <Spinner />
        <Icon name="check" />
      </>
    );
    for (const svg of container.querySelectorAll("svg")) expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});

describe("StackTable", () => {
  it("is a table of rows and cells, with a quiet text action", async () => {
    const onClick = vi.fn();
    render(
      <StackTable>
        <StackRow>
          <StackCell kind="lead">Widget key</StackCell>
          <StackCell>example.com</StackCell>
          <StackCell kind="end">
            <TableAction onClick={onClick}>Revoke</TableAction>
          </StackCell>
        </StackRow>
      </StackTable>
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("cell")).toHaveLength(3);
    const action = screen.getByRole("button", { name: "Revoke" });
    expect(action).toHaveAttribute("type", "button");
    expect(action).toHaveClass("text-red-600");
    await userEvent.click(action);
    expect(onClick).toHaveBeenCalled();
  });
});
