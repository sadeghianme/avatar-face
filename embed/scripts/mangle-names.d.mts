// Types for mangle-names.mjs, which build.mjs runs as plain Node and
// bundle-mangle.test.ts imports.

export interface MangleConfig {
  /** The engine's own files, as paths or one-star globs from the embed's root. */
  files: string[];
  /** Private members that keep their names, each with the reason. */
  keep: Record<string, string>;
  /** Names that are not class privates but are renamed too. */
  extra: string[];
}

export interface PrivateMember {
  name: string;
  /** The class that declares it. */
  owner: string;
}

export function readConfig(root?: string): MangleConfig;
export function engineFiles(root?: string, config?: MangleConfig): string[];
export function privateMembers(root: string, file: string): PrivateMember[];
export function publicMembers(root: string, file: string, owner: string): string[];
export function mangledNames(root?: string): string[];
