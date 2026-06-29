# Training-model gaps — next iteration

A review of the **theory and technical model** in `src/engine.js` from a
medical / physical-training (strength & conditioning) point of view. The engine
is sound in its core ideas — antagonist supersets, a per-session CNS + grip
fatigue budget, strength-before-metabolic ordering, grip as the limiter between
ballistics. The items below are where the **physiological model diverges from
the catalog and the prescription/time math**. Ordered by impact.

Each gap lists: the symptom, where it lives, why it matters for a trainee, and a
suggested direction. These are intentionally specification-level, not patches.

---

## 1. Unilateral work is counted as a single side (≈2× under-count) — HIGH

**Where:** `setWorkSec` (`src/engine.js`), dose render `dose = …${sets}x${reps}` (`src/app.js`).

`setWorkSec` computes `reps × tempo` with **no symmetry factor**, and the UI
shows `4x5` with no "/lado". Roughly a third of the catalog is
`SIM.UNILATERAL` — One-Arm Snatch, Remo a una mano, Rotational Press,
Bottoms-Up Press, Single-Leg Deadlift, Windmill, Suitcase Carry, Half-Racked
Marches, Turkish Get-Up, the Clean & Press / Push-Press variants.

**Why it matters:** both sides must be trained, so the real working time **and**
the real local/systemic volume of every unilateral slot is ~double the model.
A "45-minute" routine heavy in unilateral work runs well over target, and the
fatigue budget (CNS / grip) only sees half the true dose.

**Direction:** add a per-side multiplier to the time model for `UNILATERAL`
(×2 work + an inter-side micro-rest), and render the dose as `4×5 / lado` so the
trainee knows the rep count is per side.

---

## 2. All ISO / carry / Get-Up sets are a flat 35 s of work — HIGH

**Where:** `HOLD_ISO = 35` → `setWorkSec` returns it for every `DIN.ISO`
exercise (`src/engine.js`); dose renders `${sets}x ~35s` (`src/app.js`).

A flat 35 s fits a Halo or a Goblet March, but not loaded **carries**
(Suitcase Carry, Half-Racked Marches) or the **Turkish Get-Up**, which are long,
per-side movements — a single TGU set is minutes, not 35 seconds. These
low-CNS carries are exactly what the engine pulls in as **"active rest"**
partners (`isActiveRest`), so the under-estimate hits the most common pairings
and deflates both block and total-session duration.

**Direction:** give ISO exercises a per-exercise hold/duration (or a
duration-by-subtype: short stabilization holds vs. timed carries vs. grind
lifts like the TGU) instead of one global constant; combine with the
per-side factor from Gap 1 for unilateral carries/TGU.

---

## 3. Grip fatigue budget ignores non-ballistic grip work — MEDIUM

**Where:** `_grip(e) = e.grip && e.dynamics === DIN.BALLISTIC` (`src/engine.js`).

The grip budget only accumulates on **ballistic** grip exercises. But heavy
unilateral rows, loaded carries, the Turkish Get-Up and the Bottoms-Up Press
are strongly grip/forearm-limited and flagged `grip: true`, yet consume **zero**
grip budget. A session can stack several grip-intensive grinds past realistic
forearm endurance — the exact failure the budget exists to prevent.

**Direction:** count grip for any `grip` exercise, optionally weighted
(ballistic = high, heavy carry/row = medium), rather than gating on
`BALLISTIC` only.

---

## 4. HIP↔KNEE treated as a true antagonist "recovery" pair — MEDIUM

**Where:** `areAntagonists` returns true for `LEG_FAMILY` cross-pairs;
`validateBlockA` then labels it `OPTIMAL — "el grupo en reposo se recupera."`
(`src/engine.js`).

Unlike a push/pull pair, a hinge (RDL/Swing) and a front-loaded squat
(Goblet/Pit Squat) both load glutes, hamstrings and spinal erectors — there is
no genuine "resting group." Block A can therefore grind the lower body twice
and call it active recovery, contradicting the engine's own rationale.

**Direction:** downgrade lower-body cross-pattern pairs (HIP+KNEE) from
`OPTIMAL` to `ACCEPTABLE`, reserving the antagonist-recovery label for true
upper-body push/pull (and core active-rest) pairs.

---

## 5. No warm-up / ramp-up before high-CNS ballistic work — MEDIUM

**Where:** `TEMPLATES` (`src/engine.js`) — every template opens Block A.

Each objective starts Block A straight into ballistic, high-CNS hip work
(Swings, Snatches, Clean & Press). From an injury-prevention standpoint,
ballistic posterior-chain loading with no programmed preparation (mobility +
ramp-up sets) is the main medical gap in the output.

**Direction:** prepend a fixed preparatory block/note (mobility + 1–2 ramp-up
sets of the first ballistic lift) before Block A, or at least surface a
warm-up reminder in the routine output.

---

## 6. Antagonist superset rest is halved — may under-recover heavy strength pairs — LOW

**Where:** `rest = max(restA, restB) * 0.5` in `elementTimeSec` (`src/engine.js`).

For SP-range strength (150 s → 75 s), the effective recovery for the primary
lift between its own sets ≈ partner work + 75 s + transition ≈ ~100 s, below the
~150 s a maximal-strength set wants. Antagonist pairing largely preserves
performance in the literature, so this is a deliberate-tradeoff caveat: the
"Fuerza" template trends toward strength-endurance for its heaviest pairs.

**Direction:** if maximal strength is the intent for Block A, keep closer to the
full SP rest for SP-range antagonist pairs (e.g. a smaller reduction factor for
`SP`, larger for `HP`/`ME`).

---

### Summary

| # | Gap | Severity | Primary fix surface |
|---|-----|----------|---------------------|
| 1 | Unilateral counted as one side (~2× off) | High | `setWorkSec`, dose render |
| 2 | Flat 35 s for all ISO/carry/TGU | High | `HOLD_ISO` → per-exercise duration |
| 3 | Grip budget ignores non-ballistic grip | Medium | `_grip` |
| 4 | HIP↔KNEE labeled antagonist recovery | Medium | `validateBlockA` quality |
| 5 | No warm-up before ballistic Block A | Medium | `TEMPLATES` / output |
| 6 | Superset rest halved for strength pairs | Low | `elementTimeSec` rest factor |

Gaps 1–3 are concrete model/accuracy fixes. Gaps 4–5 are programming-philosophy
calls a coach should sign off on. Gap 6 is a tuning note.
