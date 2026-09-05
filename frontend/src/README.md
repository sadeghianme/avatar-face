# Dashboard source layout

```
src/
├── main.tsx            entry: providers + router
├── app/                composition root: routes, route guards
├── features/           one folder per product area (see below)
├── components/         shared UI only
│   ├── ui/             Icon, Spinner, StatusBadge — used by 3+ features
│   └── layout/         AppShell, OrgSwitcher, LanguageMenu
├── providers/          React contexts: auth, org, theme
├── lib/                framework-free code: api client, types, image, recorder
├── i18n/               i18next init + locales/<lang>/<feature>.ts
└── devtools/           console harnesses; imported by nothing
```

## Features

```
features/<name>/
├── index.ts            the ONLY thing other code may import
├── pages/              route components
└── components/         private to this feature
```

A feature owns its pages and the components only it uses. Two thirds of the
old flat `components/` folder was private to a single page; it now lives with
that page, so "what can I change without breaking someone else?" is answered by
the folder you are in.

## The three rules

Enforced by `npm run check`, which runs before every build:

1. **Features are black boxes.** Outside `features/x/`, import `@/features/x`
   and nothing deeper. If you need a component from another feature, export it
   from that feature's `index.ts` — that is a deliberate public-API decision,
   not a path.
2. **Shared layers never depend on features.** `components/`, `lib/`,
   `providers/`, `i18n/` import from each other and from packages, never from
   `@/features`.
3. **Cross-folder imports are absolute** (`@/…`). Relative imports never climb
   (`../`), so moving a file cannot silently rewire another.

## Adding things

- **A new screen in an existing area:** `features/<area>/pages/Foo.tsx`, export
  it from the feature's `index.ts`, add the route in `app/App.tsx`.
- **A new area:** new `features/<area>/` with an `index.ts`; strings go in
  `i18n/locales/en/<area>.ts` and `fr/<area>.ts` (the check insists both exist
  with the same keys).
- **A component used by two features:** promote it to `components/ui/` only if
  it is genuinely generic. If it belongs to one feature and the other just
  needs it, export it from the owner's `index.ts` instead.
- **Strings** go in the feature file that uses them; `common.ts` is for keys
  used by more than one feature or by shared components.

## Where things deliberately are NOT

- No `utils/`. Buckets named after nothing collect everything. Framework-free
  helpers go in `lib/` with a name that says what they are (`lib/image.ts`).
- No `store/`. Server state is TanStack Query's cache; session state is the
  two providers; UI preference is `providers/theme`. A second store would copy
  the first and drift.
- No `hooks/` yet. Feature hooks live in their feature; a hook used by three
  features earns `lib/`.
