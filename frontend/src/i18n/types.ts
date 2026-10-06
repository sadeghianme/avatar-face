/**
 * Typed translation keys. English is the source of truth: `t("…")` with a
 * key en does not define (misspelled, removed) fails tsc, and every other
 * language defines exactly en's keys (`Locale`, checked where each of its
 * files is declared). A key built from a value (`createErr_${code}`) is
 * typed by the values it can take, so a code without its sentence fails
 * too.
 *
 * Not i18next's own key typing (CustomTypeOptions): with this many keys
 * its overloads crash tsc ("No error for last overload signature"), take
 * seconds per check and type every result as its English literal. This is
 * one function type: a key, its values, a string.
 */
import type { messages } from "@/i18n/locales/en";

type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

type PluralSuffix = "zero" | "one" | "two" | "few" | "many" | "other";
type PluralBase<K> = K extends `${infer Base}_${PluralSuffix}` ? Base : never;

type Leaf = Leaves<typeof messages>;

/** A key `t` takes: a string of en by its dotted path (`prep.detect`); a
 *  plural by its base (`avatarCount`, with `count`). */
export type MessageKey = Leaf | PluralBase<Leaf>;

/** Interpolation values (`{{name}}`), `count` for a plural. */
export type MessageValues = Record<string, unknown>;

/** The app's `t` (useT, translate): a key en defines, its values, a string. */
export type Translate = (key: MessageKey, values?: MessageValues) => string;

/** The shape of a locale as en has it, with any words: another language's
 *  file is declared `satisfies Locale<typeof en…>`, so a key missing or
 *  extra on either side fails tsc. */
export type Locale<T> = { [K in keyof T]: T[K] extends string ? string : Locale<T[K]> };
