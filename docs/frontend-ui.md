# Dashboard UI kit, data layer and lint rules

Status: in place, 2026-10-06. Every page of the dashboard, the landing page
and the sign-in pages are built from the kit in `frontend/src/components/ui`;
every server call goes through a feature's data module; `npm run lint`
enforces both and CI runs it (`frontend-lint`). This is what each part is,
how to use it, and the few places that are deliberately different.

## Why

Before, each page drew its own buttons and fields from utility strings
(155 raw `<button>`s, 62 raw fields, 105 class strings over 160
characters), so a touch size, a focus ring or a dark-mode colour was fixed
page by page and drifted. And 36 components called the API client
directly, each with its own query keys and its own idea of what to refetch
after a write. The kit and the data modules make each of those a decision
taken once.

## The kit (`components/ui`)

One component per file, typed props, `forwardRef` where a caller needs the
element, and `className` added last so a caller can adjust it.

| Component | What it is |
|---|---|
| `Button`, `ButtonLink` | An action, or a link that looks like one. `variant`: primary (the one action a view is for), secondary, danger, ghost, contrast (ink on paper), overlay (on a picture), link, text, unstyled (see Exceptions). `size`: xs, sm, md (36px), lg (44px), xl (48px). `loading` shows a spinner and blocks a second press (`aria-busy`); `icon` / `iconEnd`. `type="button"` unless said |
| `IconButton` | One icon; `label` is required (its accessible name), `tooltip` shows it on hover |
| `CopyButton` | Copies `text`, says `copiedLabel` (and `copiedIcon`) for 1.5s |
| `ConfirmButton` | A destructive action asked once, in place: the question with Cancel (focused) and the confirm |
| `MenuButton` | A button that opens a short menu (the language menu) |
| `Field` | Label, control, hint, error, with the ids wired (`field-ids.ts`): the control inside gets its `id`, `aria-describedby` and `aria-invalid` from the field |
| `Input`, `PasswordInput`, `Textarea`, `Select`, `FileInput` | The controls; `Input` takes an `icon` and an `end` (a button inside the field) |
| `Checkbox`, `Switch`, `Slider`, `RangeInput` | Boolean and range controls; `Slider` is labelled with its value read out, `RangeInput` is bare |
| `SegmentedControl`, `Tabs`, `ChoiceCard`, `Chip` | Choices: a radiogroup or a tablist with one tab stop and arrow keys (`useRadioGroup`, its rules in `roving.ts`) |
| `Card` (+ `CardHeader`), `Disclosure` (+ `DisclosureGroup`), `Banner`, `EmptyState` | Surfaces: a card, a folding section, a status strip, an empty list |
| `Dialog`, `Drawer` | Modal surfaces with the focus kept inside and given back on close (`lib/focus.ts`) |
| `Badge`, `StatusBadge`, `ProgressBar`, `Spinner`, `Icon` | Small marks |
| `CodeBlock`, `InlineEdit`, `DropZone`, `ColorInput`, `ColorSwatch`, `Table` (`StackTable`) | Specific pieces used in more than one place |

### Looks are component classes

The kit's looks are classes in `index.css` (`@layer components`: `.btn-*`,
`.icon-btn-*`, `.input`, `.card`, `.badge-*`…), not utility strings inside
the components. A utility passed as `className` is in the utilities layer,
so it always wins over the kit's own (`px-3`, `rounded-full`), whatever
order Tailwind writes them in. `cx` joins classes and drops the falsy ones;
there is no class merging, on purpose: the stylesheet decides. A class that
only exists in a map must be written out literally (Tailwind finds classes
by reading the source).

### Touch

Under a coarse pointer every kit button, icon button, segment, switch,
checkbox row and range is at least 44px, and every text field at least
16px (iOS zooms into a smaller one). These rules are last in the
components layer of `index.css`. `xl` stays 48px. A `min-h-*` passed in
`className` replaces the kit's minimum, so pair it with `coarse:min-h-11`.

### Tokens

Colours that were hex in components are theme colours in
`tailwind.config.js`: `ink`, `panel`, `line`, `raised` (+ `hover`), `night`
(+ `glass`), `code`, `well`, `ember-*`, and `brand-*`. A TSX file has no
hex colour.

## Data

- **Keys**: `lib/queryKeys.ts` makes every query key (`queryKeys.avatar(org,
  id)`), and `keyMatches` documents the prefix matching invalidation relies
  on. No literal key is written anywhere else.
- **Modules**: each feature's `api.ts` (`avatars/api/`, a folder of four)
  holds its server calls as hooks: a query hook per read, a mutation hook
  per write that refreshes what the write changed in its `onSuccess`. The
  avatars' rule for what a change refreshes is in one place,
  `useAvatarCache`: `refresh` (the detail fetched again, re-signing its
  asset URLs, and the list) after a change to a picture or the rig;
  `merge` (the answer taken as the detail, no fetch) after a setting, so
  the preview does not restart mid-sentence.
- **Plain functions** in the same modules for requests that are a step of
  something rather than cached state: the lab's streamed and abortable
  runs, the speech stream, the share page's public endpoints, the
  wizard's per-creation requests (they go through its runner,
  `useCreationActions`, which puts each answer in the cache).
- **Stateful data hooks** that own their polling and cache: `useCreation`
  (one creation, polled with backoff), `useMouthKit` (the kit job),
  `useConsent` (terms, the remembered agreement, the dialog).
- **Providers** (`providers/auth`, `providers/org`) hold the session and
  the org list every page reads.

Components import `ApiError` from `lib/api` (to word a refusal) and
nothing else from it; lint makes that an error elsewhere.

## Lint rules (`frontend/eslint.config.js`)

- typescript-eslint recommended, with `no-floating-promises` and
  `no-misused-promises` (a promise passed as `onClick` loses its error).
- react-hooks recommended. No `exhaustive-deps` disable is left: an effect
  that must not re-run on a value reads it from a ref (the "latest" pattern,
  commented where used).
- jsx-a11y recommended.
- `no-restricted-syntax`: no raw `<button>`, `<input>`, `<select>`,
  `<textarea>` outside the kit.
- `no-restricted-imports`: no `api`, `fetchStream`, `postFormWithProgress`
  or `uploadWithProgress` outside the data modules, the three data hooks,
  the providers and `lib`.
- simple-import-sort: packages, then `@/…`, then relative.
- An unused disable comment is an error.

Formatting is Prettier (`printWidth` 120), applied once in its own commit;
`npm run format` writes it, `npm run format:check` checks it.

## Exceptions, and why

| Where | What | Why |
|---|---|---|
| `avatars/components/MarkCanvas.tsx` | raw `<button>`s | each face point is a positioned button over the photo, moved by the keyboard; not a kit button |
| `MarkCanvas`, `CropBox`, `PanPad` | two jsx-a11y rules off | keyboard surfaces: they take the focus and the arrow keys themselves (`role="application"` / `"group"`) |
| `AppShell` account row, `SampleSpeech` | `Button variant="unstyled"` | one-off compositions (an avatar and two lines; a white play card) that keep the kit's semantics and size themselves for touch |
| `VoicesPage`, `ReferenceRecording` | `jsx-a11y/media-has-caption` disabled | a recording the member just made: there is no text to caption |
| `features/share/api.ts` | `fetch` instead of the client | the public endpoints, with no account and no token |

## Checks

```
cd frontend
npm test               # node --test: the kit's rules, query keys, the wizard's model
node scripts/check-structure.mjs
npx tsc -b
npm run lint
npm run format:check
npm run build
```
