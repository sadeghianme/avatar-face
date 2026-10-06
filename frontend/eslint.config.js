// ESLint (flat config). `npm run lint`; CI runs it. What each rule is for:
// docs/frontend-ui.md, "Lint rules".
import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

// Raw controls belong to the UI kit (components/ui). Everywhere else a
// button, field, select or textarea is the kit's, so its look, its touch
// size and its accessibility come with it.
const RAW_CONTROLS = ["button", "input", "select", "textarea"].map((tag) => ({
  selector: `JSXOpeningElement[name.name='${tag}']`,
  message: `Use the UI kit (components/ui: Button, IconButton, Input, Select, Textarea, Checkbox, Switch…) instead of a raw <${tag}>.`,
}));

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src/devtools"] },
  // A disable comment that no longer disables anything is an error: the
  // ones left each say why they are there.
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // TypeScript knows what is defined; this rule only misreads types.
      "no-undef": "off",
      // Promises: an unhandled one loses its error; one passed where a
      // void callback is expected (onClick={save}) loses it too.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Deliberate focus moves (a dialog's safe answer, the sign-in field)
      // are on kit components, which this rule does not see.
      "jsx-a11y/no-autofocus": ["error", { ignoreNonDOM: true }],
      // A warning while the features move to the kit; an error once none is left.
      "no-restricted-syntax": ["warn", ...RAW_CONTROLS],
      "simple-import-sort/imports": [
        "error",
        // Packages, then the app's own (@/…), then relative files.
        { groups: [["^\\u0000"], ["^node:", "^@?\\w"], ["^@/"], ["^\\."]] },
      ],
      "simple-import-sort/exports": "error",
    },
  },
  {
    // The kit is where raw controls live.
    files: ["src/components/ui/**"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // Drawing surfaces (docs/frontend-ui.md, "Exceptions"): a point you
    // drag on a face is a positioned <button>, not a kit button.
    files: ["src/features/avatars/components/MarkCanvas.tsx"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // Keyboard surfaces: the crop frame, the face-marking canvas and the
    // framing's position pad take the focus and the arrow keys themselves
    // (role="application" / "group"), which jsx-a11y cannot know.
    files: [
      "src/features/avatars/components/MarkCanvas.tsx",
      "src/features/avatars/components/CropBox.tsx",
      "src/features/avatars/components/PanPad.tsx",
    ],
    rules: {
      "jsx-a11y/no-noninteractive-element-interactions": "off",
      "jsx-a11y/no-noninteractive-tabindex": "off",
    },
  },
  {
    // Tests run under node --test, which strips their types; tsconfig
    // leaves them out (Node's test types are not installed), so no
    // type-aware rules there.
    files: ["src/**/*.test.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // Build scripts; reference-proof.mjs also runs functions in a browser page.
    files: ["*.js", "scripts/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  }
);
