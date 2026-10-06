// The property names liveface.js renames to short names (esbuild's
// mangleProps, scripts/build.mjs): derived by the TypeScript checker, with
// nothing kept or added by hand.
//
// A name is renamed when it is a `private` or `protected` member of a class
// in liveface.js and renaming it everywhere in the bundle (mangleProps goes
// by name, bundle-wide) cannot change what the bundle does. It is left as
// it is when any use of the name could be read under its own name from
// outside the bundle:
//
//   unresolved   a use the checker cannot resolve (a member of `any`), or
//                an object literal nothing types, whose keys may go anywhere;
//   quoted       x["name"], "name" in x, or a quoted key: esbuild leaves
//                those as written, so the renamed uses would no longer meet
//                them;
//   foreign      a member of something the bundle does not own: the
//                browser's or the language's objects (TypeScript's lib), a
//                package's types; and any name the lib declares at all,
//                since the browser may read it on an object of ours
//                (then, handleEvent, toJSON...);
//   contract     a member of what the page, the network or another bundle
//                sees: everything an entry point declares (window.Liveface
//                and its engine, the other bundles' load() and attach(), the
//                API's answers), everything in a file another bundle also
//                includes, whatever is handed to a foreign parameter typed
//                `any` (JSON.stringify, a CustomEvent's detail), and,
//                transitively, the members of every type those members have;
//   reached      a use in another bundle (liveface-3d.js, liveface-mouth.js)
//                that the checker cannot resolve or that reaches a private
//                member by bracket access; or a private member of a class
//                another bundle carries too, whose instances cross (its type
//                is in a contract).
//
// A private member whose name collides only with the bundle's own records
// is renamed with them, consistently. src/__tests__/bundle-mangle.test.ts
// holds each rule to a small program that breaks it, and the shipped
// bundles are drawn mangled and unmangled in the browser test
// (browser-tests/), pixel for pixel.
//
//   node scripts/mangle-names.mjs        the names
//   node scripts/mangle-names.mjs --why  every private member left as it is, and why
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The bundles `npm run build` ships, by entry point; liveface.js is the one renamed. */
export const BUNDLES = {
  "liveface.js": "src/widget.ts",
  "liveface-3d.js": "src/widget3d.ts",
  "liveface-mouth.js": "src/widget-mouth.ts",
};
const MANGLED = "liveface.js";

/** The source files esbuild puts in each bundle, relative to `root`. */
export async function bundleInputs(root = ROOT, bundles = BUNDLES) {
  const out = {};
  for (const [name, entry] of Object.entries(bundles)) {
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
    out[name] = Object.keys(result.metafile.inputs).filter(
      (f) => !f.includes("node_modules/") && /\.[mc]?tsx?$/.test(f)
    );
  }
  return out;
}

const HIDDEN = new Set([ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword]);
const modifiers = (node) => (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []);
/** A class member (or parameter property) declared `private` or `protected`. */
const isHidden = (decl) => modifiers(decl).some((m) => HIDDEN.has(m.kind));
const isClassMember = (decl) =>
  (decl.parent && ts.isClassLike(decl.parent)) || (ts.isParameter(decl) && ts.isConstructorDeclaration(decl.parent));
const nameOf = (node) =>
  node &&
  (ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node))
    ? node.text
    : undefined;

/**
 * Every private or protected member of liveface.js's classes, and the names
 * renamed: `{ names, members, kept }`, where `members` maps each private
 * name to its declarations ("Class.member @ file") and `kept` each one left
 * as it is to why.
 */
export async function analyseMangling(root = ROOT, { bundles = BUNDLES, mangled = MANGLED, inputs } = {}) {
  root = root.replace(/\/?$/, "/");
  inputs ??= await bundleInputs(root, bundles);
  const abs = (f) => join(root, f);
  const own = new Set(inputs[mangled].map(abs));
  const others = new Set(
    Object.entries(inputs)
      .filter(([name]) => name !== mangled)
      .flatMap(([, files]) => files.map(abs))
  );
  const shared = new Set([...own].filter((f) => others.has(f)));
  const entries = new Set(Object.values(bundles).map(abs));

  const configPath = join(root, "tsconfig.json");
  const options = existsSync(configPath)
    ? ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
        .options
    : { target: ts.ScriptTarget.ES2020, lib: ["lib.es2020.d.ts", "lib.dom.d.ts"], strict: true };
  const program = ts.createProgram([...own, ...others], {
    ...options,
    noEmit: true,
    composite: false,
    declaration: false,
  });
  const checker = program.getTypeChecker();
  const rel = (file) => relative(root, file);
  const isForeignFile = (sf) =>
    program.isSourceFileDefaultLibrary(sf) ||
    program.isSourceFileFromExternalLibrary(sf) ||
    sf.fileName.includes("/node_modules/");

  // --- The candidates: private and protected members of liveface.js's classes.
  const members = new Map();
  const add = (map, name, value) => map.set(name, [...(map.get(name) ?? []), value]);
  for (const file of own) {
    const sf = program.getSourceFile(file);
    const visit = (node) => {
      if (ts.isClassLike(node)) {
        const owner = node.name?.text ?? "(anonymous class)";
        for (const member of node.members) {
          const params = ts.isConstructorDeclaration(member) ? member.parameters.filter(isHidden) : [];
          for (const decl of [member, ...params]) {
            const name = ts.isConstructorDeclaration(decl) ? undefined : nameOf(decl.name);
            if (name && isHidden(decl) && !(decl.name && ts.isPrivateIdentifier(decl.name))) {
              add(members, name, { label: `${owner}.${name} @ ${rel(file)}`, cls: node, file });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const kept = new Map();
  const keep = (name, why) => {
    if (!members.has(name)) return;
    const reasons = kept.get(name) ?? new Set();
    reasons.add(why);
    kept.set(name, reasons);
  };

  // --- Foreign: every member name TypeScript's lib declares.
  for (const sf of program.getSourceFiles()) {
    if (!program.isSourceFileDefaultLibrary(sf)) continue;
    const visit = (node) => {
      if (
        (ts.isPropertySignature(node) ||
          ts.isMethodSignature(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isGetAccessor(node) ||
          ts.isSetAccessor(node)) &&
        nameOf(node.name)
      ) {
        keep(
          nameOf(node.name),
          `foreign: the browser's or the language's own member (${sf.fileName.split("/").pop()})`
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // --- Contracts: what the page, the network or another bundle sees.
  const isForeignDecl = (decl) => isForeignFile(decl.getSourceFile());
  const queue = [];
  const push = (type) => type && queue.push(type);
  /** A declaration's types: a class's instances and its constructor, an
   *  interface's or alias's type, a variable's or function's. */
  const pushDeclared = (decl) => {
    const sym = decl.symbol ?? (decl.name && checker.getSymbolAtLocation(decl.name));
    if (!sym) return;
    if (
      ts.isClassLike(decl) ||
      ts.isInterfaceDeclaration(decl) ||
      ts.isTypeAliasDeclaration(decl) ||
      ts.isEnumDeclaration(decl)
    ) {
      push(checker.getDeclaredTypeOfSymbol(sym));
    }
    if (!ts.isInterfaceDeclaration(decl) && !ts.isTypeAliasDeclaration(decl))
      push(checker.getTypeOfSymbolAtLocation(sym, decl));
  };
  /** Push everything `files` declare. */
  const pushFiles = (files) => {
    for (const file of files) {
      const visit = (node) => {
        if (
          ts.isClassLike(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isFunctionDeclaration(node)
        ) {
          pushDeclared(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(program.getSourceFile(file));
    }
  };
  // Everything an entry point declares: window's globals (window.Liveface and
  // its engine, the other bundles' load and attach), the API's answers.
  pushFiles([...own].filter((f) => entries.has(f)));
  // Whatever is handed to a foreign function's parameter typed `any` or
  // `unknown`: JSON.stringify, a CustomEvent's detail, console.log.
  for (const file of own) {
    const visit = (node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const decl = signature?.getDeclaration?.();
        if (decl && isForeignDecl(decl)) {
          (node.arguments ?? []).forEach((arg, i) => {
            const param = signature.parameters[Math.min(i, signature.parameters.length - 1)];
            const type = param && checker.getTypeOfSymbolAtLocation(param, node);
            if (!type) return;
            const loose = (t) => t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown);
            // Directly, or a member of an options bag (CustomEventInit.detail).
            if (
              loose(type) ||
              checker.getPropertiesOfType(type).some((p) => loose(checker.getTypeOfSymbolAtLocation(p, node)))
            ) {
              push(checker.getTypeAtLocation(arg));
            }
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(program.getSourceFile(file));
  }
  // Then, transitively, the members of every type a contract member has.
  const contract = new Set();
  const visited = new Set();
  const close = () => {
    while (queue.length) {
      const type = queue.pop();
      if (visited.has(type)) continue;
      visited.add(type);
      if (type.isUnionOrIntersection()) {
        for (const t of type.types) push(t);
        continue;
      }
      if (!(type.flags & ts.TypeFlags.Object)) continue;
      if (type.objectFlags & ts.ObjectFlags.Reference) for (const t of checker.getTypeArguments(type)) push(t);
      for (const info of checker.getIndexInfosOfType(type)) push(info.type);
      for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
        for (const p of signature.parameters) push(checker.getTypeOfSymbol(p));
        push(signature.getReturnType());
      }
      for (const prop of checker.getPropertiesOfType(type)) {
        const decls = prop.declarations ?? [];
        if (!decls.length || decls.every(isForeignDecl)) continue;
        if (decls.some((d) => isClassMember(d) && isHidden(d))) continue;
        for (const d of decls) contract.add(d);
        push(checker.getTypeOfSymbol(prop));
      }
    }
  };
  close();
  // What crosses a bundle's edge is in the contract by now: an instance of
  // a class both bundles carry crosses only if its type is in there.
  const crossing = new Set(visited);
  // Everything a file another bundle also includes declares is a contract
  // too (both bundles build it, from data the other may have handed over).
  pushFiles([...shared]);
  close();

  // --- Every use of a name in liveface.js, as the checker resolves it.
  const PROPERTY_DECL = (node) =>
    ts.isPropertyDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isPropertySignature(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isEnumMember(node) ||
    (ts.isParameter(node) && isClassMember(node) && modifiers(node).length > 0);
  const judge = (name, decls, where) => {
    if (!members.has(name)) return;
    if (!decls?.length) return keep(name, `unresolved: ${where}`);
    if (decls.some(ts.isIndexSignatureDeclaration))
      return keep(name, `unresolved: through an index signature, ${where}`);
    for (const d of decls) {
      if (isForeignDecl(d))
        return keep(name, `foreign: a member of ${d.getSourceFile().fileName.split("/node_modules/").pop()}`);
      if (contract.has(d)) return keep(name, `contract: ${where} is ${describe(d)}`);
    }
  };
  const describe = (d) => {
    const owner = d.parent?.name?.text ?? (ts.isObjectLiteralExpression(d.parent) ? "an object literal" : "a type");
    return `${owner}.${nameOf(d.name)} @ ${rel(d.getSourceFile().fileName)}`;
  };
  const at = (node) => {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    return `${rel(sf.fileName)}:${line + 1}`;
  };
  const quoted = (name, node) => keep(name, `quoted: ${at(node)}`);

  for (const file of own) {
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
        judge(node.name.text, checker.getSymbolAtLocation(node.name)?.declarations, at(node));
      } else if (ts.isElementAccessExpression(node)) {
        const key = nameOf(node.argumentExpression);
        if (key !== undefined) quoted(key, node);
        else {
          // A computed key on an object: any of its members may be meant.
          const target = checker.getTypeAtLocation(node.expression);
          if (!checker.isArrayLikeType(target))
            for (const p of checker.getPropertiesOfType(target)) keep(p.name, `quoted: a computed key at ${at(node)}`);
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        nameOf(node.left) !== undefined
      ) {
        quoted(nameOf(node.left), node);
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = nameOf(node.propertyName ?? node.name);
        if (key !== undefined) {
          const prop = checker.getPropertyOfType(checker.getTypeAtLocation(node.parent), key);
          judge(key, prop?.declarations, at(node));
        }
      } else if (PROPERTY_DECL(node) && node.name) {
        const key = nameOf(node.name);
        if (key !== undefined) {
          if (!ts.isIdentifier(node.name) && !ts.isPrivateIdentifier(node.name)) quoted(key, node);
          if (contract.has(node)) keep(key, `contract: declared at ${at(node)} as ${describe(node)}`);
          if (ts.isObjectLiteralExpression(node.parent)) {
            // A literal's key meets the property it is read as: its contextual
            // type's, or nothing typed (then anything may read it).
            const contextual = checker.getContextualType(node.parent);
            if (!contextual || contextual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
              keep(key, `unresolved: an object literal nothing types, at ${at(node)}`);
            } else {
              const types = contextual.isUnion() ? contextual.types : [contextual];
              for (const t of types) {
                const prop = checker.getPropertyOfType(t, key);
                if (prop) judge(key, prop.declarations, at(node));
              }
            }
          }
        }
      } else if (ts.isComputedPropertyName(node) && nameOf(node.expression) !== undefined) {
        quoted(nameOf(node.expression), node);
      }
      ts.forEachChild(node, visit);
    };
    visit(program.getSourceFile(file));
  }

  // --- Reached from another bundle.
  for (const file of others) {
    if (own.has(file)) continue;
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && members.has(node.name.text)) {
        const decls = checker.getSymbolAtLocation(node.name)?.declarations;
        if (!decls?.length) keep(node.name.text, `reached: unresolved in another bundle, ${at(node)}`);
      } else if (ts.isElementAccessExpression(node) && nameOf(node.argumentExpression) !== undefined) {
        const key = nameOf(node.argumentExpression);
        const decls =
          checker.getSymbolAtLocation(node.argumentExpression)?.declarations ??
          checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), key)?.declarations;
        if (members.has(key) && (!decls?.length || decls.some((d) => isClassMember(d) && isHidden(d))))
          keep(key, `reached: by bracket access in another bundle, ${at(node)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(program.getSourceFile(file));
  }
  // A class both bundles carry, whose instances cross: one bundle's copy of
  // its methods would meet the other's instances, named the other way.
  for (const [name, list] of members) {
    for (const { label, cls, file } of list) {
      if (shared.has(file) && cls.symbol && crossing.has(checker.getDeclaredTypeOfSymbol(cls.symbol))) {
        keep(name, `reached: ${label}: another bundle carries its class too, and its instances cross`);
      }
    }
  }

  const names = [...members.keys()].filter((n) => !kept.has(n)).sort();
  return {
    names,
    members: new Map([...members].map(([name, list]) => [name, list.map((m) => m.label)])),
    kept: new Map([...kept].map(([name, why]) => [name, [...why]])),
  };
}

/** The names liveface.js renames. */
export async function mangledNames(root = ROOT) {
  return (await analyseMangling(root)).names;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { names, kept } = await analyseMangling();
  if (process.argv.includes("--why")) {
    for (const [name, why] of [...kept].sort(([a], [b]) => a.localeCompare(b)))
      console.log(`${name}: ${why.join("; ")}`);
  } else {
    console.log(names.join("\n"));
  }
}
