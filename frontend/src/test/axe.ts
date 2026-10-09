/**
 * axe-core over what a test rendered: every WCAG A/AA rule it can check
 * without a layout. Colour contrast needs real pixels (jsdom paints
 * none), so it is the visual audit's, not this one's.
 *
 *   await expectAccessible(container);
 */
import axe from "axe-core";
import { expect } from "vitest";

export async function axeViolations(root: Element): Promise<string[]> {
  const results = await axe.run(root, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

export async function expectAccessible(root: Element): Promise<void> {
  expect(await axeViolations(root)).toEqual([]);
}
