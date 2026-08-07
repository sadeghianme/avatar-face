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
        raised: "#1c1c1c",
        line: "#262626",
      },
      borderRadius: { "2xl": "1rem", "3xl": "1.5rem" },
    },
  },
  plugins: [],
};
