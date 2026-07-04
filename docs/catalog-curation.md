# Exercise-pool curation — audit of `BASE_CATALOG`

A per-exercise review of the built-in pool in `src/engine.js` (classification:
pattern, dynamics, symmetry, CNS, grip, load, equipment, tier), followed by a
naming pass. The goal is that every attribute the engine reasons about — the
time model, the fatigue budget, the superset rules — reflects how the movement
actually behaves with a single kettlebell. Fixes were applied in code;
"kept as-is" calls are recorded here so they are deliberate, not accidental.

## Naming convention

The original names mixed languages and styles at random ("Remo a una mano"
next to "Two Hand Row"; "Kettlebell Swings (Dos manos)" next to
"Alternating Swings"; "Alt Lunges" abbreviated). The curated convention:

- **Spanish structure, international kettlebell terms untranslated** — Swing,
  Clean, Press, Snatch, Get-Up, Windmill, Thruster, Halo, Goblet, Rack,
  Bottoms-Up, Push Press, Floor Press, High Pull, Carry are used as-is, the
  way Spanish-speaking gyms actually say them. Movements with a natural
  Spanish name use it: Remo, Sentadilla, Zancada, Peso Muerto, Flexiones,
  Dominadas, Marcha.
- **Singular for loaded lifts**; the usual plural stays for bodyweight rep
  drills (Flexiones, Dominadas, Burpees, Tuck Jumps).
- **Parenthetical modifiers only to disambiguate within a family** — "Swing
  (dos manos)" vs "Swing (alterno)"; "Remo (una mano/dos manos/alterno)".
  Inherently one-arm lifts (Snatch, Windmill, Turkish Get-Up, Floor Press)
  carry no modifier; the UI already renders "/ lado" on unilateral doses.
- ASCII only (no accents), matching the codebase's string convention.

Names are the primary key for every per-exercise store (overrides, removals,
kg memory, rep targets, pins, manual drafts, history/e1RM). `F.RENAMED` maps
every old name to its curated name, and `migrateRenamedExercises()` (app.js)
remaps all of those stores once on load, so existing user data follows.

## Merged duplicates

Four pairs had **identical engine metadata** (pattern, dynamics, symmetry,
CNS, grip, load) — the difference was a start-position or technique detail,
not a distinct programming slot, so each pair collapsed into one entry:

| Merged | Into | Note |
|---|---|---|
| Swing Cleans + Dead Cleans | **Clean (una mano)** | swing-start vs dead-start is coaching detail |
| Clean & Press Combinado + Dead Clean Push Press | **Clean + Press** | strict vs push-press finish, same slot (both were FUNDAMENTAL) |
| Close Grip Pushup + KB Push-Ups | **Flexiones (agarre cerrado)** | pushup on the bell = close-grip pushup with a prop |
| Kneeling Around The Worlds + Hip Halos | **Around the World** | same circular pass, standing vs kneeling |

Migration rule for merges: kg keeps the heavier dialed weight; a merged
exercise stays hidden only if the user had removed **every** old variant.

## Metadata fixes applied

(Names below are the curated ones.)

| Exercise | Change | Why |
|---|---|---|
| Around the World (ex Hip Halos) | `UNILATERAL` → `BILATERAL` | The bell passes around the body continuously with both hands; there is no per-side hold. As `UNILATERAL` the time model billed it double (2× work + inter-side rest). |
| Peso Muerto Rumano | `grip: false` → `true` | A heavy hinge held in the hands is classic grip work. Inconsistent with Remo (dos manos) (same two-hand hold, lighter, already `grip: true`). Weighted 0.5 in the budget (non-ballistic). |
| Peso Muerto (una pierna) | `grip: false` → `true` | One-hand hold on a medium bell — the same forearm demand as the one-hand row, which is flagged. |
| Windmill | `grip: true` → `false` | In the overhead lockout the bell rests on the forearm; the limiter is shoulder/trunk stability, not grip. Was consuming 0.5 grip budget for nothing. |
| Flexiones (agarre cerrado) | equipment requires `FLOOR` | Pushups need floor space. |
| *(new)* Floor Press | added: `PUSH_H`, `STRENGTH`, `UNILATERAL`, CNS `MEDIUM`, `[KB, FLOOR]`, load `HEAVY` | Horizontal push was the thinnest pattern (2 entries, both bodyweight/light). The one-arm floor press is the classic single-KB heavy horizontal press and gives PUSH_H a loadable, e1RM-trackable grind. |

## Floor equipment was unreachable (app fix)

The generator UI shows a locked, always-on **"Suelo"** chip, but the stored
config only ever contained `["KB"(, "BARBELL")]`, so `filterByEquipment`
silently excluded every `FLOOR` exercise (Burpees, Flexiones, Tuck Jumps)
from generation — including as pins. `app.js` now includes
`FLOOR` in the default config, migrates older stored configs on load, and the
pull-up-bar toggle preserves it. This makes the UI and the engine agree.

## Kept as-is (deliberate)

- **Remo Vertical** (upright row) — often dropped from curated programs for
  shoulder impingement risk, but with a kettlebell the wrist path is free and
  it is the **only KB-equipment vertical pull** in the pool. Removing it would
  leave PULL_V empty for anyone without a pull-up bar and starve the pattern
  balancer. It stays `OPTIONAL` tier (penalized in selection) and light.
- **Four horizontal rows** (una mano / dos manos / alterno / balistico) —
  looks redundant, but they differ in symmetry and dynamics, which is exactly
  what the superset validator and the vary/rotation logic select on. Pulls are
  scarce with one bell; the variety is load-bearing.
- **Pit Squat** — niche name, but a valid distinct knee-dominant slot
  (bilateral, heavy) alongside the goblet squat.
- **Turkish Get-Up `grip: true`** — the bell spends time pressed and racked,
  but the floor-press and transition phases are genuinely forearm-limited and
  the long per-side set (60 s) accumulates real grip fatigue; consistent with
  the fatigue-model doc (`training-model-gaps.md`, gap 3).
- **Suitcase Carry load `MEDIUM`** — a carry can go heavier, but the engine
  uses it as an active-rest partner (`CORE` + `LOW` CNS); medium keeps that
  role honest.
- **Marcha Overhead CNS `MEDIUM`** — intentionally *not* active rest: an
  overhead hold while marching is too demanding to pair as recovery. (Old
  name "Goblet Overhead March" was self-contradictory — goblet is a chest
  hold — so the rename drops "Goblet".)

## Pattern coverage after curation (KB-only user, floor available)

| Pattern | Count | Notes |
|---|---|---|
| HIP | 4 | Peso Muerto Rumano, 2 swing variants, Peso Muerto (una pierna) |
| KNEE | 5 | 2 squats, Zancada, 2 jump/plyo |
| PULL_H | 4 | symmetry/dynamics spread (see above) |
| PULL_V | 1 (+1 with bar) | Remo Vertical; Dominadas needs the bar chip |
| PUSH_H | 2 | Flexiones + heavy Floor Press |
| PUSH_V | 5 | Militar / Push Press / Goblet / Rotacional / Bottoms-Up |
| CORE | 8 | holds, carries, TGU, Windmill — feeds active-rest pairing |
| HYBRID | 8 | Clean family, Snatch, High Pull, Thruster, Curl + Press, Burpees |

PULL_V remains the structurally thin pattern — a one-bell limitation (there is
no good vertical pull with a kettlebell besides the upright-row family). If it
ever needs depth, candidates are KB Pullover (floor) or renegade-row variants.
