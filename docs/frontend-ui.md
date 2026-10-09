# Dashboard UI kit, data layer and lint rules

Status: in place, 2026-10-06 (tests, typed keys and API types added the
same day; every screen split into a hook and its sections, 2026-10-08).
Every page of the dashboard, the landing page
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
| `MenuButton` | A button that opens a short menu of exclusive choices (the language menu): the WAI-ARIA menu button pattern, the focus on the chosen item as it opens, Up/Down/Home/End and type-ahead (`roving.ts` `menuMove`, `typeaheadTarget`), Enter/Space to choose, Escape back to the button, Tab on from it |
| `Field` | Label, control, hint, error, with the ids wired (`field-ids.ts`): the control inside gets its `id`, `aria-describedby` and `aria-invalid` from the field; its error is a `FieldError` |
| `FieldError` | Error text (`.field-error`), `role="alert"` (announced as it appears) with an `id` to name in a control's `aria-describedby`; `live={false}` for an error that is part of what the page shows (a failed build's reason, a job's error in a list) |
| `Label` | A control's name (`htmlFor`), or a group's (`as="p"`, named in `aria-labelledby`); `look="plain"` for a row that wraps its control, `srOnly` |
| `Input`, `PasswordInput`, `Textarea`, `Select`, `FileInput` | The controls; `Input` takes an `icon` and an `end` (a button inside the field) |
| `Checkbox`, `Switch`, `Slider`, `RangeInput` | Boolean and range controls; `Slider` is labelled with its value read out, `RangeInput` is bare |
| `SegmentedControl`, `Tabs`, `ChoiceCard`, `Chip` | Choices: a radiogroup or a tablist with one tab stop and arrow keys (`useRadioGroup`, its rules in `roving.ts`); `ChoiceCard` looks: tile, card (a Card's surface to press), custom |
| `Card` (+ `CardHeader`), `Disclosure` (+ `DisclosureGroup`), `Banner`, `EmptyState` | Surfaces: a card (`as` div, section, form, article, aside, li, figure, details; `tone` default, muted (a flat grey well), warning, danger, success), a folding section, a status strip (`appearance` card or soft: a tinted box inside a form or a step), an empty list |
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

## Types

- **API types are generated.** `lib/api-schema.json` is the backend's
  OpenAPI document (`npm run api:schema` refreshes it from `../backend`,
  read-only); `lib/api-types.ts` is generated from it by openapi-typescript
  (`npm run gen:api`), never edited by hand, and CI fails when it differs
  from what the schema generates (`npm run check:api`). The names the code
  uses are aliases of its schemas (`lib/types.ts`, `creation/types.ts`, each
  feature's api module): `Schemas["AvatarDetail"]`, `Schemas["JobOut"]`…
  Where the server types a field loosely (a dict, a plain string),
  `Refine<Base, { field: Precise }>` says it precisely and may name only
  fields the schema has. Request bodies are the schemas' too, with
  `WithDefaults` for fields the server defaults. Still by hand, and said so
  where declared: what the server answers as an untyped dict (usage, rig
  anchors, clone jobs, TTS languages, an integration test, the public share
  endpoints, the simulator token).
- **Translation keys are typed.** Components take `t` from `useT()`
  (`@/i18n`; lint keeps react-i18next's own hook in `src/i18n`), whose key
  is a `MessageKey`: a key en defines, nested ones by path, plurals by
  their base. A key built from a value is typed by its values (the code
  lists are `as const` with a guard), so a misspelled key or a code without
  its sentence fails tsc. Each fr file is declared `satisfies
  Locale<typeof en…>`: same keys, any words. `translate` is `t` outside a
  component; `isMessageKey` checks a key made from a server's code at run
  time. Not i18next's CustomTypeOptions: with this many keys its overloads
  crash tsc 5.9 and type every result as its English literal.

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

## Big components

A screen with real state is a hook and the sections that draw it: the
hook (`features/<x>/hooks/use…`) holds the state, the requests and
the derived words; the component lays out presentational sections. Busy
and error states are the mutations' (`isPending`, `error`) rather than
flags kept beside them; state whose transitions belong together is a
reducer (a pure one, like `mouth-teeth-line.ts` or `crop.ts`, is
unit-tested). Every screen is built so: no component file over 300
lines, no component with more than five `useState`.

| Screen | Its state | Its sections |
|---|---|---|
| The creation wizard | `useNewWizard` | `wizard/WizardStep` (the screen under its heading), `NewWizard` the frame |
| Step 2, the photo | `usePhotoStep` | `wizard/photo/` |
| Step 3, preparing | `usePrepareScreen` | `wizard/prepare/` |
| Step 4, publishing | `usePublishEditor` | `wizard/publish/` |
| The avatar page | `useAvatarDetail` | `components/detail/` |
| Its Mouth panel | `useMouthPanel` | `components/mouth/` |
| Its Framing & scene | `useSceneEditor`, `useDragPan` | `components/scene/` |
| Marking the face | `useMarkFace` | `components/mark/` (`MarkFacePreview`, `FitReasons`) |
| The marking canvas | `useMarkCanvas`, `useElementWidth` | `mark/MarkLoupe` (and `placeLoupe`), `mark/MarkOutlines` |
| The crop box | `crop.ts` (the geometry, pure) | `components/crop/CropGuides` |
| Voices | `useVoicesPage`, `useVoiceRecorder` | `voices/components/` |
| The Speak panel | `useSpeakPanel` | |
| The share page | `useShareEngine`, `useShareSpeech` | `share/components/ShareComposer` |
| The reference lab | `useReferenceWorkspace`, `usePerformanceMouth` | `lab/components/reference/` |
| The landing demo | `demoScan.ts` (the intro, outside React) | `brand/VoiceMeter` |

Larger, and fine so: the pure modules (`wizard.ts`, `mouth-kit.ts`,
`face-marks.ts`), tested under node. Still to do: `useLipSyncComparison`,
the lab's streamed comparison, is a hook with thirteen `useState` that
move together (busy, playing, paused, the stream's statistics); a
reducer, with a test of the lip-sync workspace to hold it.

## Lint rules (`frontend/eslint.config.js`)

- typescript-eslint recommended, with `no-floating-promises` and
  `no-misused-promises` (a promise passed as `onClick` loses its error).
- react-hooks recommended. No `exhaustive-deps` disable is left: an effect
  that must not re-run on a value reads it from a ref (the "latest" pattern,
  commented where used).
- jsx-a11y recommended.
- `no-restricted-syntax`: no raw `<button>`, `<input>`, `<select>`,
  `<textarea>` or `<label>` outside the kit, and no kit look spelled out
  by hand: every component class in `index.css` (`btn-*`, `icon-btn-*`,
  `card`, `label`, `field-error`, `input`, `checkbox`, `check-row`,
  `slider`, `badge-*`, `chip-*`, `choice-tile-*`, `progress`,
  `code-block`) in any `className` or `*ClassName` (a string or a
  template) or `cx()` call is an error outside `components/ui`, naming the
  component to use. Exceptions: `MarkCanvas` (its face points are raw
  buttons) and the tests (a test mounts its own fixtures).
- `no-restricted-imports`: no `api`, `fetchStream`, `postFormWithProgress`
  or `uploadWithProgress` outside the data modules, the three data hooks,
  the providers and `lib`; no react-i18next `useTranslation` outside
  `src/i18n` (`useT`).
- The tests are linted with the type-aware rules too, through their own
  program (`tsconfig.test.json`).
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
| tests (`*.test.tsx`, `src/test`) | raw controls and kit classes allowed | a test mounts its own fixtures (a raw `<button>` in an action slot) |
| the landing page's cards (`Features`, `UseCases`, `Platform`, `Trust`) | hand-built surfaces, not `Card` | art-directed marketing surfaces (rounded-3xl, a 7% black hairline, a hover lift); not the app's card, and not the `card` class |
| `AvatarPageHead` back link | `iconButtonClass()` on a router `Link` | the kit's helper for an icon-only link; there is no IconButtonLink |

## Security notes

- **The session's tokens are in `localStorage`** (`lib/api.ts`, key
  `liveface.tokens`): the access token and the refresh token. Kept so on
  purpose for now. An httpOnly cookie would keep them out of reach of a
  script injected into the page, but it needs the API to set and read
  the cookie, CSRF protection on every write, and a refresh that works
  across the API's origin; that is a change to the auth contract, not to
  this dashboard. What holds meanwhile: React escapes everything it
  renders (no `dangerouslySetInnerHTML` in `src/`), nothing from a URL or
  a server string is put into the page as HTML, the client sends the
  token only to the API's own origin (`/api`), and a stored entry that is
  not a pair of tokens is dropped rather than parsed into every request
  (`getTokens`), and the dashboard's nginx sends a
  Content-Security-Policy (`frontend/nginx-security-headers.conf`: scripts
  from its own origin only, no inline script). The one page that writes
  HTML, the Simulator's customer page, escapes every value, accepts only
  an avatar id from a link, and runs in a frame without
  `allow-same-origin`, so nothing in it can read the tokens
  (`docs/process.md`, "Security headers"). What would help most next:
  refresh tokens the server can revoke (the backend's backlog). Revisit
  this decision when that lands.
- **No debug handles of the dashboard's own in a production build.**
  `window.__queryClient` (main.tsx) and `window.__lfEngine`
  (AvatarPreview, for the visual harnesses) are set only under
  `import.meta.env.DEV`, which Vite drops from the build. The embed
  engine's console handle (`__liveface`) is the engine's own and opt-in
  (`debug: true`, or `data-debug` / `?liveface-debug` on the widget):
  the share page and the landing demo opt in, for measuring them live;
  the dashboard's previews do not.
- **Retries**: a query is retried once after a network error or a 5xx,
  never after a 4xx other than 408 and 429 (`lib/queryClient.ts`): a
  refused request is not sent twice.

## Tests

- `npm test`: node --test over `src/**/*.test.ts`, the pure logic (the
  kit's rules, query keys, the wizard's model, the mouth kit, the crop's
  geometry, retries…), run by stripping their types.
- `npm run test:ui`: Vitest with Testing Library in jsdom over
  `src/**/*.test.tsx`: every kit component's behaviour and accessibility
  contract (`components/ui/*.test.tsx`), and every screen (sign-in, the
  library, the avatar page with its Mouth panel, Framing & scene, face
  marking, marking canvas and crop box, the wizard's steps 1 to 4, voices
  and the Speak panel, the share page, the reference lab) against a
  mocked API. A screen split into a hook and sections was tested first
  and its tests pass on the screen before the split too. `src/test/` has
  what they share: the
  API mocked at the network (`server.ts`: fetch and XHR answered from a
  route table, so the real client, the data modules and React Query run),
  `renderScreen` (main.tsx's providers, a router at a route), jsdom's
  missing pieces (`dom-shims.ts`: layout for focusable elements, `<dialog>`
  with Escape, matchMedia, observers, a PointerEvent for drags) and
  fixtures. Only tests may import
  it (the structure check). The engine's canvases are stood in for by
  markers (`vi.mock`). axe-core runs every WCAG 2.1 A/AA rule that needs
  no layout over the whole kit (`a11y.test.tsx`) and over each screen as
  it first shows (`expectAccessible`, `src/test/axe.ts`); colour contrast
  needs real pixels and is the visual audit's.
- Both are type-checked (`npm run typecheck`: the app, then
  `tsconfig.test.json`).
- Both are measured: `npm run test:coverage` (node --test) and `npm run
  test:ui:coverage` (Vitest) run them with coverage, each held to its own
  floors; CI runs these two in place of the plain ones (`docs/process.md`,
  "Coverage").

## Checks

```
cd frontend
npm test               # node --test: the pure logic
npm run test:ui        # Vitest + Testing Library: the kit and the screens
npm run test:coverage  # the first with coverage (coverage/node/lcov.info)
npm run test:ui:coverage   # the second with coverage (coverage/ui/index.html)
node scripts/check-structure.mjs
npm run typecheck      # the app, then the tests
npm run check:api      # api-types.ts matches the committed schema
npm run lint
npm run format:check
npm run build
```
