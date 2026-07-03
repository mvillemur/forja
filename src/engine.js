/**
 * FORJA — Rules engine (engine.js)
 * =================================
 * PURE logic for kettlebell routine generation. Does not touch the DOM or
 * storage: receives data and returns data, so it is testable in Node and
 * reusable. Exposed as `window.FORJA` (browser) and `module.exports`
 * (Node) — UMD pattern at the end of the file.
 *
 * DATA MODEL
 *   Exercise: { name, pattern, dynamics, symmetry, cns, equipment[], grip,
 *               load (1..3), tier }  — see BASE_CATALOG.
 *   Prescription: { exercise, block, sets, reps }.
 *   WorkSlot: { prescriptions[1..2], quality, note, isSuperset }.
 *   Routine: { template, blocks: [{ block, elements: WorkSlot[] }] }.
 *
 * THE 4 CRITERIA (Enums as strings, serializable)
 *   PAT  movement pattern          DIN  dynamics type
 *   SIM  symmetry                  CNS  nervous system demand
 *
 * HOW A ROUTINE IS BUILT (pipeline)
 *   generate(pool, opts)
 *     -> picks TEMPLATE (by objective) and scales it by time or structure
 *     -> buildRoutine(): filters by equipment and builds each block with:
 *          · RuleEngine (validateCombination): decides if two exercises form
 *            a valid superset and with what quality, depending on the block.
 *          · FatigueBudget: limits high-CNS and ballistic grip exercises per session.
 *          · BalanceTracker: distributes patterns (soft/hard mode) and applies focus,
 *            tier and recent-use penalty via `priority`.
 *          · buildGreedy / buildBacktrack: selection and pairing. HARD mode uses
 *            backtracking to avoid gaps in the balance quota.
 *          · preplaceFixed: places PINNED exercises by the user first.
 *
 * RATIONALE (summary): antagonist supersets (APS) to recover the resting group
 * without losing performance; grip is the limiting link between ballistics;
 * do not accumulate high CNS; active rest = low-demand core.
 *
 * This file MUST NOT gain dependencies or I/O: if something needs the DOM or
 * the browser, it goes in app.js.
 */
(function (root) {
  "use strict";

  // --- Enums as strings (serializable) ---------------------------------
  const PAT = { HIP:"HIP", KNEE:"KNEE", PULL_H:"PULL_H", PULL_V:"PULL_V",
                PUSH_H:"PUSH_H", PUSH_V:"PUSH_V", CORE:"CORE", HYBRID:"HYBRID" };
  const DIN = { STRENGTH:"STRENGTH", BALLISTIC:"BALLISTIC", ISO:"ISO", METABOLIC:"METABOLIC" };
  const SIM = { BILATERAL:"BILATERAL", UNILATERAL:"UNILATERAL", ALTERNATING:"ALTERNATING" };
  const CNS = { HIGH:"HIGH", MEDIUM:"MEDIUM", LOW:"LOW" };
  const EQ  = { KB:"KB", BARBELL:"BARBELL", FLOOR:"FLOOR" };
  const LOAD_TIER = { LIGHT:1, MEDIUM:2, HEAVY:3 };
  const TIER = { FUNDAMENTAL:"FUNDAMENTAL", ACCESSORY:"ACCESSORY", OPTIONAL:"OPTIONAL" };
  const TIER_LABEL = { FUNDAMENTAL:"Fundamental", ACCESSORY:"Accesorio", OPTIONAL:"Opcional" };
  const TIER_BONUS = { FUNDAMENTAL:3, ACCESSORY:0, OPTIONAL:-2 };
  const BLOCK = { A:"A", B:"B", C:"C" };
  const REP_RANGE = { SP:"SP", HP:"HP", ME:"ME" };
  const QUALITY = { OPTIMAL:3, ACCEPTABLE:2, INVALID:0 };
  const QUALITY_NAME = { 3:"OPTIMAL", 2:"ACCEPTABLE", 0:"INVALID" };

  const PAT_LABEL = { HIP:"Cadera", KNEE:"Rodilla", PULL_H:"Tiron horiz.",
    PULL_V:"Tiron vert.", PUSH_H:"Empuje horiz.", PUSH_V:"Empuje vert.",
    CORE:"Core / estab.", HYBRID:"Hibrido" };
  const DIN_LABEL = { STRENGTH:"Fuerza/Hipertrofia", BALLISTIC:"Balistico/Potencia",
    ISO:"Isometrico/Transporte", METABOLIC:"Metabolico" };
  const LOAD_LABEL = { 1:"Ligera", 2:"Media", 3:"Pesada" };

  // --- Base catalog (32) -------------------------------------------------
  function exercise(name, pattern, dynamics, symmetry, cns, equipment, grip, load) {
    return { name, pattern, dynamics, symmetry, cns, equipment,
             grip: !!grip, load: load || LOAD_TIER.MEDIUM, tier: TIER.ACCESSORY, plyo: false };
  }
  const BASE_CATALOG = [
    exercise("Peso Muerto Rumano / Fijo", PAT.HIP, DIN.STRENGTH, SIM.BILATERAL, CNS.MEDIUM, [EQ.KB], false, LOAD_TIER.HEAVY),
    exercise("Kettlebell Swings (Dos manos)", PAT.HIP, DIN.BALLISTIC, SIM.BILATERAL, CNS.HIGH, [EQ.KB], true, LOAD_TIER.HEAVY),
    exercise("Alternating Swings", PAT.HIP, DIN.BALLISTIC, SIM.ALTERNATING, CNS.HIGH, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Swing Cleans", PAT.HYBRID, DIN.BALLISTIC, SIM.UNILATERAL, CNS.HIGH, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Dead Cleans", PAT.HYBRID, DIN.BALLISTIC, SIM.UNILATERAL, CNS.HIGH, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Sentadilla Goblet", PAT.KNEE, DIN.STRENGTH, SIM.BILATERAL, CNS.MEDIUM, [EQ.KB], false, LOAD_TIER.HEAVY),
    exercise("Goblet Clean Squat", PAT.HYBRID, DIN.BALLISTIC, SIM.BILATERAL, CNS.HIGH, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Pit Squats", PAT.KNEE, DIN.STRENGTH, SIM.BILATERAL, CNS.MEDIUM, [EQ.KB], false, LOAD_TIER.HEAVY),
    exercise("Alt Lunges", PAT.KNEE, DIN.STRENGTH, SIM.ALTERNATING, CNS.MEDIUM, [EQ.KB], false, LOAD_TIER.MEDIUM),
    exercise("Remo a una mano", PAT.PULL_H, DIN.STRENGTH, SIM.UNILATERAL, CNS.MEDIUM, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Two Hand Row", PAT.PULL_H, DIN.STRENGTH, SIM.BILATERAL, CNS.MEDIUM, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Bent Rows (Alternating)", PAT.PULL_H, DIN.STRENGTH, SIM.ALTERNATING, CNS.MEDIUM, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Upright Row", PAT.PULL_V, DIN.STRENGTH, SIM.BILATERAL, CNS.LOW, [EQ.KB], false, LOAD_TIER.LIGHT),
    exercise("Dominadas Neutras", PAT.PULL_V, DIN.STRENGTH, SIM.BILATERAL, CNS.HIGH, [EQ.BARBELL], true, LOAD_TIER.MEDIUM),
    exercise("Clean & Press Combinado", PAT.HYBRID, DIN.BALLISTIC, SIM.UNILATERAL, CNS.HIGH, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Goblet Shoulder Press", PAT.PUSH_V, DIN.STRENGTH, SIM.BILATERAL, CNS.MEDIUM, [EQ.KB], false, LOAD_TIER.LIGHT),
    exercise("Rotational Press", PAT.PUSH_V, DIN.STRENGTH, SIM.UNILATERAL, CNS.MEDIUM, [EQ.KB], false, LOAD_TIER.LIGHT),
    exercise("Dead Clean Push Press", PAT.HYBRID, DIN.BALLISTIC, SIM.UNILATERAL, CNS.HIGH, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Close Grip Pushup", PAT.PUSH_H, DIN.STRENGTH, SIM.BILATERAL, CNS.MEDIUM, [EQ.FLOOR], false, LOAD_TIER.MEDIUM),
    exercise("Halos", PAT.CORE, DIN.ISO, SIM.BILATERAL, CNS.LOW, [EQ.KB], false, LOAD_TIER.LIGHT),
    exercise("Kneeling Around The Worlds", PAT.CORE, DIN.ISO, SIM.BILATERAL, CNS.LOW, [EQ.KB], false, LOAD_TIER.LIGHT),
    exercise("Half-Racked Marches", PAT.CORE, DIN.ISO, SIM.UNILATERAL, CNS.LOW, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Goblet Overhead March", PAT.CORE, DIN.ISO, SIM.BILATERAL, CNS.MEDIUM, [EQ.KB], false, LOAD_TIER.LIGHT),
    exercise("Burpees", PAT.HYBRID, DIN.METABOLIC, SIM.BILATERAL, CNS.HIGH, [EQ.FLOOR], false, LOAD_TIER.LIGHT),
    // --- Extension: classics with a single kettlebell ---
    exercise("Turkish Get-Up", PAT.CORE, DIN.ISO, SIM.UNILATERAL, CNS.HIGH, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("One-Arm Snatch", PAT.HYBRID, DIN.BALLISTIC, SIM.UNILATERAL, CNS.HIGH, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Windmill", PAT.CORE, DIN.ISO, SIM.UNILATERAL, CNS.MEDIUM, [EQ.KB], true, LOAD_TIER.LIGHT),
    exercise("Bottoms-Up Press", PAT.PUSH_V, DIN.STRENGTH, SIM.UNILATERAL, CNS.MEDIUM, [EQ.KB], true, LOAD_TIER.LIGHT),
    exercise("Single-Leg Deadlift", PAT.HIP, DIN.STRENGTH, SIM.UNILATERAL, CNS.MEDIUM, [EQ.KB], false, LOAD_TIER.MEDIUM),
    exercise("Suitcase Carry", PAT.CORE, DIN.ISO, SIM.UNILATERAL, CNS.LOW, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Thruster", PAT.HYBRID, DIN.METABOLIC, SIM.BILATERAL, CNS.HIGH, [EQ.KB], false, LOAD_TIER.MEDIUM),
    exercise("Figure-8", PAT.CORE, DIN.METABOLIC, SIM.ALTERNATING, CNS.MEDIUM, [EQ.KB], true, LOAD_TIER.LIGHT),
    // --- Extension: more single-kettlebell movements ---
    exercise("Curl + Press", PAT.HYBRID, DIN.STRENGTH, SIM.BILATERAL, CNS.MEDIUM, [EQ.KB], false, LOAD_TIER.MEDIUM),
    exercise("Ballistic Rows", PAT.PULL_H, DIN.BALLISTIC, SIM.ALTERNATING, CNS.MEDIUM, [EQ.KB], true, LOAD_TIER.MEDIUM),
    exercise("Hip Halos", PAT.CORE, DIN.ISO, SIM.UNILATERAL, CNS.LOW, [EQ.KB], false, LOAD_TIER.LIGHT),
    exercise("KB Jump Squats", PAT.KNEE, DIN.BALLISTIC, SIM.BILATERAL, CNS.HIGH, [EQ.KB], false, LOAD_TIER.LIGHT),
    exercise("KB Push-Ups", PAT.PUSH_H, DIN.STRENGTH, SIM.BILATERAL, CNS.MEDIUM, [EQ.KB], false, LOAD_TIER.LIGHT),
    exercise("Tuck Jumps", PAT.KNEE, DIN.BALLISTIC, SIM.BILATERAL, CNS.HIGH, [EQ.FLOOR], false, LOAD_TIER.LIGHT),
    exercise("Strict Overhead Press", PAT.PUSH_V, DIN.STRENGTH, SIM.UNILATERAL, CNS.MEDIUM, [EQ.KB], false, LOAD_TIER.MEDIUM),
    exercise("Push Press", PAT.PUSH_V, DIN.BALLISTIC, SIM.UNILATERAL, CNS.HIGH, [EQ.KB], false, LOAD_TIER.HEAVY),
    exercise("One-Arm High Pull", PAT.HYBRID, DIN.BALLISTIC, SIM.UNILATERAL, CNS.HIGH, [EQ.KB], true, LOAD_TIER.MEDIUM),
  ];

  // Tier: fundamental exercises (compound, multi-joint, high value) and optional ones.
  const _CORE_EXERCISES = new Set([
    "Peso Muerto Rumano / Fijo", "Kettlebell Swings (Dos manos)", "Sentadilla Goblet",
    "Goblet Clean Squat", "Clean & Press Combinado", "Dead Clean Push Press",
    "Thruster", "One-Arm Snatch", "Turkish Get-Up",
  ]);
  const _OPTIONAL_EXERCISES = new Set([
    "Upright Row", "Halos", "Kneeling Around The Worlds", "Figure-8", "Rotational Press",
  ]);
  // Plyometric / impact movements (stretch-shortening cycle): need full
  // recovery and are kept fresh. A subtype tag on top of DIN.BALLISTIC.
  const _PLYO_EXERCISES = new Set([
    "KB Jump Squats", "Tuck Jumps", "Burpees",
  ]);
  BASE_CATALOG.forEach(e => {
    e.tier = _CORE_EXERCISES.has(e.name) ? TIER.FUNDAMENTAL
           : _OPTIONAL_EXERCISES.has(e.name) ? TIER.OPTIONAL : TIER.ACCESSORY;
    e.plyo = _PLYO_EXERCISES.has(e.name);
  });

  // Per-exercise ISO hold/duration (seconds of work for ONE side / round).
  // Short stabilization holds ~35 s, timed carries longer, grind lifts longest.
  // Anything not listed defaults to DEFAULT_HOLD_ISO (35).
  const HOLD_BY_NAME = {
    // grind lifts (per side)
    "Turkish Get-Up": 60, "Windmill": 45,
    // timed carries / marches (per side where unilateral)
    "Suitcase Carry": 50, "Half-Racked Marches": 45,
    // short stabilization holds keep ~35 s (default)
  };
  BASE_CATALOG.forEach(e => {
    if (e.dynamics === DIN.ISO) e.holdSec = HOLD_BY_NAME[e.name] || 35;
  });

  // --- Volume and time model -----------------------------------------
  function classifyVolume(reps) { return reps <= 5 ? REP_RANGE.SP : reps <= 11 ? REP_RANGE.HP : REP_RANGE.ME; }

  const TEMPO = { STRENGTH:3.0, BALLISTIC:1.2, METABOLIC:2.0, ISO:0.0 };
  const REST_TIME = { SP:150, HP:75, ME:40 };
  const DEFAULT_HOLD_ISO = 35, SS_TRANSITION = 20, INTER_SIDE_REST = 15;
  const SETS_RANGE = { SP:[3,6], HP:[3,5], ME:[3,5] };

  // Work time for one SET. ISO uses the per-exercise holdSec (default 35).
  // Unilateral work trains both sides: ~2x work + a small inter-side micro-rest.
  function setWorkSec(e, reps) {
    const oneSide = e.dynamics === DIN.ISO ? (e.holdSec || DEFAULT_HOLD_ISO) : reps * TEMPO[e.dynamics];
    if (e.symmetry === SIM.UNILATERAL) return oneSide * 2 + INTER_SIDE_REST;
    return oneSide;
  }
  function setRestSec(reps) { return REST_TIME[classifyVolume(reps)]; }
  // Plyometric / impact work needs full recovery: never rest less than the
  // strength (SP) rest, regardless of how few reps it is.
  function restForPrescription(p) {
    const base = setRestSec(p.reps);
    return p.exercise.plyo ? Math.max(base, REST_TIME.SP) : base;
  }

  function elementTimeSec(el) {
    const s = el.prescriptions[0].sets;
    if (el.isSuperset) {
      const [a, b] = el.prescriptions;
      const work = setWorkSec(a.exercise, a.reps) + setWorkSec(b.exercise, b.reps);
      // Rep-range aware reduction: strength (SP) pairs keep more rest so the
      // primary lift recovers; HP/ME tolerate a deeper cut. Use the heaviest range.
      const ranges = new Set([classifyVolume(a.reps), classifyVolume(b.reps)]);
      const factor = ranges.has(REP_RANGE.SP) ? 0.75 : ranges.has(REP_RANGE.HP) ? 0.5 : 0.4;
      const rest = Math.max(restForPrescription(a), restForPrescription(b)) * factor;
      return s * (work + rest + SS_TRANSITION);
    }
    const p = el.prescriptions[0];
    return s * (setWorkSec(p.exercise, p.reps) + restForPrescription(p));
  }
  // Step-by-step timeline for ONE element: the ordered work/rest phases a
  // trainee actually goes through, in seconds. Used by the guided timer.
  // Each phase: { kind:"work"|"rest", sec, prescription?, setNo?, totalSets? }.
  function elementTimeline(el) {
    const steps = [];
    const totalSets = el.prescriptions[0].sets;
    if (el.isSuperset) {
      const [a, b] = el.prescriptions;
      const ranges = new Set([classifyVolume(a.reps), classifyVolume(b.reps)]);
      const factor = ranges.has(REP_RANGE.SP) ? 0.75 : ranges.has(REP_RANGE.HP) ? 0.5 : 0.4;
      const rest = Math.round(Math.max(setRestSec(a.reps), setRestSec(b.reps)) * factor);
      for (let s = 1; s <= totalSets; s++) {
        steps.push({ kind: "work", sec: Math.round(setWorkSec(a.exercise, a.reps)), prescription: a, setNo: s, totalSets });
        steps.push({ kind: "work", sec: Math.round(setWorkSec(b.exercise, b.reps)), prescription: b, setNo: s, totalSets });
        if (s < totalSets) steps.push({ kind: "rest", sec: rest });
      }
    } else {
      const p = el.prescriptions[0];
      for (let s = 1; s <= totalSets; s++) {
        steps.push({ kind: "work", sec: Math.round(setWorkSec(p.exercise, p.reps)), prescription: p, setNo: s, totalSets });
        if (s < totalSets) steps.push({ kind: "rest", sec: Math.round(setRestSec(p.reps)) });
      }
    }
    return steps;
  }
  function routineDurationMin(routine) {
    let t = 0; routine.blocks.forEach(br => br.elements.forEach(el => t += elementTimeSec(el)));
    return Math.round(t / 60);
  }
  function blockDurationMin(br) {
    return Math.round(br.elements.reduce((a, el) => a + elementTimeSec(el), 0) / 60);
  }

  // --- Antagonism --------------------------------------------------------
  const PUSH_FAMILY = new Set([PAT.PUSH_H, PAT.PUSH_V]);
  const PULL_FAMILY = new Set([PAT.PULL_H, PAT.PULL_V]);
  const LEG_FAMILY = new Set([PAT.HIP, PAT.KNEE]);
  function areAntagonists(p1, p2) {
    if (p1 === PAT.CORE || p2 === PAT.CORE) return true;
    if (LEG_FAMILY.has(p1) && LEG_FAMILY.has(p2) && p1 !== p2) return true;
    return (PUSH_FAMILY.has(p1) && PULL_FAMILY.has(p2)) || (PULL_FAMILY.has(p1) && PUSH_FAMILY.has(p2));
  }
  function isActiveRest(e) { return e.pattern === PAT.CORE && e.cns === CNS.LOW; }

  // --- RuleEngine ---------------------------------------------------------
  function makeResult(valid, quality, reasons) { return { valid, quality, reasons }; }
  function repRange(p) { return classifyVolume(p.reps); }

  function validateCombination(a, b) {
    if (a.block !== b.block) return makeResult(false, QUALITY.INVALID, ["Different blocks; they do not form a superset."]);
    if (a.block === BLOCK.A) return validateBlockA(a, b);
    if (a.block === BLOCK.B) return validateBlockB(a, b);
    return makeResult(true, QUALITY.OPTIMAL, ["Finalizador: combinacion libre."]);
  }
  function validateBlockA(a, b) {
    const ea = a.exercise, eb = b.exercise;
    if (ea.cns === CNS.HIGH && eb.cns === CNS.HIGH)
      return makeResult(false, QUALITY.INVALID, ["Dos de SNC alta degradan la fuerza/potencia."]);
    if (ea.grip && eb.grip && ea.dynamics === DIN.BALLISTIC && eb.dynamics === DIN.BALLISTIC)
      return makeResult(false, QUALITY.INVALID, ["Dos balisticos de agarre: fallo de agarre prematuro."]);
    const ranges = new Set([repRange(a), repRange(b)]);
    if (ranges.has(REP_RANGE.SP) && ranges.has(REP_RANGE.ME))
      return makeResult(false, QUALITY.INVALID, ["Fuerza 1-5 + metabolico 12+: interferencia."]);
    if (ea.pattern === eb.pattern && ea.pattern !== PAT.CORE)
      return makeResult(false, QUALITY.INVALID, ["Mismo patron: fatiga local, no antagonista."]);
    if (isActiveRest(ea) !== isActiveRest(eb))
      return makeResult(true, QUALITY.OPTIMAL, ["Lift principal + core de baja demanda: descanso activo ideal."]);
    // Lower-body cross-pattern (hinge + squat) is NOT a true antagonist recovery:
    // both load the posterior chain (gluteos, isquios, erectores). Aceptable, no optimo.
    if (LEG_FAMILY.has(ea.pattern) && LEG_FAMILY.has(eb.pattern) && ea.pattern !== eb.pattern)
      return makeResult(true, QUALITY.ACCEPTABLE, ["Cadera + rodilla: sin grupo en reposo real (ambos cargan cadena posterior)."]);
    if (areAntagonists(ea.pattern, eb.pattern))
      return makeResult(true, QUALITY.OPTIMAL, ["Superserie antagonista (APS): el grupo en reposo se recupera."]);
    return makeResult(true, QUALITY.ACCEPTABLE, ["Viable, pero no antagonista: prioriza pares opuestos."]);
  }
  function validateBlockB(a, b) {
    const ea = a.exercise, eb = b.exercise;
    if (ea.grip && eb.grip && ea.dynamics === DIN.BALLISTIC && eb.dynamics === DIN.BALLISTIC)
      return makeResult(true, QUALITY.ACCEPTABLE, ["Riesgo de agarre; reduce reps o intercala core."]);
    if (areAntagonists(ea.pattern, eb.pattern))
      return makeResult(true, QUALITY.OPTIMAL, ["Par antagonista en accesorios: eficiente."]);
    if (ea.pattern === eb.pattern && new Set([repRange(a), repRange(b)]).has(REP_RANGE.HP))
      return makeResult(true, QUALITY.ACCEPTABLE, ["Mismo patron en hipertrofia: volumen dirigido."]);
    return makeResult(true, QUALITY.ACCEPTABLE, ["Combinacion de accesorios aceptable."]);
  }

  // --- Fatigue budget ---------------------------------------------
  // Grip is a WEIGHTED accumulator: ballistic grip = full weight (1.0),
  // non-ballistic grip (heavy carries / rows / TGU / bottoms-up press) =
  // partial (0.5). maxGrip counts "ballistic-equivalents".
  const GRIP_W_BALLISTIC = 1.0, GRIP_W_OTHER = 0.5;
  function gripWeight(e) {
    if (!e.grip) return 0;
    return e.dynamics === DIN.BALLISTIC ? GRIP_W_BALLISTIC : GRIP_W_OTHER;
  }
  function newFatigueBudget(maxCns, maxGrip) {
    return {
      maxCns, maxGrip, cns: 0, grip: 0,
      _gripW(e) { return gripWeight(e); },
      allows(e) {
        if (e.cns === CNS.HIGH && this.cns >= this.maxCns) return false;
        const w = this._gripW(e);
        // allow when it still fits; a tiny epsilon avoids float edge rejections.
        if (w > 0 && this.grip + w > this.maxGrip + 1e-9) return false;
        return true;
      },
      consume(e) { if (e.cns === CNS.HIGH) this.cns++; this.grip += this._gripW(e); },
      snapshot() { return [this.cns, this.grip]; },
      restore(s) { this.cns = s[0]; this.grip = s[1]; },
    };
  }

  // --- Pattern balance -----------------------------------------------
  const PAT_CATEGORY = {
    PUSH_H:"PUSH", PUSH_V:"PUSH", PULL_H:"PULL", PULL_V:"PULL",
    HIP:"HIP", KNEE:"KNEE", CORE:"NEUTRAL", HYBRID:"NEUTRAL",
  };
  const ANTAGONIST_CAT = { PUSH:"PULL", PULL:"PUSH", HIP:"KNEE", KNEE:"HIP" };

  function newBalanceTracker(mode, tol) {
    return {
      mode, tol: tol == null ? 1 : tol, count: {},
      sameWeight: false,   // single-kettlebell: cluster a block around one load
      loads: [],           // load tiers chosen in the CURRENT block
      _cat(e) { return PAT_CATEGORY[e.pattern]; },
      _n(c) { return this.count[c] || 0; },
      allows(e) {
        if (this.mode !== "HARD") return true;
        const c = this._cat(e); if (c === "NEUTRAL") return true;
        return (this._n(c) + 1) - this._n(ANTAGONIST_CAT[c]) <= this.tol;
      },
      bonus(e) {
        if (this.mode === "NONE") return 0;
        const c = this._cat(e); if (c === "NEUTRAL") return 0;
        return Math.max(0, this._n(ANTAGONIST_CAT[c]) - this._n(c));
      },
      // Anchor = most common load tier already chosen in the block (null if empty).
      loadAnchor() {
        if (!this.loads.length) return null;
        const c = {}; let bestV = this.loads[0], bestN = 0;
        for (const l of this.loads) { c[l] = (c[l] || 0) + 1; if (c[l] > bestN) { bestN = c[l]; bestV = l; } }
        return bestV;
      },
      // Distance of an exercise's load from the block anchor (0 when off).
      loadPenalty(e) {
        if (!this.sameWeight) return 0;
        const a = this.loadAnchor();
        return a == null ? 0 : Math.abs((e.load || 2) - a);
      },
      register(e) {
        const c = this._cat(e); if (c !== "NEUTRAL") this.count[c] = this._n(c) + 1;
        if (this.sameWeight) this.loads.push(e.load || 2);
      },
      resetLoads() { this.loads = []; },
      snapshot() { return { count: Object.assign({}, this.count), loads: this.loads.slice() }; },
      restore(s) { this.count = Object.assign({}, s.count); this.loads = s.loads.slice(); },
    };
  }

  // --- Templates ---------------------------------------------------------
  function schema(block, count, sets, reps, dynamics, pair) {
    return { block, count, sets, reps, dynamics: new Set(dynamics), pair: pair !== false };
  }
  const TEMPLATES = {
    STRENGTH: {
      name: "Fuerza (full-body)", maxCns: 2, maxGrip: 2,
      blocks: [
        schema(BLOCK.A, 4, 5, 5, [DIN.STRENGTH, DIN.BALLISTIC]),
        schema(BLOCK.B, 4, 3, 10, [DIN.STRENGTH]),
        schema(BLOCK.C, 2, 3, 15, [DIN.METABOLIC, DIN.BALLISTIC]),
      ],
    },
    METABOLIC: {
      name: "Acondicionamiento metabolico", maxCns: 4, maxGrip: 3,
      blocks: [
        schema(BLOCK.A, 2, 4, 6, [DIN.BALLISTIC]),
        schema(BLOCK.B, 4, 3, 12, [DIN.STRENGTH, DIN.BALLISTIC]),
        schema(BLOCK.C, 2, 4, 20, [DIN.METABOLIC]),
      ],
    },
    // Higher rep strength work; bridges strength and conditioning.
    STRENGTH_ENDURANCE: {
      name: "Resistencia de fuerza", maxCns: 3, maxGrip: 2,
      blocks: [
        schema(BLOCK.A, 3, 4, 8,  [DIN.STRENGTH, DIN.BALLISTIC]),
        schema(BLOCK.B, 4, 3, 12, [DIN.STRENGTH]),
        schema(BLOCK.C, 2, 3, 20, [DIN.METABOLIC]),
      ],
    },
    // Power / plyometrics: explosive, low reps, full recovery between efforts.
    // Low reps (3) classify as SP, which already buys long rest; plyometric
    // movements force full recovery on top of that (see elementTimeSec).
    POWER: {
      name: "Potencia / Pliometria", maxCns: 3, maxGrip: 2,
      blocks: [
        schema(BLOCK.A, 3, 5, 3, [DIN.BALLISTIC]),
        schema(BLOCK.B, 3, 4, 6, [DIN.BALLISTIC, DIN.STRENGTH]),
      ],
    },
    // EMOM (Every Minute On the Minute): a small circuit of exercises done
    // as solo slots (pair:false). Each minute you start one exercise's reps,
    // rest the remainder of the minute, then move to the next. sets = number
    // of rounds through the circuit; reps = reps to hit each minute.
    EMOM: {
      name: "EMOM (cada minuto)", maxCns: 3, maxGrip: 3, fixedCount: true,
      blocks: [
        schema(BLOCK.A, 3, 6, 8, [DIN.BALLISTIC, DIN.STRENGTH], false),
      ],
    },
    // AMRAP / circuit: pair:false keeps every exercise as a solo slot
    // so the routine reads as a linear circuit to repeat for time.
    AMRAP: {
      name: "AMRAP / Circuito", maxCns: 4, maxGrip: 3, fixedCount: true,
      blocks: [
        schema(BLOCK.A, 4, 3, 10, [DIN.STRENGTH, DIN.BALLISTIC], false),
        schema(BLOCK.C, 1, 3, 15, [DIN.METABOLIC],               false),
      ],
    },
  };

  // --- Scaling by minutes ----------------------------------------------
  function repTempo(sch) {
    const dins = [...sch.dynamics].filter(d => d !== DIN.ISO);
    const use = dins.length ? dins : [DIN.STRENGTH];
    return use.reduce((a, d) => a + TEMPO[d], 0) / use.length;
  }
  function estimateSchemaSec(sch) {
    const work = sch.reps * repTempo(sch);
    const rest = REST_TIME[classifyVolume(sch.reps)];
    const restEf = sch.pair ? rest * 0.6 : rest;
    return sch.count * sch.sets * (work + restEf);
  }
  function scaleTemplate(base, minutes) {
    const target = minutes * 60;
    // Circuit protocols (EMOM / AMRAP): the exercise count IS the circuit and
    // must stay small. Time scales the number of ROUNDS through that circuit,
    // not the number of distinct movements.
    if (base.fixedCount) {
      const oneRound = base.blocks
        .reduce((a, b) => a + estimateSchemaSec(schema(b.block, b.count, 1, b.reps, [...b.dynamics], b.pair)), 0) || 1;
      const rounds = Math.max(2, Math.min(12, Math.round(target / oneRound)));
      const blocks = base.blocks.map(b => schema(b.block, b.count, rounds, b.reps, [...b.dynamics], b.pair));
      return { name: base.name, maxCns: base.maxCns, maxGrip: base.maxGrip, fixedCount: true, blocks };
    }
    const baseTotal = base.blocks.reduce((a, b) => a + estimateSchemaSec(b), 0) || 1;
    const factor = Math.max(0.3, Math.min(2.5, target / baseTotal));
    const sf = Math.sqrt(factor);
    const withSets = base.blocks.map(b => {
      const [lo, hi] = SETS_RANGE[classifyVolume(b.reps)];
      const ns = Math.min(hi, Math.max(lo, Math.round(b.sets * sf)));
      return schema(b.block, b.count, ns, b.reps, [...b.dynamics], b.pair);
    });
    const tUnit = withSets.map(b => estimateSchemaSec(schema(b.block, 1, b.sets, b.reps, [...b.dynamics], b.pair)));
    const denom = withSets.reduce((a, b, i) => a + b.count * tUnit[i], 0) || 1;
    const k = target / denom;
    const blocks = withSets.map(b => schema(b.block, Math.max(1, Math.round(k * b.count)), b.sets, b.reps, [...b.dynamics], b.pair));
    return { name: base.name, maxCns: base.maxCns, maxGrip: base.maxGrip, blocks };
  }

  // --- Seeded RNG -------------------------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeRng(seed) { return (seed == null || seed === "") ? Math.random : mulberry32(seed >>> 0); }
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }

  // --- Assembler --------------------------------------------------------
  function prescribe(e, sch) {
    let reps = sch.reps;
    if (e.dynamics === DIN.ISO) reps = Math.max(reps, 8);
    return { exercise: e, block: sch.block, sets: sch.sets, reps };
  }
  function priority(e, sch, bal) {
    let s = 0;
    if (sch.dynamics.has(e.dynamics)) s += 4;
    if (sch.block === BLOCK.A && e.pattern !== PAT.CORE) s += 2;
    s += 2 * bal.bonus(e);
    if (bal.focus && bal.focus.has(e.pattern)) s += 6;   // muscle focus: dominates selection
    s += TIER_BONUS[e.tier] || 0;                        // fundamentals up, optional down
    if (bal.recent) s -= (bal.recent[e.name] || 0);      // avoid repeating recent
    if (bal.sore && bal.sore.has(e.pattern)) s -= 3;     // readiness: ease off sore zones
    s -= 2.0 * bal.loadPenalty(e);                        // single-weight: cluster loads
    return s;
  }

  // Kg suggestion for an adjustable kettlebell: maps the load tier (light/
  // medium/heavy) within the user's available range, rounded to 2 kg.
  // Cold-start seed multiplier from person features (doc: load-rep-individualization §3/§4).
  // Returns 1 when no profile is given, so suggestKg(load,min,max) is unchanged.
  const UPPER_PATTERNS = new Set([PAT.PUSH_H, PAT.PUSH_V, PAT.PULL_H, PAT.PULL_V]);
  function personSeedMultiplier(person, exercise) {
    if (!person) return 1;
    let m = 1;
    const lvl = (person.level || "").toUpperCase();
    m *= { BEG: 0.85, INTER: 1, ADV: 1.12 }[lvl] || 1;
    // Sex shifts upper-body strength norms more than lower-body.
    if ((person.sex || "").toUpperCase() === "F" && exercise && UPPER_PATTERNS.has(exercise.pattern)) m *= 0.9;
    // Bodyweight as a gentle anchor around a 75 kg reference.
    const bw = +person.bodyweight;
    if (bw > 0) m *= Math.max(0.9, Math.min(1.15, 1 + ((bw - 75) / 75) * 0.15));
    return Math.max(0.7, Math.min(1.3, m));
  }

  function suggestKg(load, min, max, person, exercise) {
    if (min == null || max == null) return null;
    const base = { 1: 0.15, 2: 0.5, 3: 0.85 }[load];
    let frac = base == null ? 0.5 : base;
    frac = Math.max(0.1, Math.min(0.95, frac * personSeedMultiplier(person, exercise)));
    const kg = Math.round((min + frac * (max - min)) / 2) * 2;
    return Math.max(min, Math.min(max, kg));
  }

  // --- Double progression (doc: load-rep-individualization §2D/§6) -------
  // Rep window for an exercise, derived from its prescribed reps' volume class.
  // Progress reps from lo up to hi; on clearing hi across all sets, add load
  // and reset to lo. ISO movements progress reps a bit higher (time-under-load).
  const PROGRESSION_RANGE = { SP: [5, 8], HP: [8, 12], ME: [15, 20] };
  function progressionRange(reps, dynamics) {
    const r = PROGRESSION_RANGE[classifyVolume(reps)] || [reps, reps + 3];
    if (dynamics === DIN.ISO) return [Math.max(r[0], 8), Math.max(r[1], 12)];
    return r.slice();
  }

  // Given the current target {kg, reps} and the trainee's feedback, return the
  // next session's {kg, reps}. Feedback (RPE-style autoregulation):
  //   'ok'  / true  -> cleared normally: reps +1 toward top; at top -> +step kg,
  //                    reset reps to bottom (double progression).
  //   'easy'        -> too easy: advance two rep-steps (jumps the range faster,
  //                    or bumps load when it overshoots the top).
  //   'hard'        -> too hard: back off one step (reps -1; at bottom, -step kg).
  //   'hold'/ false -> repeat the same target unchanged.
  // step defaults to 2 kg (adjustable kettlebell increment); kg stays in range.
  function nextTarget(current, range, feedback, opts) {
    opts = opts || {};
    const step = opts.step || 2, min = opts.min, max = opts.max;
    const [lo, hi] = range;
    let kg = current && current.kg != null ? current.kg : (opts.startKg != null ? opts.startKg : null);
    let reps = current && current.reps != null ? current.reps : lo;
    if (reps < lo) reps = lo; if (reps > hi) reps = hi;
    const fb = feedback === true ? "ok" : feedback === false ? "hold" : String(feedback);
    const clamp = v => { let n = v; if (max != null) n = Math.min(max, n); if (min != null) n = Math.max(min, n); return n; };

    if (fb === "hold") return { kg, reps };
    if (fb === "hard") {
      if (reps > lo) return { kg, reps: reps - 1 };
      const nk = kg == null ? null : clamp(kg - step);
      return { kg: nk, reps: lo };       // deload weight, stay at the bottom
    }
    // 'ok' (+1) or 'easy' (+2)
    const inc = fb === "easy" ? 2 : 1;
    if (reps + inc > hi) {
      const nk = kg == null ? null : clamp(kg + step);
      // If load can't go higher (at max), keep climbing reps past the window.
      if (kg != null && max != null && nk === kg) return { kg, reps: reps + inc };
      return { kg: nk, reps: lo };
    }
    return { kg, reps: reps + inc };
  }

  // --- Estimated 1-rep max (e1RM) ---------------------------------------
  // (doc: load-rep-individualization §2D phase 4). An e1RM is the load a
  // trainee could lift ONCE, estimated from a set taken closer to failure.
  // It turns "I did 16 kg x 6" into a single comparable number that tracks
  // strength over time and can be inverted to prescribe a working weight.
  //
  // Epley's formula: 1RM ≈ w · (1 + reps/30). It is exact at reps = 1 and
  // drifts high for very high reps, so we clamp the rep count used in the
  // estimate (E1RM_MAX_REPS). e1RM is only meaningful for grind / strength
  // work: ballistics are power (load chosen for speed, not a max) and ISO is
  // time-under-load, so callers must gate on e1rmEligible for those.
  const E1RM_MAX_REPS = 12;
  function e1rmEligible(exercise) {
    return !!exercise && exercise.dynamics !== DIN.BALLISTIC && exercise.dynamics !== DIN.ISO;
  }
  // Epley e1RM for one set. Returns null for a non-positive load or rep count.
  function e1rm(kg, reps) {
    if (kg == null || !(kg > 0) || !(reps > 0)) return null;
    if (reps === 1) return kg;     // a single rep IS the 1RM (Epley is for reps>1)
    return kg * (1 + Math.min(reps, E1RM_MAX_REPS) / 30);
  }
  // Highest e1RM across the logged sets of one exercise. `sets` is an array of
  // { kg, reps }; the best (heaviest-equivalent) set wins. null if none usable.
  function bestE1rm(sets) {
    let best = null;
    (sets || []).forEach(s => {
      const v = s && e1rm(s.kg, s.reps);
      if (v != null && (best == null || v > best)) best = v;
    });
    return best;
  }
  // Inverse Epley: the working load that yields `e1` at `reps` reps. Snapped to
  // the 2 kg increment and clamped to [min,max] (opts) so it lands on the
  // adjustable kettlebell. Used to prescribe a weight from a tracked e1RM.
  function loadForReps(e1, reps, opts) {
    if (e1 == null || !(e1 > 0) || !(reps > 0)) return null;
    const raw = e1 / (1 + Math.min(reps, E1RM_MAX_REPS) / 30);
    opts = opts || {};
    return snapKg(raw, opts.min, opts.max);
  }
  // Smooth a chronological list of e1RM estimates with an exponential moving
  // average (default alpha 0.5): the latest session weighs most, a single
  // noisy near-failure set less. Returns null for an empty list.
  function smoothE1rm(values, alpha) {
    const a = alpha == null ? 0.5 : alpha;
    let ema = null;
    (values || []).forEach(v => { if (v == null) return; ema = ema == null ? v : a * v + (1 - a) * ema; });
    return ema;
  }

  // --- Routine-combination load modifier (doc §2C) ----------------------
  // Down-modulates the SUGGESTED load for context: the fatigued half of a
  // non-ideal superset, and lifts placed late in a CNS-heavy session. Returns
  // a factor in [0.8, 1]; 1 means "no change". Applies only to the cold-start
  // suggestion — a user-dialed kg always wins.
  const CNS_WEIGHT = { HIGH: 2, MEDIUM: 1, LOW: 0 };
  function cnsWeight(cns) { return CNS_WEIGHT[cns] || 0; }
  function combinationFactor(ctx) {
    ctx = ctx || {};
    let f = 1;
    // A merely-ACCEPTABLE superset pre-fatigues its second movement.
    if (ctx.isSuperset && ctx.secondInPair && ctx.quality === QUALITY.ACCEPTABLE) f *= 0.92;
    // Session fatigue: taper as cumulative CNS load builds before this lift.
    f *= Math.max(0.85, 1 - 0.03 * (ctx.cnsAccum || 0));
    return Math.max(0.8, Math.round(f * 100) / 100);
  }
  // Snap a raw kg to the 2 kg increment and clamp into [min, max].
  function snapKg(kg, min, max) {
    let k = Math.round(kg / 2) * 2;
    if (min != null) k = Math.max(min, k);
    if (max != null) k = Math.min(max, k);
    return k;
  }

  // --- Single-kettlebell mode: one weight per circuit -------------------
  // With a single adjustable kettlebell, changing the weight between every
  // exercise of a series/circuit is friction. unifiedKg collapses a group of
  // prescriptions to ONE suggested weight so the whole block can be trained
  // without re-dialing the bell. The compromise is the MEDIAN of the per-
  // exercise suggestions (snapped to 2 kg, clamped to range): heavy enough for
  // the hinge/squat work, not so heavy it wrecks the light technical lifts.
  // Returns null when no weight can be suggested (range missing / empty group).
  function unifiedKg(prescriptions, range, person) {
    if (!range || range.min == null || range.max == null) return null;
    const ks = (prescriptions || [])
      .map(p => suggestKg(p.exercise.load, range.min, range.max, person, p.exercise))
      .filter(k => k != null)
      .sort((a, b) => a - b);
    if (!ks.length) return null;
    const mid = ks.length >> 1;
    const median = ks.length % 2 ? ks[mid] : (ks[mid - 1] + ks[mid]) / 2;
    return snapKg(median, range.min, range.max);
  }

  // Load warning: "low" = the kettlebell is too light for the exercise;
  // "high" = the kettlebell is excessive for a light/technical movement.
  function loadWarning(load, weightKb) {
    if (!weightKb) return null;
    const d = load - weightKb;
    if (d >= 2) return "low";
    if (d <= -2) return "high";
    return null;
  }
  function makeSlot(prescriptions, quality, note) {
    return { prescriptions, quality, note, isSuperset: prescriptions.length === 2 };
  }

  function filterByEquipment(pool, available) {
    const set = new Set(available); set.add(EQ.FLOOR);
    return pool.filter(e => e.equipment.every(q => set.has(q)));
  }

  function pickPartner(pa, cands, sch, budget, bal) {
    // Prefer, in order: superset quality, then (single-weight mode) a partner
    // whose load matches the block anchor, then the balance bonus.
    let best = null, key = [-1, 1, -1];
    for (const c of cands) {
      if (!budget.allows(c) || !bal.allows(c)) continue;
      const res = validateCombination(pa, prescribe(c, sch));
      if (!res.valid) continue;
      const k = [res.quality, -bal.loadPenalty(c), bal.bonus(c)];
      if (k[0] > key[0] || (k[0] === key[0] && (k[1] > key[1] || (k[1] === key[1] && k[2] > key[2])))) { best = c; key = k; }
    }
    return best;
  }

  // Places pinned exercises first (with partner if applicable).
  function preplaceFixed(pinned, sch, pool, used, budget, bal, rng, reserved) {
    reserved = reserved || new Set();
    const elements = [];
    const pending = (pinned || []).filter(e => !used.has(e));
    for (let i = 0; i < pending.length; i++) {
      const first = pending[i];
      if (used.has(first)) continue;
      used.add(first); budget.consume(first); bal.register(first);
      const pa = prescribe(first, sch);
      let partner = null;
      if (sch.pair) {
        const otherPinned = pending.slice(i + 1).filter(e => !used.has(e));
        partner = pickPartner(pa, otherPinned, sch, budget, bal);
        if (!partner) {
          const free = pool.filter(e => !used.has(e) && !reserved.has(e) && !pending.includes(e));
          partner = pickPartner(pa, free, sch, budget, bal);
        }
      }
      if (partner) {
        used.add(partner); budget.consume(partner); bal.register(partner);
        const res = validateCombination(pa, prescribe(partner, sch));
        elements.push(makeSlot([pa, prescribe(partner, sch)], res.quality, "Fijado · " + res.reasons.join(" | ")));
      } else {
        elements.push(makeSlot([pa], QUALITY.ACCEPTABLE, "Fijado · set directo."));
      }
    }
    return elements;
  }

  function buildGreedy(sch, pool, used, budget, bal, rng, pinned, reserved) {
    reserved = reserved || new Set();
    bal.resetLoads();   // load cohesion is per-block
    const elements = preplaceFixed(pinned, sch, pool, used, budget, bal, rng, reserved);
    let placed = elements.reduce((a, el) => a + el.prescriptions.length, 0);
    const avail = shuffle(pool.filter(e => !used.has(e) && !reserved.has(e)), rng);
    while (placed < sch.count) {
      const cands = avail.filter(e => !used.has(e) && budget.allows(e) && bal.allows(e));
      if (!cands.length) break;
      let first = cands[0], best = priority(first, sch, bal);
      for (const c of cands) { const p = priority(c, sch, bal); if (p > best) { best = p; first = c; } }
      used.add(first); budget.consume(first); bal.register(first);
      const pa = prescribe(first, sch);
      if (sch.pair && (placed + 1) < sch.count) {
        const rest = avail.filter(e => !used.has(e));
        const partner = pickPartner(pa, rest, sch, budget, bal);
        if (partner) {
          used.add(partner); budget.consume(partner); bal.register(partner);
          const res = validateCombination(pa, prescribe(partner, sch));
          elements.push(makeSlot([pa, prescribe(partner, sch)], res.quality, res.reasons.join(" | ")));
          placed += 2; continue;
        }
      }
      elements.push(makeSlot([pa], QUALITY.ACCEPTABLE, "Set directo: sin pareja antagonista disponible."));
      placed += 1;
    }
    return { block: sch.block, elements };
  }

  function buildBacktrack(sch, pool, used, budget, bal, rng, pinned, reserved) {
    reserved = reserved || new Set();
    bal.resetLoads();   // load cohesion is per-block
    const target = sch.count;
    const apply = e => { used.add(e); budget.consume(e); bal.register(e); };
    const pre = preplaceFixed(pinned, sch, pool, used, budget, bal, rng, reserved);  // pinned already consumed
    const avail = shuffle(pool.filter(e => !used.has(e) && !reserved.has(e)), rng);
    const LIMIT = 4000, BP = 8, BPART = 6;
    const valid = () => avail.filter(e => !used.has(e) && budget.allows(e) && bal.allows(e));
    const nPlaced = els => els.reduce((a, el) => a + el.prescriptions.length, 0);
    const score = els => [nPlaced(els), els.reduce((a, el) => a + el.quality, 0)];

    function genMoves(remaining) {
      const cands = valid().sort((x, y) => priority(y, sch, bal) - priority(x, sch, bal)).slice(0, BP);
      const moves = [];
      if (sch.pair && remaining >= 2) {
        for (const first of cands) {
          const sb = bal.snapshot(), sp = budget.snapshot();
          apply(first);
          const pa = prescribe(first, sch);
          const partners = [];
          for (const part of valid()) {
            if (part === first) continue;
            const res = validateCombination(pa, prescribe(part, sch));
            if (res.valid) partners.push([res.quality, bal.bonus(part), part, res]);
          }
          partners.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
          used.delete(first); bal.restore(sb); budget.restore(sp);
          for (const [, , part, res] of partners.slice(0, BPART))
            moves.push([[first, part], makeSlot([prescribe(first, sch), prescribe(part, sch)], res.quality, res.reasons.join(" | "))]);
        }
      }
      for (const first of cands)
        moves.push([[first], makeSlot([prescribe(first, sch)], QUALITY.ACCEPTABLE, "Set directo: sin pareja viable bajo la cuota de balance.")]);
      return moves;
    }

    let best = { els: pre.slice(), score: score(pre) }, nodes = 0;
    function dfs(els) {
      nodes++;
      const sc = score(els);
      if (sc[0] > best.score[0] || (sc[0] === best.score[0] && sc[1] > best.score[1]))
        best = { els: els.slice(), score: sc };
      if (sc[0] >= target) return true;
      if (nodes > LIMIT) return false;
      for (const [exs, el] of genMoves(target - sc[0])) {
        const sb = bal.snapshot(), sp = budget.snapshot();
        exs.forEach(apply); els.push(el);
        if (dfs(els)) return true;
        els.pop(); exs.forEach(e => used.delete(e)); bal.restore(sb); budget.restore(sp);
      }
      return false;
    }
    dfs(pre.slice());

    let relaxed = false;
    if (best.score[0] < target) {
      const tol0 = bal.tol; bal.tol += 1; best = { els: pre.slice(), score: score(pre) }; nodes = 0;
      dfs(pre.slice()); bal.tol = tol0; relaxed = true;
    }
    const elements = best.els;
    // pinned (0..pre.length) already consumed; apply only what DFS added
    for (let i = pre.length; i < elements.length; i++)
      elements[i].prescriptions.forEach(p => apply(p.exercise));
    if (relaxed) elements.forEach(el => { if (!/Fijado/.test(el.note)) el.note += "  [+tolerancia: balance relajado para evitar hueco]"; });
    return { block: sch.block, elements };
  }

  function inferBlock(e, template) {
    for (const b of template.blocks) if (b.dynamics.has(e.dynamics)) return b.block;
    const ids = template.blocks.map(b => b.block);
    return ids.indexOf(BLOCK.B) >= 0 ? BLOCK.B : ids[0];
  }

  function templateFromStructure(base, structure) {
    const blocks = base.blocks
      .filter(b => (structure[b.block] || 0) > 0)
      .map(b => schema(b.block, structure[b.block], b.sets, b.reps, [...b.dynamics], b.pair));
    return { name: base.name, maxCns: base.maxCns, maxGrip: base.maxGrip, blocks };
  }

  function buildRoutine(template, available, weightKb, seed, balance, tol, focus, pinnedNames, recent, sameWeight) {
    const rng = makeRng(seed);
    const poolBase = template.__pool || BASE_CATALOG;
    const pool = filterByEquipment(poolBase, available);
    const used = new Set();
    const budget = newFatigueBudget(template.maxCns, template.maxGrip);
    const bal = newBalanceTracker(balance || "NONE", tol);
    bal.focus = focus || null;
    bal.weightKb = weightKb || null;
    bal.recent = recent || null;
    bal.sore = template.__sore || null;   // sore patterns to de-prioritize today
    bal.sameWeight = !!sameWeight;

    // Resolve pinned exercises. Each can be a name (string) or {name, block}.
    // block "AUTO"/absent -> infer by dynamics. If the requested block does not exist
    // in the template, it is inferred and, as a last resort, goes to the first block.
    const templateIds = template.blocks.map(b => b.block);
    const byBlock = {};
    (pinnedNames || []).forEach(f => {
      const name = typeof f === "string" ? f : f.name;
      const requested = typeof f === "string" ? null : f.block;
      const e = pool.find(x => x.name === name);
      if (!e) return;
      let b = (requested && requested !== "AUTO" && templateIds.indexOf(requested) >= 0) ? requested : inferBlock(e, template);
      if (templateIds.indexOf(b) < 0) b = templateIds[0];
      (byBlock[b] = byBlock[b] || []).push(e);
    });

    const reserved = new Set();
    Object.keys(byBlock).forEach(b => byBlock[b].forEach(e => reserved.add(e)));

    const blocks = template.blocks.map(sch => {
      const pinned = byBlock[sch.block] || [];
      const schAdjusted = pinned.length > sch.count
        ? schema(sch.block, pinned.length, sch.sets, sch.reps, [...sch.dynamics], sch.pair)
        : sch;
      const build = bal.mode === "HARD" ? buildBacktrack : buildGreedy;
      return build(schAdjusted, pool, used, budget, bal, rng, pinned, reserved);
    });
    return { template: template.name, warmup: buildWarmup(blocks), blocks };
  }

  // --- Warm-up / ramp-up -------------------------------------------------
  // Ballistic posterior-chain work with no preparation is the main injury gap.
  // Returns a lightweight, data-driven prep block: mobility + 1-2 ramp-up sets
  // of the first ballistic (or first) lift of Block A. Shape: { items: string[],
  // rampUp: { exercise, sets, reps } | null }.
  function buildWarmup(blocks) {
    const items = [
      "Movilidad de cadera y columna toracica (~3 min): rotaciones, gato-camello, halos ligeros.",
      "Activacion de gluteo y core: puentes y planchas cortas.",
    ];
    const blockA = blocks.find(b => b.block === BLOCK.A);
    let rampUp = null;
    if (blockA) {
      const prescriptions = blockA.elements.flatMap(el => el.prescriptions);
      const firstBallistic = prescriptions.find(p => p.exercise.dynamics === DIN.BALLISTIC);
      const lead = firstBallistic || prescriptions[0];
      if (lead) {
        rampUp = { exercise: lead.exercise, sets: 2, reps: Math.max(5, Math.round(lead.reps * 0.6)) };
        items.push("Series de aproximacion: 2 x " + rampUp.reps + " de " + lead.exercise.name +
          " con carga ligera antes del trabajo pesado.");
      }
    }
    return { items, rampUp };
  }

  // --- Manual routines: compose + audit ---------------------------------
  // The generator is not the only path to a session: the trainee can hand-
  // build one and have the SAME rule engine scrutinize it. composeRoutine
  // turns a flat list of user entries into the routine shape the rest of the
  // app understands; auditRoutine walks any routine (manual or generated) and
  // returns a scored critique instead of silently fixing it.

  // entries: [{ exercise, block:"A"|"B"|"C", sets, reps, pair }] in user order.
  // pair=true merges the entry into the PREVIOUS entry of the same block as a
  // superset (only if that element is still a single). Quality/notes come from
  // validateCombination so the trainee sees the same verdicts the engine uses.
  function composeRoutine(entries) {
    const byBlock = { A: [], B: [], C: [] };
    (entries || []).forEach(en => {
      if (!en || !en.exercise) return;
      const blockId = byBlock[en.block] ? en.block : BLOCK.B;
      const list = byBlock[blockId];
      const p = { exercise: en.exercise, block: blockId,
                  sets: Math.max(1, en.sets || 3), reps: Math.max(1, en.reps || 8) };
      const prev = list[list.length - 1];
      if (en.pair && prev && prev.prescriptions.length === 1) {
        prev.prescriptions.push(p);
        const res = validateCombination(prev.prescriptions[0], p);
        prev.quality = res.quality;
        prev.isSuperset = true;
        prev.note = "Definida por ti · " + res.reasons.join(" | ");
      } else {
        list.push(makeSlot([p], QUALITY.ACCEPTABLE, "Definida por ti."));
      }
    });
    const blocks = [BLOCK.A, BLOCK.B, BLOCK.C]
      .filter(k => byBlock[k].length)
      .map(k => ({ block: k, elements: byBlock[k] }));
    return { template: "Rutina manual", warmup: buildWarmup(blocks), blocks };
  }

  // Scrutiny: score a routine against the engine's own rules. Unlike the
  // generator (which enforces budgets while selecting), the audit takes a
  // finished routine and reports what it finds: findings [{level, msg, block}]
  // with level "error" (breaks a hard rule), "warn" (budget/balance risk) or
  // "tip" (suboptimal but defensible). Score starts at 100 and drops per
  // finding; verdict is a plain-language label. Caps default to a mid-range
  // budget (between the strictest and loosest objective templates) and can be
  // overridden via opts {maxCns, maxGrip} to audit against a specific goal.
  // Pass opts.pool (the available exercises) to also get `suggestions`:
  // concrete fixes (swap/add/split) for what the findings flag.
  const AUDIT_PENALTY = { error: 25, warn: 10, tip: 3 };
  function auditVerdict(score) {
    return score >= 90 ? "Solida" : score >= 70 ? "Con matices"
         : score >= 45 ? "Mejorable" : "Arriesgada";
  }
  function auditRoutine(routine, opts) {
    opts = opts || {};
    const maxCns = opts.maxCns == null ? 3 : opts.maxCns;
    const maxGrip = opts.maxGrip == null ? 3 : opts.maxGrip;
    const findings = [];
    const add = (level, msg, block) => findings.push({ level, msg, block: block || null });
    const blocks = (routine && routine.blocks) || [];
    const all = [];   // [prescription, blockId]
    blocks.forEach(br => br.elements.forEach(elm => elm.prescriptions.forEach(p => all.push([p, br.block]))));

    if (!all.length) {
      add("error", "Rutina vacia: anade al menos un ejercicio.");
      return { score: 0, verdict: auditVerdict(0), findings, suggestions: [],
               stats: { exercises: 0, highCns: 0, grip: 0, minutes: 0 } };
    }

    // 1) Supersets: the same block-A/B rules the generator enforces.
    blocks.forEach(br => br.elements.forEach(elm => {
      if (elm.prescriptions.length !== 2) return;
      const [a, b] = elm.prescriptions;
      const names = a.exercise.name + " + " + b.exercise.name;
      const res = validateCombination(a, b);
      if (!res.valid) add("error", "Superserie " + names + ": " + res.reasons.join(" "), br.block);
      else if (res.quality === QUALITY.ACCEPTABLE) add("tip", "Superserie " + names + ": " + res.reasons.join(" "), br.block);
    }));

    // 2) Fatigue budgets: high-CNS count and weighted grip accumulator.
    const highCns = all.filter(([p]) => p.exercise.cns === CNS.HIGH).length;
    if (highCns > maxCns)
      add(highCns > maxCns + 1 ? "error" : "warn",
        highCns + " ejercicios de SNC alta (presupuesto: " + maxCns + "): la sesion puede fundirte antes del final.");
    const grip = all.reduce((acc, [p]) => acc + gripWeight(p.exercise), 0);
    if (grip > maxGrip + 1e-9)
      add("warn", "Carga de agarre " + (Math.round(grip * 10) / 10) + " sobre un maximo de " + maxGrip +
        ": el agarre puede fallar antes que el musculo objetivo.");

    // 3) Repeated exercise across the session.
    const seen = {};
    all.forEach(([p]) => { seen[p.exercise.name] = (seen[p.exercise.name] || 0) + 1; });
    Object.keys(seen).forEach(n => {
      if (seen[n] > 1) add("warn", n + " aparece " + seen[n] + " veces: reparte ese volumen en un solo hueco o cambia la variante.");
    });

    // 4) Pattern balance: push/pull and hip/knee should not diverge by 2+.
    const cat = {};
    all.forEach(([p]) => { const c = PAT_CATEGORY[p.exercise.pattern]; if (c !== "NEUTRAL") cat[c] = (cat[c] || 0) + 1; });
    [["PUSH", "PULL", "empuje", "tiron"], ["HIP", "KNEE", "cadera", "rodilla"]].forEach(([x, y, lx, ly]) => {
      const nx = cat[x] || 0, ny = cat[y] || 0;
      if (Math.abs(nx - ny) >= 2)
        add("warn", "Desequilibrio " + lx + "/" + ly + " (" + nx + " vs " + ny + "): a la larga pasa factura; compensa el patron contrario.");
    });

    // 5) Order: demanding work belongs early, metabolic work late.
    blocks.forEach(br => br.elements.forEach(elm => elm.prescriptions.forEach(p => {
      if (br.block === BLOCK.C && p.exercise.cns === CNS.HIGH)
        add("tip", p.exercise.name + " en el finalizador: lo de SNC alta rinde mas al principio, en fresco.", br.block);
      if (br.block === BLOCK.A && p.exercise.dynamics === DIN.METABOLIC)
        add("tip", p.exercise.name + " en el bloque A: lo metabolico encaja mejor como finalizador (C).", br.block);
      if (p.exercise.dynamics === DIN.STRENGTH && p.reps >= 15)
        add("tip", p.exercise.name + " a " + p.reps + " reps: eso ya es resistencia, no fuerza; sube carga o baja reps.", br.block);
      if (p.sets > 6)
        add("tip", p.exercise.name + " a " + p.sets + " series: mas de 6 rara vez suma; reparte en otro ejercicio.", br.block);
    })));

    let score = 100;
    findings.forEach(f => { score -= AUDIT_PENALTY[f.level] || 0; });
    score = Math.max(0, score);
    const suggestions = (opts.pool && opts.pool.length)
      ? auditSuggestions(blocks, all, opts.pool, { maxCns, highCns, maxGrip, grip, seen, cat })
      : [];
    return {
      score, verdict: auditVerdict(score), findings, suggestions,
      stats: { exercises: all.length, highCns, grip: Math.round(grip * 10) / 10, minutes: routineDurationMin(routine) },
    };
  }

  // Suggestions: the prescriptive half of the scrutiny. Findings say what is
  // wrong; suggestions say what to DO about it, with concrete exercises drawn
  // from the trainee's available pool (fundamental tier first, never one that
  // is already in the routine). Only produced when auditRoutine receives
  // opts.pool; capped so the card stays readable.
  const MAX_SUGGESTIONS = 4;
  function auditSuggestions(blocks, all, pool, ctx) {
    const sugg = [];
    const used = new Set(all.map(([p]) => p.exercise.name));
    const candidates = pred => pool
      .filter(e => !used.has(e.name) && pred(e))
      .sort((a, b) => (TIER_BONUS[b.tier] || 0) - (TIER_BONUS[a.tier] || 0) || a.name.localeCompare(b.name));
    // "Trains the same thing": exact pattern or same push/pull/hip/knee category.
    const sameWork = (e, x) => e.pattern === x.pattern ||
      (PAT_CATEGORY[e.pattern] !== "NEUTRAL" && PAT_CATEGORY[e.pattern] === PAT_CATEGORY[x.pattern]);

    // Broken supersets: offer a partner that actually combines, else split.
    blocks.forEach(br => br.elements.forEach(elm => {
      if (elm.prescriptions.length !== 2) return;
      const [a, b] = elm.prescriptions;
      if (validateCombination(a, b).valid) return;
      const partner = candidates(e => validateCombination(a,
        { exercise: e, block: br.block, sets: b.sets, reps: b.reps }).quality === QUALITY.OPTIMAL)[0];
      sugg.push(partner
        ? "Superserie rota: empareja " + a.exercise.name + " con " + partner.name + " (combinacion optima) o separa ambos en huecos propios."
        : "Superserie rota: separa " + a.exercise.name + " y " + b.exercise.name + " en huecos propios.");
    }));

    // Over the CNS budget: swap an excess high-CNS lift for a calmer one that
    // trains the same pattern.
    if (ctx.highCns > ctx.maxCns) {
      const extra = all.filter(([p]) => p.exercise.cns === CNS.HIGH).slice(ctx.maxCns);
      for (const [p] of extra) {
        const alt = candidates(e => e.cns !== CNS.HIGH && sameWork(e, p.exercise))[0];
        if (alt) {
          sugg.push("Para volver al presupuesto de SNC, cambia " + p.exercise.name + " por " +
            alt.name + ": mismo trabajo con menos demanda nerviosa.");
          break;
        }
      }
    }

    // Grip overload: replace the heaviest grip consumer with a grip-free option.
    if (ctx.grip > ctx.maxGrip + 1e-9) {
      const heaviest = all.slice().sort((x, y) => gripWeight(y[0].exercise) - gripWeight(x[0].exercise))[0][0].exercise;
      const alt = candidates(e => !e.grip && sameWork(e, heaviest))[0];
      if (alt) sugg.push("Para aliviar el agarre, cambia " + heaviest.name + " por " + alt.name + ", que no lo consume.");
    }

    // Repeated exercise: propose a variant that spreads the stimulus.
    Object.keys(ctx.seen).filter(n => ctx.seen[n] > 1).forEach(n => {
      const ex = all.map(([p]) => p.exercise).find(e => e.name === n);
      const alt = ex && candidates(e => sameWork(e, ex))[0];
      if (alt) sugg.push("En vez de repetir " + n + ", prueba " + alt.name + " en uno de los huecos.");
    });

    // Pattern imbalance: name the missing category with up to two options.
    [["PUSH", "PULL", "empuje", "tiron"], ["HIP", "KNEE", "cadera", "rodilla"]].forEach(([x, y, lx, ly]) => {
      const nx = ctx.cat[x] || 0, ny = ctx.cat[y] || 0;
      if (Math.abs(nx - ny) < 2) return;
      const short = nx < ny ? x : y, label = nx < ny ? lx : ly;
      const picks = candidates(e => PAT_CATEGORY[e.pattern] === short).slice(0, 2);
      if (picks.length)
        sugg.push("Anade " + label + " para equilibrar: " + picks.map(e => e.name).join(" o ") + ".");
    });

    return sugg.slice(0, MAX_SUGGESTIONS);
  }

  // --- High-level API --------------------------------------------------
  const FOCUS_PAT = {
    LEGS:      [PAT.HIP, PAT.KNEE],
    PUSH:      [PAT.PUSH_H, PAT.PUSH_V],
    PULL:      [PAT.PULL_H, PAT.PULL_V],
    SHOULDERS: [PAT.PUSH_V, PAT.PULL_V],
    CHEST:     [PAT.PUSH_H, PAT.PULL_H],
    CORE:      [PAT.CORE, PAT.HYBRID],
  };
  const FOCUS_LABEL = {
    FULL:      "Full-body",
    LEGS:      "Piernas",
    PUSH:      "Empuje / hombros",
    PULL:      "Pull / tirón",
    SHOULDERS: "Hombros",
    CHEST:     "Pecho",
    CORE:      "Core / abdomen",
  };

  // Rescale a (already scaled) template toward a time target. For circuit
  // templates that means more/fewer ROUNDS (sets, clamped 2..12); otherwise
  // more/fewer exercises (count, min 1).
  function rescaleTemplateCounts(tpl, factor, fixedCount) {
    const blocks = tpl.blocks.map(b => {
      if (fixedCount) {
        const ns = Math.max(2, Math.min(12, Math.round(b.sets * factor)));
        return schema(b.block, b.count, ns, b.reps, [...b.dynamics], b.pair);
      }
      const nc = Math.max(1, Math.round(b.count * factor));
      return schema(b.block, nc, b.sets, b.reps, [...b.dynamics], b.pair);
    });
    return { name: tpl.name, maxCns: tpl.maxCns, maxGrip: tpl.maxGrip, fixedCount: tpl.fixedCount, blocks };
  }

  // --- Daily readiness / mood autoregulation ----------------------------
  // The plan (objective + progression) says what's *due*; readiness bends it to
  // how the trainee actually shows up today. A pre-session check — energy (1..5),
  // sleep (ok|poor) and sore zones — maps to factors that feed the SAME levers
  // as periodization, so the day's session = objective × phase × readiness:
  //   volumeFactor  scales target minutes (fewer/more sets) — engine.
  //   cnsFactor     tightens the high-CNS budget on rough days — engine.
  //   sore (Set)    de-prioritizes sore movement patterns in selection — engine.
  //   loadFactor    multiplies the SUGGESTED kg (lighter when flat) — app render.
  // All factors are 1 / 0 / empty for a missing or "normal" check, so behavior
  // is unchanged without readiness. A user-dialed kg always wins over loadFactor.
  function readinessFactors(readiness) {
    const neutral = { volumeFactor: 1, loadFactor: 1, cnsFactor: 1, sore: new Set(), energy: 3, level: "normal" };
    if (!readiness) return neutral;
    const e = Math.max(1, Math.min(5, +readiness.energy || 3));
    const poor = (readiness.sleep || "").toLowerCase() === "poor";
    const VOL  = { 1: 0.70, 2: 0.85, 3: 1, 4: 1.10, 5: 1.15 };
    const LOAD = { 1: 0.88, 2: 0.94, 3: 1, 4: 1.02, 5: 1.05 };
    const CNS  = { 1: 0.50, 2: 0.75, 3: 1, 4: 1.00, 5: 1.00 };
    const f = {
      volumeFactor: VOL[e]  * (poor ? 0.92 : 1),
      loadFactor:   LOAD[e] * (poor ? 0.96 : 1),
      cnsFactor:    CNS[e]  * (poor ? 0.85 : 1),
      sore: new Set(readiness.sore || []),
      energy: e,
      level: e <= 2 ? "low" : e >= 4 ? "high" : "normal",
    };
    f.loadFactor = Math.max(0.85, Math.min(1.06, f.loadFactor));
    return f;
  }

  function generate(pool, opts) {
    opts = opts || {};
    const obj = (opts.objective || "STRENGTH").toUpperCase();
    const base = TEMPLATES[obj] || TEMPLATES.STRENGTH;
    const poolRef = pool || BASE_CATALOG;

    // opts.focus can be a string key, an array of keys, or empty/FULL = no filter.
    const focusKeys = Array.isArray(opts.focus) ? opts.focus : [opts.focus || "FULL"];
    const allPats = focusKeys.flatMap(k => FOCUS_PAT[k.toUpperCase()] || []);
    const focus = allPats.length ? new Set(allPats) : null;
    // Focus intentionally unbalances: it disables balance while active.
    const balance = focus ? "NONE" : (opts.balance || "NONE").toUpperCase();

    // Daily readiness bends the session: trim the high-CNS budget, steer away
    // from sore patterns (engine), and scale volume (below). loadFactor /
    // intensityBias ride along on the routine for the app's prescription pass.
    const rf = readinessFactors(opts.readiness);
    const cnsCap = Math.max(1, Math.round(base.maxCns * rf.cnsFactor));

    const build = tpl => {
      tpl.maxCns = cnsCap; tpl.maxGrip = base.maxGrip; tpl.__pool = poolRef;
      tpl.__sore = rf.sore && rf.sore.size ? rf.sore : null;
      const rt = buildRoutine(tpl, opts.equipment || [EQ.KB], opts.weightKb || null,
        opts.seed == null ? null : opts.seed, balance,
        opts.tolerance == null ? 1 : opts.tolerance, focus, opts.pinned || [], opts.recent || null,
        opts.sameWeight);
      rt.readiness = { loadFactor: rf.loadFactor, level: rf.level };
      return rt;
    };

    // Structure mode: the user fixed the exact exercise counts; no time fit.
    if (opts.structure && Object.values(opts.structure).some(n => n > 0))
      return build(templateFromStructure(base, opts.structure));

    // Time mode: the pre-build estimate is only approximate (it can't know which
    // exercises get picked, unilateral/ISO/long-rest costs, etc.), so build,
    // measure the REAL duration and correct the counts toward the target. Keep
    // the closest result; stop early once within 10% or when it stops improving.
    const minutes = Math.round((opts.minutes || 45) * rf.volumeFactor);
    let tpl = scaleTemplate(base, minutes);
    let routine = build(tpl);
    let best = routine, bestErr = Math.abs(routineDurationMin(routine) - minutes);
    for (let i = 0; i < 3 && bestErr > minutes * 0.1; i++) {
      const actual = routineDurationMin(routine);
      const factor = actual > 0 ? minutes / actual : 1;
      if (Math.abs(factor - 1) < 0.05) break;
      tpl = rescaleTemplateCounts(tpl, factor, !!base.fixedCount);
      routine = build(tpl);
      const err = Math.abs(routineDurationMin(routine) - minutes);
      if (err < bestErr - 1e-9) { best = routine; bestErr = err; }
      else break;   // no further improvement
    }
    return best;
  }

  function newExercise(fields) {
    const e = exercise(fields.name.trim(), fields.pattern, fields.dynamics, fields.symmetry,
      fields.cns, fields.equipment, fields.grip, fields.load || LOAD_TIER.MEDIUM);
    e.tier = fields.tier || TIER.ACCESSORY;
    e.plyo = !!fields.plyo;
    return e;
  }

  const API = {
    PAT, DIN, SIM, CNS, EQ, LOAD_TIER, BLOCK, REP_RANGE, QUALITY, QUALITY_NAME, TIER, TIER_LABEL,
    PAT_LABEL, DIN_LABEL, LOAD_LABEL, FOCUS_LABEL,
    BASE_CATALOG, TEMPLATES,
    classifyVolume, elementTimeSec, elementTimeline, routineDurationMin, blockDurationMin,
    areAntagonists, validateCombination, generate, newExercise, filterByEquipment, loadWarning, suggestKg,
    composeRoutine, auditRoutine,
    progressionRange, nextTarget, combinationFactor, snapKg, cnsWeight, unifiedKg,
    e1rm, e1rmEligible, bestE1rm, loadForReps, smoothE1rm, readinessFactors,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.FORJA = API;
})(typeof self !== "undefined" ? self : this);
