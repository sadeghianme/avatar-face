/**
 * The picture laid on the canvas, and everything built on where it lies:
 * the face mesh over it (geometry.ts) and, for the head turning in depth,
 * the head's field around it (head-field.ts), what it looks like
 * (sampling.ts), whether it is a cut-out, the head as a movable unit and,
 * for a cut-out that asks for it, its own feathered layer (render2d.ts),
 * the character mouth's field and the lower face's rig. All of it is
 * rebuilt whole when the texture or the viewport changes, and nothing else
 * changes it (the head's field is laid again, on a new mesh, when the head
 * motion or the layers change).
 */
import { CharacterField } from "./character-mouth";
import { addHeadField, type HeadPictures } from "./head-field";
import { buildLowerFaceRig, type LowerFaceRig } from "./jaw-rig";
import type { KindProfile } from "./kind-profile";
import type { Rig } from "../types";
import { layOutFace, placeHead, refineMesh, type FaceMesh, type HeadGeom, type Point } from "./geometry";
import type { WarpSource } from "./mesh-warp";
import { cutHeadLayer, type HeadLayer } from "./render2d";
import { FaceSamples, probeCutOut } from "./sampling";

export class FacePicture {
  /** What the picture looks like, read again with every texture. */
  readonly samples = new FaceSamples();
  /** Whether the photo is a cut-out. Decides how far the body may move. */
  cutOut = false;
  /** The face mesh laid on the canvas, with the head's field when it is
   *  wanted and could be laid. */
  mesh!: FaceMesh;
  /** The same without the head's field. */
  private bare!: FaceMesh;
  /** The head as a movable unit: where it sits and how far it may travel. */
  headGeom: HeadGeom | null = null;
  /** A cut-out's head REGION — hair, ears, skull — cut out once with
   *  feathered edges, which moves over transparency; only when asked for
   *  (headLayerWanted). A cut-out otherwise moves as one picture. */
  headLayer: HeadLayer | null = null;
  /** Cut the head layer for a cut-out (EngineOptions.cutOutHeadLayer). */
  private headLayerWanted = false;
  /** Lay the head's field (the "3d" head motion). */
  private headFieldWanted = false;
  /** A layered avatar's layers: where its head may move without showing
   *  its still background (head-field.ts). */
  private layers: HeadPictures["layers"] = null;
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
    this.bare = mesh;
    this.mesh = this.withHeadField(mesh);
    this.cutHead();
  }

  /** What the mesh warp draws of the picture (mesh-warp.ts). `turned`: the
   *  face turns in depth this frame, so the outline is left unpadded; a
   *  face at rest draws as it always did. */
  warpSource(turned: boolean): WarpSource {
    return {
      texture: this.texture,
      mesh: this.mesh,
      padEverywhere: !!this.field || this.samples.look.flat,
      lowerFace: this.lowerFace,
      replace: this.cutOut,
      unpadOutline: turned,
    };
  }

  /** Move a cut-out's head as its own layer (true), or the picture as one
   *  (false, the default). False when that is already so. */
  useHeadLayer(on: boolean): boolean {
    if (on === this.headLayerWanted) return false;
    this.headLayerWanted = on;
    if (this.mesh) this.cutHead();
    return true;
  }

  /** Lay the head's field around the face (the "3d" head motion), or not.
   *  False when that is already so. */
  useHeadField(on: boolean): boolean {
    if (on === this.headFieldWanted) return false;
    this.headFieldWanted = on;
    if (this.bare) this.mesh = this.withHeadField(this.bare);
    return true;
  }

  /** A layered avatar's layers (or null): the head's field is laid again
   *  for them. */
  setLayers(layers: HeadPictures["layers"]): void {
    this.layers = layers;
    if (this.bare && this.headFieldWanted) this.mesh = this.withHeadField(this.bare);
  }

  /** `mesh` with the head's field laid on a copy of it, when wanted and
   *  it can be; `mesh` itself otherwise. */
  private withHeadField(mesh: FaceMesh): FaceMesh {
    if (!this.headFieldWanted) return mesh;
    const copy: FaceMesh = { ...mesh, texPoints: [...mesh.texPoints], triangles: [...mesh.triangles] };
    const [w, h] = this.rig.image_size;
    addHeadField(
      copy,
      this.rig.triangles,
      { x: this.texture.naturalWidth / w, y: this.texture.naturalHeight / h },
      { texture: this.texture, cutOut: this.cutOut, layers: this.layers }
    );
    return copy.head ? copy : mesh;
  }

  /** The head layer, after the refinement: the head's mask must be whole
   *  over every vertex the warp draws, the neck band's included. */
  private cutHead(): void {
    const geom = this.headGeom;
    this.headLayer = this.headLayerWanted && geom && this.cutOut ? cutHeadLayer(this.texture, this.mesh, geom) : null;
  }
}
