/**
 * The crop box, as the avatar page (Apply / Cancel) and the wizard
 * (controlled) use it: the keys move and resize the rectangle and say
 * where it is, a pointer drags it, an aspect fits it, and a rectangle too
 * small for the server cannot be applied.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CropBox, type CropRect } from "@/features/avatars/components/CropBox";
import { translate } from "@/i18n";
import { expectAccessible } from "@/test/axe";

const t = translate;
const START: CropRect = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };

function region() {
  return screen.getByRole("application", { name: t("cropAreaLabel") });
}

/** The picture, as if it had loaded at this size. */
function loaded(width: number, height: number) {
  const img = document.querySelector("img")!;
  Object.defineProperty(img, "naturalWidth", { value: width });
  Object.defineProperty(img, "naturalHeight", { value: height });
  fireEvent.load(img);
}

function controlled(value: CropRect = START) {
  const onChange = vi.fn();
  const view = render(<CropBox src="/photo.png" value={value} onChange={onChange} />);
  return { ...view, onChange };
}

describe("the crop box", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an arrow key moves the rectangle and says where it is; Shift resizes it", async () => {
    const { onChange, container } = controlled();
    act(() => region().focus());
    await userEvent.keyboard("{ArrowRight}");
    const moved = onChange.mock.calls[0][0] as CropRect;
    expect(moved.x).toBeCloseTo(0.21);
    expect(moved.w).toBeCloseTo(0.5);
    expect(screen.getByRole("status")).toHaveTextContent(
      t("cropAreaPosition", { left: 21, top: 20, width: 50, height: 50 })
    );
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    const taller = onChange.mock.calls[1][0] as CropRect;
    expect(taller.h).toBeCloseTo(0.51);
    expect(taller.y).toBeCloseTo(0.2);
    await expectAccessible(container);
  });

  it("a pointer drags the rectangle by where it was grabbed", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 100));
    const { onChange } = controlled();
    fireEvent.pointerDown(region(), { clientX: 80, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(region(), { clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(region(), { pointerId: 1 });
    const moved = onChange.mock.calls[0][0] as CropRect;
    expect(moved.x).toBeCloseTo(0.3);
    expect(moved.y).toBeCloseTo(0.3);
    // Released: a move after it drags nothing.
    const calls = onChange.mock.calls.length;
    fireEvent.pointerMove(region(), { clientX: 150, clientY: 90, pointerId: 1 });
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it("an aspect, once the picture's size is known, fits the rectangle to it and shows its pixels", async () => {
    const { onChange } = controlled();
    loaded(2000, 1000);
    expect(screen.getByText("1000 × 500")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: t("cropSquare") }));
    const square = onChange.mock.calls.at(-1)![0] as CropRect;
    expect(square.w).toBeCloseTo(0.5);
    expect(square.h).toBeCloseTo(1 - square.y);
  });

  it("on its own, applies the rectangle or cancels; one too small cannot be applied", async () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<CropBox src="/photo.png" onApply={onApply} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: t("cropApply") }));
    expect(onApply).toHaveBeenCalledWith({ x: 0.08, y: 0.04, w: 0.84, h: 0.92 });
    await userEvent.click(screen.getByRole("button", { name: t("cancel") }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("a rectangle smaller than the server allows says so and cannot be applied", () => {
    render(
      <CropBox src="/photo.png" value={{ x: 0.1, y: 0.1, w: 0.1, h: 0.5 }} onApply={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(t("cropTooSmall"));
    expect(screen.getByRole("button", { name: t("cropApply") })).toBeDisabled();
  });
});
