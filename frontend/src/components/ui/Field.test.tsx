import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Checkbox } from "@/components/ui/Checkbox";
import { ColorInput } from "@/components/ui/ColorInput";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { RangeInput } from "@/components/ui/RangeInput";
import { Select } from "@/components/ui/Select";
import { Slider } from "@/components/ui/Slider";
import { Textarea } from "@/components/ui/Textarea";

describe("Field", () => {
  it("labels the control inside it", () => {
    render(
      <Field label="Email">
        <Input />
      </Field>
    );
    expect(screen.getByRole("textbox", { name: "Email" })).toBeInTheDocument();
  });

  it("uses the id it is given for the control", () => {
    render(
      <Field id="email" label="Email">
        <Input />
      </Field>
    );
    expect(screen.getByLabelText("Email")).toHaveAttribute("id", "email");
  });

  it("describes the control with its hint, and is not invalid without an error", () => {
    render(
      <Field id="name" label="Name" hint="As visitors see it">
        <Input />
      </Field>
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveAccessibleDescription("As visitors see it");
    expect(input).toHaveAttribute("aria-describedby", "name-hint");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("with an error: the control is invalid and described by the hint, then the error", () => {
    render(
      <Field id="name" label="Name" hint="As visitors see it" error="A name is needed">
        <Input />
      </Field>
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", "name-hint name-error");
    expect(input).toHaveAccessibleDescription("As visitors see it A name is needed");
    expect(document.getElementById("name-error")).toHaveTextContent("A name is needed");
  });

  it("keeps a control's own describedby after the field's, and its own aria-invalid", () => {
    render(
      <>
        <p id="caps">Caps Lock is on</p>
        <Field id="pw" label="Password" error="Wrong password">
          <Input aria-describedby="caps" aria-invalid={false} />
        </Field>
      </>
    );
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("aria-describedby", "pw-error caps");
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  it("wires a Select and a Textarea the same way", () => {
    render(
      <>
        <Field label="Role" error="Pick one">
          <Select>
            <option>Admin</option>
          </Select>
        </Field>
        <Field label="Lines" hint="One per line">
          <Textarea />
        </Field>
      </>
    );
    expect(screen.getByRole("combobox", { name: "Role" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "Lines" })).toHaveAccessibleDescription("One per line");
  });

  it("can hide its label from sight but not from a screen reader", () => {
    render(
      <Field label="Search avatars" hideLabel>
        <Input type="search" />
      </Field>
    );
    expect(screen.getByText("Search avatars")).toHaveClass("sr-only");
    expect(screen.getByRole("searchbox", { name: "Search avatars" })).toBeInTheDocument();
  });

  it("puts something beside its label", () => {
    render(
      <Field label="Password" labelAside={<a href="/forgot">Forgot?</a>}>
        <Input type="password" />
      </Field>
    );
    expect(screen.getByRole("link", { name: "Forgot?" })).toBeInTheDocument();
  });
});

describe("Input", () => {
  it("outside a Field, passes its own props through", () => {
    render(<Input aria-label="Name" id="n" aria-describedby="x" />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveAttribute("id", "n");
    expect(input).toHaveAttribute("aria-describedby", "x");
  });

  it("draws an icon at its start and something at its end", () => {
    const { container } = render(<Input aria-label="Search" icon="search" end={<span>end</span>} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("end")).toBeInTheDocument();
  });
});

describe("PasswordInput", () => {
  it("shows and hides the password with a named, pressed eye", async () => {
    render(
      <Field label="Password">
        <PasswordInput showLabel="Show password" hideLabel="Hide password" />
      </Field>
    );
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    const eye = screen.getByRole("button", { name: "Show password" });
    expect(eye).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(eye);
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Checkbox", () => {
  it("is labelled by its whole row, with a line under the words", async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Show the mesh" description="For checking a fit" onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: /Show the mesh/ });
    await userEvent.click(screen.getByText("For checking a fit"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(box).toBeChecked();
  });
});

describe("Slider", () => {
  it("is a labelled range with its value read out", () => {
    const onChange = vi.fn();
    render(<Slider label="Jaw" value={0.5} min={0} max={1} step={0.05} onChange={onChange} />);
    const range = screen.getByRole("slider", { name: /Jaw/ });
    expect(screen.getByText("0.50")).toBeInTheDocument();
    fireEvent.change(range, { target: { value: "0.75" } });
    expect(onChange).toHaveBeenCalledWith(0.75);
  });

  it("reads out the caller's words when given, in the compact look too", () => {
    render(<Slider look="compact" label="Speed" value={2} readout="Fast" onChange={() => undefined} />);
    expect(screen.getByRole("slider", { name: "Speed" })).toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();
  });
});

describe("the bare inputs", () => {
  it("RangeInput, ColorInput and FileInput are the native controls", () => {
    const { container } = render(
      <>
        <RangeInput aria-label="Divider" />
        <ColorInput aria-label="Background colour" />
        <FileInput aria-label="Photo" />
        <FileInput aria-label="Teeth" srOnly />
      </>
    );
    expect(screen.getByRole("slider", { name: "Divider" })).toHaveAttribute("type", "range");
    expect(screen.getByLabelText("Background colour")).toHaveAttribute("type", "color");
    const files = container.querySelectorAll('input[type="file"]');
    expect(files[0]).toHaveClass("hidden");
    // srOnly: still in the accessibility tree (and droppable), out of sight.
    expect(files[1]).toHaveClass("sr-only");
  });
});
