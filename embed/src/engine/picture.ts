/**
 * The picture laid on the canvas, and everything built on where it lies:
 * the face mesh over it (geometry.ts), what it looks like (sampling.ts),
 * whether it is a cut-out, the head as a movable unit and, for a cut-out
 * that asks for it, its own feathered layer (render2d.ts), the character
 * mouth's field and the lower face's rig. All of it is rebuilt whole when the texture or the
 * viewport changes, and nothing else changes it.
 */
import { CharacterField } from "./character-mouth";
import { buildLowerFaceRig, type LowerFaceRig } from "./jaw-rig";
import type { KindProfile } from "./kind-profile";
import type { Rig } from "../types";
import { layOutFace, placeHead, refineMesh, type FaceMesh, type HeadGeom, type Point } from "./geometry";
import { cutHeadLayer, type HeadLayer } from "./render2d";
import { FaceSamples, probeCutOut } from "./sampling";

export class FacePicture {
  /** What the picture looks like, read again with every texture. */
  readonly samples = new FaceSamples();
  /** Whether the photo is a cut-out. Decides how far the body may move. */
  cutOut = false;
  /** The face mesh laid on the canvas. */
  mesh!: FaceMesh;
  /** The head as a movable unit: where it sits and how far it may travel. */
  headGeom: HeadGeom | null = null;
  /** A cut-out's head REGION — hair, ears, skull — cut out once with
   *  feathered edges, which moves over transparency; only when asked for
   *  (headLayerWanted). A cut-out otherwise moves as one picture. */
  headLayer: HeadLayer | null = null;
  /** Cut the head layer for a cut-out (EngineOptions.cutOutHeadLayer). */
  private headLayerWanted = false;
  /** The character mouth's jaw field, only for a profile that asks for it. */
  field: CharacterField | null = null;
  /** The jaw, chin and cheeks for every mouth driver (jaw-rig.ts). */
  lowerFace: LowerFaceRig | null = null;

  /** `onLaid`: told the landmarks as laid, before the mesh is refined
   *  (the body is measured against them). */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly rig: Rig,
    private readonly profile: KindProfile,
    public texture: HTMLImageElement,
    private readonly onLaid: (basePoints: readonly Point[]) => void
  ) {}

  /**
   * Lay the picture on the canvas at `zoom` and `pan` (geometry.ts
   * layOutFace), place by it what moves with the framing, then refine the
   * mesh. With `sample` (a new texture), first read what the picture looks
   * like at the landmarks just laid on it: texPoints are over the texture's
   * own size, so landmarks laid for another texture (the thumbnail before
   * the full picture) point at the wrong pixels of this one.
   */
  lay(zoom: number, pan: { x: number; y: number } | undefined, sample: boolean): void {
    const mesh = layOutFace(this.rig, this.texture, this.canvas, zoom, pan);
    const cutOut = probeCutOut(this.texture);
    if (cutOut !== null) this.cutOut = cutOut;
    this.onLaid(mesh.basePoints);
    this.headGeom = placeHead(mesh.basePoints, mesh.picture);
    this.field = this.profile.mouth === "character" ? new CharacterField(mesh.basePoints) : null;
    this.lowerFace = buildLowerFaceRig(mesh.basePoints);
    if (sample) this.samples.sample(this.texture, mesh.texPoints, this.rig, this.profile);
    refineMesh(mesh, this.rig, this.texture);
    this.mesh = mesh;
    this.cutHead();
  }

  /** Move a cut-out's head as its own layer (true), or the picture as one
   *  (false, the default). False when that is already so. */
  useHeadLayer(on: boolean): boolean {
    if (on === this.headLayerWanted) return false;
    this.headLayerWanted = on;
    if (this.mesh) this.cutHead();
    return true;
  }

  /** The head layer, after the refinement: the head's mask must be whole
   *  over every vertex the warp draws, the neck band's included. */
  private cutHead(): void {
    const geom = this.headGeom;
    this.headLayer = this.headLayerWanted && geom && this.cutOut ? cutHeadLayer(this.texture, this.mesh, geom) : null;
  }
}
