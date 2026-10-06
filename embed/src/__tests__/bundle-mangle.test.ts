import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyseMangling, bundleInputs, type ManglingAnalysis } from "../../scripts/mangle-names.mjs";

/**
 * liveface.js renames its classes' private members to short names
 * (scripts/build.mjs, esbuild's mangleProps), and esbuild renames by name,
 * bundle-wide: a name is safe only if nothing outside the bundle reads it
 * under its own name. scripts/mangle-names.mjs derives the names from the
 * TypeScript checker, with nothing kept by hand. These hold the derivation
 * to each of its rules on a small program built to break them, and the
 * real list to what can be checked without the checker: the data the
 * bundle reads, the page's API, the browser's members, quoted keys. (The
 * browser test draws liveface.js renamed and not, pixel for pixel.)
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const kinds = (analysis: ManglingAnalysis, name: string) => (analysis.kept.get(name) ?? []).map((why) => why.split(":")[0]);

describe("the rules: a program built to break each one", () => {
  // liveface.js is src/widget.ts; src/other.ts is another bundle, and
  // src/clock.ts is in both.
  const program: Record<string, string> = {
    "src/widget.ts": `
      import { Engine } from "./engine";
      import { Clock, Quiet } from "./clock";
      /** The API's answer: network data. */
      interface Answer { scene: string }
      declare global {
        interface Window { lf?: { engine: Engine; clock: Clock } }
      }
      export async function boot(url: string): Promise<void> {
        const answer = (await (await fetch(url)).json()) as Answer;
        const engine = new Engine(answer.scene);
        window.lf = { engine, clock: new Clock() };
        engine.run(new Quiet().hushed());
      }
      void boot("/a");
    `,
    "src/engine.ts": `
      /** One of the bundle's own records. */
      interface Internal { record: number }
      class Helper {
        /** Named like Engine.run, which the page calls. */
        private run = 1;
        value(): number { return this.run; }
      }
      export class Engine {
        private scene: string;
        private canvas = document.createElement("canvas");
        private then = 0;
        private voice = "warm";
        private quotedName = 1;
        private loose = 2;
        private literal = 3;
        private record = 4;
        private internal = 5;
        private bracketed = 6;
        constructor(scene: string) {
          this.scene = scene;
        }
        run(extra: number): number {
          const ctx = this.canvas.getContext("2d");
          const own: Internal = { record: this.record };
          const untyped = { literal: this.literal };
          const anything: unknown = this;
          const sent = JSON.stringify({ voice: this.voice });
          return (ctx?.canvas.width ?? 0) + this.then + this["quotedName"] + (anything as { [k: string]: number }).loose +
            untyped.literal + own.record + this.internal + this.bracketed + sent.length + new Helper().value() + extra +
            this.scene.length + this.loose;
        }
      }
    `,
    "src/clock.ts": `
      /** Crosses to the page (window.lf.clock): both bundles carry it. */
      export class Clock {
        private tick = 0;
        now(): number { return this.tick++; }
      }
      /** Both bundles carry it too, but no instance crosses. */
      export class Quiet {
        private hush = 0;
        hushed(): number { return this.hush; }
      }
    `,
    "src/other.ts": `
      import type { Engine } from "./engine";
      import { Clock, Quiet } from "./clock";
      export function peek(engine: Engine): number {
        return engine["bracketed"] + new Clock().now() + new Quiet().hushed();
      }
      void peek;
    `,
  };
  let dir: string;
  let analysis: ManglingAnalysis;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mangle-rules-"));
    for (const [path, source] of Object.entries(program)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), source);
    }
    analysis = await analyseMangling(dir, { bundles: { "liveface.js": "src/widget.ts", "other.js": "src/other.ts" } });
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ["scene", "contract", "a field of the API's answer, declared by the entry point"],
    ["voice", "contract", "a key of what JSON.stringify sends"],
    ["run", "contract", "the name of a method the page calls on the engine"],
    ["canvas", "foreign", "a member of the browser's objects, read here (ctx.canvas)"],
    ["then", "foreign", "a name the browser reads on its own (a thenable's)"],
    ["quotedName", "quoted", "read as this[\"quotedName\"]"],
    ["loose", "unresolved", "read off an untyped value"],
    ["literal", "unresolved", "a key of an object literal nothing types"],
    ["bracketed", "reached", "read by bracket access in another bundle"],
    ["tick", "reached", "a member of a class both bundles carry whose instances cross"],
  ])("keeps %s: %s, %s", (name, kind) => {
    expect(analysis.members.has(name)).toBe(true);
    expect(analysis.names).not.toContain(name);
    expect(kinds(analysis, name)).toContain(kind);
  });

  it("renames the rest, including a name it shares only with the bundle's own records", () => {
    expect(analysis.names).toEqual(["hush", "internal", "record"]);
  });
});

describe("the names liveface.js renames", () => {
  let analysis: ManglingAnalysis;
  let inputs: Record<string, string[]>;
  beforeAll(async () => {
    inputs = await bundleInputs(root);
    analysis = await analyseMangling(root, { inputs });
  }, 60_000);

  it("are derived, with nothing kept or added by hand", () => {
    expect(existsSync(join(root, "scripts/mangle-props.json"))).toBe(false);
    // Every private member is renamed or kept, with a reason, never both.
    for (const [name] of analysis.members) {
      expect(analysis.names.includes(name) !== analysis.kept.has(name), name).toBe(true);
    }
    for (const [name, why] of analysis.kept) expect(why.length, name).toBeGreaterThan(0);
    // A derivation that silently found nothing would only cost bytes.
    expect(analysis.names.length).toBeGreaterThan(100);
    expect(new Set(analysis.names).size).toBe(analysis.names.length);
  });

  it("are private or protected members of liveface.js's own classes, as its source declares them", () => {
    // Read without the checker: every class member marked private or
    // protected in the files esbuild puts in liveface.js.
    const declared = new Set<string>();
    for (const file of inputs["liveface.js"]) {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      const hidden = (node: ts.Node) =>
        (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some(
          (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
        );
      const visit = (node: ts.Node) => {
        if (ts.isClassLike(node)) {
          for (const member of node.members) {
            const params = ts.isConstructorDeclaration(member) ? member.parameters : [];
            for (const decl of [member, ...params]) {
              const name = (decl as { name?: ts.Node }).name;
              if (name && ts.isIdentifier(name) && hidden(decl)) declared.add(name.text);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(analysis.names.filter((name) => !declared.has(name))).toEqual([]);
    // What the derivation finds, by example: a method, a field, a parameter property.
    for (const name of ["drawTeethRow", "cueStart", "onLaid"]) expect(analysis.names).toContain(name);
  });

  it("are no key of the data the widget and the engine read", () => {
    const keysOf = (value: unknown, into = new Set<string>()): Set<string> => {
      if (Array.isArray(value)) for (const v of value) keysOf(v, into);
      else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          into.add(k);
          keysOf(v, into);
        }
      }
      return into;
    };
    const dirs = ["assets", "src/__tests__/fixtures", "src/mouth/__tests__/fixtures"];
    const json = dirs.flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".json")).map((f) => `${d}/${f}`));
    expect(json.length).toBeGreaterThan(5);
    const keys = new Set(json.flatMap((f) => [...keysOf(JSON.parse(read(f)))]));
    expect(analysis.names.filter((name) => keys.has(name))).toEqual([]);
  });

  it("are no member the browser or the language declares", () => {
    const lib = join(root, "node_modules/typescript/lib");
    const declarations = readdirSync(lib)
      .filter((f) => /^lib\..*\.d\.ts$/.test(f))
      .map((f) => readFileSync(join(lib, f), "utf8"))
      .join("\n");
    expect(declarations).toMatch(/^\s+readonly canvas: HTMLCanvasElement/m); // what this would catch
    const member = (name: string) => new RegExp(`^\\s+(readonly\\s+)?${name}\\??\\s*[:(<]`, "m");
    expect(analysis.names.filter((name) => member(name).test(declarations))).toEqual([]);
  });

  it("are none of the page's API: window.Liveface.engine's public members", () => {
    const pageApi = new Set<string>();
    for (const [file, owner] of [["src/engine.ts", "AvatarEngine"], ["src/engine3d.ts", "Avatar3DEngine"]]) {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      ts.forEachChild(source, (node) => {
        if (!ts.isClassDeclaration(node) || node.name?.text !== owner) return;
        for (const m of node.members) {
          const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : [];
          const hidden = mods.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword);
          if (!hidden && m.name && ts.isIdentifier(m.name)) pageApi.add(m.name.text);
        }
      });
    }
    expect([...pageApi]).toEqual(expect.arrayContaining(["playAudio", "setActive", "destroy", "tuning", "isSpeaking", "landmarks"]));
    expect(analysis.names.filter((name) => pageApi.has(name))).toEqual([]);
  });

  it("are never quoted as a key in liveface.js's sources", () => {
    // x["name"], "name" in x, { "name": ... }: as the parser sees them.
    const quoted = new Set<string>();
    const text = (node: ts.Node) => (ts.isStringLiteralLike(node) ? node.text : undefined);
    for (const file of inputs["liveface.js"]) {
      const visit = (node: ts.Node) => {
        let key: string | undefined;
        if (ts.isElementAccessExpression(node)) key = text(node.argumentExpression);
        else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) key = text(node.left);
        else if ((ts.isPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && node.name) key = text(node.name);
        if (key !== undefined) quoted.add(key);
        ts.forEachChild(node, visit);
      };
      visit(ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true));
    }
    expect(quoted.size).toBeGreaterThan(0);
    expect(analysis.names.filter((name) => quoted.has(name))).toEqual([]);
  });
});
