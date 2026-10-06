/** The debug overlay (EngineOptions.debugMesh): the deformed mesh's
 *  triangles and the inner-lip ring the classic mouth is built on. */
import type { Point, Triangle } from "./geometry";

export function drawDebugMesh(
  ctx: CanvasRenderingContext2D,
  pts: readonly Point[],
  triangles: readonly Triangle[],
  innerRing: readonly number[]
): void {
  ctx.save();
  ctx.strokeStyle = "rgba(0, 255, 140, 0.35)";
  ctx.lineWidth = 0.5;
  for (const [a, b, c] of triangles) {
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.lineTo(pts[c].x, pts[c].y);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255, 80, 80, 0.9)";
  for (const i of innerRing) {
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
