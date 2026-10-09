/**
 * The whole kit, rendered as the app uses it, through axe-core: every
 * WCAG A/AA rule that does not need a layout (src/test/axe.ts).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, it } from "vitest";

import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Card, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Chip } from "@/components/ui/Chip";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { ColorInput } from "@/components/ui/ColorInput";
import { ColorSwatch } from "@/components/ui/ColorSwatch";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog } from "@/components/ui/Dialog";
import { Disclosure, DisclosureGroup } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { DropZone } from "@/components/ui/DropZone";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { FieldError } from "@/components/ui/FieldError";
import { IconButton } from "@/components/ui/IconButton";
import { InlineEdit } from "@/components/ui/InlineEdit";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { MenuButton } from "@/components/ui/MenuButton";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { RangeInput } from "@/components/ui/RangeInput";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { Slider } from "@/components/ui/Slider";
import { Spinner } from "@/components/ui/Spinner";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Switch } from "@/components/ui/Switch";
import { StackCell, StackRow, StackTable, TableAction } from "@/components/ui/Table";
import { Tabs } from "@/components/ui/Tabs";
import { Textarea } from "@/components/ui/Textarea";
import { useRadioGroup } from "@/components/ui/useRadioGroup";
import { expectAccessible } from "@/test/axe";

function Choices() {
  const [size, setSize] = useState<"s" | "l">("s");
  const [tab, setTab] = useState<"a" | "b">("a");
  const [mouth, setMouth] = useState<"classic" | "photo">("classic");
  const radio = useRadioGroup(["classic", "photo"] as const, mouth, setMouth);
  return (
    <>
      <SegmentedControl
        label="Size"
        options={[
          { value: "s", label: "Small" },
          { value: "l", label: "Large" },
        ]}
        value={size}
        onChange={setSize}
      />
      <Tabs
        label="Language"
        idPrefix="t"
        panelId="t-panel"
        items={[
          { value: "a", label: "cURL" },
          { value: "b", label: "JS" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div id="t-panel" role="tabpanel" aria-labelledby={`t-${tab}`}>
        {tab}
      </div>
      <div role="radiogroup" aria-label="Mouth">
        <ChoiceCard selected={mouth === "classic"} {...radio("classic")}>
          Classic
        </ChoiceCard>
        <ChoiceCard selected={mouth === "photo"} {...radio("photo")}>
          Photographic
        </ChoiceCard>
      </div>
      <Chip selected>All</Chip>
      <Chip variant="suggestion">A friendly barista</Chip>
      <Switch aria-label="Public link" checked onChange={() => undefined} />
      <ColorSwatch color="#ffffff" label="White" selected />
      <MenuButton
        label="Language"
        icon="globe"
        choices={[{ key: "en", label: "English", checked: true, onSelect: () => undefined }]}
      />
    </>
  );
}

describe("the kit, through axe", () => {
  it("actions, fields and marks", async () => {
    const { container } = render(
      <MemoryRouter>
        <main>
          <Button icon="plus">New</Button>
          <Button loading>Saving</Button>
          <ButtonLink to="/app">Library</ButtonLink>
          <IconButton label="Delete" icon="trash" />
          <CopyButton text="x" label="Copy" />
          <ConfirmButton
            label="Delete"
            question="Delete it?"
            confirmLabel="Delete"
            cancelLabel="Cancel"
            onConfirm={() => undefined}
          />
          <Field label="Name" hint="As shown" error="Required">
            <Input />
          </Field>
          <Field label="Password">
            <PasswordInput showLabel="Show password" hideLabel="Hide password" />
          </Field>
          <Field label="Role">
            <Select>
              <option>Admin</option>
            </Select>
          </Field>
          <Field label="Lines">
            <Textarea />
          </Field>
          <Label htmlFor="free">Free text</Label>
          <Input id="free" />
          <Checkbox label="I agree" description="Recorded with the date" />
          <Slider label="Jaw" value={0.5} onChange={() => undefined} />
          <RangeInput aria-label="Divider" />
          <ColorInput aria-label="Background colour" />
          <FieldError>Could not save</FieldError>
          <Badge tone="brand">AI-edited</Badge>
          <StatusBadge status="ready" />
          <ProgressBar value={40} label="Usage" />
          <Spinner />
          <CodeBlock code="npm i" copy={{ label: "Copy", copiedLabel: "Copied" }} />
          <InlineEdit
            value="Maya"
            onSave={() => Promise.resolve()}
            labels={{ field: "Name", edit: "Rename", hint: "Enter saves", failed: "Not saved", saved: "Saved" }}
          />
          <p id="drop-label">Photo</p>
          <DropZone labelledBy="drop-label" title="Drop a photo" hint="JPEG or PNG" onFile={() => undefined} />
        </main>
      </MemoryRouter>
    );
    await expectAccessible(container);
  });

  it("choices", async () => {
    const { container } = render(
      <main>
        <Choices />
      </main>
    );
    await userEvent.click(screen.getByRole("button", { name: "Language" }));
    await expectAccessible(container);
  });

  it("surfaces", async () => {
    const { container } = render(
      <main>
        <Card as="section" aria-labelledby="usage-title">
          <CardHeader id="usage-title" title="Usage" description="This month" />
        </Card>
        <Banner tone="warning" icon="alert" title="Not published" role="status">
          Visitors see the last version.
        </Banner>
        <Banner appearance="soft" tone="danger" role="alert">
          Wrong password.
        </Banner>
        <DisclosureGroup label="Look">
          <Disclosure id="mouth" title="Mouth" summary="Classic" open onToggle={() => undefined}>
            <p>Settings</p>
          </Disclosure>
        </DisclosureGroup>
        <EmptyState icon="faces" title="No avatars yet" body="Make one." />
        <StackTable>
          <StackRow>
            <StackCell kind="lead">Key</StackCell>
            <StackCell kind="end">
              <TableAction>Revoke</TableAction>
            </StackCell>
          </StackRow>
        </StackTable>
      </main>
    );
    await expectAccessible(container);
  });

  it("an open dialog and an open drawer", async () => {
    const { baseElement } = render(
      <>
        <Dialog open onClose={() => undefined} labelledBy="d-title">
          <h2 id="d-title">Delete Maya?</h2>
          <Button>Cancel</Button>
        </Dialog>
        <Drawer open onClose={() => undefined} label="Navigation" closeLabel="Close the menu">
          <a href="/app">Avatars</a>
        </Drawer>
      </>
    );
    await expectAccessible(baseElement);
  });
});
