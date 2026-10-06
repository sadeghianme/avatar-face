import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

import { engineFiles, mangledNames, privateMembers, publicMembers, readConfig } from "../../scripts/mangle-names.mjs";

/**
 * liveface.js renames the engine's private members to short names
 * (scripts/build.mjs, esbuild's mangleProps): every private or protected
 * member of a class in the engine's own files, less what
 * scripts/mangle-props.json keeps, plus its extras (scripts/mangle-names.mjs).
 * A renamed property is renamed everywhere in that one bundle, so a name is
 * safe only if nothing outside the bundle reads or writes it under its own
 * name: not the mouth or 3D bundle, not a host page, not the browser, not
 * the network's data. These pin every renamed name to that — a new private
 * member that is not safe fails here rather than in a visitor's browser —
 * and every kept one to needing it.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const config = readConfig(root);
const names = mangledNames(root);
const engine = engineFiles(root, config);

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
    absWorkingDir: root,
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

/** Every reason `name` may not be renamed in liveface.js; none: it may. */
type Vet = (name: string) => string[];

let vet: Vet;

beforeAll(async () => {
  const files = await inputsOf("src/widget.ts");
  const mouth = await inputsOf("src/widget-mouth.ts");
  const sources = new Map(files.map((f) => [f, withoutComments(read(f))]));
  const outside = [...CONTRACTS, ...mouth.filter((f) => !engine.includes(f))].map((f) => [f, withoutComments(read(f))] as const);
  const json = [
    ...readdirSync(join(root, "assets")).filter((f) => f.endsWith(".json")).map((f) => `assets/${f}`),
    ...readdirSync(join(root, "src/__tests__/fixtures")).filter((f) => f.endsWith(".json")).map((f) => `src/__tests__/fixtures/${f}`),
  ];
  expect(json.length).toBeGreaterThan(3);
  const dataKeys = new Set(json.flatMap((f) => [...keysOf(JSON.parse(read(f)))]));
  const lib = join(root, "node_modules/typescript/lib");
  const declarations = readdirSync(lib)
    .filter((f) => /^lib\..*\.d\.ts$/.test(f))
    .map((f) => readFileSync(join(lib, f), "utf8"))
    .join("\n");
  expect(declarations).toMatch(/readonly speaking: boolean;/); // what the last check would catch
  expect(files).toContain("src/engine.ts");
  // What a page calls on window.Liveface.engine, which no source here shows.
  const pageApi = publicMembers(root, "src/engine.ts", "AvatarEngine");
  expect(pageApi).toEqual(expect.arrayContaining(["playAudio", "setActive", "destroy", "tuning"]));

  vet = (name) => {
    const why: string[] = [];
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) why.push("not an identifier");
    if (CONSOLE_PROBES.includes(name)) why.push("a console probe");
    if (pageApi.includes(name)) why.push("the page's API (Liveface.engine is an AvatarEngine)");
    const at = files.filter((f) => word(name).test(sources.get(f)!));
    const elsewhere = at.filter((f) => !engine.includes(f));
    if (elsewhere.length) why.push(`written outside the engine: ${elsewhere.join(", ")}`);
    if (!at.length) why.push("in no file of the bundle");
    // A quoted name is a property esbuild does not rename: x["name"], "name" in x.
    const quoted = new RegExp(`["'\`]${name}["'\`]`);
    const quotes = files.filter((f) => quoted.test(sources.get(f)!));
    if (quotes.length) why.push(`quoted in ${quotes.join(", ")}`);
    const readers = outside.filter(([, source]) => word(name).test(source)).map(([f]) => f);
    if (readers.length) why.push(`read by ${readers.join(", ")}`);
    if (dataKeys.has(name)) why.push("a key of the data the engine and the mouth read");
    if (new RegExp(`(?<![\\w$])${name}\\??\\s*[:(]`).test(declarations)) why.push("a member of the browser's or the language's own objects");
    return why;
  };
});

describe("the names liveface.js renames", () => {
  it("are distinct, and each is safe: in the engine's files only, unquoted, read by nothing outside the bundle", () => {
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(100);
    const unsafe = Object.fromEntries(names.map((n) => [n, vet(n)]).filter(([, why]) => why.length));
    expect(unsafe).toEqual({});
  });

  it("are every private member of the engine's classes that is not kept, and the extras", () => {
    const privates = new Set(engine.flatMap((f) => privateMembers(root, f).map((m) => m.name)));
    for (const name of privates) {
      expect(names.includes(name) !== name in config.keep, `${name}: renamed or kept, not both or neither`).toBe(true);
    }
    // What the derivation finds, by example: a method, a field, a parameter property.
    for (const name of ["drawTeethRow", "cueStart", "onLaid"]) expect(names).toContain(name);
    for (const name of config.extra) {
      expect(privates.has(name), `${name} is private: no need to list it`).toBe(false);
      expect(names).toContain(name);
    }
  });

  it("keep only private members that exist and could not be renamed", () => {
    const privates = new Set(engine.flatMap((f) => privateMembers(root, f).map((m) => m.name)));
    for (const [name, reason] of Object.entries(config.keep)) {
      expect(privates.has(name), `${name} is kept but no engine class has it`).toBe(true);
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(0);
      expect(vet(name), `${name} is kept but would be safe to rename`).not.toEqual([]);
    }
  });
});
