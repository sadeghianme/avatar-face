// The property names liveface.js renames, derived rather than kept by hand.
//
// Every `private` or `protected` member of a class in the engine's own files
// (mangle-props.json `files`) is renamed, unless mangle-props.json `keep`s it,
// with the reason; `extra` adds the few names that are not class privates
// (fields of the engine's internal records) but are as safe. A new private
// member is renamed without anyone listing it, and
// src/__tests__/bundle-mangle.test.ts fails the build's tests if the name is
// not safe to rename: read by another bundle, a page, the browser or the
// network's data. A name missing from the list only costs bytes; a wrong one
// breaks the widget.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** mangle-props.json: { files, keep, extra }. */
export function readConfig(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "scripts/mangle-props.json"), "utf8"));
}

/** A `files` pattern ("src/engine/*.ts" or a path) as a test on a path
 *  relative to the embed's root. */
const matcher = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

/** The engine's own files, relative to the root, sorted. */
export function engineFiles(root = ROOT, config = readConfig(root)) {
  const tests = config.files.map(matcher);
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) {
        if (name.name !== "__tests__") walk(path);
      } else if (name.name.endsWith(".ts")) {
        const rel = relative(root, path).split("\\").join("/");
        if (tests.some((t) => t.test(rel))) out.push(rel);
      }
    }
  };
  walk(join(root, "src"));
  return out.sort();
}

const HIDDEN = new Set([ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword]);
const hidden = (node) => (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => HIDDEN.has(m.kind));

/** Every private or protected member name declared in `file`, with its class. */
export function privateMembers(root, file) {
  const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isClassLike(node)) {
      const owner = node.name?.text ?? "(anonymous)";
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) {
          for (const p of member.parameters) if (hidden(p) && ts.isIdentifier(p.name)) found.push({ name: p.name.text, owner });
        } else if (member.name && ts.isIdentifier(member.name) && hidden(member)) {
          found.push({ name: member.name.text, owner });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every public member name of class `owner` in `file`: for AvatarEngine,
 *  what a page calls on `Liveface.engine`. */
export function publicMembers(root, file, owner) {
  const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === owner) {
      for (const member of node.members) {
        if (!ts.isConstructorDeclaration(member) && member.name && ts.isIdentifier(member.name) && !hidden(member)) {
          found.push(member.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The names to rename: the engine files' privates, less `keep`, plus `extra`. */
export function mangledNames(root = ROOT) {
  const config = readConfig(root);
  const privates = new Set(engineFiles(root, config).flatMap((f) => privateMembers(root, f).map((m) => m.name)));
  for (const name of Object.keys(config.keep)) privates.delete(name);
  return [...new Set([...privates, ...config.extra])].sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(mangledNames().join("\n"));
}
