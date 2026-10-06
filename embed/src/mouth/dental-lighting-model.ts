type RGB = readonly [number, number, number];
const clamp = (value: number, min: number, max: number, fallback: number) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** Warm reflected oral light. Even the deepest shade retains colour instead
 * of crushing to black. Enamel keeps the illumination in its source photo. */
export function dentalLighting(lipColour: readonly number[] = [150, 90, 84], warmth = 0.5) {
  const [r, g, b] = [
    clamp(lipColour[0], 65, 220, 150),
    clamp(lipColour[1], 35, 170, 90),
    clamp(lipColour[2], 35, 170, 84),
  ];
  const tone = clamp(warmth, 0, 1, 0.5);
  const colour = (red: number, green: number, blue: number): RGB => [
    Math.round(red),
    Math.round(green),
    Math.round(blue),
  ];
  return {
    recess: colour(18 + r * 0.12, 8 + g * 0.085, 11 + b * 0.1),
    cavity: colour(24 + r * 0.22, 11 + g * 0.18, 15 + b * 0.19),
    tissue: colour(27 + r * 0.36, 15 + g * 0.31, 19 + b * 0.32),
    floor: colour(14 + r * 0.65, 11 + g * 0.48, 14 + b * 0.48),
    enamelBrightness: 0.98 - tone * 0.035,
    enamelSepia: tone * 0.1,
  };
}

/** This soft corner falloff is drawn BEHIND enamel, never across the teeth.
 * Positions are fractions of the neutral mouth width, independent of vowels. */
export const ORAL_CORNER_STOPS: readonly (readonly [number, number])[] = [
  [0, 0.42],
  [0.12, 0.24],
  [0.27, 0.06],
  [0.4, 0],
  [0.6, 0],
  [0.73, 0.06],
  [0.88, 0.24],
  [1, 0.42],
];

/** Restrained rear-crown falloff, applied once to the enamel texture's own
 * alpha. Front teeth stay untouched; rear teeth retain most of their light. */
export const ENAMEL_EDGE_STOPS: readonly (readonly [number, number])[] = [
  [0, 0.26],
  [0.12, 0.16],
  [0.24, 0.06],
  [0.38, 0],
  [0.62, 0],
  [0.76, 0.06],
  [0.88, 0.16],
  [1, 0.26],
];
