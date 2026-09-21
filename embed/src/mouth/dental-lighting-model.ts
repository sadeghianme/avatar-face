type RGB = readonly [number, number, number];
const clamp = (value: number, min: number, max: number, fallback: number) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** Warm reflected oral light. Even the deepest shade retains colour instead
 * of crushing to black. Enamel keeps the illumination in its source photo. */
export function dentalLighting(lipColour: readonly number[] = [150, 90, 84], warmth = .5) {
  const [r, g, b] = [clamp(lipColour[0], 65, 220, 150), clamp(lipColour[1], 35, 170, 90), clamp(lipColour[2], 35, 170, 84)];
  const tone = clamp(warmth, 0, 1, .5);
  const colour = (red: number, green: number, blue: number): RGB => [Math.round(red), Math.round(green), Math.round(blue)];
  return {
    recess: colour(18 + r * .12, 8 + g * .085, 11 + b * .10),
    cavity: colour(24 + r * .22, 11 + g * .18, 15 + b * .19),
    tissue: colour(27 + r * .36, 15 + g * .31, 19 + b * .32),
    floor: colour(14 + r * .65, 11 + g * .48, 14 + b * .48),
    enamelBrightness: .98 - tone * .035,
    enamelSepia: tone * .10,
  };
}

/** This soft corner falloff is drawn BEHIND enamel, never across the teeth.
 * Positions are fractions of the neutral mouth width, independent of vowels. */
export const ORAL_CORNER_STOPS: readonly (readonly [number, number])[] = [
  [0, .42], [.12, .24], [.27, .06], [.40, 0], [.60, 0], [.73, .06], [.88, .24], [1, .42],
];

/** Restrained rear-crown falloff, applied once to the enamel texture's own
 * alpha. Front teeth stay untouched; rear teeth retain most of their light. */
export const ENAMEL_EDGE_STOPS: readonly (readonly [number, number])[] = [
  [0, .26], [.12, .16], [.24, .06], [.38, 0], [.62, 0], [.76, .06], [.88, .16], [1, .26],
];
