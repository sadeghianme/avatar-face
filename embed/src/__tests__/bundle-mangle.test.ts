import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * liveface.js renames the engine's private members to short names
 * (scripts/build.mjs, esbuild's mangleProps, the names in
 * scripts/mangle-props.json). A renamed property is renamed everywhere in
 * that one bundle, so a name is safe only if nothing outside the bundle
 * reads or writes it under its own name: not the mouth or 3D bundle, not
 * a host page, not the browser, not the network's data. These pin every
 * listed name to that, so a name that is not safe fails here rather than
 * in a visitor's browser.
 */

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const { names } = JSON.parse(read("scripts/mangle-props.json")) as { names: string[] };

/** The engine's own files: the only places a renamed member may be written. */
const ENGINE_FILES = [
  /^src\/engine\.ts$/,
  /^src\/engine\/[\w-]+\.ts$/,
  /^src\/(blink|kind-profile|character-paint|face-sharpness|warp-gl|viewport)\.ts$/,
];
/** What crosses a bundle or reaches a page: the mouth bundle's host and
 *  extension contract, the rig, cues and tuning, the widgets' globals. */
const CONTRACTS = ["src/types.ts", "src/mouth-extension.ts", "src/mouth/index.ts", "src/speech.ts", "src/widget.ts", "src/widget3d.ts", "src/widget-mouth.ts"];
/** What the console reads on `window.__liveface` (engine.ts). */
const CONSOLE_PROBES = ["face", "motion", "speech", "classicMouth", "lastAperture", "blinks", "tuning", "debugMesh"];

const word = (name: string) => new RegExp(`(?<![\\w$])${name}(?![\\w$])`);
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** The source files esbuild puts in a bundle. */
async function inputsOf(entry: string): Promise<string[]> {
  const result = await build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    write: false,
    metafile: true,
    outfile: "out.js",
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs).filter((f) => f.startsWith("src/"));
}

/** Every key of every object in a JSON document. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  }
  return into;
}

describe("the names liveface.js renames", () => {
  it("are distinct identifiers, none of them a console probe", () => {
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Za-z_$][\w$]*$/);
    expect(names.filter((n) => CONSOLE_PROBES.includes(n))).toEqual([]);
  });

  it("are written only in the engine's own files, never quoted, and each still is", async () => {
    const files = await inputsOf("src/widget.ts");
    const engine = files.filter((f) => ENGINE_FILES.some((re) => re.test(f)));
    expect(engine).toContain("src/engine.ts");
    const sources = new Map(files.map((f) => [f, withoutComments(read(f))]));
    for (const name of names) {
      const at = files.filter((f) => word(name).test(sources.get(f)!));
      expect(at.filter((f) => !engine.includes(f)), `${name} outside the engine`).toEqual([]);
      expect(at.length, `${name} is in no file of the bundle`).toBeGreaterThan(0);
      // A quoted name is a property esbuild does not rename: x["name"], "name" in x.
      const quoted = new RegExp(`["'\`]${name}["'\`]`);
      expect(files.filter((f) => quoted.test(sources.get(f)!)), `${name} quoted`).toEqual([]);
    }
  });

  it("are no member of anything another bundle, a page or the network reads", async () => {
    const mouth = await inputsOf("src/widget-mouth.ts");
    for (const file of [...CONTRACTS, ...mouth.filter((f) => !ENGINE_FILES.some((re) => re.test(f)))]) {
      const source = withoutComments(read(file));
      expect(names.filter((name) => word(name).test(source)), file).toEqual([]);
    }
  });

  it("are no key of the data the engine and the mouth read", () => {
    const json = [
      ...readdirSync(new URL("assets/", root)).filter((f) => f.endsWith(".json")).map((f) => `assets/${f}`),
      ...readdirSync(new URL("src/__tests__/fixtures/", root)).filter((f) => f.endsWith(".json")).map((f) => `src/__tests__/fixtures/${f}`),
    ];
    expect(json.length).toBeGreaterThan(3);
    for (const file of json) {
      const keys = keysOf(JSON.parse(read(file)));
      expect(names.filter((name) => keys.has(name)), file).toEqual([]);
    }
  });

  it("are no property or method of the browser's or the language's own objects", () => {
    const lib = new URL("node_modules/typescript/lib/", root);
    const declarations = readdirSync(lib)
      .filter((f) => /^lib\..*\.d\.ts$/.test(f))
      .map((f) => readFileSync(new URL(f, lib), "utf8"))
      .join("\n");
    expect(declarations).toMatch(/readonly speaking: boolean;/); // what this would catch
    const clashes = names.filter((name) => new RegExp(`(?<![\\w$])${name}\\??\\s*[:(]`).test(declarations));
    expect(clashes).toEqual([]);
  });
});
