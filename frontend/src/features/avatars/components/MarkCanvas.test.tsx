/**
 * The marking canvas: a handle nudged with the keys (Shift: ten pixels),
 * the zoom on the handle the keys move, a press that picks up the nearest
 * handle and drags it, and one too far from any that picks up nothing.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkCanvas } from "@/features/avatars/components/MarkCanvas";
import { marks as detected } from "@/features/avatars/creation/fixtures";
import type { FaceMarks } from "@/features/avatars/face-marks";
import { translate } from "@/i18n";
import { expectAccessible } from "@/test/axe";

const t = translate;
// The fixture's photo is 800 × 1000; shown 400 px wide, half size.
const SIZE: [number, number] = [800, 1000];
const HEAD_TOP = `${t("markHead")}: ${t("markEdgeTop")}`;

function Canvas({ onChange }: { onChange: (marks: FaceMarks) => void }) {
  const [marks, setMarks] = useState(detected);
  return (
    <MarkCanvas
      imageUrl="/photo.png"
      imageSize={SIZE}
      marks={marks}
      onChange={(next) => {
        setMarks(next);
        onChange(next);
      }}
    />
  );
}

function setup() {
  const onChange = vi.fn<(marks: FaceMarks) => void>();
  const view = render(<Canvas onChange={onChange} />);
  return { ...view, onChange, last: () => onChange.mock.calls.at(-1)![0] };
}

describe("the marking canvas", () => {
  const observer = window.ResizeObserver;
  beforeEach(() => {
    // The photo is laid out 400 px wide (jsdom lays nothing out).
    window.ResizeObserver = class {
      constructor(private report: ResizeObserverCallback) {}
      observe() {
        this.report([{ contentRect: { width: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 500));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
      frame(0);
      return 1;
    });
  });
  afterEach(() => {
    window.ResizeObserver = observer;
  });

  it("the arrow keys nudge the focused handle one image pixel, ten with Shift", async () => {
    const { last, container } = setup();
    act(() => screen.getByRole("button", { name: HEAD_TOP }).focus());
    await userEvent.keyboard("{ArrowRight}");
    expect(last().head.top).toEqual({ x: 401, y: 150 });
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(last().head.top).toEqual({ x: 401, y: 160 });
    await expectAccessible(container);
  });

  it("the zoom follows the handle the keys move, and names it", () => {
    const { container } = setup();
    const zoom = container.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    expect(zoom.style.opacity).not.toBe("1");
    act(() => screen.getByRole("button", { name: HEAD_TOP }).focus());
    expect(zoom.style.opacity).toBe("1");
    expect(zoom.querySelector("p")).toHaveTextContent(HEAD_TOP);
  });

  it("a press picks up the nearest handle and drags it", () => {
    const { container, last } = setup();
    const photo = container.firstElementChild as HTMLElement;
    // The head's top is at (400, 150) in the photo: (200, 75) on screen.
    fireEvent.pointerDown(photo, { clientX: 203, clientY: 77, pointerId: 1 });
    expect(screen.getByRole("button", { name: HEAD_TOP })).toHaveFocus();
    fireEvent.pointerMove(photo, { clientX: 223, clientY: 77, pointerId: 1 });
    fireEvent.pointerUp(photo, { clientX: 223, clientY: 77, pointerId: 1 });
    // Moved by the pointer's 20 screen px (40 image px), not snapped to it.
    expect(last().head.top.x).toBeCloseTo(440);
    expect(last().head.top.y).toBeCloseTo(150);
  });

  it("a press far from every handle picks up nothing", () => {
    const { container, onChange } = setup();
    const photo = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(photo, { clientX: 10, clientY: 490, pointerId: 1 });
    fireEvent.pointerMove(photo, { clientX: 60, clientY: 450, pointerId: 1 });
    fireEvent.pointerUp(photo, { clientX: 60, clientY: 450, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
