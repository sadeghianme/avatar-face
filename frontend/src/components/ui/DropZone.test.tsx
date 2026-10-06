import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DropZone } from "@/components/ui/DropZone";

const photo = () => new File(["png"], "me.png", { type: "image/png" });

function setup(props: Partial<Parameters<typeof DropZone>[0]> = {}) {
  const onFile = vi.fn();
  const { container } = render(
    <>
      <p id="drop-label">Your photo</p>
      <DropZone
        labelledBy="drop-label"
        title="Drop a photo here"
        hint="JPEG or PNG"
        accept="image/png"
        onFile={onFile}
        {...props}
      />
    </>
  );
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  return { onFile, input, zone: screen.getByRole("button", { name: "Your photo Drop a photo here" }) };
}

describe("DropZone", () => {
  it("is a button named by the field's label and its own title, described by its hint", () => {
    const { zone, input } = setup();
    expect(zone).toHaveAttribute("tabindex", "0");
    expect(zone).toHaveAccessibleDescription("JPEG or PNG");
    expect(input).toHaveAttribute("accept", "image/png");
    expect(input).toHaveAttribute("tabindex", "-1");
  });

  it("Enter or Space opens the picker", async () => {
    const { zone, input } = setup();
    // A picker opening is a click on the file input (the browser drops the
    // nested one its bubbling click asks for).
    const opened = vi.fn();
    input.addEventListener("click", opened);
    zone.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it("a picked file goes to onFile", async () => {
    const { input, onFile } = setup();
    const file = photo();
    await userEvent.upload(input, file);
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("is lit while a file is dragged over it, and takes the dropped file", () => {
    const { zone, onFile } = setup();
    fireEvent.dragOver(zone);
    expect(zone).toHaveClass("border-brand-500");
    fireEvent.dragLeave(zone);
    expect(zone).not.toHaveClass("border-brand-500");
    const file = photo();
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("disabled: says so, opens nothing and takes no drop", async () => {
    const { zone, input, onFile } = setup({ disabled: true });
    const opened = vi.fn();
    input.addEventListener("click", opened);
    expect(zone).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [photo()] } });
    expect(opened).not.toHaveBeenCalled();
    expect(onFile).not.toHaveBeenCalled();
  });
});
