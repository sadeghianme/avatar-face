import plugin from "tailwindcss/plugin";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Warm orange accent, per the reference. One accent colour used
        // sparingly reads as deliberate; three gradients read as a demo.
        brand: {
          50: "#fff5ed",
          100: "#ffe8d5",
          200: "#ffd0aa",
          300: "#fdb174",
          400: "#fb8b3c",
          500: "#f97316",
          600: "#ea6a0c",
          700: "#c2540c",
        },
        // NEUTRAL black for dark mode — no blue cast. `ink` is the page,
        // `panel` the cards, `line` the hairlines between them.
        ink: "#0a0a0a",
        panel: "#141414",
        raised: { DEFAULT: "#1c1c1c", hover: "#242424" },
        line: "#262626",
      },
      borderRadius: { "2xl": "1rem", "3xl": "1.5rem", "4xl": "2rem" },
      // Marketing motion. Every one of these is applied through a
      // `motion-safe:` variant, so prefers-reduced-motion gets a still page.
      keyframes: {
        eq: { "0%, 100%": { transform: "scaleY(0.35)" }, "50%": { transform: "scaleY(1)" } },
        float: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-8px)" } },
        "rise-in": {
          "0%": { opacity: "0", transform: "translateY(14px) scale(0.98)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        caret: { "0%,49%": { opacity: "1" }, "50%,100%": { opacity: "0" } },
        marquee: { "0%": { transform: "translateX(0)" }, "100%": { transform: "translateX(-50%)" } },
        scan: {
          "0%": { transform: "translateY(-10%)", opacity: "0" },
          "12%": { opacity: "1" },
          "88%": { opacity: "1" },
          "100%": { transform: "translateY(110%)", opacity: "0" },
        },
        draw: { "0%": { strokeDashoffset: "1" }, "60%,100%": { strokeDashoffset: "0" } },
        glow: { "0%,100%": { opacity: "0.55" }, "50%": { opacity: "0.9" } },
        "tick-in": { "0%": { opacity: "0", transform: "scale(0.6)" }, "100%": { opacity: "1", transform: "scale(1)" } },
        // Two states sharing one slot: the second runs half a period behind.
        swap: {
          "0%,42%": { opacity: "1", transform: "translateY(0)" },
          "50%,92%": { opacity: "0", transform: "translateY(-6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        playhead: { "0%": { left: "0%" }, "100%": { left: "100%" } },
        type: { "0%": { width: "0ch" }, "55%,100%": { width: "var(--type-width)" } },
        fill: { "0%": { transform: "scaleX(0.12)" }, "70%,100%": { transform: "scaleX(var(--fill, 0.62))" } },
        // The creation wizard's loading pictures (features/avatars/components/wizard).
        shimmer: { "0%": { backgroundPosition: "150% 0" }, "100%": { backgroundPosition: "-50% 0" } },
      },
      animation: {
        eq: "eq 0.9s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
        "float-slow": "float 9s ease-in-out infinite",
        "rise-in": "rise-in 0.7s cubic-bezier(0.22,1,0.36,1) both",
        caret: "caret 1s step-end infinite",
        marquee: "marquee 36s linear infinite",
        scan: "scan 3.2s cubic-bezier(0.45,0,0.2,1) infinite",
        draw: "draw 5s ease-out infinite",
        glow: "glow 4s ease-in-out infinite",
        "tick-in": "tick-in 0.35s cubic-bezier(0.22,1,0.36,1) both",
        swap: "swap 6s ease-in-out infinite",
        playhead: "playhead 3.2s linear infinite",
        type: "type 5s steps(40, end) infinite",
        fill: "fill 6s cubic-bezier(0.22,1,0.36,1) infinite",
        shimmer: "shimmer 2.2s ease-in-out infinite",
      },
    },
  },
  plugins: [
    // `coarse:` — a finger is the main pointer (phones, tablets): the touch
    // sizes (44px targets) apply there and a mouse keeps the compact desktop.
    plugin(({ addVariant }) => addVariant("coarse", "@media (pointer: coarse)")),
  ],
};
