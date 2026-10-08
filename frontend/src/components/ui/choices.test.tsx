import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Chip } from "@/components/ui/Chip";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { ColorSwatch } from "@/components/ui/ColorSwatch";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { Tabs } from "@/components/ui/Tabs";
import { useRadioGroup } from "@/components/ui/useRadioGroup";

type Size = "s" | "m" | "l";
const SIZES = [
  { value: "s", label: "Small" },
  { value: "m", label: "Medium", disabled: true },
  { value: "l", label: "Large" },
] as const;

function Segments({ onChange, selectOnMove }: { onChange?: (v: Size) => void; selectOnMove?: boolean }) {
  const [value, setValue] = useState<Size>("s");
  return (
    <SegmentedControl<Size>
      label="Size"
      options={SIZES}
      value={value}
      selectOnMove={selectOnMove}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

describe("SegmentedControl", () => {
  it("is a named radio group with one tab stop, the chosen option", () => {
    render(<Segments />);
    expect(screen.getByRole("radiogroup", { name: "Size" })).toBeInTheDocument();
    const [small, medium, large] = screen.getAllByRole("radio");
    expect(small).toHaveAttribute("aria-checked", "true");
    expect(small).toHaveAttribute("tabindex", "0");
    expect(large).toHaveAttribute("aria-checked", "false");
    expect(large).toHaveAttribute("tabindex", "-1");
    expect(medium).toBeDisabled();
  });

  it("the arrows choose the next option, stepping over a disabled one and wrapping; Home and End go to the ends", async () => {
    const onChange = vi.fn();
    render(<Segments onChange={onChange} />);
    const small = screen.getByRole("radio", { name: "Small" });
    const large = screen.getByRole("radio", { name: "Large" });
    await userEvent.click(small);
    await userEvent.keyboard("{ArrowRight}");
    expect(large).toHaveFocus();
    expect(large).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowRight}");
    expect(small).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(large).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(small).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{End}");
    expect(large).toHaveAttribute("aria-checked", "true");
    expect(onChange).toHaveBeenLastCalledWith("l");
  });

  it("in a right-to-left page, Left is next", async () => {
    document.documentElement.dir = "rtl";
    try {
      render(<Segments />);
      await userEvent.click(screen.getByRole("radio", { name: "Small" }));
      await userEvent.keyboard("{ArrowLeft}");
      expect(screen.getByRole("radio", { name: "Large" })).toHaveAttribute("aria-checked", "true");
    } finally {
      document.documentElement.dir = "ltr";
    }
  });

  it("selectOnMove off: the arrows move the focus only, Space chooses", async () => {
    render(<Segments selectOnMove={false} />);
    const small = screen.getByRole("radio", { name: "Small" });
    const large = screen.getByRole("radio", { name: "Large" });
    await userEvent.click(small);
    await userEvent.keyboard("{ArrowRight}");
    expect(large).toHaveFocus();
    expect(small).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard(" ");
    expect(large).toHaveAttribute("aria-checked", "true");
  });
});

describe("Tabs", () => {
  function Panel() {
    const [tab, setTab] = useState<"curl" | "js">("curl");
    return (
      <>
        <Tabs
          label="Language"
          idPrefix="lang"
          panelId="lang-panel"
          items={[
            { value: "curl", label: "cURL" },
            { value: "js", label: "JavaScript" },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div id="lang-panel" role="tabpanel" aria-labelledby={`lang-${tab}`}>
          {tab}
        </div>
      </>
    );
  }

  it("is a named tab list whose tabs control the panel, the arrows moving between them", async () => {
    render(<Panel />);
    expect(screen.getByRole("tablist", { name: "Language" })).toBeInTheDocument();
    const curl = screen.getByRole("tab", { name: "cURL" });
    const js = screen.getByRole("tab", { name: "JavaScript" });
    expect(curl).toHaveAttribute("aria-selected", "true");
    expect(curl).toHaveAttribute("aria-controls", "lang-panel");
    expect(js).toHaveAttribute("tabindex", "-1");
    await userEvent.click(curl);
    await userEvent.keyboard("{ArrowRight}");
    expect(js).toHaveFocus();
    expect(js).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "JavaScript" })).toHaveTextContent("js");
  });
});

describe("ChoiceCard with useRadioGroup", () => {
  function Cards() {
    const [value, setValue] = useState<"classic" | "photo">("classic");
    const radio = useRadioGroup(["classic", "photo"] as const, value, setValue);
    return (
      <div role="radiogroup" aria-label="Mouth">
        <ChoiceCard selected={value === "classic"} {...radio("classic")}>
          Classic
        </ChoiceCard>
        <ChoiceCard selected={value === "photo"} {...radio("photo")}>
          Photographic
        </ChoiceCard>
      </div>
    );
  }

  it("is a radio with the tile look, chosen by click or arrows", async () => {
    render(<Cards />);
    const classic = screen.getByRole("radio", { name: "Classic" });
    const photo = screen.getByRole("radio", { name: "Photographic" });
    expect(classic).toHaveAttribute("type", "button");
    expect(classic).toHaveClass("choice-tile", "choice-tile-on");
    await userEvent.click(photo);
    expect(photo).toHaveAttribute("aria-checked", "true");
    expect(photo).toHaveClass("choice-tile-on");
    await userEvent.keyboard("{ArrowUp}");
    expect(classic).toHaveFocus();
    expect(classic).toHaveAttribute("aria-checked", "true");
  });
});

describe("ChoiceCard looks", () => {
  it("card: a Card's surface to press; custom: only the caller's classes", () => {
    render(
      <>
        <ChoiceCard look="card">Ava</ChoiceCard>
        <ChoiceCard look="custom" className="rounded-3xl">
          Human
        </ChoiceCard>
      </>
    );
    expect(screen.getByRole("button", { name: "Ava" })).toHaveClass("card");
    expect(screen.getByRole("button", { name: "Human" })).toHaveAttribute("class", "rounded-3xl");
  });
});

describe("Chip", () => {
  it("a filter is pressed when applied; a suggestion is a plain button", async () => {
    const onClick = vi.fn();
    render(
      <>
        <Chip selected>All</Chip>
        <Chip>Ready</Chip>
        <Chip variant="suggestion" onClick={onClick}>
          A friendly barista
        </Chip>
      </>
    );
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Ready" })).toHaveAttribute("aria-pressed", "false");
    const suggestion = screen.getByRole("button", { name: "A friendly barista" });
    expect(suggestion).not.toHaveAttribute("aria-pressed");
    await userEvent.click(suggestion);
    expect(onClick).toHaveBeenCalled();
  });
});

describe("Switch", () => {
  it("is a switch that says its state and flips on press", async () => {
    const onChange = vi.fn();
    render(<Switch aria-label="Public link" checked={false} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "Public link" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not flip when the caller's onClick prevents it", async () => {
    const onChange = vi.fn();
    render(
      <Switch aria-label="AI" checked onChange={onChange} onClick={(event) => event.preventDefault()} size="sm" />
    );
    await userEvent.click(screen.getByRole("switch", { name: "AI" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps its role and state whatever a caller spreads on it", () => {
    const props = { role: "button", "aria-checked": false } as unknown as Record<string, never>;
    render(<Switch aria-label="Sound" checked onChange={() => undefined} {...props} />);
    const toggle = screen.getByRole("switch", { name: "Sound" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});

describe("ColorSwatch", () => {
  it("is named by its colour's name and pressed when chosen", () => {
    render(
      <>
        <ColorSwatch color="#ffffff" label="White" selected />
        <ColorSwatch color="#000000" label="Black" selected={false} />
      </>
    );
    expect(screen.getByRole("button", { name: "White" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Black" })).toHaveStyle({ backgroundColor: "#000000" });
  });
});
