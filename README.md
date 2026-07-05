# FORJA — Kettlebell routine generator

Web app (PWA) to generate training routines with **a single kettlebell**
(ideally adjustable). Works **offline**, **installs** on mobile and saves
your history on the device. The sports programming logic lives in a
**rules engine** in pure JavaScript, separate from the interface.

No frameworks or runtime dependencies: plain HTML + CSS + JS.

---

## Features

- **Rules engine** that builds routines in blocks (Principal / Accesorios /
  Finalizador) with antagonist supersets, fatigue management and a time model.
- **Objective** (strength / metabolic) and **muscle focus** (legs / push / pull).
- **Pattern balance** (none / soft / hard with backtracking) to balance
  push-pull and hip-knee patterns.
- **Volume by time** (choose minutes) or **by structure** (choose number of exercises).
- **Pin exercises** to specific blocks; the rest is auto-completed.
- **Vary**: avoids repeating recent sessions (rotates exercises).
- **Adjustable kettlebell**: set your range and each exercise suggests its kg.
- **Editable pool**: add, edit and remove exercises (40 built-in, curated —
  see `docs/catalog-curation.md`).
- **Session history** with detail view and completion mark.
- **Progress chart**: per-session volume trend plus session/completion counts.
- **Daily readiness (mood autoregulation)**: a quick pre-session check —
  energy, sleep, sore zones — bends the generated session to how you show up
  today: scales volume, eases or raises suggested load, tightens the high-CNS
  budget on rough days, steers away from sore patterns, and suggests an easier
  objective when you're flat. Neutral by default; a dialed kg always wins.
- **Estimated 1-rep max (e1RM)**: per-exercise strength estimate (Epley) built
  from your logged sets and current working weight. Shown with a trend in
  History; once an exercise has enough data, the kg suggestion is derived from
  your e1RM at the block's rep target instead of the generic load tier. Grinds
  only — ballistics and carries progress by reps/density/time.
- **Guided workout timer that logs performance**: full-screen work/rest
  countdown that starts with the warm-up, walks the routine set by set and
  **records what you actually do** — adjust the reps of the set you just did
  during the rest, tap Facil/OK/Duro once per exercise, and on finish the
  session is auto-completed and saved with the real sets. Logged performance
  feeds the volume chart, the e1RM series and the double progression.
- **Protocol-true EMOM/AMRAP**: circuit templates run round-major (ex 1 → 2 →
  3, repeat), EMOM slots last exactly one minute (work + remainder as rest),
  AMRAP flows on 15 s transitions, and requested minutes scale rounds.
- **Rep-aware load suggestions**: the cold-start kg is shaded down at higher
  rep targets (no "heavy tier" kg at 15 reps), and e1RM-derived loads keep
  2 reps in reserve instead of prescribing your exact rep-max.
- **Skill tag**: technical lifts (snatch, get-up, windmill, cleans…) are
  tagged. Technique is assumed learned — the tag does not gate any level;
  it only keeps high-skill ISO lifts out of fatigued finishers. Grip-on-grip
  supersets are never rated optimal.
- **Per-exercise kg memory**: the weight you dial in is remembered and offered
  next time (the engine suggestion is the fallback).
- **Reorderable pins**: order and per-block assignment of pinned exercises.
- **Built-in guide** explaining each concept.

---

## Project structure

```
forja/
├── index.html              App (links styles and scripts; real PWA)
├── styles.css              Styles (design tokens in :root)
├── manifest.webmanifest    PWA manifest
├── sw.js                   Service worker (offline pre-cache of app shell)
├── assets/
│   └── icon.svg            App icon
├── src/
│   ├── engine.js           Rules ENGINE (no DOM). Defines window.FORJA.
│   ├── app.js              INTERFACE: state, storage, render, events.
│   └── pwa.js              Service worker registration.
├── build.js                Generates dist/forja.html (single-file version).
├── dist/
│   └── forja.html          Self-contained build (to copy to mobile).
├── test/
│   ├── engine.test.js      Engine tests (Node).
│   └── dom.test.js         UI tests (jsdom).
├── package.json
└── README.md
```

**Key separation:** `src/engine.js` does not touch the DOM or storage —
it only receives data and returns data. All sports logic is there and is
testable in Node. `src/app.js` handles screen, events and persistence.

---

## Development

The app loads scripts and (when installed) a service worker, so it is best
served over HTTP rather than opening the file directly:

```bash
npm run serve          # python3 -m http.server 8000
# then open http://localhost:8000
```

Edit `src/*.js`, `styles.css` or `index.html` and reload. No build step
needed for development.

> Note: opening `index.html` with `file://` also works for testing the logic,
> but the service worker does not register under `file://` (no offline pre-cache).

### Single-file build

To take the app to mobile as a single file (no server needed):

```bash
npm run build          # generates dist/forja.html
```

`dist/forja.html` inlines CSS and JS and embeds icon/manifest as `data:` URIs.
It works offline when opened because it does not depend on the network.

### Tests

```bash
npm test               # build + engine tests (Node) + UI tests (jsdom)
```

---

## Deploying as a PWA

Upload the folder (everything except `node_modules/`) to any static hosting
with HTTPS — for example **GitHub Pages**:

1. Push the repo to GitHub.
2. Settings → Pages → Deploy from branch → `main` / `root`.
3. Open the URL on mobile and use **"Add to home screen"**.

With HTTPS, the service worker (`sw.js`) pre-caches the app shell and the app
opens offline and installed in full screen.

---

## Data and persistence

Everything is saved on the device (no server). Storage uses a cascade:
`window.storage` (if present) → `localStorage` → memory.

Keys (`forja:*`):

- `forja:cfg` — generator configuration.
- `forja:hist` — session history.
- `forja:custom` — exercises added by the user.
- `forja:removed` — names of hidden base exercises.
- `forja:overrides` — field overrides by name for base exercises.

The effective pool is **recomputed** from `FORJA.BASE_CATALOG` applying
`overrides`, removing `removed` and adding `custom`. This way, expanding the
base catalog in code makes new exercises appear without overwriting user data
(automatic migration from the old full-pool format is included).

---

## The rules engine (technical summary)

`generate(pool, opts)` → picks a template by objective, scales it (time or
structure) and calls `buildRoutine`, which for each block:

- **RuleEngine** (`validateCombination`): validates a superset and assigns it
  quality based on the block (in A the rules are strict: no two high-CNS,
  no two ballistic grip exercises, no mixing strength with metabolic, no
  repeated pattern; the ideal pair is antagonist or a core active-rest exercise).
- **FatigueBudget**: limits per session the high-CNS and ballistic grip exercises.
- **BalanceTracker** + `priority`: distributes patterns (soft/hard), applies
  **focus**, **tier** (fundamental/accessory/optional) and a **recent-use penalty**
  (vary).
- **buildGreedy / buildBacktrack**: selection and pairing. HARD balance mode uses
  backtracking to avoid gaps in the quota.
- **preplaceFixed**: places pinned exercises by the user first.

Time model: each set = work (reps × tempo by dynamics) + rest (by rep range);
in a superset the rest is shared. Scaling by minutes adjusts sets and number
of exercises to approach the target duration.

---

## Roadmap (ideas)

- Multi-week programming (see `docs/multi-week-programming.md`): schedule,
  anchor lifts, periodization with deloads, "Entrenar hoy".
- Contextual help (ⓘ icons next to each control linking to the Guide).
- Edit the suggested default block for each exercise.
- Stable exercise ids (today every per-exercise store is keyed by the
  mutable name, making catalog renames a migration hotspot).

Done and shipped: export/import + linked auto-backup, CSV import, more
objective templates (strength endurance, power, EMOM/AMRAP), PNG/maskable
icons, guided timer with performance capture, resume-after-crash, wake lock.

---

## License

MIT.
