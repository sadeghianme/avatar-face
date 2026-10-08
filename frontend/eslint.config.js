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
const RAW_CONTROLS = ["button", "input", "select", "textarea", "label"].map((tag) => ({
  selector: `JSXOpeningElement[name.name='${tag}']`,
  message: `Use the UI kit (components/ui: Button, IconButton, Input, Select, Textarea, Checkbox, Switch, Label…) instead of a raw <${tag}>.`,
}));

// The kit's looks are the kit's: a className (any *ClassName prop, a
// template, or a cx() call) that spells out one of the component classes
// in index.css (a button, a card, a field, its label or error text, a
// badge, a chip, a choice, a range, a progress bar, a code block) is a kit
// component drawn by hand. Use the component instead.
const KIT_LOOKS = [
  "btn-[a-z0-9-]+",
  "icon-btn(-[a-z]+)?",
  "card",
  "label",
  "field-error",
  "input",
  "checkbox",
  "check-row",
  "slider",
  "badge(-[a-z]+)?",
  "chip-[a-z-]+",
  "choice-tile(-[a-z]+)?",
  "progress(-bar)?",
  "code-block",
];
const KIT_CLASS = String.raw`/(^|\s)(${KIT_LOOKS.join("|")})(\s|$)/`;
const KIT_CLASS_MESSAGE =
  "A kit look written by hand: use Button/ButtonLink (btn-*), IconButton (icon-btn-*), Card/Banner (card), " +
  "Label/Field (label), FieldError (field-error), Input (input), Checkbox (checkbox, check-row), Slider (slider), " +
  "Badge (badge-*), Chip (chip-*), ChoiceCard (choice-tile-*), ProgressBar (progress) or CodeBlock (code-block).";
const KIT_CLASSES = [
  `JSXAttribute[name.name=/[cC]lassName$/] Literal[value=${KIT_CLASS}]`,
  `JSXAttribute[name.name=/[cC]lassName$/] TemplateElement[value.raw=${KIT_CLASS}]`,
  `CallExpression[callee.name='cx'] Literal[value=${KIT_CLASS}]`,
].map((selector) => ({ selector, message: KIT_CLASS_MESSAGE }));

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
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
      "no-restricted-syntax": ["error", ...RAW_CONTROLS, ...KIT_CLASSES],
      // Server calls go through a feature's data hooks (features/<x>/api),
      // which also say what each call refreshes; ApiError, to word a
      // refusal, may be imported anywhere.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/api",
              importNames: ["api", "fetchStream", "postFormWithProgress", "uploadWithProgress"],
              message: "Call the server through the feature's api module (features/<x>/api), not from a component.",
            },
            {
              name: "react-i18next",
              importNames: ["useTranslation", "Trans", "withTranslation"],
              message: "Use useT (or translate) from @/i18n: its t takes only the keys en defines (i18n/types.ts).",
            },
          ],
        },
      ],
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
    // Where the client may be called (docs/frontend-ui.md, "Data"): the
    // features' api modules, the stateful data hooks that own their
    // polling and cache (one creation, the mouth kit's job, consent), the
    // session and org providers every page reads, and the client itself.
    files: [
      "src/features/*/api.ts",
      "src/features/*/api/**",
      "src/features/avatars/hooks/useConsent.tsx",
      "src/features/avatars/hooks/useCreation.ts",
      "src/features/avatars/hooks/useMouthKit.ts",
      "src/providers/**",
      "src/lib/**",
      // Where react-i18next's own hook is wrapped (useT).
      "src/i18n/**",
    ],
    rules: { "no-restricted-imports": "off" },
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
    // The tests: node --test (*.test.ts) and the rendering tests (*.test.tsx,
    // src/test). Their own program (tsconfig.test.json, with Node's types),
    // so the type-aware rules read them as tsc does. node:test's describe
    // and it return promises the runner itself awaits.
    files: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/test/**"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: false, project: "./tsconfig.test.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["describe", "it", "test"] }] },
      ],
      // A test mounts its own fixtures: a raw <button> in an action slot is
      // the caller's markup, not the app's.
      "no-restricted-syntax": "off",
    },
  },
  {
    // Build scripts; reference-proof.mjs also runs functions in a browser page.
    files: ["*.js", "scripts/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  }
);
