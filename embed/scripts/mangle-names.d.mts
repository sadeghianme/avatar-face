// Types for mangle-names.mjs, which build.mjs runs as plain Node and
// bundle-mangle.test.ts imports.

/** Bundle name -> its entry point, relative to the root. */
export type Bundles = Record<string, string>;

export interface ManglingAnalysis {
  /** The names liveface.js renames, sorted. */
  names: string[];
  /** Every private or protected member name of the bundle's classes ->
   *  where it is declared ("Class.member @ file"). */
  members: Map<string, string[]>;
  /** Each member name left as it is -> why ("foreign: ...", "contract: ...",
   *  "quoted: ...", "unresolved: ...", "reached: ..."). */
  kept: Map<string, string[]>;
}

export const BUNDLES: Bundles;
export function bundleInputs(root?: string, bundles?: Bundles): Promise<Record<string, string[]>>;
export function analyseMangling(
  root?: string,
  options?: { bundles?: Bundles; mangled?: string; inputs?: Record<string, string[]> }
): Promise<ManglingAnalysis>;
export function mangledNames(root?: string): Promise<string[]>;
