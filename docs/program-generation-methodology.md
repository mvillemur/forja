# How training programs are generated — methodology investigation

Grounding for the multi-week scheduler proposed in `multi-week-programming.md`.
That doc is the *engineering* plan (how to bolt a program onto the existing
generator); it deliberately defers the sports-science numbers ("get a coach
sign-off on the ramp/deload"). This doc supplies that grounding: **how real
programs are actually generated**, what the evidence says, and the concrete
parameters FORJA should use — so the schedule is derived from methodology, not
invented.

The key finding up front: **FORJA already embodies most of a sound program by
accident of its design.** Its per-day objective schedule is a form of daily
undulating periodization; its anchors-vs-`vary` split is exactly the
consistency-vs-variation balance the literature recommends; its readiness layer
is textbook autoregulation. The scheduler mostly needs to *sequence weeks* and
*add a deload* — not invent a training philosophy.

---

## 1. What a program-generator must decide

Generating a program (vs. a single session) is a set of nested decisions:

1. **Weekly split** — how many days, and what each day trains.
2. **Periodization model** — how intensity/volume vary across days and weeks.
3. **Mesocycle shape** — how long the block runs and when it deloads.
4. **Progression rule** — how load/reps advance week to week.
5. **Exercise continuity** — what stays fixed vs. what rotates.
6. **Autoregulation** — how the plan bends to the day.

The sections below answer each with evidence and give FORJA's parameter.

---

## 2. Periodization model — undulating, which FORJA already does

Linear periodization (LP) ramps one quality over weeks (volume→intensity);
undulating periodization (DUP) varies the stimulus *session to session*.
Meta-analytic evidence: LP and DUP are **equivalent for hypertrophy**, with DUP
holding a **small edge for strength** (Grgic 2017; Harries 2015; Rhea 2002).
The practical consensus is that *doing* periodization beats not doing it far
more than the choice between models.

**FORJA fit.** A week of `[Fuerza, Metabólico, Fuerza]` or
`[Fuerza, Resistencia, Potencia]` is **daily undulating periodization** — each
day is a different intensity/rep world. This is already what `week[]` in the
plan doc encodes. So FORJA's model is DUP, which the evidence supports; no
change needed beyond letting the user lay out the week.

- **Parameter:** default weeks by frequency (see §3), each day carrying its own
  `objective` (which already sets rep range, CNS budget, dynamics via
  `TEMPLATES`). No new "model" knob — the day list *is* the model.

---

## 3. Weekly split — frequency-driven templates

Evidence points to **each major pattern trained 2–3×/week** for hypertrophy and
strength (Schoenfeld 2016 frequency meta-analysis). Kettlebell practice
(StrongFirst / Tsatsouline) for balanced development: **strength 2×/week +
conditioning 2×/week**, strength days built on grinds and heavy quick lifts with
full rest, conditioning trained the day *after* strength.

**FORJA fit.** Ship default week templates keyed to `daysPerWeek`, each slot a
`{objective, focus, label}` the generator already understands:

| Days | Default week (objective per day) |
|---|---|
| 2 | Fuerza (full) · Metabólico (full) |
| 3 | Fuerza · Metabólico · Fuerza |
| 4 | Fuerza (tren inf.) · Metabólico · Fuerza (tren sup.) · Resistencia |
| 5 | Fuerza · Metabólico · Fuerza · Resistencia · Potencia |
| 6 | as 3-day pattern ×2, alternating focus |

These are **editable defaults**, not rules — the user can set each day. Full-body
strength days paired with a conditioning day the next slot mirror the KB
literature and keep every pattern hit ~2×/week at 3+ days.

- **Parameter:** `daysPerWeek ∈ [2,6]`; default `week[]` from the table; user
  overrides per slot. Focus per day steers pattern emphasis (the KB "strength
  vs conditioning" divide maps to Fuerza vs Metabólico objectives).

---

## 4. Mesocycle shape — 4 weeks, deload the 4th

Strong convergent evidence and expert consensus (Bell 2023 practical review;
2023 Delphi consensus on deloading):

- **Mesocycle length:** ~**3–6 weeks** of accumulation, 4 being the common
  default.
- **Deload cadence:** a deload **after each mesocycle** (i.e. every ~4th week).
  Deloading *too* frequently blunts adaptation — it is a periodic reset, not a
  weekly feature.
- **Deload dose:** reduce **volume ~40–60%** (commonly via **~50% fewer sets**),
  keep **frequency** (train the same days, so you don't detrain), and hold or
  slightly reduce **intensity/load** (a common recipe: −10% load, −50% sets,
  −20% reps). Keeping some intensity preserves the skill/neural side while
  volume drops to shed fatigue.

**FORJA fit.** This validates and refines the plan doc's placeholders:

- `mesocycle.lengthWeeks = 4`, `deloadEveryWeeks = 4` (deload = week 4).
- Deload `volumeFactor ≈ 0.5` (doc had 0.6 — evidence supports 0.4–0.6; **0.5**
  is the safe center). Realized as fewer sets via the existing time model
  (lower `minutes`).
- Deload `intensityFactor ≈ −0.3` (bias reps toward the *top* of the range →
  lighter `loadForReps`), **not** a hard load cut — keep the movement, drop the
  grind. Doc's −0.5 is a touch aggressive; **−0.3** better matches "hold
  intensity, cut volume."
- **Keep the same training days** during deload (frequency preserved) — the
  cursor still walks the week; only the dose drops.

---

## 5. Progression across weeks — gentle volume ramp + step-loading

Two complementary levers, both evidence-based:

- **Volume ramp (accumulation):** add work *slowly*. Reviews favor **adding ~1
  set every 2–4 weeks** or **+1–2 reps/week**, not a big weekly jump — weekly set
  volume lands in the **10–20 sets/muscle/week** productive band, above which
  fatigue outpaces growth. So the accumulation ramp should be **mild**.
- **Load step-cycling (KB tradition):** *stay at the same load for 2+ sessions
  before increasing* (Tsatsouline "step cycling"), rather than adding load every
  session. This is exactly FORJA's **double progression** (advance reps to the
  top of the range, *then* add kg) — already implemented per exercise.

**FORJA fit.** The engine already progresses load/reps per lift via double
progression + RPE + e1RM, and those persist globally. So **week-to-week
intensity progression is emergent** — because anchors recur (§6) and generation
reads live `state.prog`/`state.kg`/e1RM, week N automatically starts where week
N-1 left off. The program only needs to add the **mesocycle volume ramp** on top:

- Accumulation `volumeFactor` per week: **1.0 → 1.1 → 1.15** across weeks 1–3
  (mild, matching "a set every 2–4 weeks" rather than the doc's 1.0/1.1/1.2/…
  read as per-week). Week 4 = deload (§4).
- `intensityFactor` per week: **0 → +0.15 → +0.3** (accumulating toward heavier
  reps), reset at deload. Gentler than the doc's `+0.5*t`.
- No separate progression engine — double progression + e1RM do the per-lift
  work; the ramp only modulates session *dose*.

---

## 6. Exercise continuity — anchors fixed, accessories rotate

The cleanest result for FORJA: **consistency on the main lifts, variation on the
accessories.**

- Keeping the **primary compound lifts constant** lets motor learning and
  progressive overload compound on them (the whole point of a program) —
  randomly rotating them fragments frequency and stalls progression.
- **Varying accessories** across weeks manages overuse, staves off boredom, and
  still drives hypertrophy (muscles respond to tension, not exercise names;
  Fonseca 2014 showed varied vs. fixed can match for size when overload holds).

**FORJA fit.** This is *literally* the plan doc's design: **anchors = program-
owned pins** (kept every matching day via the existing `preplaceFixed`), while
`vary: true` rotates the rest via `calcRecent()`. The methodology just sets the
default:

- **Anchor only the day's primary pattern(s)** — e.g. a hinge + a press on a
  Fuerza day — 1–3 anchors, not the whole session. Keeps continuity where it
  compounds without freezing the program.
- Default anchors = the **★ fundamentals** already tagged in the catalog,
  filtered to the day's objective/focus.
- Leave accessories to `vary` — the rotation the app already does.

---

## 7. Autoregulation — the day bends the week

Autoregulation (adjust the session to real readiness) is at least as effective
as rigid prescription and better for trained lifters (Greig 2020; Zhang 2021
meta-analysis). Standard tools: **RPE 7–9 for strength**, **RIR 0–3 for
hypertrophy**; the justification is that sleep/stress/fatigue move readiness day
to day, so a fixed plan is a starting point, not a mandate.

**FORJA fit.** Already shipped. `readinessFactors` (energy/sleep/soreness) and
the Facil/OK/Duro RPE progression are exactly this. The program **composes** with
it (plan doc §4b): the mesocycle sets the week's *intent*, readiness bends it to
the *day*, and — by design — **deload wins** (a great day in a deload week stays
easy). No new work; the JIT `opts` just carry both the phase factors and the
readiness factors, and the engine already applies the readiness half.

---

## 8. The scheduler recipe (parameters, consolidated)

Everything above, as the concrete inputs the generator needs:

```
Program defaults (evidence-grounded):
  daysPerWeek        : 3                      # user-set 2..6
  week[]             : from §3 table by daysPerWeek, editable per slot
  mesocycle.lengthWeeks   : 4
  mesocycle.deloadEveryWeeks : 4              # week 4 = deload
  anchorsPerDay      : 1..3 (day's primary pattern[s]), default ★ fundamentals

phaseFor(week):                               # week is 1-based within meso
  if week % 4 == 0:                           # deload
     return { volumeFactor: 0.5, intensityFactor: -0.3 }   # cut sets, keep movement
  t = (week-1) / 3                            # 0, .33, .66 across weeks 1..3
  return { volumeFactor: 1 + 0.15*t,          # 1.0 -> ~1.15  (mild ramp)
           intensityFactor: 0.3*t }           # 0   -> ~0.3   (toward heavier reps)

Per-session (JIT), composed with readiness:
  minutes   = baseMinutes × phase.volumeFactor × readiness.volumeFactor
  intensity = clamp(phase.intensityFactor + readiness.intensityBias, -1, +1)
  load      = suggestion × phase.loadFactor × readiness.loadFactor
  pinned    = anchorsForDay(program, day)     # program pins + continuity
  vary      = true                            # rotate non-anchors
  # objective/focus from the day slot; everything else from cfg unchanged
```

Deviations from the plan doc's placeholders, with reasons:

| Parameter | Doc | This doc | Why |
|---|---|---|---|
| Deload volume | ×0.6 | **×0.5** | Center of the 0.4–0.6 evidence band |
| Deload intensity | −0.5 | **−0.3** | "Hold intensity, cut volume" — keep the movement |
| Weekly volume ramp | ×1.0→1.2/wk | **×1.0→1.15 over 3 wk** | "+1 set every 2–4 wk", not a steep weekly climb |
| Weekly intensity ramp | +0.5·t | **+0.3·t** | Gentler; double progression already adds load per lift |

---

## 9. What stays deferred (needs real training data or a coach call)

- **Autoregulated deloads** — triggering a deload on accumulated "Duro"/stalled
  e1RM instead of a fixed 4th week. Better in theory, but needs dense RPE/e1RM
  history to trust. Keep **fixed cadence** first (plan doc §7 agrees).
- **Longer macro structure** — chaining mesocycles with shifting emphasis
  (strength block → power block). Out of scope for v1; one mesocycle that
  repeats is enough to deliver continuity + deload.
- **Exact split science per goal** — the §3 templates are sound defaults, but the
  precise objective mix for a stated goal (pure strength vs. GPP vs. fat-loss)
  is a coaching judgment; expose the week as editable and ship a few presets
  (plan doc rollout step 4).

---

## Bibliography

Periodization models:
- Grgic J, et al. Effects of linear and daily undulating periodized resistance
  training on hypertrophy: a meta-analysis. *PeerJ.* 2017;5:e3695.
- Harries SK, Lubans DR, Callister R. Systematic review and meta-analysis of
  linear and undulating periodization on strength. *J Strength Cond Res.* 2015.
- Rhea MR, et al. A comparison of linear and daily undulating periodized
  programs. *J Strength Cond Res.* 2002;16(2):250–255.

Mesocycle / deload:
- Bell L, et al. A practical approach to deloading. *Strength Cond J.* 2023.
- Bell L, et al. Integrating deloading into training: an international Delphi
  consensus. *Sports Med.* 2023 (PMC10511399).

Volume / progression:
- Schoenfeld BJ, Ogborn D, Krieger JW. Dose-response of weekly set volume for
  hypertrophy: a meta-analysis. *J Sports Sci.* 2017.
- Schoenfeld BJ, et al. Training frequency for hypertrophy: a meta-analysis.
  *Sports Med.* 2016.

Exercise variation:
- Fonseca RM, et al. Exercise variation in muscle thickness, strength and
  motivation in resistance-trained men. *PLoS One.* 2019 (PMC6934277).

Autoregulation:
- Greig L, et al. Autoregulation in resistance training: a review. *Sports Med.*
  2020;50(11):1873–1887.
- Zhang X, et al. Load and volume autoregulation on strength and hypertrophy: a
  meta-analysis. *Sports Med Open.* 2021 (PMC8762534).

Kettlebell practice:
- Tsatsouline P. *Enter the Kettlebell!* Dragon Door; 2006. (strength/conditioning
  split, step cycling)
- StrongFirst. A Total Package Weekly Template. strongfirst.com.
