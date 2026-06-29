# Individualized load & reps — investigation

How should FORJA decide **weight (kg)** and **reps** for each prescription,
given the *person*, the *exercise*, the *routine combination*, and the
*training history*? Today it does almost none of this. This document is a
specification-level investigation: where prescription comes from now, what each
input axis should contribute, candidate models, the data we'd need to collect,
and a phased rollout. It is intentionally not a patch.

Companion to `training-model-gaps.md` (which covers the *time & fatigue* model).
That doc is about how long work takes and how fatigue accumulates; this one is
about *what load and rep target to put on the bar*.

---

## 1. What determines weight and reps today

**Reps** — fixed by the template block and never individualized:

- `schema(block, count, sets, reps, …)` hard-codes `reps` per block
  (`src/engine.js`, `TEMPLATES`). Block A ≈ 5, B ≈ 10–12, C ≈ 15–20.
- `prescribe(e, sch)` returns `reps = sch.reps`, with the single exception that
  ISO movements are bumped to `max(reps, 8)`.
- Scaling by time/structure changes **sets and exercise count**, never the rep
  target.

**Weight** — a static map from a 3-level load tier into the user's KB range:

- Each catalog exercise has `load ∈ {1,2,3}` (light/medium/heavy).
- `suggestKg(load, min, max)` places it at a fixed fraction of the range
  (`{1:0.15, 2:0.5, 3:0.85}`), rounded to 2 kg, clamped (`src/engine.js`).
- `loadWarning(load, weightKb)` exists but is essentially unused.

**History** — does **not** influence prescription. It feeds:

- `calcRecent()` → variety rotation only (avoid repeating recent exercises).
- per-exercise kg memory (`state.kg`, added recently) → display default for the
  kg stepper and the volume estimate; it does *not* drive rep targets or
  progression.

**Person** — the only profile inputs are `weightMin` / `weightMax` (the
adjustable kettlebell's range). No bodyweight, sex, age, or training age.

**Net:** two people with the same kettlebell get identical numbers, and the
numbers never move as they get stronger. That is the gap.

---

## 2. The four input axes and what each should contribute

### A. Person features
Candidate inputs, cheapest-to-collect first:

| Feature | Why it matters | Collection cost |
|---|---|---|
| Bodyweight | Anchors absolute-load expectations (KB norms are bodyweight-relative) | one field |
| Sex | Shifts strength norms, esp. upper body | one field |
| Training age (beginner/intermediate/advanced) | Sets starting load %, progression rate, and recoverable volume | one select |
| Available KB range | Already have it; bounds everything | have it |
| Injury / contraindications | Caps load on affected patterns | later |
| Per-session readiness (optional) | Autoregulate the day's load ±5–10% | timer prompt |

For a **single adjustable kettlebell**, absolute load is coarse (2 kg steps,
bounded range). So person features mostly set the **starting point** and the
**rep/density lever**, not fine load — see §4.

### B. Exercise type
The catalog already carries the right discriminants; they should modulate
load/reps explicitly rather than only via the static tier:

- **Dynamics**: ballistics (Swing/Snatch/Clean) are *power* — capped reps,
  load chosen for speed, not grind; progress by reps/density, not by chasing
  a 1RM. Grinds (press/squat/RDL) carry the heaviest relative load and the
  classic strength rep ranges. ISO/carries prescribe *time/distance under load*,
  not reps.
- **Load tier** (1–3): the existing anchor for relative heaviness.
- **Pattern & whether it's bodyweight-bounded**: pull-ups / push-ups are gated
  by bodyweight, not KB load — their "load" lever is reps and tempo.
- **Symmetry**: unilateral targets are *per side* (already surfaced in dose).

### C. Routine combination
The same movement should not always get the same numbers — context fatigues it:

- **Superset partner**: an antagonist pair preserves load (the rationale of APS);
  a same-pattern or HIP↔KNEE pair pre-fatigues, so the second lift should drop
  load or reps. The engine already grades these (`validateCombination` quality).
- **Block position & accumulated CNS/grip budget**: a lift late in the session,
  after the CNS/grip budget is largely spent, should be prescribed more
  conservatively than the same lift opening Block A.
- **Objective**: Strength vs Metabolic already pick rep ranges via templates;
  individualization should respect that intent (don't push a metabolic finisher
  toward a 3RM load).

### D. History
The strongest signal once it exists. Two complementary loops:

- **Progressive overload (double progression)**: prescribe at the bottom of the
  rep range; when the trainee completes the top of the range across all sets,
  bump load one step (2 kg) and reset to the bottom. This is the simplest robust
  KB-appropriate rule and needs only *reps achieved* + *load used*.
- **Estimated 1RM tracking**: from logged `load × reps`, compute an e1RM
  (Epley `1RM ≈ w·(1 + reps/30)` or Brzycki) per movement, smooth it over time,
  and derive each session's load from a %e1RM ↔ rep-target table. Better load
  precision, but noisier for ballistics and needs more data.
- **Autoregulation**: if available, an RPE/RIR or a "too easy / right / too hard"
  tap after a set nudges the next prescription ±a step.

We already capture the raw material for the double-progression loop in **manual
sessions** (per-set reps + kg) and partially via `state.kg`. We do **not** yet
capture *reps achieved vs prescribed* or RPE for generated sessions — see §5.

---

## 3. The cold-start problem

A new user has no history, so the first prescriptions must come from person
features + exercise type:

1. Seed a per-pattern starting load from bodyweight × sex × training-age norms,
   snapped into the user's KB range (e.g. beginner female overhead press starts
   much lighter than advanced male hinge).
2. Seed reps from the template's objective rep range (bottom of range for
   strength, middle for hypertrophy).
3. From session 2 onward, history takes over and the cold-start estimate decays
   in weight. This is a classic estimate-then-converge setup; the seed only has
   to be *safe and roughly right*, since the overload loop corrects it within a
   few sessions.

---

## 4. Candidate model (single adjustable KB)

A pragmatic layering that fits the existing architecture:

```
target_reps   = objective_rep_range(block)                     // template intent
            then autoregulated by history (double progression)
load_fraction = base_tier_fraction(load)                       // current suggestKg
            × person_seed_multiplier(bw, sex, training_age)    // cold start
            × combo_modifier(superset quality, block position) // routine context
kg            = snap_to_range(load_fraction, min, max, step=2) // existing clamp
            then overridden by history e1RM / last-used when available
```

Key properties:
- Reduces to **today's behavior** when person features and history are absent
  (the multipliers default to 1, history overrides are empty) — safe migration.
- The **2 kg-step, bounded range** means load is coarse; the model leans on the
  **rep/density lever** for fine progression, which is the KB-appropriate choice.
- **Ballistics** opt out of e1RM chasing: progress them by reps/rounds/density,
  cap the load.
- All new logic stays in `engine.js` (pure, testable); `app.js` only collects
  profile + feedback and passes them in.

---

## 5. Data we need to start collecting

To make the history loop real, generated sessions need to log outcomes, not just
the plan. Minimal additions:

- **Reps achieved per set** (vs prescribed) — the timer is the natural capture
  point (a quick tap/short field at end of each work phase).
- **Load actually used** — already have `state.kg`; persist it *per session* in
  history, not just globally.
- **Optional RPE / "too easy–right–too hard"** — one tap per exercise or per
  session enables autoregulation.
- **Person profile** — bodyweight, sex, training age: a small one-time form
  (Generar or a new Perfil view).

We already have: manual CSV logs (reps + kg + notes), completion marks, and the
adjustable-range. The above closes the loop for *generated* sessions.

---

## 6. Phased rollout

1. **Capture** — add the person-profile form and per-session logged
   load/reps(+optional RPE) in the timer/history. No behavior change yet; just
   start accumulating the inputs. (Low risk, unblocks everything else.)
2. **Double progression** — once a movement has logged history, prescribe
   bottom-of-range and bump load 2 kg when the top is cleared across all sets.
   Pure `engine.js` rule; easy to unit-test. (Biggest value per effort.)
3. **Cold-start seeding** — person-feature multipliers for the first session,
   converging into the history loop. (Removes the "everyone starts identical".)
4. **e1RM + autoregulation** — per-pattern e1RM tracking and RPE nudges for
   finer load precision on grinds; ballistics stay rep/density-driven.
5. **Routine-combination modifiers** — down-modulate load/reps by superset
   quality and accumulated CNS/grip budget within a session.

Steps 1–2 deliver most of the felt value (numbers that move as you get
stronger) with the least modeling risk. Steps 3–5 add precision and should be
signed off by a coach, like the philosophy calls in `training-model-gaps.md`.

---

## 7. Open questions / risks

- **Safety on auto-escalation**: never auto-increase ballistic/high-CNS load
  aggressively; prefer rep/density progression and cap weekly load jumps.
- **Sparse, noisy history**: KB load is coarse and sessions are intermittent;
  e1RM from a single AMRAP set is unreliable — require N data points before
  trusting it, and always keep the user's manual override (`state.kg`) as the
  source of truth.
- **Per-side vs total** for unilateral movements must stay consistent between
  the prescription, the dose render, and any e1RM math (see Gap 1 in
  `training-model-gaps.md`).
- **How much to ask the user**: every required field lowers adoption. Bodyweight
  + training age is probably the minimum worthwhile profile; everything else
  should be optional and have sane defaults.
