import { closedCurvePath, type FaceMarks, GROUP_COLOURS, headOutline } from "@/features/avatars/face-marks";

const REGION_IDS = ["left_eye", "right_eye", "mouth"] as const;

/** The outlines between the marks, in image coordinates, so the handles read
 * as shapes: the head as the smooth oval through its outline points (the
 * curve the fit puts the face's edge on), an eye or a human mouth as the
 * shape through its four edges, the mouth line as the stroke it is, a pupil
 * as its circle. Drawn in the view and, again, in the zoom. */
export function MarkOutlines({ marks, dash }: { marks: FaceMarks; dash: number }) {
  const stroke = (colour: string) => ({
    fill: "none",
    stroke: colour,
    strokeWidth: 1.5,
    strokeDasharray: `${dash} ${dash * 0.6}`,
    vectorEffect: "non-scaling-stroke" as const,
  });
  return (
    <>
      <path d={closedCurvePath(headOutline(marks.head, marks.chin))} {...stroke(GROUP_COLOURS.head)} />
      {REGION_IDS.map((id) => {
        const m = marks[id];
        if (!m) return null;
        const points = [m.top, m.right, m.bottom, m.left].map((p) => `${p.x},${p.y}`).join(" ");
        return <polygon key={id} points={points} {...stroke(GROUP_COLOURS[id])} />;
      })}
      {marks.mouth_line && (
        <polyline
          points={marks.mouth_line.map((p) => `${p.x},${p.y}`).join(" ")}
          {...stroke(GROUP_COLOURS.mouth_line)}
          strokeDasharray="none"
        />
      )}
      {marks.chin && marks.mouth_line && (
        // From the middle of the mouth down to the chin: the jaw it sets.
        <line
          x1={marks.mouth_line[2].x}
          y1={marks.mouth_line[2].y}
          x2={marks.chin.x}
          y2={marks.chin.y}
          {...stroke(GROUP_COLOURS.chin)}
        />
      )}
      {(["left_pupil", "right_pupil"] as const).map((id) => {
        const p = marks[id];
        if (!p) return null;
        const r = Math.hypot(p.rim.x - p.center.x, p.rim.y - p.center.y);
        return <circle key={id} cx={p.center.x} cy={p.center.y} r={r} {...stroke(GROUP_COLOURS[id])} />;
      })}
    </>
  );
}
