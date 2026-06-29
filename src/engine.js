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
             grip: !!grip, load: load || LOAD_TIER.MEDIUM, tier: TIER.ACCESSORY };
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
  BASE_CATALOG.forEach(e => {
    e.tier = _CORE_EXERCISES.has(e.name) ? TIER.FUNDAMENTAL
           : _OPTIONAL_EXERCISES.has(e.name) ? TIER.OPTIONAL : TIER.ACCESSORY;
  });

  // --- Volume and time model -----------------------------------------
  function classifyVolume(reps) { return reps <= 5 ? REP_RANGE.SP : reps <= 11 ? REP_RANGE.HP : REP_RANGE.ME; }

  const TEMPO = { STRENGTH:3.0, BALLISTIC:1.2, METABOLIC:2.0, ISO:0.0 };
  const REST_TIME = { SP:150, HP:75, ME:40 };
  const HOLD_ISO = 35, SS_TRANSITION = 20;
  const SETS_RANGE = { SP:[3,6], HP:[3,5], ME:[3,5] };

  function setWorkSec(e, reps) { return e.dynamics === DIN.ISO ? HOLD_ISO : reps * TEMPO[e.dynamics]; }
  function setRestSec(reps) { return REST_TIME[classifyVolume(reps)]; }

  function elementTimeSec(el) {
    const s = el.prescriptions[0].sets;
    if (el.isSuperset) {
      const [a, b] = el.prescriptions;
      const work = setWorkSec(a.exercise, a.reps) + setWorkSec(b.exercise, b.reps);
      const rest = Math.max(setRestSec(a.reps), setRestSec(b.reps)) * 0.5;
      return s * (work + rest + SS_TRANSITION);
    }
    const p = el.prescriptions[0];
    return s * (setWorkSec(p.exercise, p.reps) + setRestSec(p.reps));
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
  function newFatigueBudget(maxCns, maxGrip) {
    return {
      maxCns, maxGrip, cns: 0, grip: 0,
      _grip(e) { return e.grip && e.dynamics === DIN.BALLISTIC; },
      allows(e) {
        if (e.cns === CNS.HIGH && this.cns >= this.maxCns) return false;
        if (this._grip(e) && this.grip >= this.maxGrip) return false;
        return true;
      },
      consume(e) { if (e.cns === CNS.HIGH) this.cns++; if (this._grip(e)) this.grip++; },
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
      register(e) { const c = this._cat(e); if (c !== "NEUTRAL") this.count[c] = this._n(c) + 1; },
      snapshot() { return Object.assign({}, this.count); },
      restore(s) { this.count = Object.assign({}, s); },
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
    // EMOM: pairs modelled as alternating-minute protocol.
    // sets = number of minutes, reps = reps per minute.
    EMOM: {
      name: "EMOM (cada minuto)", maxCns: 3, maxGrip: 3,
      blocks: [
        schema(BLOCK.A, 2, 10, 5, [DIN.BALLISTIC]),
        schema(BLOCK.B, 3,  8, 6, [DIN.STRENGTH, DIN.BALLISTIC]),
      ],
    },
    // AMRAP / circuit: pair:false keeps every exercise as a solo slot
    // so the routine reads as a linear circuit to repeat for time.
    AMRAP: {
      name: "AMRAP / Circuito", maxCns: 4, maxGrip: 3,
      blocks: [
        schema(BLOCK.A, 5, 3, 10, [DIN.STRENGTH, DIN.BALLISTIC], false),
        schema(BLOCK.C, 2, 3, 15, [DIN.METABOLIC],               false),
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
    return s;
  }

  // Kg suggestion for an adjustable kettlebell: maps the load tier (light/
  // medium/heavy) within the user's available range, rounded to 2 kg.
  function suggestKg(load, min, max) {
    if (min == null || max == null) return null;
    const frac = { 1: 0.15, 2: 0.5, 3: 0.85 }[load];
    const kg = Math.round((min + (frac == null ? 0.5 : frac) * (max - min)) / 2) * 2;
    return Math.max(min, Math.min(max, kg));
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
    let best = null, key = [-1, -1];
    for (const c of cands) {
      if (!budget.allows(c) || !bal.allows(c)) continue;
      const res = validateCombination(pa, prescribe(c, sch));
      if (!res.valid) continue;
      const k = [res.quality, bal.bonus(c)];
      if (k[0] > key[0] || (k[0] === key[0] && k[1] > key[1])) { best = c; key = k; }
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

  function buildRoutine(template, available, weightKb, seed, balance, tol, focus, pinnedNames, recent) {
    const rng = makeRng(seed);
    const poolBase = template.__pool || BASE_CATALOG;
    const pool = filterByEquipment(poolBase, available);
    const used = new Set();
    const budget = newFatigueBudget(template.maxCns, template.maxGrip);
    const bal = newBalanceTracker(balance || "NONE", tol);
    bal.focus = focus || null;
    bal.weightKb = weightKb || null;
    bal.recent = recent || null;

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
    return { template: template.name, blocks };
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

  function generate(pool, opts) {
    opts = opts || {};
    const obj = (opts.objective || "STRENGTH").toUpperCase();
    const base = TEMPLATES[obj] || TEMPLATES.STRENGTH;

    let template;
    if (opts.structure && Object.values(opts.structure).some(n => n > 0))
      template = templateFromStructure(base, opts.structure);
    else
      template = scaleTemplate(base, opts.minutes || 45);
    template.maxCns = base.maxCns; template.maxGrip = base.maxGrip;
    template.__pool = pool || BASE_CATALOG;

    // opts.focus can be a string key, an array of keys, or empty/FULL = no filter.
    const focusKeys = Array.isArray(opts.focus) ? opts.focus : [opts.focus || "FULL"];
    const allPats = focusKeys.flatMap(k => FOCUS_PAT[k.toUpperCase()] || []);
    const focus = allPats.length ? new Set(allPats) : null;
    // Focus intentionally unbalances: it disables balance while active.
    const balance = focus ? "NONE" : (opts.balance || "NONE").toUpperCase();

    return buildRoutine(template, opts.equipment || [EQ.KB], opts.weightKb || null,
      opts.seed == null ? null : opts.seed, balance,
      opts.tolerance == null ? 1 : opts.tolerance, focus, opts.pinned || [], opts.recent || null);
  }

  function newExercise(fields) {
    const e = exercise(fields.name.trim(), fields.pattern, fields.dynamics, fields.symmetry,
      fields.cns, fields.equipment, fields.grip, fields.load || LOAD_TIER.MEDIUM);
    e.tier = fields.tier || TIER.ACCESSORY;
    return e;
  }

  const API = {
    PAT, DIN, SIM, CNS, EQ, LOAD_TIER, BLOCK, REP_RANGE, QUALITY, QUALITY_NAME, TIER, TIER_LABEL,
    PAT_LABEL, DIN_LABEL, LOAD_LABEL, FOCUS_LABEL,
    BASE_CATALOG, TEMPLATES,
    classifyVolume, elementTimeSec, routineDurationMin, blockDurationMin,
    areAntagonists, validateCombination, generate, newExercise, filterByEquipment, loadWarning, suggestKg,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.FORJA = API;
})(typeof self !== "undefined" ? self : this);
