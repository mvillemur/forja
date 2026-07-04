# Exercise-pool curation — audit of `BASE_CATALOG`

A per-exercise review of the built-in pool in `src/engine.js` (classification:
pattern, dynamics, symmetry, CNS, grip, load, equipment, tier). The goal is
that every attribute the engine reasons about — the time model, the fatigue
budget, the superset rules — reflects how the movement actually behaves with a
single kettlebell. Fixes were applied in code; "kept as-is" calls are recorded
here so they are deliberate, not accidental.

## Fixes applied

| Exercise | Change | Why |
|---|---|---|
| Hip Halos | `UNILATERAL` → `BILATERAL` | The bell passes around the waist continuously with both hands; there is no per-side hold. Matches Halos / Kneeling Around The Worlds. As `UNILATERAL` the time model billed it double (2× work + inter-side rest). |
| Peso Muerto Rumano / Fijo | `grip: false` → `true` | A heavy hinge held in the hands is classic grip work. Inconsistent with Two Hand Row (same two-hand hold, lighter, already `grip: true`). Weighted 0.5 in the budget (non-ballistic). |
| Single-Leg Deadlift | `grip: false` → `true` | One-hand hold on a medium bell — the same forearm demand as the one-hand row, which is flagged. |
| Windmill | `grip: true` → `false` | In the overhead lockout the bell rests on the forearm; the limiter is shoulder/trunk stability, not grip. Was consuming 0.5 grip budget for nothing. |
| KB Push-Ups | equipment `[KB]` → `[KB, FLOOR]` | Pushups on the bell need floor space, same as Close Grip Pushup. |
| *(new)* Floor Press (una mano) | added: `PUSH_H`, `STRENGTH`, `UNILATERAL`, CNS `MEDIUM`, `[KB, FLOOR]`, load `HEAVY` | Horizontal push was the thinnest pattern (2 entries, both bodyweight/light). The one-arm floor press is the classic single-KB heavy horizontal press and gives PUSH_H a loadable, e1RM-trackable grind. |

## Floor equipment was unreachable (app fix)

The generator UI shows a locked, always-on **"Suelo"** chip, but the stored
config only ever contained `["KB"(, "BARBELL")]`, so `filterByEquipment`
silently excluded every `FLOOR` exercise (Burpees, Close Grip Pushup,
Tuck Jumps) from generation — including as pins. `app.js` now includes
`FLOOR` in the default config, migrates older stored configs on load, and the
pull-up-bar toggle preserves it. This makes the UI and the engine agree.

## Kept as-is (deliberate)

- **Upright Row** — often dropped from curated programs for shoulder
  impingement risk, but with a kettlebell the wrist path is free and it is the
  **only KB-equipment vertical pull** in the pool. Removing it would leave
  PULL_V empty for anyone without a pull-up bar and starve the pattern
  balancer. It stays `OPTIONAL` tier (penalized in selection) and light.
- **Four horizontal rows** (one-hand / two-hand / alternating / ballistic) —
  looks redundant, but they differ in symmetry and dynamics, which is exactly
  what the superset validator and the vary/rotation logic select on. Pulls are
  scarce with one bell; the variety is load-bearing.
- **Pit Squats** — niche name, but a valid distinct knee-dominant slot
  (bilateral, heavy) alongside the goblet squat.
- **Turkish Get-Up `grip: true`** — the bell spends time pressed and racked,
  but the floor-press and transition phases are genuinely forearm-limited and
  the long per-side set (60 s) accumulates real grip fatigue; consistent with
  the fatigue-model doc (`training-model-gaps.md`, gap 3).
- **Suitcase Carry load `MEDIUM`** — a carry can go heavier, but the engine
  uses it as an active-rest partner (`CORE` + `LOW` CNS); medium keeps that
  role honest.
- **Goblet Overhead March CNS `MEDIUM`** — intentionally *not* active rest:
  an overhead hold while marching is too demanding to pair as recovery.
- **Mixed Spanish/English names** — inconsistent, but names are the primary
  key for user overrides (`forja:overrides`), removals, per-exercise kg memory
  and e1RM history. Renaming would orphan user data; not worth it.

## Pattern coverage after curation (KB-only user, floor available)

| Pattern | Count | Notes |
|---|---|---|
| HIP | 4 | hinge + 2 swing variants + SLDL |
| KNEE | 5 | 2 squats, lunges, 2 jump/plyo |
| PULL_H | 4 | symmetry/dynamics spread (see above) |
| PULL_V | 1 (+1 with bar) | Upright Row; Dominadas needs the bar chip |
| PUSH_H | 3 | 2 pushup variants + heavy floor press |
| PUSH_V | 5 | strict/push/goblet/rotational/bottoms-up |
| CORE | 9 | holds, carries, TGU, windmill — feeds active-rest pairing |
| HYBRID | 10 | cleans, snatch, C&P, thruster, burpees… |

PULL_V remains the structurally thin pattern — a one-bell limitation (there is
no good vertical pull with a kettlebell besides the upright-row family). If it
ever needs depth, candidates are KB Pullover (floor) or renegade-row variants.
