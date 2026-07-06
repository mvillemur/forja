# Multi-week programming — plan

How FORJA grows from a **single-session generator** into a **multi-week
program** without throwing away anything it already does. This is a
specification-level plan, not a patch. Companion to
`load-rep-individualization.md` (load/reps per exercise) and
`training-model-gaps.md` (time/fatigue model) — this doc is about *structure
across weeks*. The sports-science grounding for the numbers below (periodization
model, split templates, deload dose, ramp rates, anchor policy) is investigated
and sourced in `program-generation-methodology.md`; where that doc refines a
placeholder here (deload ×0.5 not ×0.6, gentler ramps), the methodology doc's
values win.

**Decision taken up front (just-in-time):** a program does **not** pre-generate
every session. It stores a thin, persistent *plan layer* (schedule + cycle
shape + anchor lifts + progression state) and, on each training day, generates
**only the next session** from the program's current parameters plus the
trainee's accumulated state (e1RM, `state.prog`, `state.kg`, recent history).
This keeps the program adaptive — every session reflects the latest strength
data — and reuses the existing generator wholesale.

---

## 1. Why a program (what single sessions can't do)

Today every "Generar" is independent and slightly random (`vary` rotates
exercises, the seed shuffles). That is great for one-offs but means:

- **No continuity** — the squat you progressed last Monday may not appear next
  Monday, so double progression / e1RM never compound on the same lift.
- **No periodization** — intensity and volume don't ramp then deload; the
  trainee just trains "hard" every session until they stall or burn out.
- **No schedule** — there's no notion of "3 days/week, strength + metabolic +
  strength", no adherence, no week-over-week view.

A program supplies exactly these three things — **continuity, periodization,
schedule** — as a layer *above* the generator, not a rewrite of it.

---

## 2. The plan layer (data model)

One new persisted object, `forja:program` (single active program; past ones can
be archived in history). Everything else it needs already exists.

```
Program {
  id, name, startDate,
  // --- schedule ---
  daysPerWeek,                 // 2..6
  week: [                      // one slot per training day, in order
    { objective, focus[], label }   // e.g. {STRENGTH, [], "Fuerza A"}
  ],
  // --- cycle shape (periodization) ---
  mesocycle: {
    lengthWeeks,               // e.g. 4
    deloadEveryWeeks,          // e.g. 4 -> last week is a deload
    rampProfile: "linear" | "step" | "none"
  },
  // --- continuity ---
  anchors: [ exerciseName ],   // core lifts kept every matching day
  // --- live state ---
  cursor: { week, dayIndex },  // where the trainee is now
  baseVolume,                  // reference sets/min from week 1 (for the ramp)
  generated: [ sessionId ],    // history ids this program produced (back-links)
}
```

Notes:

- **No per-session storage.** `week[]` is a *template* of intents, not routines.
  The actual routine for a day is generated when the trainee trains it and is
  saved to normal session history (already supported), tagged with
  `{ programId, week, dayIndex }`.
- **Progression state is shared, not duplicated.** Per-exercise `state.prog`
  (rep target), `state.kg` (working weight) and the computed e1RM already
  persist globally and survive across sessions — the program does not need its
  own copy. Continuity (anchors) is what makes them compound.

---

## 3. Just-in-time generation flow

"Entrenar hoy" (or auto-selecting the day at the top of the cursor) runs the
**existing** `generate(pool, opts)` with opts assembled from the program:

```
day      = program.week[cursor.dayIndex]
phase    = phaseFor(program.mesocycle, cursor.week)   // accumulation | deload
opts = {
  objective: day.objective,
  focus:     day.focus,
  equipment, weightMin, weightMax, profile,           // from cfg, unchanged
  // continuity: pin the program's anchors that fit this day's objective
  pinned:    anchorsForDay(program, day),
  vary:      true,                                     // still rotate the non-anchors
  // periodization: scale this session's dose (see §4)
  minutes:   baseMinutes * phase.volumeFactor,
  intensityBias: phase.intensityFactor,               // new opt, see §4
}
routine = generate(pool, opts)
```

Then the trainee trains/saves as today, RPE autoregulation and e1RM update as
today, and `advance(program)` moves the cursor to the next day (wrapping weeks,
inserting deloads). Because generation reads live e1RM/`state.prog`, **week N's
load already reflects week N-1's results** — no separate progression engine.

`anchorsForDay` reuses the existing **pin** mechanism (`cfg.pinned`,
`preplaceFixed`) — anchors are just program-owned pins, so the squat/press/hinge
recur every week while accessories keep rotating via `vary`.

---

## 4. Periodization math (small, reuses the dose model)

A mesocycle ramps work then backs off. Two levers, both already meaningful in
the engine:

- **Volume** — scale target `minutes` (drives sets/exercise count via the
  existing time model). Accumulation weeks step up (e.g. ×1.0, ×1.1, ×1.2),
  the deload week drops (×0.6).
- **Intensity** — a new `intensityBias ∈ [-1,+1]` that nudges the **rep target**
  toward the bottom (heavier) or top (lighter) of each block's
  `progressionRange`, and therefore the e1RM-derived `loadForReps`. Heavy weeks
  bias low reps / higher load; the deload biases high reps / lower load.

```
phaseFor(meso, week):
  isDeload = (week % meso.deloadEveryWeeks === 0)
  if isDeload: return { volumeFactor: 0.6, intensityFactor: -0.5 }   // lighter, fewer
  t = position within the accumulation block (0..1)
  return { volumeFactor: 1 + 0.2*t, intensityFactor: +0.5*t }        // ramp up
```

This is a **safe extension**: `intensityBias` defaults to 0 (today's behavior),
and with no program the generator is byte-for-byte unchanged. Deload safety
(never auto-ramp ballistic/high-CNS load aggressively) is inherited from the
e1RM caps already in place.

### 4b. Readiness composes with the phase (already shipped)

Daily readiness — energy, sleep, soreness — is **already implemented** as a
standalone autoregulation layer (`readinessFactors` in `engine.js`; the "¿Cómo
llegas hoy?" card in Generar). It maps the trainee's day to the **same levers**:
`volumeFactor`, `loadFactor`, `cnsFactor`, `intensityBias`, and a sore-pattern
penalty. A program does not replace it — it **multiplies into it**:

```
volume    = baseMinutes × phase.volumeFactor   × readiness.volumeFactor
intensity = phase.intensityFactor              + readiness.intensityBias   // clamped [-1,1]
cnsCap    = round(maxCns × phase.cnsFactor      × readiness.cnsFactor)
load      = suggestion × phase.loadFactor       × readiness.loadFactor
sore      = readiness.sore   (always honored, day-level)
```

So the program sets the week's *intent* (ramp / deload) and readiness bends that
intent to the *day*: a heavy week + a wrecked day still backs off; a deload week
+ a great day stays easy (deload wins by design — readiness only nudges).
Practically, the JIT `opts` in §3 just carries **both** `readiness` (from the
card) and the program-phase factors, and the engine already knows how to apply
the readiness half. Because every factor is neutral by default, the program, the
readiness check, and plain one-off generation all share one code path.

The product principle behind this: **what's best to train is decided in the
moment** — not only from history, progression and objective, but from how the
trainee actually shows up. Readiness is the "in the moment" input; the program
is the longer arc it bends against.

---

## 5. UI surface

- **New "Programa" view** (5th nav item, or a card in Generar):
  - Create: name, days/week, pick an objective + focus per day, mesocycle
    length + deload cadence, choose anchors (from the pool, defaults = the
    fundamentals ★).
  - A **week strip**: the days as chips with their objective + a ✓ when done;
    the current day highlighted.
  - **"Entrenar hoy"** → generates the JIT session and opens it (same routine
    UI + timer as now).
  - A **progress ribbon**: week X of N, phase (acumulación/deload), adherence,
    and the e1RM trend (already built) for the anchors.
- **History** sessions gain a small "Semana 2 · Día 1" tag when they belong to a
  program.
- **Guide**: one new accordion "Programas (varias semanas)" explaining
  continuity, the ramp/deload, and that each day is generated fresh from your
  latest numbers.

Everything else (routine card, kg steppers, RPE, timer, e1RM panel) is reused
as-is.

---

## 6. Phased rollout

1. **Plan layer + JIT, no periodization.** Program object, weekly schedule,
   anchors-as-pins, cursor advance, "Entrenar hoy", program tags in history.
   `volumeFactor`/`intensityBias` fixed at 1/0. Delivers continuity (the big
   felt win) with almost no new engine code.
2. **Periodization.** Add `phaseFor`, the `intensityBias` opt in the
   prescription path, deload weeks, and the progress ribbon (week/phase).
3. **Adherence & adjustment.** Missed-day handling (slip the cursor, optional
   auto-deload after a layoff), and "regenerate this day" without losing the
   program slot.
4. **Templates.** Ship a few ready-made programs (e.g. "3 días fuerza", "2 días
   full-body", "kettlebell minimalista") as preset Program objects.

Step 1 is the high-leverage, low-risk core. Steps 2–4 add the periodization and
polish and should get a coach sign-off on the ramp/deload numbers, like the
philosophy calls in the companion docs.

---

## 7. Open questions / risks

- **Anchor vs variety tension.** Too many anchors = a rigid program; too few =
  no continuity. Default to anchoring only the day's primary pattern(s) and let
  `vary` handle the rest. Make the anchor count a visible knob.
- **Schedule drift.** Real life skips days. The cursor must advance by *sessions
  completed*, not by calendar, or the ramp desyncs from actual training. Treat
  the week as a sequence, not fixed weekdays (offer weekday hints, don't enforce
  them).
- **Deload trigger.** Fixed cadence (every 4th week) is simplest and predictable;
  an autoregulated deload (trigger on accumulated "Duro" RPE / stalled e1RM) is
  better but needs the RPE/e1RM history to be dense enough to trust — defer to a
  later step.
- **One active program.** Keep it to a single active program first; multiple
  concurrent programs add a selection/merge problem in the shared `state.prog`/
  `state.kg`/e1RM space that isn't worth it yet.
- **Migration.** The plan layer is purely additive (new key, new opt defaults to
  neutral), so existing users and saved sessions are unaffected.
