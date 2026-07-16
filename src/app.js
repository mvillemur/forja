/**
 * FORJA — Interface layer (app.js)
 * =================================
 * Responsible for EVERYTHING that touches the DOM and the browser. Contains no
 * training logic: that lives in `engine.js` (window.FORJA). Manages:
 *
 *   - App state (`state`): configuration, exercise pool and history.
 *   - Offline cascading storage (window.storage -> localStorage -> RAM).
 *   - Rendering of the routine, history, pool and forms.
 *   - Interface events (segmented controls, steppers, chips, navigation).
 *
 * Pool data model (key to maintainability):
 *   - `state.custom`    : exercises added by the user (each with a stable id).
 *   - `state.removed`   : ids of hidden base exercises.
 *   - `state.overrides` : field overrides by id for base exercises.
 *   The effective pool (`state.pool`) is ALWAYS recomputed from the current
 *   base catalog (FORJA.BASE_CATALOG) applying those three layers. This way,
 *   expanding the base catalog makes new exercises appear without breaking user data.
 *   Every per-exercise store is keyed by the exercise's STABLE id (engine
 *   catalog ids / "c-<slug>" custom ids), so display renames never orphan
 *   user data. The display name is only ever shown, never used as a key.
 *
 * Dependencies: window.FORJA (engine.js). No external libraries.
 */
(function () {
  "use strict";
  const F = window.FORJA;

  // ---- Cascading storage: window.storage -> localStorage -> memory
  const Store = (function () {
    let mode = "mem"; const mem = {};
    try { localStorage.setItem("__forja_t", "1"); localStorage.removeItem("__forja_t"); mode = "local"; } catch (e) {}
    if (typeof window !== "undefined" && window.storage && typeof window.storage.get === "function") mode = "win";
    async function get(k) {
      try {
        if (mode === "win") { const r = await window.storage.get(k); return r ? r.value : null; }
        // A key parked in `mem` while in local mode means its last write
        // failed to land in localStorage: the overlay holds the newest value.
        if (mode === "local") return k in mem ? mem[k] : localStorage.getItem(k);
        return k in mem ? mem[k] : null;
      } catch (e) { return k in mem ? mem[k] : null; }
    }
    async function set(k, v) {
      try {
        if (mode === "win") { await window.storage.set(k, v); }
        else if (mode === "local") { localStorage.setItem(k, v); delete mem[k]; }
        else mem[k] = v;
      } catch (e) {
        // Write failed (quota full, private mode...). Keep the value in the
        // RAM overlay so the running session stays consistent, and report it:
        // without this the user sees "Guardada" while nothing survives a reload.
        mem[k] = v;
        api.degraded = true;
        try { if (api.onFail) api.onFail(k, e); } catch (_) {}
      }
      // Write hook: lets the backup layer mirror every change to the
      // user-chosen backup file without each caller knowing about it.
      try { if (api.onWrite) api.onWrite(k); } catch (e) {}
    }
    const api = { get, set, get mode() { return mode; }, onWrite: null, onFail: null, degraded: false };
    return api;
  })();

  const K = { HIST: "forja:hist", POOL: "forja:pool", CUSTOM: "forja:custom", REMOVED: "forja:removed", OVERRIDES: "forja:overrides", CFG: "forja:cfg", KG: "forja:kg", PROG: "forja:prog", PAUSED: "forja:paused", TIMER: "forja:timer", ROUTINES: "forja:routines", PROGRAM: "forja:program" };
  // Original catalog names (24): reference for migration without hiding new additions.
  const LEGACY_BASE = [
    "Peso Muerto Rumano / Fijo", "Kettlebell Swings (Dos manos)", "Alternating Swings", "Swing Cleans",
    "Dead Cleans", "Sentadilla Goblet", "Goblet Clean Squat", "Pit Squats", "Alt Lunges", "Remo a una mano",
    "Two Hand Row", "Bent Rows (Alternating)", "Upright Row", "Dominadas Neutras", "Clean & Press Combinado",
    "Goblet Shoulder Press", "Rotational Press", "Dead Clean Push Press", "Close Grip Pushup", "Halos",
    "Kneeling Around The Worlds", "Half-Racked Marches", "Goblet Overhead March", "Burpees",
  ];

  const STRIPE = { HIP:"#e8742c", KNEE:"#e6b450", PULL_H:"#6fa8c7", PULL_V:"#5b93b8",
    PUSH_H:"#b98cc9", PUSH_V:"#a978bf", CORE:"#7fae6a", HYBRID:"#d9533b" };
  const OBJ_LABEL = { STRENGTH:"Fuerza", METABOLIC:"Metabólico", STRENGTH_ENDURANCE:"Resistencia",
    POWER:"Potencia", EMOM:"EMOM", AMRAP:"AMRAP", MANUAL:"Creada por mí" };

  const state = {
    cfg: { objective:"STRENGTH", focus:[], equipment:["KB", "FLOOR"], weightMin:12, weightMax:32,
           volumeMode:"time", minutes:45, structure:{ A:4, B:4, C:2 },
           balance:"NONE", tolerance:1, pinned:[], vary:true, sameWeight:false,
           profile:{ bodyweight:null, sex:"", level:"INTER" },
           readiness:{ energy:3, sleep:"ok", sore:[] }, focusSoft:false,
           mode:"auto",                        // "auto" (generator) | "manual" (builder)
           manual:{ A:[], B:[], C:[] },        // builder draft: {id, sets, reps, pair, kg} per block
           manualObjective:"AUTO" },           // declared objective of the manual routine (AUTO = infer)
    custom: [],       // exercises added by the user (each carries a stable id)
    removed: [],      // ids of hidden base exercises
    paused: [],       // ids temporarily out of selection (injury, no bar...)
    templates: [],    // saved reusable routines ("Mis rutinas")
    programs: [],     // multi-week programs (plan layer); may hold several
    activeProgramId: null,   // which program "Entrenar hoy" runs
    overrides: {},    // id -> edited fields of base exercises
    pool: [],         // computed
    byId: {},         // computed: id -> exercise of the effective pool
    nameToId: {},     // computed: display name -> id of the effective pool
    hist: [],
    routine: null,
    routineSource: "auto",   // where state.routine came from: generator or manual builder
    lastSavedId: null, // history id of the live routine (timer updates it instead of duplicating)
    editing: null,    // id of the exercise being edited, or null
    kg: {},           // exercise id -> last dialed kg (plus "__sw:<block>" circuit keys; persisted)
    prog: {},         // exercise id -> current rep target (double progression, persisted)
  };
  // UI-only filters for the pin panel (not persisted): tag -> selected values.
  const pinFilter = { pattern: [], dynamics: [], tier: [] };
  // UI-only filters for the Pool view: free-text search + tag selections.
  const poolFilter = { text: "", pattern: [], dynamics: [], tier: [] };
  let manualEditId = null;   // id of the manual session currently being edited
  let applyModeRef = null;   // init() assigns applyMode so module-scope loadRoutine can call it
  // Monotonic id generator: history/session ids must be unique even when two
  // are minted within the same millisecond (e.g. a save and a CSV import, or
  // several sessions in one import). Seeded above any existing id on load.
  let _idSeq = 0;
  const nextId = () => { const t = Date.now(); _idSeq = Math.max(_idSeq + 1, t); return _idSeq; };
  const clone = e => Object.assign({}, e, { equipment: e.equipment.slice() });
  const isBaseId = id => F.BASE_CATALOG.some(e => e.id === id);
  function computePool() {
    const base = F.BASE_CATALOG.filter(e => !state.removed.includes(e.id)).map(e => {
      const c = clone(e); const ov = state.overrides[e.id];
      // id and name are the identity: an override can never rewrite them.
      return ov ? Object.assign(c, ov, { id: e.id, name: e.name }) : c;
    });
    state.pool = base.concat(state.custom.map(clone));
    // Lookup maps for the effective pool: every store is id-keyed, but the
    // engine and old embedded data still speak names.
    state.byId = {}; state.nameToId = {};
    state.pool.forEach(e => { state.byId[e.id] = e; state.nameToId[e.name] = e.id; });
  }
  // Stable id of an exercise object. Routines embedded in history or the
  // timer checkpoint before the id refactor carry no id: resolve through the
  // current pool by name; an unknown exercise falls back to its raw name
  // (which is exactly where its legacy store entries stayed).
  const exId = e => e.id || state.nameToId[e.name] || e.name;

  const $ = s => document.querySelector(s);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  // Escape user-controlled text (exercise names, CSV notes...) before it is
  // interpolated into an innerHTML sink like el(). Names come from forms,
  // CSV imports and shared backup files — never trust them as markup.
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Icon-only buttons show a glyph (✕ ✎ ▶ ...): screen readers need a real
  // name, so the tooltip text doubles as the aria-label.
  const a11y = (b, text) => { b.title = text; b.setAttribute("aria-label", text); return b; };

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1900);
  }

  // One warning per session when the device store rejects writes: the app
  // keeps running on the RAM overlay, but nothing new survives a reload.
  let warnedStoreFail = false;
  Store.onFail = () => {
    if (warnedStoreFail) return; warnedStoreFail = true;
    toast("No se pudo guardar en el dispositivo (almacenamiento lleno o bloqueado). Exporta una copia: los cambios se perderán al recargar.");
  };

  // ---- Persistence
  // A corrupt stored blob is NOT discarded: it is parked under "<key>:corrupt"
  // so the next save cannot destroy the only recoverable copy, and the key is
  // recorded so init can warn the user (and the auto-backup can hold off).
  const corruptKeys = [];
  function parseStored(k, raw, fallback) {
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch (e) {
      corruptKeys.push(k);
      try { Store.set(k + ":corrupt", raw); } catch (_) {}
      return fallback;
    }
  }
  async function loadJson(k, fallback) { return parseStored(k, await Store.get(k), fallback); }

  async function loadAll() {
    const h = await loadJson(K.HIST); if (Array.isArray(h)) state.hist = h;
    const c = await loadJson(K.CFG); if (c && typeof c === "object") Object.assign(state.cfg, c);
    // The "Suelo" chip is locked ON in the UI: floor space is always available.
    // Older stored configs only listed ["KB"(, "BARBELL")], which silently
    // excluded floor exercises (Burpees, pushups, Tuck Jumps) from generation.
    if (!Array.isArray(state.cfg.equipment)) state.cfg.equipment = ["KB", "FLOOR"];
    if (!state.cfg.equipment.includes("FLOOR")) state.cfg.equipment.push("FLOOR");
    // Migrate old single-string focus ("FULL"/"LEGS"/...) to array model.
    if (!Array.isArray(state.cfg.focus)) {
      state.cfg.focus = (state.cfg.focus && state.cfg.focus !== "FULL") ? [state.cfg.focus] : [];
    }
    if (!state.cfg.profile || typeof state.cfg.profile !== "object") {
      state.cfg.profile = { bodyweight: null, sex: "", level: "INTER" };
    }
    if (!state.cfg.readiness || typeof state.cfg.readiness !== "object") {
      state.cfg.readiness = { energy: 3, sleep: "ok", sore: [] };
    }
    if (!Array.isArray(state.cfg.readiness.sore)) state.cfg.readiness.sore = [];
    if (state.cfg.mode !== "manual") state.cfg.mode = "auto";
    if (!state.cfg.manual || typeof state.cfg.manual !== "object") state.cfg.manual = {};
    ["A", "B", "C"].forEach(k => { if (!Array.isArray(state.cfg.manual[k])) state.cfg.manual[k] = []; });
    if (state.cfg.manualObjective !== "AUTO" && !F.TEMPLATES[state.cfg.manualObjective]) state.cfg.manualObjective = "AUTO";
    let loaded = false;
    {
      const cuRaw = await Store.get(K.CUSTOM); const rmRaw = await Store.get(K.REMOVED);
      if (cuRaw != null || rmRaw != null) {
        // Corrupt blobs fall back to [] but still mark this model as loaded,
        // so the legacy-pool migration below cannot clobber modern data.
        const cu = parseStored(K.CUSTOM, cuRaw, []); const rm = parseStored(K.REMOVED, rmRaw, []);
        state.custom = Array.isArray(cu) ? cu : []; state.removed = Array.isArray(rm) ? rm : [];
        loaded = true;
      }
    }
    if (!loaded) {
      // Migration from old model (full pool) -> custom + removed.
      // Only the original 24 can be marked as 'removed'; new base additions
      // (expanded catalog) should always appear after migration.
      try {
        const arr = await loadJson(K.POOL);
        if (Array.isArray(arr)) {
          const baseNames = new Set(F.BASE_CATALOG.map(e => e.name));
          const have = new Set(arr.map(e => e.name));
          state.custom = arr.filter(e => !baseNames.has(e.name));
          state.removed = LEGACY_BASE.filter(n => !have.has(n));
          savePoolState();
        }
      } catch (e) {}
    }
    const ov = await loadJson(K.OVERRIDES); if (ov && typeof ov === "object") state.overrides = ov;
    state.paused = await loadJson(K.PAUSED, []);
    if (!Array.isArray(state.paused)) state.paused = [];
    state.templates = await loadJson(K.ROUTINES, []);
    if (!Array.isArray(state.templates)) state.templates = [];
    // Program store: { programs:[...], activeId }. Migrate the old single-
    // program shape (a bare object with an id) into a one-element list.
    const pgStore = await loadJson(K.PROGRAM, null);
    if (Array.isArray(pgStore)) { state.programs = pgStore; }
    else if (pgStore && Array.isArray(pgStore.programs)) { state.programs = pgStore.programs; state.activeProgramId = pgStore.activeId || null; }
    else if (pgStore && pgStore.id) { state.programs = [pgStore]; state.activeProgramId = pgStore.id; }
    else state.programs = [];
    if (!state.activeProgramId && state.programs[0]) state.activeProgramId = state.programs[0].id;
    const kg = await loadJson(K.KG); if (kg && typeof kg === "object") state.kg = kg;
    const pr = await loadJson(K.PROG); if (pr && typeof pr === "object") state.prog = pr;
    // Migration: pinned as strings -> objects {name, block}
    state.cfg.pinned = (state.cfg.pinned || []).map(f => typeof f === "string" ? { name: f, block: "AUTO" } : f);
    migrateRenamedExercises();
    migrateToIds();
    computePool();
    // Seed the id sequence above any id already in history.
    state.hist.forEach(h => { if (typeof h.id === "number") _idSeq = Math.max(_idSeq, h.id); });
  }

  // ---- Catalog rename migration
  // The base catalog was renamed to a consistent convention (F.RENAMED maps
  // old -> new; two olds on one new = merged exercises). Names are the
  // primary key for every per-exercise store, so each one follows the map:
  // overrides, removals, kg memory, rep targets, pins, manual drafts and the
  // exercise names embedded in history (keeps e1RM/vary/detail views whole).
  function migrateRenamedExercises() {
    const REN = F.RENAMED || {};
    const mapName = n => REN[n] || n;
    let touched = false;
    const t = n => { if (REN[n]) touched = true; return mapName(n); };

    // Removals: a merged exercise stays hidden only if the user had removed
    // EVERY old variant that folded into it (removing just one meant "I still
    // want the other", so the merged slot survives).
    const group = {};   // new name -> [old names]
    Object.keys(REN).forEach(o => (group[REN[o]] || (group[REN[o]] = [])).push(o));
    const oldRemoved = new Set(state.removed);
    state.removed = [...new Set(state.removed.map(t))]
      .filter(n => !group[n] || oldRemoved.has(n) || group[n].every(o => oldRemoved.has(o)));

    // Keyed objects: first value wins on merge collisions, except kg where
    // the heavier dialed weight is the trainee's real working weight.
    const remapKeys = (obj, pick) => {
      const out = {};
      Object.keys(obj).forEach(k => {
        const nk = t(k);
        out[nk] = (nk in out) ? pick(out[nk], obj[k]) : obj[k];
      });
      return out;
    };
    state.overrides = remapKeys(state.overrides, a => a);
    state.kg = remapKeys(state.kg, (a, b) => (typeof a === "number" && typeof b === "number") ? Math.max(a, b) : a);
    state.prog = remapKeys(state.prog, (a, b) => (typeof a === "number" && typeof b === "number") ? Math.max(a, b) : a);

    // Pins and manual builder drafts. Entries already in id form ({id})
    // are untouched: renames never move ids, only display names.
    const seenPin = new Set();
    state.cfg.pinned = state.cfg.pinned
      .map(f => f.name != null ? Object.assign({}, f, { name: t(f.name) }) : f)
      .filter(f => { const k = f.id != null ? "i:" + f.id : "n:" + f.name; return !seenPin.has(k) && seenPin.add(k); });
    ["A", "B", "C"].forEach(k => (state.cfg.manual[k] || []).forEach(it => { if (it.name != null) it.name = t(it.name); }));

    // History: manual logs ({exercises:[{name}]}) and embedded routines.
    state.hist.forEach(h => {
      if (Array.isArray(h.exercises)) h.exercises.forEach(ex => { ex.name = t(ex.name); });
      if (h.routine && Array.isArray(h.routine.blocks)) h.routine.blocks.forEach(br =>
        (br.elements || []).forEach(el => (el.prescriptions || []).forEach(p => {
          if (p.exercise) p.exercise.name = t(p.exercise.name);
        })));
    });

    if (touched) {
      savePoolState(); saveConfig(); saveKg(); saveProg(); saveHistory();
    }
  }

  // Persistent id for a custom exercise: "c-" + slug of its name at creation
  // ("c-" keeps the namespace clear of base-catalog ids), with a numeric
  // suffix if it ever collides. Assigned once and NEVER changed afterwards.
  function newCustomId(name) {
    const base = "c-" + (F.slugId(name) || "ejercicio");
    const taken = new Set(F.BASE_CATALOG.map(e => e.id));
    state.custom.forEach(e => { if (e.id) taken.add(e.id); });
    let id = base, n = 2;
    while (taken.has(id)) id = base + "-" + (n++);
    return id;
  }

  // ---- Name -> id migration (one-time)
  // Per-exercise stores were historically keyed by the display name; the
  // stable exercise id is the key now. Runs AFTER migrateRenamedExercises so
  // legacy data follows the full chain old name -> curated name -> id.
  // Detection is per-entry: a key that is not already a known id but matches
  // a known name (base catalog or custom) is remapped; anything else —
  // including the "__sw:<block>" circuit keys — is kept untouched under its
  // original key, so no data is ever dropped.
  function migrateToIds() {
    let touched = false;
    // Custom exercises minted before ids existed get their persistent id now.
    state.custom.forEach(e => { if (!e.id) { e.id = newCustomId(e.name); touched = true; } });
    const nameToId = {};
    F.BASE_CATALOG.forEach(e => { nameToId[e.name] = e.id; });
    state.custom.forEach(e => { nameToId[e.name] = e.id; });
    const ids = new Set(Object.values(nameToId));
    const toId = k => {
      if (ids.has(k) || String(k).indexOf("__sw:") === 0) return k;   // already an id / circuit key
      if (nameToId[k] != null) { touched = true; return nameToId[k]; }
      return k;   // unknown string: keep it as-is (never lose data)
    };
    const remap = obj => {
      const out = {};
      Object.keys(obj).forEach(k => { const nk = toId(k); if (!(nk in out)) out[nk] = obj[k]; });
      return out;
    };
    state.kg = remap(state.kg);
    state.prog = remap(state.prog);
    state.overrides = remap(state.overrides);
    state.removed = [...new Set(state.removed.map(toId))];
    state.paused = [...new Set(state.paused.map(toId))];
    state.cfg.pinned = state.cfg.pinned.map(f => {
      if (f.id != null) return f;
      touched = true;
      return { id: toId(f.name), block: f.block || "AUTO" };
    });
    ["A", "B", "C"].forEach(k => (state.cfg.manual[k] || []).forEach(it => {
      if (it.id == null && it.name != null) { it.id = toId(it.name); delete it.name; touched = true; }
    }));
    if (touched) { savePoolState(); saveConfig(); saveKg(); saveProg(); savePaused(); }
  }
  const saveHistory = () => Store.set(K.HIST, JSON.stringify(state.hist));
  const savePoolState = () => {
    Store.set(K.CUSTOM, JSON.stringify(state.custom));
    Store.set(K.REMOVED, JSON.stringify(state.removed));
    Store.set(K.OVERRIDES, JSON.stringify(state.overrides));
  };
  const saveConfig = () => Store.set(K.CFG, JSON.stringify(state.cfg));
  const savePaused = () => Store.set(K.PAUSED, JSON.stringify(state.paused));
  const saveTemplates = () => Store.set(K.ROUTINES, JSON.stringify(state.templates));
  const saveProgram = () => Store.set(K.PROGRAM, JSON.stringify({ programs: state.programs, activeId: state.activeProgramId }));
  const activeProgram = () => state.programs.find(p => p.id === state.activeProgramId) || null;
  // Paused = temporarily out of SELECTION (injury, missing equipment...):
  // the generator, the builder picker, the pin list and the routine-editor
  // swap all skip paused exercises, but nothing already using them (drafts,
  // pins, saved sessions) is touched — reactivating restores everything.
  const isPaused = id => state.paused.includes(id);
  function togglePause(id) {
    const i = state.paused.indexOf(id);
    if (i >= 0) state.paused.splice(i, 1); else state.paused.push(id);
    savePaused(); renderPool();
    toast(i >= 0 ? "Reactivado: vuelve a la selección" : "Pausado: fuera de la selección");
  }
  const saveKg = () => Store.set(K.KG, JSON.stringify(state.kg));
  const saveProg = () => Store.set(K.PROG, JSON.stringify(state.prog));

  // ---- Formatting
  // Symmetry suffix: unilateral reps are per side; alternating reps are the
  // TOTAL split between sides — say so, or "3x15" reads as 15 per leg.
  const symSuffix = e => e.symmetry === F.SIM.UNILATERAL ? " / lado"
    : e.symmetry === F.SIM.ALTERNATING ? " (alt.)" : "";
  const dose = p => {
    if (p.exercise.dynamics === F.DIN.ISO) {
      const sec = p.exercise.holdSec || 35;
      return `${p.sets}x ~${sec}s` + symSuffix(p.exercise);
    }
    return `${p.sets}x${p.reps}` + symSuffix(p.exercise);
  };

  // Current rep target for an exercise (double progression). Falls back to the
  // template's prescribed reps until the user records a first "cumplido".
  const targetReps = p => { const id = exId(p.exercise); return state.prog[id] != null ? state.prog[id] : p.reps; };
  // Dose string using the progression target (for the live, editable routine).
  function doseTarget(p) {
    if (p.exercise.dynamics === F.DIN.ISO) return dose(p);
    return `${p.sets}x${targetReps(p)}` + symSuffix(p.exercise);
  }
  // Record the trainee's feedback ('easy'|'ok'|'hard') and autoregulate the
  // next target for this exercise (double progression + RPE nudge).
  // opts.silent skips the toast/re-render (used when the timer applies the
  // whole session's feedback in one pass at the end).
  function applyProgression(p, feedback, opts) {
    opts = opts || {};
    const id = exId(p.exercise);
    const min = state.cfg.weightMin, max = state.cfg.weightMax;
    const rng = F.progressionRange(p.reps, p.exercise.dynamics);
    // Use the same kg key the renderer uses: a shared circuit key in
    // same-weight mode, otherwise per-exercise. Keeps the bump visible.
    const sameW = !!state.cfg.sameWeight;
    const kgKey = sameW ? ("__sw:" + p.block) : id;
    let curKg = state.kg[kgKey];
    if (curKg == null) {
      if (sameW && state.routine) {
        const blk = state.routine.blocks.find(b => b.block === p.block);
        curKg = blk ? F.unifiedKg(blk.elements.flatMap(e => e.prescriptions), { min, max }, state.cfg.profile) : null;
      }
      if (curKg == null) curKg = F.suggestKg(p.exercise.load, min, max, state.cfg.profile, p.exercise, p.reps);
    }
    const cur = { kg: curKg, reps: state.prog[id] != null ? state.prog[id] : p.reps };
    const next = F.nextTarget(cur, rng, feedback, { step: 2, min, max, startKg: curKg });
    state.prog[id] = next.reps; saveProg();
    const up = next.kg != null && next.kg > curKg;
    const down = next.kg != null && next.kg < curKg;
    if (next.kg != null) { state.kg[kgKey] = next.kg; saveKg(); }
    if (opts.silent) return;
    toast(up   ? `¡Progreso! Sube a ${next.kg} kg · reps reinician en ${next.reps}`
       : down  ? `Bajamos a ${next.kg} kg para afianzar · ${next.reps} reps`
               : `Objetivo próxima vez: ${next.reps} reps`);
    if (state.routine) renderRoutine(state.routine, $("#routine-out"), { min, max }, true);
  }

  // ---- Estimated 1-rep max (e1RM) tracking ------------------------------
  // Builds a per-exercise strength estimate from the data we already keep.
  // Two sources, in chronological order:
  //   1. Manual session logs (real kg + per-set reps) — the strongest signal.
  //   2. The current working set the trainee is on (state.kg dialed weight +
  //      state.prog rep target) as the most recent point.
  // Only grind/strength movements are tracked (e1rmEligible); ballistics and
  // ISO are progressed by reps/density/time, not a max. Each series is EMA-
  // smoothed so one noisy near-failure set can't spike the number.
  // Minimum data points before an e1RM is trusted to drive a kg suggestion.
  const E1RM_MIN_POINTS = 2;
  // Canonical series key for a logged entry: the id the timer recorded, else
  // the current pool id for its (possibly legacy) name — F.RENAMED first, so
  // CSV rows typed with a retired name still land on the right exercise.
  // An exercise no longer in the pool keeps its raw name as the key.
  const canonLogId = ex => ex.id || state.nameToId[(F.RENAMED && F.RENAMED[ex.name]) || ex.name] || ex.name;
  function computeE1rm() {
    const series = {};                    // id -> [values, oldest first]
    const label = {};                     // id -> current display name
    const push = (key, name, v) => {
      if (v == null) return;
      (series[key] || (series[key] = [])).push(v);
      label[key] = name;
    };
    // 1) Logged sets, oldest session first: manual logs AND the performance
    //    the guided timer captured for generated sessions (same shape).
    state.hist.slice().reverse().forEach(h => {
      const logs = (h.manual && Array.isArray(h.exercises)) ? h.exercises
                 : Array.isArray(h.performed) ? h.performed : null;
      if (!logs) return;
      logs.forEach(ex => {
        const key = canonLogId(ex);
        const def = state.byId[key];
        if (!def || !F.e1rmEligible(def)) return;
        push(key, def.name, F.bestE1rm((ex.sets || []).map(r => ({ kg: ex.kg, reps: r }))));
      });
    });
    // 2) Current working set (latest point) from the live progression state.
    Object.keys(state.kg).forEach(id => {
      if (id.indexOf("__sw:") === 0) return;     // circuit shared-weight key
      const def = state.byId[id];
      const reps = state.prog[id];
      if (!def || !F.e1rmEligible(def) || reps == null) return;
      push(id, def.name, F.e1rm(state.kg[id], reps));
    });
    const out = {};
    Object.keys(series).forEach(key => {
      const v = series[key];
      out[key] = { name: label[key], current: F.smoothE1rm(v), first: v[0], last: v[v.length - 1], n: v.length };
    });
    return out;
  }

  // Smooth-scroll helpers (no-ops / guarded for jsdom).
  function scrollToY(y) {
    try { if (window.scrollTo) window.scrollTo({ top: Math.max(0, y), behavior: "smooth" }); } catch (e) {}
  }
  function scrollToRoutine() {
    const node = $("#routine-out");
    if (!node) return;
    try { scrollToY(node.getBoundingClientRect().top + (window.pageYOffset || 0) - 60); } catch (e) { scrollToY(0); }
  }
  function scrollToTop() { scrollToY(0); }

  // ---- Render: routine
  function renderRoutine(r, into, range, editable) {
    into.innerHTML = "";
    if (!r) return;
    range = range || { min: state.cfg.weightMin, max: state.cfg.weightMax };
    if (editable) {
      const back = el("button", "to-settings", "↑ Ajustes");
      back.title = "Volver a la configuración";
      back.onclick = scrollToTop;
      into.appendChild(back);
    }
    // Program day: a banner making clear this routine came from a program —
    // which program, week, phase, day and emphasis — instead of looking like
    // a plain one-off generation.
    if (r.programMeta) {
      const pm = r.programMeta;
      const banner = el("div", "routine-prog");
      const line1 = el("div", "routine-prog-top");
      line1.appendChild(el("span", "routine-prog-name", esc(pm.name || "Programa") + " · " + esc(pm.label || "")));
      line1.appendChild(el("span", "prog-phase " + (pm.deload ? "deload" : "accum"),
        "Sem " + pm.week + " · " + (pm.deload ? "Descarga" : "Acumulación")));
      banner.appendChild(line1);
      const notes = [];
      if (pm.volumePct) notes.push((pm.volumePct > 0 ? "+" : "") + pm.volumePct + "% volumen");
      if (pm.deload) notes.push("volumen reducido para soltar fatiga");
      if (pm.emphasis && pm.emphasis.length)
        notes.push("énfasis " + pm.emphasis.map(k => (F.FOCUS_LABEL[k] || k).toLowerCase()).join(" / "));
      if (notes.length) banner.appendChild(el("div", "routine-prog-note", notes.join(" · ")));
      into.appendChild(banner);
    }
    const head = el("div", "routine-head");
    const title = r.programMeta ? (OBJ_LABEL[r.programMeta.objective] || r.template) : r.template;
    head.appendChild(el("div", "routine-title", esc(title)));
    head.appendChild(el("div", "routine-dur", `~${F.routineDurationMin(r)} min`));
    into.appendChild(head);

    if (r.warmup && r.warmup.items && r.warmup.items.length) {
      const wu = el("div", "block warmup");
      const wh = el("div", "block-head");
      wh.appendChild(el("div", "block-name", "Calentamiento · preparación"));
      wu.appendChild(wh);
      const ul = el("ul", "warmup-list");
      r.warmup.items.forEach(it => ul.appendChild(el("li", null, it)));
      wu.appendChild(ul);
      into.appendChild(wu);
    }

    const blockName = { A: "Principal", B: "Accesorios", C: "Finalizador" };
    const e1map = computeE1rm();   // per-exercise estimated 1RM, drives kg below
    let cnsAccum = 0;   // CNS load placed before the current element (session fatigue)
    r.blocks.forEach(br => {
      if (!br.elements.length) return;
      const blk = el("div", "block");
      const bh = el("div", "block-head");
      bh.appendChild(el("div", "block-name", `Bloque <b>${br.block}</b> · ${blockName[br.block]}`));
      bh.appendChild(el("div", "block-dur", `~${F.blockDurationMin(br, r.protocol)} min`));
      blk.appendChild(bh);

      // Single-kettlebell mode: one shared weight for the whole block/circuit,
      // so the adjustable bell is dialed once. The override is stored per block
      // (key "__sw:<block>"), keeping per-exercise kg untouched for progression.
      const sameW = !!state.cfg.sameWeight;
      const swKey = "__sw:" + br.block;
      const blockKg = sameW
        ? F.unifiedKg(br.elements.flatMap(e => e.prescriptions), range, state.cfg.profile)
        : null;

      br.elements.forEach(item => {
        const accumBefore = cnsAccum;
        cnsAccum += item.prescriptions.reduce((a, pp) => a + F.cnsWeight(pp.exercise.cns), 0);
        const node = el("div", "element" + (item.isSuperset ? " ss" : ""));
        const tag = el("div", "el-tag");
        tag.appendChild(el("span", "el-kind", item.isSuperset ? "Superserie" : "Set directo"));
        tag.appendChild(el("span", "quality q-" + item.quality, F.QUALITY_NAME[item.quality]));
        node.appendChild(tag);
        item.prescriptions.forEach((p, pi) => {
          const name = p.exercise.name;
          const id = exId(p.exercise);
          const ctxFactor = F.combinationFactor({ isSuperset: item.isSuperset, secondInPair: pi === 1, quality: item.quality, cnsAccum: accumBefore });
          const ex = el("div", "exercise");
          const st = el("div", "stripe"); st.style.background = STRIPE[p.exercise.pattern] || "#6b7280";
          ex.appendChild(st);
          const body = el("div", "ex-body");
          const star = p.exercise.tier === "FUNDAMENTAL" ? '<span class="star">★</span> ' : "";
          body.appendChild(el("div", "ex-name", star + esc(name)));
          body.appendChild(el("div", "ex-meta", `${F.PAT_LABEL[p.exercise.pattern]} · SNC ${p.exercise.cns}`));
          ex.appendChild(body);
          const doseEl = el("div", "ex-dose");
          doseEl.appendChild(el("div", null, editable ? doseTarget(p) : dose(p)));
          let baseKg, usedE1 = false;
          if (sameW) {
            // One weight for the whole circuit; the per-lift fatigue taper is
            // intentionally skipped — the point is a single, constant load.
            baseKg = blockKg;
          } else {
            // Prefer the trainee's tracked strength (e1RM) once it has enough
            // data points: load = inverse-Epley at this exercise's rep target.
            // Otherwise fall back to the cold-start tier suggestion.
            const est = e1map[id];
            const reps = editable ? targetReps(p) : p.reps;
            if (est && est.n >= E1RM_MIN_POINTS && F.e1rmEligible(p.exercise)) {
              baseKg = F.loadForReps(est.current, reps, { min: range.min, max: range.max });
              usedE1 = baseKg != null;
            }
            if (!usedE1) baseKg = F.suggestKg(p.exercise.load, range.min, range.max, state.cfg.profile, p.exercise, reps);
            // Daily readiness: lighten (or slightly raise) the suggestion to match
            // how the trainee shows up today. Only touches the suggestion — a
            // dialed kg (savedKg) still wins below.
            const loadF = r.readiness ? r.readiness.loadFactor : 1;
            if (baseKg != null && loadF !== 1) baseKg = F.snapKg(baseKg * loadF, range.min, range.max);
            // Routine-combination taper: lighten the suggestion for the fatigued
            // half of a non-ideal superset or a lift late in a CNS-heavy session.
            if (baseKg != null && ctxFactor < 1) baseKg = F.snapKg(baseKg * ctxFactor, range.min, range.max);
          }
          if (baseKg != null) {
            // In same-weight mode the override is shared across the block.
            const kgKey = sameW ? swKey : id;
            const savedKg = state.kg[kgKey];
            if (editable) {
              // Default to the kg the user last dialed in for this exercise
              // (or this circuit); fall back to the engine's suggestion.
              let curKg = savedKg != null ? savedKg : baseKg;
              curKg = Math.max(range.min, Math.min(range.max, curKg));
              const kgRow = el("div", "ex-kg-row");
              const dec = el("button", "kg-adj", "−");
              const kgSpan = el("span", "ex-kg", curKg + " kg");
              const inc = el("button", "kg-adj", "+");
              const set = v => {
                curKg = Math.max(range.min, Math.min(range.max, v));
                kgSpan.textContent = curKg + " kg"; state.kg[kgKey] = curKg; saveKg();
                // Re-render so the shared circuit weight updates every exercise.
                if (sameW) renderRoutine(r, into, range, editable);
              };
              dec.onclick = () => set(curKg - 2);
              inc.onclick = () => set(curKg + 2);
              kgRow.appendChild(dec); kgRow.appendChild(kgSpan); kgRow.appendChild(inc);
              doseEl.appendChild(kgRow);
              if (savedKg == null) {
                const tapered = ctxFactor < 1
                  ? (pi === 1 && item.quality === F.QUALITY.ACCEPTABLE ? " · ajustado 2º superserie" : " · ajustado fatiga")
                  : "";
                const reason = sameW ? "misma pesa · circuito"
                  : usedE1 ? "según tu e1RM" + tapered
                  : tapered ? tapered.replace(" · ", "") : "sugerido";
                doseEl.appendChild(el("div", "ex-kg-hint", reason));
              }
            } else {
              // Show the user's last kg if known, else the suggestion.
              // Per-session kg (saved-routine edit) wins over the memory.
              doseEl.appendChild(el("div", "ex-kg", (p.kg != null ? p.kg : savedKg != null ? savedKg : baseKg) + " kg"));
            }
          }
          ex.appendChild(doseEl);
          if (editable) {
            const isPinned = pinnedIndex(id) >= 0;
            const pinBtn = el("button", "icon-btn pin-ex" + (isPinned ? " on" : ""), "★");
            a11y(pinBtn, isPinned ? "Desfijar" : "Fijar para regenerar");
            pinBtn.onclick = () => {
              const idx = pinnedIndex(id);
              if (idx >= 0) {
                state.cfg.pinned.splice(idx, 1);
                pinBtn.className = "icon-btn pin-ex";
                a11y(pinBtn, "Fijar para regenerar");
              } else {
                state.cfg.pinned.push({ id, block: br.block });
                pinBtn.className = "icon-btn pin-ex on";
                a11y(pinBtn, "Desfijar");
              }
              updatePinnedCount();
              saveConfig();
            };
            ex.appendChild(pinBtn);
          }
          node.appendChild(ex);
          // Double progression + RPE autoregulation as a clean full-width strip
          // under the exercise: target reps on the left, Facil/OK/Duro on the right.
          if (editable && p.exercise.dynamics !== F.DIN.ISO) {
            const progRow = el("div", "prog-row");
            progRow.appendChild(el("span", "prog-target", `objetivo ${targetReps(p)} reps`));
            const fbRow = el("div", "prog-fb");
            [["easy", "Fácil", "Demasiado fácil: sube más rápido"],
             ["ok", "OK", "En punto: progresa normal"],
             ["hard", "Duro", "Demasiado duro: baja un escalón"]].forEach(([fb, label, title]) => {
              const b = el("button", "prog-btn prog-" + fb, label);
              b.title = title;
              b.onclick = () => applyProgression(p, fb);
              fbRow.appendChild(b);
            });
            progRow.appendChild(fbRow);
            node.appendChild(progRow);
          }
        });
        node.appendChild(el("div", "el-note", item.note));
        blk.appendChild(node);
      });
      into.appendChild(blk);
    });
  }

  // ---- Guided workout timer --------------------------------------------
  // Flattens a routine into an ordered list of work/rest phases (from the
  // engine's block timelines) and drives a full-screen countdown. The timer
  // is also the capture point: every completed work set is logged (kg + reps,
  // adjustable during the following rest) and one-tap RPE per exercise feeds
  // the double-progression at the end — so history records what was actually
  // done, not just the plan.
  let timer = null;

  // ---- Session resilience ----------------------------------------------
  // Two failure modes killed in-progress workouts: the screen locking mid-set
  // (missed transitions) and a refresh / OS killing the PWA (all captured
  // sets lost). The timer holds a screen wake lock while open and
  // checkpoints itself to K.TIMER — excluded from the auto-backup mirror —
  // so init can offer to resume exactly where it stopped.
  let wakeLock = null;
  async function acquireWakeLock() {
    try {
      if (navigator.wakeLock && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch (e) { /* unsupported or denied: the timer still runs */ }
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }
  document.addEventListener("visibilitychange", () => {
    // The browser auto-releases the lock when the tab hides; re-arm on return.
    if (document.visibilityState === "visible" && timer) acquireWakeLock();
  });
  const clearTimerState = () => Store.set(K.TIMER, "null");
  // Android back button: close the timer overlay instead of exiting the PWA.
  window.addEventListener("popstate", () => {
    if (timer && timer.closeFromPop) timer.closeFromPop();
  });

  function timerDose(p) {
    if (p.exercise.dynamics === F.DIN.ISO) return `~${p.exercise.holdSec || 35}s` + symSuffix(p.exercise);
    // Hand-edited saved sessions: the trainee's numbers rule over the live
    // progression target.
    const reps = p.edited ? p.reps : targetReps(p);
    return `${reps} reps` + symSuffix(p.exercise);
  }
  const WARMUP_MOBILITY_SEC = 180, WARMUP_RAMP_REST = 45;
  function buildTimerSteps(routine) {
    const steps = [];
    // Warm-up first: the prep block exists to protect the ballistic work that
    // follows — the guided flow must not skip it.
    if (routine.warmup && routine.warmup.items && routine.warmup.items.length)
      steps.push({ kind: "rest", sec: WARMUP_MOBILITY_SEC, label: "Calentamiento: movilidad + activación", warmup: true });
    const ru = routine.warmup && routine.warmup.rampUp;
    if (ru) {
      const pseudo = { isSuperset: false, prescriptions: [{ exercise: ru.exercise, block: "A", sets: ru.sets, reps: ru.reps }] };
      F.elementTimeline(pseudo).forEach(ph => steps.push(Object.assign({}, ph, {
        block: "A", warmup: true,
        sec: ph.kind === "rest" ? WARMUP_RAMP_REST : ph.sec,
        doseLabel: ru.reps + " reps · carga ligera (aproximación)",
      })));
    }
    routine.blocks.forEach(br => {
      const tl = F.blockTimeline(br, routine.protocol || null);
      if (!tl.length) return;
      if (steps.length) steps.push({ kind: "rest", sec: F.CHANGEOVER_SEC, label: routine.protocol ? "Cambio de bloque" : "Cambio de ejercicio", block: br.block });
      tl.forEach(ph => steps.push(Object.assign({ block: br.block }, ph)));
    });
    return steps;
  }
  function ensureTimerOverlay() {
    let o = $("#timer-overlay");
    if (o) return o;
    o = el("div", "timer-overlay hidden"); o.id = "timer-overlay";
    o.innerHTML =
      '<div class="timer-inner">' +
      '<div class="timer-top"><span id="t-step" class="timer-step"></span>' +
      '<button id="t-close" class="timer-x" title="Cerrar" aria-label="Cerrar temporizador">✕</button></div>' +
      '<div id="t-kind" class="timer-kind"></div>' +
      '<div id="t-name" class="timer-name"></div>' +
      '<div id="t-sub" class="timer-sub"></div>' +
      '<div id="t-count" class="timer-count">0:00</div>' +
      '<div id="t-log" class="timer-log hidden">' +
      '<div class="t-log-title">Serie hecha: <span id="t-log-name"></span></div>' +
      '<div class="t-log-reps">' +
      '<button id="t-log-dec" class="kg-adj" aria-label="Una repetición menos">−</button>' +
      '<span id="t-log-val"></span>' +
      '<button id="t-log-inc" class="kg-adj" aria-label="Una repetición más">+</button></div>' +
      '<div class="t-log-fb" id="t-log-fb">' +
      '<button data-fb="easy" class="prog-btn prog-easy">Fácil</button>' +
      '<button data-fb="ok" class="prog-btn prog-ok">OK</button>' +
      '<button data-fb="hard" class="prog-btn prog-hard">Duro</button>' +
      '</div></div>' +
      '<div id="t-next" class="timer-next"></div>' +
      '<div class="timer-controls">' +
      '<button id="t-prev" class="btn btn-ghost" aria-label="Paso anterior">‹</button>' +
      '<button id="t-pause" class="btn btn-forge">Pausa</button>' +
      '<button id="t-skip" class="btn btn-ghost" aria-label="Siguiente paso">›</button>' +
      '</div></div>';
    document.body.appendChild(o);
    return o;
  }
  // Working kg for a prescription right now: the dialed weight (shared circuit
  // weight in same-weight mode), else the engine suggestion.
  function currentKgFor(p) {
    const sameW = !!state.cfg.sameWeight;
    if (sameW && state.kg["__sw:" + p.block] != null) return state.kg["__sw:" + p.block];
    if (state.kg[exId(p.exercise)] != null) return state.kg[exId(p.exercise)];
    return F.suggestKg(p.exercise.load, state.cfg.weightMin, state.cfg.weightMax, state.cfg.profile, p.exercise, p.reps);
  }
  // Group the flat set log into per-exercise entries (same shape as manual
  // session logs: { name, kg, sets: [reps...] }), so e1RM and volume can
  // consume both without caring where the data came from.
  function groupPerformed(done) {
    const out = [];
    const byKey = {};
    done.forEach(en => {
      const key = en.name + "@" + en.kg;
      if (!byKey[key]) { byKey[key] = { name: en.name, kg: en.kg, sets: [] }; out.push(byKey[key]); }
      byKey[key].sets.push(en.reps);
    });
    return out;
  }
  function startTimer(routine, histEntry, resume) {
    if (!routine || !routine.blocks) return;
    const steps = buildTimerSteps(routine);
    if (!steps.length) { toast("Rutina vacía"); return; }
    if (timer) clearInterval(timer.tick);
    const o = ensureTimerOverlay(); o.classList.remove("hidden");
    const T = timer = { i: 0, remaining: 0, paused: false, tick: null,
      done: [], logged: {}, fb: {}, lastEntry: null };
    // Restore a checkpointed session: done[] entries and logged{} share
    // identity in the live timer, so rebuild logged from the index map.
    if (resume) {
      T.done = (resume.done || []).map(en => ({ name: en.name, kg: en.kg, reps: en.reps, p: en.p || undefined }));
      Object.keys(resume.loggedIdx || {}).forEach(i => { T.logged[i] = T.done[resume.loggedIdx[i]]; });
      Object.keys(resume.isoLogged || {}).forEach(i => { T.logged[i] = { name: resume.isoLogged[i] }; });
      T.fb = resume.fb || {};
    }
    acquireWakeLock();
    try { history.pushState({ forjaTimer: true }, ""); } catch (e) {}
    // Checkpoint the live state so a refresh or the OS killing the app can
    // resume instead of losing the workout.
    function checkpoint() {
      const loggedIdx = {}, isoLogged = {};
      Object.keys(T.logged).forEach(i => {
        const en = T.logged[i]; const di = T.done.indexOf(en);
        if (di >= 0) loggedIdx[i] = di; else isoLogged[i] = en.name;
      });
      Store.set(K.TIMER, JSON.stringify({
        routine, histId: histEntry ? histEntry.id : state.lastSavedId,
        i: T.i, remaining: T.remaining, fb: T.fb,
        done: T.done.map(en => ({ name: en.name, kg: en.kg, reps: en.reps, p: en.p || null })),
        loggedIdx, isoLogged, savedAt: Date.now(),
      }));
    }
    const fmt = sec => Math.floor(sec / 60) + ":" + String(Math.max(0, sec) % 60).padStart(2, "0");
    // Log a work step the moment the trainee moves past it. Warm-up and ISO
    // phases are not logged (no meaningful rep count); re-visiting a step via
    // ‹/› never double-logs it.
    function logWorkStep(i) {
      const s = steps[i];
      if (!s || s.kind !== "work" || s.warmup) return;
      if (T.logged[i]) { T.lastEntry = T.logged[i].reps != null ? T.logged[i] : null; return; }
      const p = s.prescription;
      if (p.exercise.dynamics === F.DIN.ISO) { T.logged[i] = { name: p.exercise.name }; T.lastEntry = null; return; }
      // Same rule as timerDose: a hand-edited saved session logs the
      // trainee's numbers, not the live progression target.
      const entry = { name: p.exercise.name, kg: currentKgFor(p), reps: p.edited ? p.reps : targetReps(p), p };
      T.logged[i] = entry; T.done.push(entry); T.lastEntry = entry;
    }
    function renderLog() {
      const s = steps[T.i];
      const show = s.kind === "rest" && !s.warmup && T.lastEntry;
      $("#t-log").classList.toggle("hidden", !show);
      if (!show) return;
      $("#t-log-name").textContent = T.lastEntry.name + (T.lastEntry.kg != null ? " · " + T.lastEntry.kg + " kg" : "");
      $("#t-log-val").textContent = T.lastEntry.reps + " reps";
      const fb = T.fb[T.lastEntry.name];
      $("#t-log-fb").querySelectorAll("button").forEach(b =>
        b.classList.toggle("on", b.getAttribute("data-fb") === fb));
    }
    function render() {
      const s = steps[T.i];
      $("#t-step").textContent = `Paso ${T.i + 1} / ${steps.length}`;
      o.classList.toggle("rest", s.kind === "rest");
      if (s.kind === "work") {
        $("#t-kind").textContent = (s.warmup ? "CALENTAMIENTO" : "TRABAJO") + " · Bloque " + s.block;
        $("#t-name").textContent = s.prescription.exercise.name;
        $("#t-sub").textContent = `Serie ${s.setNo}/${s.totalSets} · ${s.doseLabel || timerDose(s.prescription)}`;
      } else {
        $("#t-kind").textContent = s.warmup ? "PREPARACIÓN" : "DESCANSO";
        $("#t-name").textContent = s.label || "Descanso";
        $("#t-sub").textContent = "";
      }
      const nxt = steps[T.i + 1];
      $("#t-next").textContent = nxt
        ? "Sigue: " + (nxt.kind === "work" ? nxt.prescription.exercise.name : (nxt.label || "descanso"))
        : "Última fase";
      $("#t-count").textContent = fmt(T.remaining);
      renderLog();
    }
    function load(i) { T.i = Math.max(0, Math.min(steps.length - 1, i)); T.remaining = steps[T.i].sec; render(); checkpoint(); }
    // Persist what actually happened. Completed=finished the whole flow; an
    // early close keeps the partial log (if the session lives in history)
    // without marking it complete.
    function persist(completed) {
      const performed = groupPerformed(T.done);
      if (!performed.length && !completed) return false;
      let h = histEntry || (state.lastSavedId != null ? state.hist.find(x => x.id === state.lastSavedId) : null);
      if (h) {
        if (performed.length) h.performed = performed;
        if (completed) h.completed = true;
        saveHistory(); renderHistory();
        return true;
      }
      if (routine === state.routine) {
        saveToHistory(Object.assign({ completed: !!completed },
          performed.length ? { performed } : {}));
        return true;
      }
      return false;
    }
    function finish() {
      logWorkStep(T.i);   // the final work phase has no rest after it
      // One progression nudge per exercise, from the RPE taps collected.
      Object.keys(T.fb).forEach(name => {
        const en = T.done.find(x => x.name === name && x.p);
        if (en) applyProgression(en.p, T.fb[name], { silent: true });
      });
      const saved = persist(true);
      if (state.routine) renderRoutine(state.routine, $("#routine-out"), { min: state.cfg.weightMin, max: state.cfg.weightMax }, true);
      toast(saved ? "Entrenamiento completado y registrado" : "Entrenamiento completado");
      stop();
    }
    function stop() {
      clearInterval(T.tick); o.classList.add("hidden"); timer = null;
      releaseWakeLock(); clearTimerState();
      // Consume the history entry pushed on open (a popstate-close already
      // popped it, and then history.state is no longer ours).
      try { if (history.state && history.state.forjaTimer) history.back(); } catch (e) {}
    }
    T.closeFromPop = () => { persist(false); stop(); };
    function onTick() {
      if (T.paused) return;
      T.remaining--;
      if (T.remaining <= 0) {
        if (navigator.vibrate) navigator.vibrate(120);
        if (T.i >= steps.length - 1) { $("#t-count").textContent = "0:00"; finish(); return; }
        logWorkStep(T.i);
        load(T.i + 1); return;
      }
      $("#t-count").textContent = fmt(T.remaining);
      if (T.remaining % 5 === 0) checkpoint();   // survive a mid-step kill
    }
    $("#t-pause").onclick = () => { T.paused = !T.paused; $("#t-pause").textContent = T.paused ? "Reanudar" : "Pausa"; checkpoint(); };
    $("#t-prev").onclick = () => load(T.i - 1);
    $("#t-skip").onclick = () => {
      if (T.i >= steps.length - 1) { finish(); return; }
      logWorkStep(T.i);
      load(T.i + 1);
    };
    $("#t-close").onclick = () => { persist(false); stop(); };
    $("#t-log-dec").onclick = () => { if (T.lastEntry && T.lastEntry.reps > 0) { T.lastEntry.reps--; renderLog(); checkpoint(); } };
    $("#t-log-inc").onclick = () => { if (T.lastEntry && T.lastEntry.reps < 50) { T.lastEntry.reps++; renderLog(); checkpoint(); } };
    $("#t-log-fb").querySelectorAll("button").forEach(b => {
      b.onclick = () => { if (T.lastEntry) { T.fb[T.lastEntry.name] = b.getAttribute("data-fb"); renderLog(); checkpoint(); } };
    });
    load(resume ? Math.min(resume.i || 0, steps.length - 1) : 0);
    if (resume) {
      // Land on the checkpointed second, paused: the trainee decides when
      // the countdown moves again.
      if (typeof resume.remaining === "number" && resume.remaining > 0)
        T.remaining = Math.min(steps[T.i].sec, resume.remaining);
      T.paused = true; $("#t-pause").textContent = "Reanudar";
      render();
    }
    T.tick = setInterval(onTick, 1000);
  }

  // ---- Generate
  function filteredPool() { return F.filterByEquipment(state.pool, state.cfg.equipment); }

  function calcRecent() {
    if (!state.cfg.vary) return null;
    const rec = {}; const weights = [4, 2, 1];   // last 3 sessions, decaying
    state.hist.slice(0, 3).forEach((h, idx) => {
      if (!h.routine) return;   // CSV-imported logs carry no routine object
      const w = weights[idx] || 0;
      h.routine.blocks.forEach(b => b.elements.forEach(el => el.prescriptions.forEach(p => {
        rec[p.exercise.name] = (rec[p.exercise.name] || 0) + w;
      })));
    });
    return rec;
  }

  function generateRoutine() {
    const c = state.cfg;
    // Focus chips act as a HARD filter (focus) or a SOFT emphasis depending on
    // the mode toggle; soft keeps balance and full-body coverage.
    const soft = c.focusSoft && c.focus.length;
    const opts = { objective: c.objective,
      focus: soft ? ["FULL"] : (c.focus.length ? c.focus : ["FULL"]),
      emphasis: soft ? c.focus : undefined,
      equipment: c.equipment,
      balance: c.balance, tolerance: c.tolerance, recent: calcRecent(), seed: null,
      sameWeight: c.sameWeight, readiness: c.readiness, person: c.profile,
      // The engine resolves pins by display name; app pins are id-keyed.
      pinned: c.pinned.map(f => {
        const d = state.byId[f.id != null ? f.id : state.nameToId[f.name]];
        return d ? { name: d.name, block: f.block } : null;
      }).filter(Boolean) };
    if (c.volumeMode === "structure") opts.structure = c.structure; else opts.minutes = c.minutes;
    const r = F.generate(state.pool.filter(e => !isPaused(e.id)), opts);
    state.routine = r;
    state.routineSource = "auto";
    state.loadedObjective = null;   // freshly generated: config objective applies
    state.pendingProgram = null;    // a manual "Generar" is not a program day
    state.lastSavedId = null;   // a fresh routine is not yet in history
    renderRoutine(r, $("#routine-out"), { min: c.weightMin, max: c.weightMax }, true);
    $("#audit-out").innerHTML = "";
    $("#btn-regenerar").classList.remove("hidden");
    $("#save-row").classList.remove("hidden");
    saveConfig();
    scrollToRoutine();   // jump straight to the result, not the bottom of the form
  }

  // Put an EXISTING routine (a repeated session or a saved template) onto the
  // Generate view as the live, editable routine — the shared tail of
  // generateRoutine, minus generation. `source` marks manual vs auto so
  // saving keeps the right objective; regeneration is hidden (there is no
  // config behind this routine to regenerate from).
  function loadRoutine(routine, source, objective) {
    state.routine = JSON.parse(JSON.stringify(routine));
    state.routineSource = source === "manual" ? "manual" : "auto";
    state.loadedObjective = objective || null;   // used by saveToHistory below
    state.pendingProgram = null;   // repeat/template loads are not program days
    state.lastSavedId = null;
    state.cfg.mode = "auto"; setSeg("#seg-mode", "auto");
    if (typeof applyModeRef === "function") applyModeRef();
    showView("gen");
    renderRoutine(state.routine, $("#routine-out"), { min: state.cfg.weightMin, max: state.cfg.weightMax }, true);
    $("#audit-out").innerHTML = "";
    $("#btn-regenerar").classList.add("hidden");
    $("#save-row").classList.remove("hidden");
    scrollToRoutine();
  }

  // ---- Mis rutinas: saved reusable routines -----------------------------
  function saveCurrentAsTemplate() {
    if (!state.routine) { toast("Genera o compón una rutina primero"); return; }
    const def = (OBJ_LABEL[state.routineSource === "manual" ? "MANUAL" : state.cfg.objective] || "Rutina") +
      " · " + new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
    let name = def;
    try { const p = window.prompt("Nombre de la plantilla", def); if (p === null) return; if (p.trim()) name = p.trim(); } catch (e) {}
    state.templates.unshift({
      id: nextId(), name,
      source: state.routineSource,
      objective: state.routineSource === "manual" ? "MANUAL" : state.cfg.objective,
      routine: JSON.parse(JSON.stringify(state.routine)),
    });
    saveTemplates(); renderTemplates(); toast("Guardada en Mis rutinas");
  }
  function renderTemplates() {
    const host = $("#templates-list"); if (!host) return;
    host.innerHTML = "";
    $("#templates-card").classList.toggle("hidden", !state.templates.length);
    state.templates.forEach(t => {
      const row = el("div", "tpl-row");
      const meta = el("div", "tpl-meta");
      meta.appendChild(el("div", "tpl-name", esc(t.name)));
      const nEx = (t.routine.blocks || []).reduce((a, b) => a + b.elements.reduce((x, e2) => x + e2.prescriptions.length, 0), 0);
      meta.appendChild(el("div", "tpl-sub", (OBJ_LABEL[t.objective] || t.objective || "") + " · " + nEx + " ejercicios"));
      meta.style.cursor = "pointer";
      meta.onclick = () => { loadRoutine(t.routine, t.source, t.objective); toast("Plantilla cargada · ajusta o entrena"); };
      const load = el("button", "icon-btn", "▶"); a11y(load, "Cargar plantilla");
      load.onclick = () => { loadRoutine(t.routine, t.source, t.objective); toast("Plantilla cargada · ajusta o entrena"); };
      const del = el("button", "icon-btn del", "✕"); a11y(del, "Borrar plantilla");
      del.onclick = () => { state.templates = state.templates.filter(x => x.id !== t.id); saveTemplates(); renderTemplates(); toast("Plantilla borrada"); };
      const actions = el("div", "hist-actions");
      actions.appendChild(load); actions.appendChild(del);
      row.appendChild(meta); row.appendChild(actions);
      host.appendChild(row);
    });
  }

  // ---- Multi-week program (plan layer over the generator) ----------------
  // The program stores intent (schedule + mesocycle + anchors + cursor + a
  // global cycle emphasis), not routines: each day is generated just-in-time
  // from its objective, the week's phase (ramp/deload), the trainee's live
  // numbers and the cycle emphasis distributed across the week, then saved to
  // normal history tagged with the program slot. Several programs can coexist;
  // one is active. Methodology: docs/program-generation-methodology.md.
  const PROG_EMPHASIS_CHOICES = [
    ["", "—"], ["LEGS", "Piernas"], ["PUSH,PULL", "Torso"],
    ["PUSH", "Empuje"], ["PULL", "Pull"], ["CORE", "Core"], ["ARMS", "Brazos"], ["GRIP", "Agarre"],
  ];
  const PROG_DOSE_CHOICES = [["soft", "Suave"], ["medium", "Medio"], ["strong", "Fuerte"]];
  let progCreating = false;   // UI flag: show the create form even if programs exist
  let progEditOpen = false;   // keep the editor <details> open across re-renders
  // Editor works on a DRAFT (a copy of the active program); changes only take
  // effect when the trainee presses "Guardar". Null when not editing.
  let progDraft = null;
  const discardDraft = () => { progDraft = null; };

  // Default anchors: one fundamental per distinct pattern, up to 3 — the lifts
  // kept every matching day so progression/e1RM compound (continuity).
  function defaultAnchors() {
    const picked = [], seen = new Set();
    state.pool.filter(e => e.tier === "FUNDAMENTAL" && !isPaused(e.id))
      .forEach(e => { if (!seen.has(e.pattern) && picked.length < 3) { picked.push(e.id); seen.add(e.pattern); } });
    return picked;
  }
  function createProgram(days, mesoLen, minutes) {
    const d = Math.max(2, Math.min(6, days || 3));
    const pg = {
      id: nextId(), name: "Programa " + (state.programs.length + 1), daysPerWeek: d,
      week: F.programWeekDefaults(d),
      mesocycle: { lengthWeeks: mesoLen || 4, deloadEveryWeeks: mesoLen || 4 },
      anchors: defaultAnchors(),
      cursor: { week: 1, dayIndex: 0 },
      baseMinutes: minutes || state.cfg.minutes || 40,
      cycleEmphasis: [],        // global "bring up X this cycle" (soft)
      cycleDose: "medium",      // how many days lean toward it
    };
    state.programs.push(pg);
    state.activeProgramId = pg.id;
    progCreating = false;
    saveProgram(); renderProgram();
  }
  // Which day indices carry the global cycle emphasis, spread across the week
  // by dose: soft=1 day, medium≈half, strong=most (always leaving one general
  // day so it stays "más, no solo").
  function cycleEmphasisDays(pg) {
    if (!pg.cycleEmphasis || !pg.cycleEmphasis.length) return new Set();
    const n = pg.week.length;
    const count = pg.cycleDose === "soft" ? 1
      : pg.cycleDose === "strong" ? Math.max(1, n - 1)
      : Math.max(1, Math.round(n / 2));
    const set = new Set();
    for (let i = 0; i < count; i++) set.add(Math.round((i * n) / count) % n);
    return set;
  }
  // The effective soft emphasis for a day: a manual per-day override wins;
  // otherwise the global cycle emphasis on the days it's distributed to.
  function effectiveEmphasis(pg, dayIndex) {
    const day = pg.week[dayIndex];
    if (day.emphasis && day.emphasis.length) return day.emphasis;
    if (cycleEmphasisDays(pg).has(dayIndex)) return pg.cycleEmphasis;
    return [];
  }
  // Anchors that fit a given day's objective (an anchor whose dynamics appears
  // in that objective's template), as generator pins.
  function anchorsForDay(pg, day) {
    const tpl = F.TEMPLATES[day.objective];
    if (!tpl) return [];
    return (pg.anchors || [])
      .map(id => state.byId[id])
      .filter(e => e && !isPaused(e.id) && tpl.blocks.some(b => [...b.dynamics].includes(e.dynamics)))
      .map(e => ({ name: e.name, block: "AUTO" }));
  }
  function trainToday() {
    const pg = activeProgram(); if (!pg) return;
    const day = pg.week[pg.cursor.dayIndex];
    const phase = F.phaseFor(pg.cursor.week, pg.mesocycle);
    const emph = effectiveEmphasis(pg, pg.cursor.dayIndex);
    const c = state.cfg;
    const opts = {
      objective: day.objective,
      emphasis: emph.length ? emph : undefined,
      equipment: c.equipment, weightMin: c.weightMin, weightMax: c.weightMax, profile: c.profile,
      readiness: c.readiness, vary: true, recent: calcRecent(), seed: null, sameWeight: c.sameWeight,
      minutes: Math.max(10, Math.round((pg.baseMinutes || c.minutes) * phase.volumeFactor)),
      loadBias: 1 + 0.1 * phase.intensityFactor,
      pinned: anchorsForDay(pg, day),
    };
    const r = F.generate(state.pool.filter(e => !isPaused(e.id)), opts);
    // Program context travels with the routine (banner + History), so the
    // day never looks like a plain one-off generation.
    r.programMeta = {
      name: pg.name, label: day.label, objective: day.objective,
      week: pg.cursor.week, deload: phase.deload,
      emphasis: emph.slice(), volumePct: Math.round((phase.volumeFactor - 1) * 100),
    };
    loadRoutine(r, "auto", day.objective);   // clears pendingProgram, then:
    state.pendingProgram = { programId: pg.id, week: pg.cursor.week, dayIndex: pg.cursor.dayIndex, label: day.label, deload: phase.deload };
    toast(day.label + " · semana " + pg.cursor.week + (phase.deload ? " · descarga" : ""));
  }
  function advanceProgram() {
    const pg = state.pendingProgram ? state.programs.find(p => p.id === state.pendingProgram.programId) : null;
    if (!pg) return;
    pg.cursor.dayIndex++;
    if (pg.cursor.dayIndex >= pg.week.length) { pg.cursor.dayIndex = 0; pg.cursor.week++; }
    saveProgram();
  }

  function renderProgramCreate(host) {
    host.appendChild(el("div", "prog-intro",
      "Un programa encadena semanas: mantiene tus ejercicios base (para que la progresión se acumule), reparte objetivos por día y sube el volumen antes de una semana de descarga. Cada día se genera al momento con tus números más recientes."));
    let days = 3, meso = 4, minutes = state.cfg.minutes || 40;
    const stepRow = (label, get, set, min, max, step) => {
      const row = el("div", "est-row");
      row.appendChild(el("span", null, label));
      const wrap = el("div", "stepper");
      const dec = el("button", null, "−"), val = el("span", "val", String(get())), inc = el("button", null, "+");
      dec.onclick = () => { set(Math.max(min, get() - (step || 1))); val.textContent = get(); };
      inc.onclick = () => { set(Math.min(max, get() + (step || 1))); val.textContent = get(); };
      wrap.appendChild(dec); wrap.appendChild(val); wrap.appendChild(inc);
      row.appendChild(wrap); return row;
    };
    host.appendChild(stepRow("Días por semana", () => days, v => days = v, 2, 6));
    host.appendChild(stepRow("Semanas por ciclo (descarga la última)", () => meso, v => meso = v, 2, 8));
    host.appendChild(stepRow("Duración por sesión (min)", () => minutes, v => minutes = v, 15, 75, 5));
    const create = el("button", "btn btn-forge", "Crear programa");
    create.style.marginTop = "12px";
    create.onclick = () => { createProgram(days, meso, minutes); toast("Programa creado"); };
    host.appendChild(create);
    if (state.programs.length) {
      const cancel = el("button", "btn btn-ghost", "Cancelar");
      cancel.style.marginTop = "10px";
      cancel.onclick = () => { progCreating = false; renderProgram(); };
      host.appendChild(cancel);
    }
  }

  function renderProgram() {
    const host = $("#program-body"); if (!host) return;
    host.innerHTML = "";

    // Program switcher: pick the active program or start a new one.
    if (state.programs.length) {
      const bar = el("div", "prog-switch");
      state.programs.forEach(p => {
        const chip = el("button", "prog-tab" + (p.id === state.activeProgramId ? " current" : ""), esc(p.name));
        chip.onclick = () => { state.activeProgramId = p.id; progCreating = false; discardDraft(); saveProgram(); renderProgram(); };
        bar.appendChild(chip);
      });
      const add = el("button", "prog-tab prog-add", "+ Nuevo");
      add.onclick = () => { progCreating = true; discardDraft(); renderProgram(); };
      bar.appendChild(add);
      host.appendChild(bar);
    }

    if (progCreating || !state.programs.length) { renderProgramCreate(host); return; }

    const pg = activeProgram();
    if (!pg) { renderProgramCreate(host); return; }

    // Progress ribbon + week strip + train button.
    const phase = F.phaseFor(pg.cursor.week, pg.mesocycle);
    const ribbon = el("div", "prog-ribbon");
    ribbon.appendChild(el("span", "prog-week", "Semana " + pg.cursor.week));
    ribbon.appendChild(el("span", "prog-phase " + (phase.deload ? "deload" : "accum"),
      phase.deload ? "Descarga" : "Acumulación"));
    host.appendChild(ribbon);

    const emphDays = cycleEmphasisDays(pg);
    const strip = el("div", "prog-strip");
    const dayChips = [];   // kept so label edits below reflect live at the top
    pg.week.forEach((day, i) => {
      const lean = (day.emphasis && day.emphasis.length) || emphDays.has(i);
      const chip = el("button", "prog-day" + (i === pg.cursor.dayIndex ? " current" : "") + (lean ? " leaning" : ""), esc(day.label));
      a11y(chip, "Ir a este día");
      chip.onclick = () => { pg.cursor.dayIndex = i; saveProgram(); renderProgram(); };
      strip.appendChild(chip);
      dayChips.push(chip);
    });
    host.appendChild(strip);

    const trainBtn = el("button", "btn btn-forge", "Entrenar hoy · " + esc(pg.week[pg.cursor.dayIndex].label));
    trainBtn.style.marginTop = "12px";
    trainBtn.onclick = trainToday;
    host.appendChild(trainBtn);

    // ---- Editor (open on demand): works on a DRAFT; changes only take effect
    // on "Guardar". The strip/ribbon/train button above always reflect the
    // SAVED program, so what you train is what you saved.
    if (!progDraft || progDraft.id !== pg.id) progDraft = JSON.parse(JSON.stringify(pg));
    const dr = progDraft;
    const dirty = JSON.stringify(dr) !== JSON.stringify(pg);
    // A field change re-renders to refresh previews/dirty state; keep the
    // editor expanded so it never collapses mid-edit.
    const reEdit = () => { progEditOpen = true; renderProgram(); };

    const editWrap = el("details", "prog-edit");
    editWrap.open = progEditOpen;
    editWrap.addEventListener("toggle", () => { progEditOpen = editWrap.open; });
    const sum = document.createElement("summary");
    sum.textContent = "Editar programa" + (dirty ? " · cambios sin guardar" : "");
    if (dirty) sum.classList.add("prog-dirty");
    editWrap.appendChild(sum);

    const nameRow = el("div", "prog-edit-row");
    nameRow.appendChild(el("span", "prog-edit-lbl", "Nombre"));
    const nameInp = document.createElement("input");
    nameInp.type = "text"; nameInp.className = "manual-input"; nameInp.value = dr.name;
    nameInp.oninput = () => { dr.name = nameInp.value; };
    nameInp.onchange = () => reEdit();   // refresh the "sin guardar" state on blur
    nameRow.appendChild(nameInp);
    editWrap.appendChild(nameRow);

    // Global cycle emphasis + dose: bring up a region across the whole cycle.
    const emRow = el("div", "prog-edit-row");
    emRow.appendChild(el("span", "prog-edit-lbl", "Énfasis del ciclo (mejora una zona; se reparte en varios días)"));
    const emSel = document.createElement("select"); emSel.className = "mk-select";
    const curEm = (dr.cycleEmphasis || []).join(",");
    PROG_EMPHASIS_CHOICES.forEach(([v, label]) => {
      const op = document.createElement("option"); op.value = v; op.textContent = label;
      if (curEm === v) op.selected = true; emSel.appendChild(op);
    });
    emSel.onchange = () => { dr.cycleEmphasis = emSel.value ? emSel.value.split(",") : []; reEdit(); };
    emRow.appendChild(emSel);
    const doseSel = document.createElement("select"); doseSel.className = "mk-select";
    PROG_DOSE_CHOICES.forEach(([v, label]) => {
      const op = document.createElement("option"); op.value = v; op.textContent = "Dosis: " + label;
      if ((dr.cycleDose || "medium") === v) op.selected = true; doseSel.appendChild(op);
    });
    doseSel.onchange = () => { dr.cycleDose = doseSel.value; reEdit(); };
    emRow.appendChild(doseSel);
    editWrap.appendChild(emRow);

    // Mesocycle length.
    const mesoRow = el("div", "prog-edit-row");
    mesoRow.appendChild(el("span", "prog-edit-lbl", "Semanas por ciclo"));
    const mesoStep = el("div", "stepper");
    const mDec = el("button", null, "−"), mVal = el("span", "val", String(dr.mesocycle.deloadEveryWeeks)), mInc = el("button", null, "+");
    const setMeso = v => { const n = Math.max(2, Math.min(8, v)); dr.mesocycle.lengthWeeks = n; dr.mesocycle.deloadEveryWeeks = n; mVal.textContent = n; reEdit(); };
    mDec.onclick = () => setMeso(dr.mesocycle.deloadEveryWeeks - 1);
    mInc.onclick = () => setMeso(dr.mesocycle.deloadEveryWeeks + 1);
    mesoStep.appendChild(mDec); mesoStep.appendChild(mVal); mesoStep.appendChild(mInc);
    mesoRow.appendChild(mesoStep);
    editWrap.appendChild(mesoRow);

    // Session duration: the main volume knob (fewer minutes = fewer exercises).
    const minRow = el("div", "prog-edit-row");
    const eff = Math.round((dr.baseMinutes || 40) * F.phaseFor(pg.cursor.week, dr.mesocycle).volumeFactor);
    minRow.appendChild(el("span", "prog-edit-lbl", "Duración por sesión (min) · esta semana ≈ " + eff + " min"));
    const minStep = el("div", "stepper");
    const nDec = el("button", null, "−"), nVal = el("span", "val", String(dr.baseMinutes || 40)), nInc = el("button", null, "+");
    const setMin = v => { dr.baseMinutes = Math.max(15, Math.min(75, v)); nVal.textContent = dr.baseMinutes; reEdit(); };
    nDec.onclick = () => setMin((dr.baseMinutes || 40) - 5);
    nInc.onclick = () => setMin((dr.baseMinutes || 40) + 5);
    minStep.appendChild(nDec); minStep.appendChild(nVal); minStep.appendChild(nInc);
    minRow.appendChild(minStep);
    editWrap.appendChild(minRow);

    // Days per week: add or drop a training day. New days seed from the default
    // schedule; existing (possibly edited) days are kept; dropping removes from
    // the end. The cursor is clamped so it never points past the last day.
    const daysRow = el("div", "prog-edit-row");
    daysRow.appendChild(el("span", "prog-edit-lbl", "Días por semana"));
    const daysStep = el("div", "stepper");
    const dDec = el("button", null, "−"), dVal = el("span", "val", String(dr.week.length)), dInc = el("button", null, "+");
    const setDays = v => {
      const n = Math.max(2, Math.min(6, v));
      if (n === dr.week.length) return;
      if (n > dr.week.length) {
        const defs = F.programWeekDefaults(n);
        for (let i = dr.week.length; i < n; i++) dr.week.push(defs[i]);
      } else {
        dr.week = dr.week.slice(0, n);
        if (dr.cursor.dayIndex >= n) dr.cursor.dayIndex = 0;
      }
      dr.daysPerWeek = n;
      reEdit();
    };
    dDec.onclick = () => setDays(dr.week.length - 1);
    dInc.onclick = () => setDays(dr.week.length + 1);
    daysStep.appendChild(dDec); daysStep.appendChild(dVal); daysStep.appendChild(dInc);
    daysRow.appendChild(daysStep);
    editWrap.appendChild(daysRow);

    // Per-day label, objective and optional manual emphasis override.
    editWrap.appendChild(el("div", "prog-edit-lbl", "Días (objetivo y énfasis manual opcional)"));
    dr.week.forEach(day => {
      const row = el("div", "prog-edit-row");
      const lblInp = document.createElement("input");
      lblInp.type = "text"; lblInp.className = "manual-input"; lblInp.value = day.label;
      lblInp.oninput = () => { day.label = lblInp.value; };
      lblInp.onchange = () => reEdit();
      row.appendChild(lblInp);
      const objSel = document.createElement("select"); objSel.className = "mk-select";
      ["STRENGTH", "METABOLIC", "STRENGTH_ENDURANCE", "POWER", "EMOM", "AMRAP"].forEach(o => {
        const op = document.createElement("option"); op.value = o; op.textContent = OBJ_LABEL[o] || o;
        if (day.objective === o) op.selected = true; objSel.appendChild(op);
      });
      objSel.onchange = () => { day.objective = objSel.value; };
      row.appendChild(objSel);
      const daySel = document.createElement("select"); daySel.className = "mk-select";
      const curDay = (day.emphasis || []).join(",");
      PROG_EMPHASIS_CHOICES.forEach(([v, label]) => {
        const op = document.createElement("option"); op.value = v; op.textContent = "Énfasis: " + (v ? label : "auto");
        if (curDay === v) op.selected = true; daySel.appendChild(op);
      });
      daySel.onchange = () => { day.emphasis = daySel.value ? daySel.value.split(",") : []; };
      row.appendChild(daySel);
      editWrap.appendChild(row);
    });

    // Save / discard the draft.
    const editBtns = el("div", "btn-row"); editBtns.style.marginTop = "12px";
    const saveBtn = el("button", "btn btn-forge", "Guardar programa");
    saveBtn.onclick = () => {
      const idx = state.programs.findIndex(p => p.id === pg.id);
      if (idx >= 0) state.programs[idx] = JSON.parse(JSON.stringify(dr));
      discardDraft();
      saveProgram(); renderProgram(); toast("Programa guardado");
    };
    const discardBtn = el("button", "btn btn-ghost", "Descartar");
    discardBtn.onclick = () => { discardDraft(); renderProgram(); toast("Cambios descartados"); };
    editBtns.appendChild(discardBtn); editBtns.appendChild(saveBtn);
    editWrap.appendChild(editBtns);
    host.appendChild(editWrap);

    const del = el("button", "btn btn-ghost", "Borrar este programa");
    del.style.marginTop = "12px";
    del.onclick = () => {
      state.programs = state.programs.filter(p => p.id !== pg.id);
      state.activeProgramId = state.programs[0] ? state.programs[0].id : null;
      discardDraft(); saveProgram(); renderProgram(); toast("Programa borrado");
    };
    host.appendChild(del);
  }

  // ---- Manual routine builder ("Creada por mi") --------------------------
  // The trainee composes the session by hand: rows per block with exercise,
  // sets, reps and an optional superset link to the previous row. The draft
  // persists in cfg.manual; "Evaluar mi rutina" composes it through the engine
  // and renders the scrutiny (auditRoutine) next to the routine itself.
  const MK_DEFAULTS = { A: { sets: 4, reps: 6 }, B: { sets: 3, reps: 10 }, C: { sets: 3, reps: 15 } };
  // UI-only state of the exercise picker: which block it is open for + query.
  const mkPicker = { block: null, text: "" };

  // Template schema for a block under the DECLARED objective (null in Auto).
  // The declared objective only ADVISES the builder — it ranks and marks
  // recommended exercises and prefills sets/reps; placing exercises remains
  // the generator's job (Generada mode).
  function mkObjSchema(k) {
    const tpl = F.TEMPLATES[state.cfg.manualObjective];
    return tpl ? (tpl.blocks.find(b => b.block === k) || null) : null;
  }
  function mkDefaults(k) {
    const sch = mkObjSchema(k);
    return sch ? { sets: sch.sets, reps: sch.reps } : MK_DEFAULTS[k];
  }

  // Effective kg shown for a builder row: the row's own choice, else the kg
  // memory for that exercise, else the engine's cold-start suggestion.
  function mkEffKg(it, e) {
    if (it.kg != null) return it.kg;
    if (state.kg[it.id] != null) return state.kg[it.id];
    const s = F.suggestKg(e.load, state.cfg.weightMin, state.cfg.weightMax, state.cfg.profile, e, it.reps);
    return s == null ? state.cfg.weightMin : s;
  }

  function renderBuilder() {
    const pool = filteredPool().slice().sort((a, b) => a.name.localeCompare(b.name));
    const inPool = {}; pool.forEach(e => { inPool[e.id] = e; });
    ["A", "B", "C"].forEach(k => {
      const host = $("#mk-" + k); if (!host) return;
      host.innerHTML = "";
      // Normalize any legacy name-keyed rows, then drop rows whose exercise
      // left the pool (equipment change / removal).
      state.cfg.manual[k].forEach(it => {
        if (it.id == null && it.name != null) { it.id = state.nameToId[it.name]; delete it.name; }
      });
      const kept = state.cfg.manual[k].filter(it => inPool[it.id]);
      if (kept.length !== state.cfg.manual[k].length) { state.cfg.manual[k] = kept; saveConfig(); }
      const items = state.cfg.manual[k];
      items.forEach((it, i) => {
        const ex = inPool[it.id];
        // Un-pair rows whose previous row is itself paired (an element only
        // holds two exercises).
        if (it.pair && (i === 0 || items[i - 1].pair)) it.pair = false;
        const row = el("div", "mk-row");
        if (it.pair) row.classList.add("paired");
        const sel = document.createElement("select");
        sel.className = "mk-select";
        pool.forEach(e => {
          const op = document.createElement("option");
          op.value = e.id; op.textContent = e.name; op.selected = e.id === it.id;
          sel.appendChild(op);
        });
        sel.onchange = () => { it.id = sel.value; it.kg = null; saveConfig(); renderBuilder(); };
        row.appendChild(sel);
        const ctl = el("div", "mk-ctl");
        const stepper = (label, get, set, min, max, step, cls) => {
          const wrap = el("div", "mk-step");
          const dec = el("button", "kg-adj", "−");
          const val = el("span", "mk-val" + (cls ? " " + cls : ""), get() + label);
          const inc = el("button", "kg-adj", "+");
          const upd = d => {
            set(Math.max(min, Math.min(max, get() + d)));
            val.textContent = get() + label; val.classList.remove("mk-kg-sug");
            saveConfig();
          };
          dec.onclick = () => upd(-(step || 1)); inc.onclick = () => upd(step || 1);
          wrap.appendChild(dec); wrap.appendChild(val); wrap.appendChild(inc);
          return wrap;
        };
        ctl.appendChild(stepper("x", () => it.sets, v => { it.sets = v; }, 1, 8));
        ctl.appendChild(stepper(" reps", () => it.reps, v => { it.reps = v; }, 1, 30));
        // Weight: only kettlebell movements carry a kg. Dimmed while it is
        // still the suggestion; the first nudge makes it the row's own choice.
        if (ex.equipment.includes("KB")) {
          ctl.appendChild(stepper(" kg",
            () => mkEffKg(it, ex),
            v => { it.kg = v; },
            state.cfg.weightMin, state.cfg.weightMax, 2,
            it.kg == null ? "mk-kg-sug" : ""));
        }
        if (i > 0 && !items[i - 1].pair) {
          const pairBtn = el("button", "chip mk-pair", "⇄ superserie");
          pairBtn.setAttribute("aria-pressed", String(!!it.pair));
          pairBtn.title = "En superserie con el anterior";
          pairBtn.onclick = () => { it.pair = !it.pair; saveConfig(); renderBuilder(); };
          ctl.appendChild(pairBtn);
        }
        const rm = el("button", "icon-btn del mk-rm", "✕");
        a11y(rm, "Quitar");
        rm.onclick = () => { items.splice(i, 1); saveConfig(); renderBuilder(); };
        ctl.appendChild(rm);
        row.appendChild(ctl);
        host.appendChild(row);
      });
      if (!items.length && mkPicker.block !== k)
        host.appendChild(el("div", "pin-empty", "Vacío: este bloque no saldrá en la rutina."));
      if (F.TEMPLATES[state.cfg.manualObjective] && !mkObjSchema(k))
        host.appendChild(el("div", "pin-empty", "El objetivo declarado no suele usar este bloque."));
      // Searchable picker, opened by "+ Anadir a <block>".
      if (mkPicker.block === k) host.appendChild(renderMkPicker(k, pool));
    });
  }

  // Picker panel: search input + tappable chips of matching exercises.
  // Typing only refreshes the chip list (not the whole builder) so the input
  // keeps focus while the trainee narrows the search.
  function renderMkPicker(k, pool) {
    const panel = el("div", "mk-pick");
    const input = document.createElement("input");
    input.type = "text"; input.placeholder = "Buscar por nombre, patrón, tag…";
    input.autocomplete = "off"; input.className = "mk-pick-search";
    input.value = mkPicker.text;
    panel.appendChild(input);
    const wrap = el("div", "chips mk-pick-chips");
    const fill = () => {
      wrap.innerHTML = "";
      const hits = pool.filter(e => !isPaused(e.id) && matchesQuery(e, mkPicker.text));
      if (!hits.length) { wrap.appendChild(el("div", "pin-empty", "Sin resultados.")); return; }
      // Declared objective: exercises fitting this block's template schema
      // are recommended (★) and ranked first; the rest stay available.
      const sch = mkObjSchema(k);
      const rec = e => !!(sch && sch.dynamics.has(e.dynamics));
      if (sch) hits.sort((a, b) => (rec(b) ? 1 : 0) - (rec(a) ? 1 : 0));
      hits.forEach(e => {
        const isRec = rec(e);
        const c = el("button", "chip" + (isRec ? " mk-rec" : ""), (isRec ? "★ " : "") + esc(e.name));
        if (isRec) c.title = "Encaja con el objetivo declarado";
        c.onclick = () => {
          const d = mkDefaults(k);
          state.cfg.manual[k].push({ id: e.id, sets: d.sets, reps: d.reps, pair: false, kg: null });
          mkPicker.block = null; mkPicker.text = "";
          saveConfig(); renderBuilder();
        };
        wrap.appendChild(c);
      });
    };
    input.oninput = () => { mkPicker.text = input.value; fill(); };
    fill();
    panel.appendChild(wrap);
    try { setTimeout(() => input.focus(), 0); } catch (e) {}
    return panel;
  }

  function composeManual() {
    const entries = [];
    ["A", "B", "C"].forEach(k => state.cfg.manual[k].forEach(it => {
      const e = state.byId[it.id != null ? it.id : state.nameToId[it.name]];
      if (e) entries.push({ exercise: e, block: k, sets: it.sets, reps: it.reps, pair: it.pair });
    }));
    if (!entries.length) { toast("Añade al menos un ejercicio a la rutina"); return; }
    // Weights chosen in the builder become the dialed kg for those exercises,
    // so the rendered routine, the timer and the progression all use them.
    let kgTouched = false;
    ["A", "B", "C"].forEach(k => state.cfg.manual[k].forEach(it => {
      if (it.kg != null && state.byId[it.id]) { state.kg[it.id] = it.kg; kgTouched = true; }
    }));
    if (kgTouched) saveKg();
    const r = F.composeRoutine(entries);
    // Objective: the DECLARED one wins; otherwise detect what the composition
    // resembles. Either way the scrutiny audits against that objective's
    // fatigue budgets and the profile travels with the routine (History
    // label + later audits). With a declared objective, inference doubles as
    // a coherence check inside the audit (opts.declared).
    const declared = F.TEMPLATES[state.cfg.manualObjective] ? state.cfg.manualObjective : null;
    r.inferred = F.inferObjective(r);
    r.declared = declared;
    const capKey = declared || r.inferred.objective;
    const tpl = capKey ? F.TEMPLATES[capKey] : null;
    const opts = tpl ? { maxCns: tpl.maxCns, maxGrip: tpl.maxGrip } : {};
    opts.pool = filteredPool();
    if (declared) opts.declared = declared;
    state.routine = r;
    state.routineSource = "manual";
    state.loadedObjective = null;
    state.pendingProgram = null;
    state.lastSavedId = null;   // a freshly composed routine is not yet in history
    renderRoutine(r, $("#routine-out"), { min: state.cfg.weightMin, max: state.cfg.weightMax }, true);
    renderAudit(F.auditRoutine(r, opts), $("#audit-out"),
      { declared, inferred: r.inferred, assessment: capKey ? F.assessObjective(r, capKey) : null });
    $("#btn-regenerar").classList.add("hidden");   // nothing to regenerate by hand
    $("#save-row").classList.remove("hidden");
    saveConfig();
    scrollToRoutine();
  }

  // ---- Render: scrutiny (audit) of a routine
  const AUDIT_ICON = { error: "✕", warn: "!", tip: "·" };
  // `profile` (optional, hand-built routines): { declared, inferred } — the
  // objective the audit budgets came from, stated by the trainee or detected.
  function renderAudit(a, host, profile) {
    host.innerHTML = "";
    const card = el("div", "card audit-card");
    const head = el("div", "audit-head");
    head.appendChild(el("div", "label", "Escrutinio"));
    const badge = el("div", "audit-score " +
      (a.score >= 90 ? "aud-ok" : a.score >= 45 ? "aud-mid" : "aud-bad"),
      a.score + "/100 · " + a.verdict);
    head.appendChild(badge);
    card.appendChild(head);
    card.appendChild(el("div", "audit-stats",
      `~${a.stats.minutes} min · ${a.stats.exercises} ejercicios · SNC alta ${a.stats.highCns} · agarre ${a.stats.grip}`));
    if (profile !== undefined) {
      const inf = profile && profile.inferred;
      const txt = profile && profile.declared
        ? "Objetivo declarado: <b>" + (OBJ_LABEL[profile.declared] || esc(profile.declared)) + "</b> · auditada con sus presupuestos"
        : inf && inf.objective
        ? "Perfil detectado: <b>" + (OBJ_LABEL[inf.objective] || esc(inf.objective)) + "</b> (" +
          Math.round(inf.score * 100) + "% coincidencia) · auditada con los presupuestos de ese objetivo"
        : "Perfil mixto: sin objetivo claro; auditada con presupuestos genéricos.";
      card.appendChild(el("div", "audit-infer", txt));
    }
    if (!a.findings.length) {
      card.appendChild(el("div", "audit-clean", "Sin objeciones: estructura sólida según las reglas del motor."));
    } else {
      const ul = el("div", "audit-list");
      a.findings.forEach(f => {
        const row = el("div", "audit-item aud-" + f.level);
        row.appendChild(el("span", "audit-ico", AUDIT_ICON[f.level] || "·"));
        row.appendChild(el("span", "audit-msg", (f.block ? "[" + f.block + "] " : "") + esc(f.msg)));
        ul.appendChild(row);
      });
      card.appendChild(ul);
    }
    // Prescriptive follow-up: concrete fixes from the engine (only present
    // when there is something to fix and the pool offers an alternative).
    if (a.suggestions && a.suggestions.length) {
      card.appendChild(el("div", "label audit-sug-label", "Sugerencias"));
      const ul = el("div", "audit-list");
      a.suggestions.forEach(s => {
        const row = el("div", "audit-item aud-sug");
        row.appendChild(el("span", "audit-ico", "→"));
        row.appendChild(el("span", "audit-msg", esc(s)));
        ul.appendChild(row);
      });
      card.appendChild(ul);
    }
    // Objective assessment: why the routine serves (or not) its goal, with
    // global adjustments to steer it there (reps/weight/dynamics/blocks).
    if (profile && profile.assessment) {
      const as = profile.assessment;
      card.appendChild(el("div", "label audit-sug-label", "Para " + (OBJ_LABEL[as.objective] || esc(as.name))));
      const ul = el("div", "audit-list");
      as.strengths.forEach(s => {
        const row = el("div", "audit-item aud-good");
        row.appendChild(el("span", "audit-ico", "✓"));
        row.appendChild(el("span", "audit-msg", esc(s)));
        ul.appendChild(row);
      });
      as.adjustments.forEach(s => {
        const row = el("div", "audit-item aud-adj");
        row.appendChild(el("span", "audit-ico", "↗"));
        row.appendChild(el("span", "audit-msg", esc(s)));
        ul.appendChild(row);
      });
      card.appendChild(ul);
    }
    host.appendChild(card);
  }

  // Plain-language summary of how today's readiness will bend the session,
  // plus an objective suggestion when energy is low but a heavy goal is set.
  function updateReadinessHint() {
    const c = state.cfg, f = F.readinessFactors(c.readiness);
    const host = $("#readiness-hint");
    if (!host) return;
    const parts = [];
    if (f.level === "low") {
      parts.push("Día flojo: menos volumen y cargas más suaves.");
      if (c.objective === "STRENGTH" || c.objective === "POWER")
        parts.push("Quizá hoy rinda más un día metabólico o de técnica que ir a fuerza máxima.");
    } else if (f.level === "high") {
      parts.push("Buen día: algo más de volumen y permiso para cargar.");
    }
    if (c.readiness.sore && c.readiness.sore.length) parts.push("Aliviamos las zonas doloridas.");
    host.innerHTML = parts.join(" ");
    host.classList.toggle("hidden", parts.length === 0);
  }

  function applyFocusUI() {
    const has = state.cfg.focus.length > 0;
    // Soft emphasis keeps balance on; only a HARD focus disables it.
    const hardOff = has && !state.cfg.focusSoft;
    $("#card-balance").classList.toggle("disabled", hardOff);
    $("#balance-note").classList.toggle("hidden", !hardOff);
    const w = $("#focus-mode-wrap"); if (w) w.classList.toggle("hidden", !has);
  }
  function applyVolumeUI() {
    const isStructure = state.cfg.volumeMode === "structure";
    $("#vol-time").classList.toggle("hidden", isStructure);
    $("#vol-structure").classList.toggle("hidden", !isStructure);
  }
  function updatePinnedCount() {
    const n = state.cfg.pinned.length;
    $("#pin-count").textContent = n ? "(" + n + ")" : "";
  }
  function prunePinned() {
    const valid = new Set(filteredPool().map(e => e.id));
    state.cfg.pinned = state.cfg.pinned.filter(f => valid.has(f.id));
  }
  const pinnedIndex = id => state.cfg.pinned.findIndex(f => f.id === id);
  // Exercises matching the equipment AND the active tag filters.
  function pinPoolFiltered() {
    return filteredPool().filter(e =>
      !isPaused(e.id) &&
      (!pinFilter.pattern.length  || pinFilter.pattern.includes(e.pattern)) &&
      (!pinFilter.dynamics.length || pinFilter.dynamics.includes(e.dynamics)) &&
      (!pinFilter.tier.length     || pinFilter.tier.includes(e.tier)));
  }

  function renderPinFilters() {
    const host = $("#pin-filters"); host.innerHTML = "";
    const groups = [
      { key: "pattern",  label: "Patrón",   labels: F.PAT_LABEL },
      { key: "dynamics", label: "Dinámica", labels: F.DIN_LABEL },
      { key: "tier",     label: "Tier",     labels: F.TIER_LABEL },
    ];
    groups.forEach(g => {
      // Only show values present in the current (equipment-filtered) pool.
      const present = new Set(filteredPool().map(e => e[g.key]));
      const vals = Object.keys(g.labels).filter(v => present.has(v));
      if (!vals.length) return;
      host.appendChild(el("div", "label pin-filter-label", g.label));
      const row = el("div", "chips pin-filter-row");
      vals.forEach(v => {
        const c = el("button", "chip filter-chip", g.labels[v]);
        c.setAttribute("aria-pressed", String(pinFilter[g.key].includes(v)));
        c.onclick = () => {
          const i = pinFilter[g.key].indexOf(v);
          if (i >= 0) pinFilter[g.key].splice(i, 1); else pinFilter[g.key].push(v);
          renderPinned();
        };
        row.appendChild(c);
      });
      host.appendChild(row);
    });
  }

  function renderPinned() {
    renderPinFilters();
    const wrap = $("#pin-chips"); wrap.innerHTML = "";
    const list = pinPoolFiltered().slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) wrap.appendChild(el("div", "pin-empty", "Ningún ejercicio coincide con los filtros."));
    list.forEach(e => {
      const b = el("button", "chip fijado", esc(e.name));
      b.setAttribute("aria-pressed", String(pinnedIndex(e.id) >= 0));
      b.onclick = () => {
        const i = pinnedIndex(e.id);
        if (i >= 0) state.cfg.pinned.splice(i, 1); else state.cfg.pinned.push({ id: e.id, block: "AUTO" });
        updatePinnedCount(); saveConfig(); renderPinned();
      };
      wrap.appendChild(b);
    });
    // Block assignment for each pinned exercise
    const asig = $("#pin-assigned"); asig.innerHTML = "";
    if (state.cfg.pinned.length) {
      asig.appendChild(el("div", "label", "Orden y bloque de cada fijado"));
      const move = (i, dir) => {
        const j = i + dir;
        if (j < 0 || j >= state.cfg.pinned.length) return;
        const p = state.cfg.pinned;
        [p[i], p[j]] = [p[j], p[i]];
        saveConfig(); renderPinned();
      };
      state.cfg.pinned.forEach((f, i) => {
        const row = el("div", "est-row");
        const left = el("div", "pin-asig-left");
        const ord = el("div", "pin-order");
        const up = el("button", "kg-adj", "▲"); a11y(up, "Subir"); up.disabled = i === 0; up.onclick = () => move(i, -1);
        const dn = el("button", "kg-adj", "▼"); a11y(dn, "Bajar"); dn.disabled = i === state.cfg.pinned.length - 1; dn.onclick = () => move(i, 1);
        ord.appendChild(up); ord.appendChild(dn);
        left.appendChild(ord);
        left.appendChild(el("span", "pin-asig-name", esc((state.byId[f.id] || { name: f.name || f.id }).name)));
        row.appendChild(left);
        const sel = document.createElement("select");
        ["AUTO", "A", "B", "C"].forEach(o => { const op = document.createElement("option"); op.value = o; op.textContent = o === "AUTO" ? "Auto" : "Bloque " + o; if (f.block === o) op.selected = true; sel.appendChild(op); });
        sel.style.cssText = "padding:6px 8px;border-radius:8px;border:1px solid var(--line-2);background:var(--bg-2);color:var(--ink);font-size:13px;";
        sel.onchange = () => { f.block = sel.value; saveConfig(); };
        row.appendChild(sel);
        asig.appendChild(row);
      });
    }
  }

  // Save the live routine to history. `extra` lets the timer attach outcome
  // fields ({ completed, performed }) in the same entry. Remembering the id
  // means a later timer run updates THIS entry instead of duplicating it.
  function saveToHistory(extra) {
    if (!state.routine) return null;
    const r = state.routine;
    const entry = Object.assign({
      id: nextId(),
      date: new Date().toISOString(),
      // A repeated session / loaded template records ITS objective, not the
      // current config; a freshly generated one uses the config objective.
      objective: state.routineSource === "manual" ? "MANUAL"
        : (state.loadedObjective || state.cfg.objective),
      minutes: state.cfg.minutes, balance: state.cfg.balance,
      duration: F.routineDurationMin(r), routine: r, completed: false, range: { min: state.cfg.weightMin, max: state.cfg.weightMax },
    }, extra || {});
    // A program day: tag the session with its slot and advance the cursor
    // (advance by sessions done, not calendar — see methodology §5).
    if (state.pendingProgram) {
      entry.program = state.pendingProgram;
      advanceProgram();
      state.pendingProgram = null;
      renderProgram();
    }
    state.hist.unshift(entry);
    state.lastSavedId = entry.id;
    saveHistory(); renderHistory();
    return entry;
  }

  const repsToText = sets => sets.join(" ");
  const textToReps = t => (t.match(/\d+/g) || []).map(Number);

  // ---- Render: a manually-imported session (per-set log)
  function renderManualCard(h) {
    const exVol = ex => (ex.kg || 0) * ex.sets.reduce((a, n) => a + n, 0);
    const totalVol = Math.round(h.exercises.reduce((a, ex) => a + exVol(ex), 0));
    const editing = manualEditId === h.id;
    const card = el("div", "card"); card.style.padding = "0";
    const row = el("div", "hist-item");
    const meta = el("div", "hist-meta");
    const d = new Date(h.date);
    const dateStr = d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
    meta.appendChild(el("div", "hist-title", "Registro · " + dateStr));
    meta.appendChild(el("div", "hist-sub", `${h.exercises.length} ejercicios · volumen ${totalVol} kg`));
    meta.style.cursor = "pointer";
    const detail = el("div"); detail.style.padding = "0 14px 14px";
    if (!editing) detail.classList.add("hidden");
    meta.onclick = () => { if (!editing) detail.classList.toggle("hidden"); };

    if (editing) detail.appendChild(renderManualEditor(h));
    else h.exercises.forEach((ex, i) => {
      if (i === 0 || ex.order !== h.exercises[i - 1].order) {
        if (ex.order) detail.appendChild(el("div", "label", esc(ex.order)));
      }
      const item = el("div", "manual-ex");
      const top = el("div", "manual-ex-top");
      top.appendChild(el("span", "manual-ex-name", esc(ex.name)));
      if (ex.kg != null) top.appendChild(el("span", "manual-ex-kg", ex.kg + " kg"));
      item.appendChild(top);
      const reps = ex.sets.reduce((a, n) => a + n, 0);
      const series = ex.sets.length ? ex.sets.join(" · ") : "—";
      item.appendChild(el("div", "manual-ex-sets", `Series: ${series}  ·  ${reps} reps  ·  ${Math.round(exVol(ex))} kg`));
      if (ex.note) item.appendChild(el("div", "manual-ex-note", esc(ex.note)));
      detail.appendChild(item);
    });

    const actions = el("div", "hist-actions");
    if (editing) {
      const save = el("button", "icon-btn on", "✓"); a11y(save, "Guardar cambios");
      save.onclick = () => { manualEditId = null; saveHistory(); renderHistory(); toast("Registro actualizado"); };
      actions.appendChild(save);
    } else {
      const edit = el("button", "icon-btn", "✎"); a11y(edit, "Editar registro");
      edit.onclick = () => { manualEditId = h.id; renderHistory(); };
      const okBtn = el("button", "icon-btn" + (h.completed ? " on" : ""), "✓");
      a11y(okBtn, "Marcar completada");
      okBtn.onclick = () => { h.completed = !h.completed; saveHistory(); renderHistory(); };
      actions.appendChild(edit); actions.appendChild(okBtn);
    }
    const del = el("button", "icon-btn del", "✕"); a11y(del, "Eliminar");
    del.onclick = () => { manualEditId = null; state.hist = state.hist.filter(x => x.id !== h.id); saveHistory(); renderHistory(); toast("Sesión eliminada"); };
    actions.appendChild(del);
    row.appendChild(meta); row.appendChild(actions);
    card.appendChild(row); card.appendChild(detail);
    return card;
  }

  // Inline editor for a manual session: date, and per-exercise order, name,
  // kg, per-set reps and note. Mutates h directly (live bound to inputs).
  function renderManualEditor(h) {
    const wrap = el("div", "manual-edit");
    const inp = (val, ph, cls) => { const n = document.createElement("input"); n.type = "text"; n.value = val == null ? "" : val; if (ph) n.placeholder = ph; n.className = "manual-input " + (cls || ""); return n; };

    const dateRow = el("div", "manual-edit-row");
    dateRow.appendChild(el("span", "manual-edit-lbl", "Fecha"));
    const dateInp = document.createElement("input"); dateInp.type = "date";
    // Local Y-M-D (not toISOString, which is UTC and shifts the day for
    // timezones behind UTC, drifting the date on round-trip).
    const ld = new Date(h.date);
    dateInp.value = `${ld.getFullYear()}-${String(ld.getMonth() + 1).padStart(2, "0")}-${String(ld.getDate()).padStart(2, "0")}`;
    dateInp.className = "manual-input";
    dateInp.onchange = () => { const v = dateInp.value; if (v) h.date = new Date(v + "T12:00:00").toISOString(); };
    dateRow.appendChild(dateInp);
    wrap.appendChild(dateRow);

    h.exercises.forEach(ex => {
      const box = el("div", "manual-edit-ex");
      const name = inp(ex.name, "Ejercicio", "name"); name.oninput = () => { ex.name = name.value; };
      box.appendChild(name);
      const grid = el("div", "manual-edit-grid");
      const order = inp(ex.order, "Bloque / orden"); order.oninput = () => { ex.order = order.value; };
      const kg = inp(ex.kg, "kg"); kg.inputMode = "decimal"; kg.oninput = () => { const n = parseFloat(kg.value.replace(",", ".")); ex.kg = isNaN(n) ? null : n; };
      grid.appendChild(order); grid.appendChild(kg);
      box.appendChild(grid);
      const reps = inp(repsToText(ex.sets), "Reps por serie (ej. 16 10 10)");
      reps.oninput = () => { ex.sets = textToReps(reps.value); };
      box.appendChild(reps);
      const note = inp(ex.note, "Notas"); note.oninput = () => { ex.note = note.value; };
      box.appendChild(note);
      const rm = el("button", "manual-rm", "Quitar ejercicio");
      rm.onclick = () => { h.exercises = h.exercises.filter(x => x !== ex); renderHistory(); };
      box.appendChild(rm);
      wrap.appendChild(box);
    });

    const add = el("button", "btn btn-ghost", "+ Añadir ejercicio");
    add.style.cssText = "margin-top:8px;padding:9px;font-size:13px;";
    add.onclick = () => {
      const last = h.exercises[h.exercises.length - 1];
      h.exercises.push({ order: last ? last.order : "", name: "", kg: last ? last.kg : null, sets: [], note: "" });
      renderHistory();
    };
    wrap.appendChild(add);
    return wrap;
  }

  // ---- Progress stats ---------------------------------------------------
  // Estimated tonnage (kg lifted) for a session, used for the trend chart.
  // Manual sessions log real kg + reps; generated sessions are estimated from
  // the user's last/suggested kg per exercise.
  function sessionVolume(h) {
    if (h.manual) {
      return Math.round(h.exercises.reduce((a, ex) => a + (ex.kg || 0) * ex.sets.reduce((x, n) => x + n, 0), 0));
    }
    // Generated session trained through the timer: real logged sets beat the
    // plan-based estimate below.
    if (Array.isArray(h.performed) && h.performed.length) {
      return Math.round(h.performed.reduce((a, ex) => a + (ex.kg || 0) * ex.sets.reduce((x, n) => x + n, 0), 0));
    }
    if (!h.routine) return 0;
    const range = h.range || { min: state.cfg.weightMin, max: state.cfg.weightMax };
    let vol = 0;
    h.routine.blocks.forEach(b => b.elements.forEach(elm => elm.prescriptions.forEach(p => {
      const id = exId(p.exercise);
      // Prefer the per-exercise kg; fall back to a shared circuit weight
      // (same-weight mode), then to the engine suggestion.
      const kg = state.kg[id] != null ? state.kg[id]
        : state.kg["__sw:" + p.block] != null ? state.kg["__sw:" + p.block]
        : (F.suggestKg(p.exercise.load, range.min, range.max, state.cfg.profile, p.exercise, p.reps) || 0);
      vol += kg * p.sets * p.reps;
    })));
    return Math.round(vol);
  }

  // Estimated-strength panel: current e1RM per tracked exercise, with the
  // change since the first logged point. A coarse but motivating "are my
  // numbers moving?" readout. Grinds only (see computeE1rm).
  function renderE1rmPanel(host) {
    const map = computeE1rm();
    const names = Object.keys(map).sort((a, b) => map[b].current - map[a].current);
    if (!names.length) return;
    const card = el("div", "card stats-card");
    card.appendChild(el("div", "label", "Fuerza estimada · e1RM"));
    card.appendChild(el("div", "e1rm-note",
      "Tu 1RM estimado (el peso que moverías una sola vez) por ejercicio, a partir de tus series. Es una estimación, no un máximo real."));
    const list = el("div", "e1rm-list");
    names.forEach(key => {
      const e = map[key];
      const cur = Math.round(e.current);
      const delta = Math.round(e.current - e.first);
      const row = el("div", "e1rm-row");
      // Keys are exercise ids; e.name carries the current display name.
      row.appendChild(el("span", "e1rm-name", esc(e.name || key)));
      const val = el("span", "e1rm-val", cur + " kg");
      if (e.n >= 2 && delta !== 0) {
        const up = delta > 0;
        val.appendChild(el("span", "e1rm-trend " + (up ? "up" : "down"),
          (up ? " ▲ +" : " ▼ ") + delta + " kg"));
      }
      row.appendChild(val);
      list.appendChild(row);
    });
    card.appendChild(list);
    host.appendChild(card);
  }

  function renderStats() {
    const host = $("#hist-stats"); host.innerHTML = "";
    renderE1rmPanel(host);
    if (state.hist.length < 2) return;   // not enough data for the volume trend
    const card = el("div", "card stats-card");
    card.appendChild(el("div", "label", "Progreso · volumen por sesión"));

    // Oldest -> newest, last 12 sessions.
    const series = state.hist.slice(0, 12).map(h => ({ vol: sessionVolume(h), date: new Date(h.date), done: !!h.completed })).reverse();
    const max = Math.max(1, ...series.map(s => s.vol));
    const W = 320, H = 96, n = series.length, gap = 4;
    const bw = (W - gap * (n - 1)) / n;
    const svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" class="stats-svg" preserveAspectRatio="none">'];
    series.forEach((s, i) => {
      const bh = Math.max(2, Math.round((s.vol / max) * (H - 4)));
      const x = i * (bw + gap), y = H - bh;
      const fill = s.done ? "var(--forge)" : "var(--line-2)";
      svg.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${bh}" rx="2" fill="${fill}"><title>${s.date.toLocaleDateString("es-ES", { day: "2-digit", month: "short" })}: ${s.vol} kg</title></rect>`);
    });
    svg.push("</svg>");
    const chart = el("div", "stats-chart"); chart.innerHTML = svg.join("");
    card.appendChild(chart);

    // Summary figures: total sessions, completed, sessions in the last 7 days.
    const weekAgo = Date.now() - 7 * 864e5;
    const week = state.hist.filter(h => new Date(h.date).getTime() >= weekAgo).length;
    const done = state.hist.filter(h => h.completed).length;
    const row = el("div", "stats-figs");
    const fig = (n2, lbl) => { const f = el("div", "stat-fig"); f.appendChild(el("div", "stat-num", String(n2))); f.appendChild(el("div", "stat-lbl", lbl)); return f; };
    row.appendChild(fig(state.hist.length, "sesiones"));
    row.appendChild(fig(done, "completadas"));
    row.appendChild(fig(week, "últ. 7 días"));
    card.appendChild(row);
    host.appendChild(card);
  }

  // ---- Edit a saved routine: per-prescription sets / reps / kg ----------
  // Edits persist on the SESSION (h.routine), not on the global kg memory:
  // the trainee is correcting what that day should look like, not their
  // current working weight. The per-session kg (p.kg) wins over the memory
  // in the read-only render, and edited reps win over the progression
  // target in the guided timer. Work happens on a deep clone so Cancelar
  // discards cleanly.
  function renderRoutineEditor(h, host) {
    const range = h.range || { min: state.cfg.weightMin, max: state.cfg.weightMax };
    const draft = JSON.parse(JSON.stringify(h.routine));
    // paint() redraws the whole editor from the SAME draft, so swapping an
    // exercise (which can add/remove the reps stepper or the kg control)
    // keeps every other pending edit.
    const paint = () => {
      host.innerHTML = "";
      const pool = filteredPool().filter(e => !isPaused(e.id)).sort((a, b) => a.name.localeCompare(b.name));
      host.appendChild(el("div", "label", "Editar rutina · ejercicio, series, reps y kg"));
      draft.blocks.forEach((br, bi) => {
        const bhead = el("div", "red-block-head");
        bhead.appendChild(el("div", "label red-block", "Bloque " + br.block));
        const delBlk = el("button", "icon-btn del", "✕"); a11y(delBlk, "Borrar bloque entero");
        delBlk.onclick = () => { draft.blocks.splice(bi, 1); paint(); };
        bhead.appendChild(delBlk);
        host.appendChild(bhead);
        if (!br.elements.length) host.appendChild(el("div", "pin-empty", "Bloque vacío (se quitará al guardar)."));
        br.elements.forEach((elm, ei) => elm.prescriptions.forEach((p, pi) => {
          const row = el("div", "red-row");
          // Exercise swap: any pool exercise; the current one stays listed
          // even if it has since left the pool.
          const sel = document.createElement("select");
          sel.className = "mk-select";
          const names = pool.map(e => e.name);
          if (names.indexOf(p.exercise.name) < 0) names.unshift(p.exercise.name);
          names.forEach(n => {
            const op = document.createElement("option");
            op.value = n; op.textContent = n; op.selected = n === p.exercise.name;
            sel.appendChild(op);
          });
          sel.onchange = () => {
            const def = pool.find(e => e.name === sel.value);
            if (!def) return;
            p.exercise = clone(def);
            p.kg = null;          // the old weight belongs to the old exercise
            p.edited = true;
            // The pairing verdict refers to the old exercise: re-judge it.
            if (elm.prescriptions.length === 2) {
              const res = F.validateCombination(elm.prescriptions[0], elm.prescriptions[1]);
              elm.quality = res.quality;
              elm.note = "Editada por ti · " + res.reasons.join(" | ");
            } else {
              elm.note = "Editada por ti.";
            }
            paint();
          };
          row.appendChild(sel);
          const ctl = el("div", "mk-ctl");
          const stepper = (cls, label, get, set, min, max, step) => {
            const wrap = el("div", "mk-step " + cls);
            const dec = el("button", "kg-adj", "−");
            const val = el("span", "mk-val", get() + label);
            const inc = el("button", "kg-adj", "+");
            const upd = d2 => { set(Math.max(min, Math.min(max, get() + d2))); val.textContent = get() + label; };
            dec.onclick = () => upd(-step); inc.onclick = () => upd(step);
            wrap.appendChild(dec); wrap.appendChild(val); wrap.appendChild(inc);
            return wrap;
          };
          ctl.appendChild(stepper("red-sets", "x", () => p.sets, v => { p.sets = v; p.edited = true; }, 1, 8, 1));
          if (p.exercise.dynamics !== F.DIN.ISO)
            ctl.appendChild(stepper("red-reps", " reps", () => p.reps, v => { p.reps = v; p.edited = true; }, 1, 30, 1));
          if (p.exercise.equipment.includes("KB")) {
            const effKg = () => p.kg != null ? p.kg
              : state.kg[exId(p.exercise)] != null ? state.kg[exId(p.exercise)]
              : (F.suggestKg(p.exercise.load, range.min, range.max, state.cfg.profile, p.exercise) || range.min);
            ctl.appendChild(stepper("red-kg", " kg", effKg, v => { p.kg = v; }, range.min, range.max, 2));
          }
          // Remove this exercise: from a superset it drops to a single (re-
          // judged); a lone exercise removes its whole element.
          const rm = el("button", "icon-btn del red-rm", "✕"); a11y(rm, "Quitar ejercicio");
          rm.onclick = () => {
            if (elm.prescriptions.length === 2) {
              elm.prescriptions.splice(pi, 1);
              elm.isSuperset = false;
              elm.quality = F.QUALITY.ACCEPTABLE;
              elm.note = "Editada por ti.";
            } else {
              br.elements.splice(ei, 1);
            }
            paint();
          };
          ctl.appendChild(rm);
          row.appendChild(ctl);
          host.appendChild(row);
        }));
      });
      const btns = el("div", "btn-row"); btns.style.marginTop = "12px";
      const cancel = el("button", "btn btn-ghost", "Cancelar");
      cancel.onclick = () => renderHistory();
      const save = el("button", "btn btn-forge", "Guardar cambios");
      save.onclick = () => {
        // Drop blocks left empty by deletions; a routine can't be empty.
        draft.blocks = draft.blocks.filter(b => b.elements.length);
        if (!draft.blocks.length) { toast("La rutina no puede quedar vacía"); return; }
        // Swaps may have changed the lead ballistic: refresh the warm-up.
        draft.warmup = F.buildWarmup(draft.blocks);
        h.routine = draft;
        h.duration = F.routineDurationMin(draft);
        saveHistory(); renderHistory(); toast("Rutina actualizada");
      };
      btns.appendChild(cancel); btns.appendChild(save);
      host.appendChild(btns);
    };
    paint();
  }

  // ---- Render: history
  // Relative age of a date in plain Spanish ("hoy", "ayer", "hace 3 días",
  // "hace 2 sem", "hace 5 meses"). Purely cosmetic, paired with the date.
  function relTime(d) {
    const days = Math.floor((Date.now() - d.getTime()) / 864e5);
    if (days <= 0) return "hoy";
    if (days === 1) return "ayer";
    if (days < 14) return "hace " + days + " días";
    if (days < 60) return "hace " + Math.floor(days / 7) + " sem";
    return "hace " + Math.floor(days / 30) + " meses";
  }

  // History status filter (UI-only, not persisted).
  let histFilter = "all";   // all | done | pending
  function histMatches(h) {
    if (histFilter === "done") return !!h.completed;
    if (histFilter === "pending") return !h.completed;
    return true;
  }
  function renderHistFilter() {
    const host = $("#hist-filter"); if (!host) return;
    host.innerHTML = "";
    [["all", "Todas"], ["pending", "Pendientes"], ["done", "Completadas"]].forEach(([v, label]) => {
      const c = el("button", "chip filter-chip", label);
      c.setAttribute("aria-pressed", String(histFilter === v));
      c.onclick = () => { histFilter = v; renderHistory(); };
      host.appendChild(c);
    });
  }

  function renderHistory() {
    renderStats();
    renderTemplates();
    renderHistFilter();
    const list = $("#hist-list"); list.innerHTML = "";
    if (!state.hist.length) {
      list.appendChild(el("div", "empty", "<b>Sin sesiones todavía</b>Genera una rutina y guárdala para llevar el registro."));
      return;
    }
    const shown = state.hist.filter(histMatches);
    if (!shown.length) {
      list.appendChild(el("div", "empty", "<b>Nada aquí</b>Ninguna sesión coincide con el filtro."));
      return;
    }
    shown.forEach(h => {
      // One malformed entry (old backup, hand-edited file, shape drift) must
      // not blank the whole History view: render what loads, flag the rest.
      try {
        list.appendChild(h.manual ? renderManualCard(h) : renderGeneratedCard(h));
      } catch (e) {
        const card = el("div", "card");
        const row = el("div", "hist-item");
        row.appendChild(el("div", "hist-meta", "Sesión ilegible (datos incompletos)"));
        const actions = el("div", "hist-actions");
        const del = el("button", "icon-btn del", "✕"); a11y(del, "Eliminar");
        del.onclick = () => { state.hist = state.hist.filter(x => x !== h); saveHistory(); renderHistory(); toast("Sesión eliminada"); };
        actions.appendChild(del);
        row.appendChild(actions);
        card.appendChild(row); list.appendChild(card);
      }
    });
  }

  function renderGeneratedCard(h) {
      const card = el("div", "card");
      card.style.padding = "0";
      const row = el("div", "hist-item");
      const meta = el("div", "hist-meta");
      const d = new Date(h.date);
      const dateStr = d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) + " · " + relTime(d);
      let title = OBJ_LABEL[h.objective] || h.objective;
      // Manual sessions carry their profile: declared by the trainee, else
      // the one the engine detected.
      const hKey = h.objective === "MANUAL" && h.routine
        ? (h.routine.declared || (h.routine.inferred && h.routine.inferred.objective)) : null;
      if (hKey) title += " · " + (OBJ_LABEL[hKey] || hKey);
      meta.appendChild(el("div", "hist-title", esc(title)));
      // Entries restored from older backups may lack duration/balance.
      const subBits = [dateStr];
      if (h.program) subBits.push("sem " + h.program.week + (h.program.deload ? " · descarga" : ""));
      if (h.duration != null) subBits.push(`~${h.duration} min`);
      if (h.balance) subBits.push("balance " + String(h.balance).toLowerCase());
      meta.appendChild(el("div", "hist-sub", subBits.join(" · ")));
      meta.style.cursor = "pointer";
      const detail = el("div"); detail.style.padding = "0 14px 14px"; detail.classList.add("hidden");
      meta.onclick = () => {
        if (detail.classList.contains("hidden")) {
          renderRoutine(h.routine, detail, h.range);
          // Scrutinize later: audit any saved session on demand. Generated
          // sessions use their own objective's budgets; manual ones the
          // budgets of their detected profile (inferred on the fly for
          // sessions saved before inference existed).
          const auditBtn = el("button", "btn btn-ghost audit-btn", "Escrutinio");
          const auditHost = el("div");
          auditBtn.onclick = () => {
            const isManual = h.objective === "MANUAL";
            const declared = isManual && h.routine.declared && F.TEMPLATES[h.routine.declared]
              ? h.routine.declared : null;
            const inferred = isManual ? (h.routine.inferred || F.inferObjective(h.routine)) : undefined;
            const capKey = F.TEMPLATES[h.objective] ? h.objective
              : (declared || (inferred && inferred.objective));
            const tpl = capKey ? F.TEMPLATES[capKey] : null;
            const caps = tpl ? { maxCns: tpl.maxCns, maxGrip: tpl.maxGrip } : {};
            caps.pool = filteredPool();
            if (declared) caps.declared = declared;
            renderAudit(F.auditRoutine(h.routine, caps), auditHost, isManual
              ? { declared, inferred, assessment: capKey ? F.assessObjective(h.routine, capKey) : null }
              : undefined);
            auditBtn.classList.add("hidden");
          };
          detail.appendChild(auditBtn); detail.appendChild(auditHost);
          detail.classList.remove("hidden");
        }
        else detail.classList.add("hidden");
      };
      const actions = el("div", "hist-actions");
      const trainBtn = el("button", "icon-btn", "▶"); a11y(trainBtn, "Entrenar con temporizador");
      trainBtn.onclick = () => startTimer(h.routine, h);   // timer logs into this entry
      const repeatBtn = el("button", "icon-btn", "↻"); a11y(repeatBtn, "Repetir como rutina de hoy");
      repeatBtn.onclick = () => {
        const objective = h.objective === "MANUAL"
          ? null : (F.TEMPLATES[h.objective] ? h.objective : null);
        loadRoutine(h.routine, h.objective === "MANUAL" ? "manual" : "auto", objective);
        toast("Rutina cargada · ajústala, entrénala o guárdala");
      };
      const editRt = el("button", "icon-btn", "✎"); a11y(editRt, "Editar rutina");
      editRt.onclick = () => { renderRoutineEditor(h, detail); detail.classList.remove("hidden"); };
      const okBtn = el("button", "icon-btn" + (h.completed ? " on" : ""), "✓");
      a11y(okBtn, "Marcar completada");
      okBtn.onclick = () => { h.completed = !h.completed; saveHistory(); renderHistory(); };
      const del = el("button", "icon-btn del", "✕"); a11y(del, "Eliminar");
      del.onclick = () => { state.hist = state.hist.filter(x => x.id !== h.id); saveHistory(); renderHistory(); toast("Sesión eliminada"); };
      actions.appendChild(trainBtn); actions.appendChild(repeatBtn); actions.appendChild(editRt); actions.appendChild(okBtn); actions.appendChild(del);
      row.appendChild(meta); row.appendChild(actions);
      card.appendChild(row); card.appendChild(detail);
      return card;
  }

  // Searchable text of an exercise: the name PLUS its tag/category labels
  // (pattern, dynamics, tier, load, CNS, grip, plyo, equipment — Spanish
  // labels and raw enum keys), so a query like "balistico", "cadera" or
  // "fundamental" finds exercises by what they ARE, not only by name.
  function exerciseHaystack(e) {
    return deaccent([
      e.name,
      F.PAT_LABEL[e.pattern] || "", e.pattern,
      F.DIN_LABEL[e.dynamics] || "", e.dynamics,
      F.TIER_LABEL[e.tier] || "",
      F.LOAD_LABEL[e.load] ? "carga " + F.LOAD_LABEL[e.load] : "",
      "snc " + e.cns,
      e.grip ? "agarre" : "",
      e.plyo ? "pliometrico salto" : "",
      e.arms ? "brazos arms" : "",
      e.skill ? "tecnica skill" : "",
      e.equipment.join(" "),
    ].join(" "));
  }
  // Every whitespace-separated term must match somewhere in the haystack,
  // so "tiron balistico" narrows to ballistic pulls. Empty query matches all.
  function matchesQuery(e, text) {
    const hay = exerciseHaystack(e);
    return deaccent(text || "").split(/\s+/).filter(Boolean).every(t => hay.includes(t));
  }

  // Pool filtering: free-text (accent/case-insensitive) AND tag selections.
  function poolMatches(e) {
    if (!matchesQuery(e, poolFilter.text)) return false;
    if (poolFilter.pattern.length && !poolFilter.pattern.includes(e.pattern)) return false;
    if (poolFilter.dynamics.length && !poolFilter.dynamics.includes(e.dynamics)) return false;
    if (poolFilter.tier.length && !poolFilter.tier.includes(e.tier)) return false;
    return true;
  }
  function poolFilterCount() {
    return poolFilter.pattern.length + poolFilter.dynamics.length + poolFilter.tier.length;
  }
  function renderPoolFilters() {
    const host = $("#pool-filters"); host.innerHTML = "";
    const groups = [
      { key: "pattern", label: "Patrón", labels: F.PAT_LABEL },
      { key: "dynamics", label: "Dinámica", labels: F.DIN_LABEL },
      { key: "tier", label: "Tier", labels: F.TIER_LABEL },
    ];
    groups.forEach(g => {
      const present = new Set(state.pool.map(x => x[g.key]));
      const vals = Object.keys(g.labels).filter(v => present.has(v));
      if (!vals.length) return;
      host.appendChild(el("div", "label pin-filter-label", g.label));
      const rowf = el("div", "chips pin-filter-row");
      vals.forEach(v => {
        const c = el("button", "chip filter-chip", g.labels[v]);
        c.setAttribute("aria-pressed", String(poolFilter[g.key].includes(v)));
        c.onclick = () => {
          const i = poolFilter[g.key].indexOf(v);
          if (i >= 0) poolFilter[g.key].splice(i, 1); else poolFilter[g.key].push(v);
          renderPool();
        };
        rowf.appendChild(c);
      });
      host.appendChild(rowf);
    });
    const n = poolFilterCount();
    $("#pool-filter-count").textContent = n ? "(" + n + ")" : "";
  }

  // ---- Render: pool
  function renderPool() {
    renderPoolFilters();
    const list = $("#pool-list"); list.innerHTML = "";
    const all = state.pool.slice().sort((a, b) => a.pattern.localeCompare(b.pattern) || a.name.localeCompare(b.name));
    const sorted = all.filter(poolMatches);
    $("#pool-count").textContent = sorted.length === all.length
      ? all.length + " ejercicios"
      : sorted.length + " de " + all.length;
    if (!sorted.length) { list.appendChild(el("div", "empty", "<b>Sin resultados</b>Ajusta la búsqueda o los filtros.")); return; }
    sorted.forEach(e => {
      const card = el("div", "card"); card.style.padding = "0";
      const row = el("div", "pool-item");
      const st = el("div", "stripe"); st.style.background = STRIPE[e.pattern] || "#6b7280"; st.style.minHeight = "42px";
      row.appendChild(st);
      const body = el("div", "ex-body");
      body.appendChild(el("div", "ex-name", esc(e.name)));
      const tags = el("div", "pool-tags");
      tags.appendChild(el("span", "tag", F.PAT_LABEL[e.pattern]));
      tags.appendChild(el("span", "tag", F.DIN_LABEL[e.dynamics].split("/")[0]));
      if (e.tier === "FUNDAMENTAL") tags.appendChild(el("span", "tag tier-fund", "★ fundamental"));
      else if (e.tier === "OPTIONAL") tags.appendChild(el("span", "tag", "opcional"));
      tags.appendChild(el("span", "tag snc-" + e.cns, "SNC " + e.cns));
      if (e.grip) tags.appendChild(el("span", "tag", "agarre"));
      if (e.plyo) tags.appendChild(el("span", "tag tag-plyo", "pliométrico"));
      if (e.arms) tags.appendChild(el("span", "tag", "brazos"));
      tags.appendChild(el("span", "tag", "carga " + F.LOAD_LABEL[e.load].toLowerCase()));
      tags.appendChild(el("span", "tag", e.equipment.join("+")));
      if (state.overrides[e.id]) tags.appendChild(el("span", "tag", "editado"));
      if (isPaused(e.id)) { tags.appendChild(el("span", "tag tag-paused", "pausado")); row.classList.add("paused"); }
      body.appendChild(tags);
      row.appendChild(body);
      row.style.cursor = "pointer";
      row.onclick = () => openForEdit(e);
      const pauseBtn = el("button", "icon-btn" + (isPaused(e.id) ? " on" : ""), isPaused(e.id) ? "▶" : "⏸");
      a11y(pauseBtn, isPaused(e.id) ? "Reactivar (vuelve a la selección)" : "Pausar temporalmente (fuera de la selección)");
      pauseBtn.onclick = (ev) => { ev.stopPropagation(); togglePause(e.id); };
      row.appendChild(pauseBtn);
      const del = el("button", "icon-btn del", "✕"); a11y(del, "Quitar del pool");
      del.onclick = (ev) => {
        ev.stopPropagation();
        if (isBaseId(e.id)) { if (!state.removed.includes(e.id)) state.removed.push(e.id); }
        else { state.custom = state.custom.filter(x => x.id !== e.id); }
        state.cfg.pinned = state.cfg.pinned.filter(f => f.id !== e.id);
        state.paused = state.paused.filter(id => id !== e.id);
        computePool(); savePoolState(); savePaused(); saveConfig(); renderPool(); updatePinnedCount(); toast("Quitado del pool");
      };
      row.appendChild(del);
      card.appendChild(row); list.appendChild(card);
    });
  }

  function readForm() {
    const equipment = [];
    if ($("#f-eq-kb").checked) equipment.push(F.EQ.KB);
    if ($("#f-eq-barbell").checked) equipment.push(F.EQ.BARBELL);
    if ($("#f-eq-floor").checked) equipment.push(F.EQ.FLOOR);
    if (!equipment.length) equipment.push(F.EQ.FLOOR);
    return { pattern: $("#f-pattern").value, dynamics: $("#f-dynamics").value,
      symmetry: $("#f-symmetry").value, cns: $("#f-cns").value, equipment,
      grip: $("#f-grip").checked, plyo: $("#f-plyo").checked, arms: $("#f-arms").checked,
      skill: $("#f-skill").checked,
      load: parseInt($("#f-load").value, 10), tier: $("#f-tier").value };
  }
  // Coherence lint for user-defined metadata: non-blocking (the pool is the
  // trainee's to shape), but incoherent tags silently corrupt the fatigue and
  // time models, so the contradictions worth catching get a warning toast.
  function lintExercise(f) {
    if (f.plyo && f.cns === "LOW") return "Ojo: un pliométrico (salto/impacto) rara vez es SNC baja.";
    if (f.plyo && f.dynamics === "ISO") return "Ojo: pliométrico e isométrico se contradicen; revisa la dinámica.";
    if (f.load === 3 && f.dynamics === "METABOLIC") return "Ojo: el trabajo metabólico suele ir con carga ligera/media, no pesada.";
    return null;
  }
  function fillForm(e) {
    $("#f-name").value = e.name;
    $("#f-pattern").value = e.pattern; $("#f-dynamics").value = e.dynamics;
    $("#f-symmetry").value = e.symmetry; $("#f-cns").value = e.cns;
    $("#f-load").value = String(e.load); $("#f-tier").value = e.tier;
    $("#f-grip").checked = !!e.grip;
    $("#f-plyo").checked = !!e.plyo;
    $("#f-arms").checked = !!e.arms;
    $("#f-skill").checked = !!e.skill;
    $("#f-eq-kb").checked = e.equipment.includes("KB");
    $("#f-eq-barbell").checked = e.equipment.includes("BARBELL");
    $("#f-eq-floor").checked = e.equipment.includes("FLOOR");
  }
  function resetForm() {
    state.editing = null;
    $("#pool-form-title").textContent = "Nuevo ejercicio";
    $("#btn-add").textContent = "Añadir al pool";
    $("#f-name").value = ""; $("#f-name").disabled = false;
    $("#f-pattern").selectedIndex = 0; $("#f-dynamics").selectedIndex = 0;
    $("#f-symmetry").selectedIndex = 0; $("#f-cns").selectedIndex = 0;
    $("#f-load").value = "2"; $("#f-tier").value = "ACCESSORY";
    $("#f-grip").checked = false; $("#f-plyo").checked = false; $("#f-arms").checked = false;
    $("#f-skill").checked = false;
    $("#f-eq-kb").checked = true; $("#f-eq-barbell").checked = false; $("#f-eq-floor").checked = false;
  }
  function openForEdit(e) {
    state.editing = e.id;
    fillForm(e);
    $("#f-name").disabled = true;   // name is the key; not renamed when editing
    $("#pool-form-title").textContent = "Editar: " + e.name;
    $("#btn-add").textContent = "Guardar cambios";
    $("#pool-form").classList.remove("hidden");
    const pf = $("#pool-form"); if (pf.scrollIntoView) pf.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function saveExercise() {
    const fields = readForm();
    const lint = lintExercise(fields);
    if (state.editing) {
      const id = state.editing;
      if (isBaseId(id)) state.overrides[id] = fields;                       // modification over the base
      else state.custom = state.custom.map(x => x.id === id
        ? Object.assign(F.newExercise(Object.assign({ name: x.name }, fields)), { id })
        : x);
      computePool(); savePoolState(); renderPool();
      $("#pool-form").classList.add("hidden"); resetForm(); toast(lint || "Cambios guardados");
      return;
    }
    const name = $("#f-name").value.trim();
    if (!name) { toast("Ponle un nombre"); return; }
    if (state.pool.some(e => e.name.toLowerCase() === name.toLowerCase())) { toast("Ese nombre ya existe"); return; }
    state.custom.push(Object.assign(F.newExercise(Object.assign({ name }, fields)), { id: newCustomId(name) }));
    computePool(); savePoolState(); renderPool();
    $("#pool-form").classList.add("hidden"); resetForm(); toast(lint || "Ejercicio añadido");
  }

  // ---- Export / Import
  // The backup is ONE self-contained JSON with everything the app persists —
  // including cfg (settings, builder drafts, declared objective) since v2 —
  // so restoring it on any device reproduces this one exactly.
  function exportPayload() {
    return {
      version: 2,
      date: new Date().toISOString(),
      hist: state.hist,
      custom: state.custom,
      removed: state.removed,
      overrides: state.overrides,
      kg: state.kg,
      prog: state.prog,
      cfg: state.cfg,
      paused: state.paused,
      templates: state.templates,
      program: { programs: state.programs, activeId: state.activeProgramId },
    };
  }
  function exportData() {
    const payload = JSON.stringify(exportPayload(), null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    a.download = "forja-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    markBackupDone("manual");
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data || typeof data !== "object") throw new Error("invalid");
        // Importing REPLACES the local data — make that explicit before
        // touching anything (a mis-picked file was irreversible).
        const nh = Array.isArray(data.hist) ? data.hist.length : 0;
        const nc = Array.isArray(data.custom) ? data.custom.length : 0;
        const ok = window.confirm(
          "Restaurar copia: " + nh + " sesiones y " + nc + " ejercicios propios.\n" +
          "Reemplaza los datos actuales (" + state.hist.length + " sesiones). ¿Continuar?");
        if (!ok) { toast("Importación cancelada"); return; }
        // Drop entries that are not even objects (hand-edited/truncated
        // files) so one bad row cannot break the History render.
        if (Array.isArray(data.hist)) data.hist = data.hist.filter(x => x && typeof x === "object");
        state.hist = Array.isArray(data.hist) ? data.hist : state.hist;
        state.custom = Array.isArray(data.custom) ? data.custom : state.custom;
        state.removed = Array.isArray(data.removed) ? data.removed : state.removed;
        state.overrides = (data.overrides && typeof data.overrides === "object") ? data.overrides : state.overrides;
        if (data.kg && typeof data.kg === "object") state.kg = data.kg;
        if (data.prog && typeof data.prog === "object") state.prog = data.prog;
        if (data.cfg && typeof data.cfg === "object") Object.assign(state.cfg, data.cfg);
        if (Array.isArray(data.paused)) state.paused = data.paused;
        if (Array.isArray(data.templates)) state.templates = data.templates;
        if (data.program && typeof data.program === "object") {
          // Accept both the new {programs, activeId} shape and the old single
          // program object.
          if (Array.isArray(data.program.programs)) { state.programs = data.program.programs; state.activeProgramId = data.program.activeId || null; }
          else if (data.program.id) { state.programs = [data.program]; state.activeProgramId = data.program.id; }
          if (!state.activeProgramId && state.programs[0]) state.activeProgramId = state.programs[0].id;
        }
        await Promise.all([
          Store.set(K.HIST, JSON.stringify(state.hist)),
          Store.set(K.KG, JSON.stringify(state.kg)),
          Store.set(K.PROG, JSON.stringify(state.prog)),
          Store.set(K.CFG, JSON.stringify(state.cfg)),
          savePaused(),
          saveTemplates(),
          saveProgram(),
          savePoolState(),
        ]);
        computePool();
        renderPool();
        // Re-seed the id sequence over the imported ids so a session saved
        // right after the import cannot collide with a restored one.
        state.hist.forEach(h => { if (typeof h.id === "number") _idSeq = Math.max(_idSeq, h.id); });
        toast(`Importado: ${state.hist.length} sesiones, ${state.custom.length} ejercicios propios`);
        // cfg touches every control on the Generate view; a reload re-inits
        // the whole UI from storage instead of hand-patching each widget.
        if (data.cfg) setTimeout(() => { try { location.reload(); } catch (e) {} }, 700);
      } catch (_) {
        toast("Error al importar: archivo no válido");
      }
    };
    reader.readAsText(file);
  }

  // ---- Backup file: the user decides where -----------------------------
  // The WORKING copy always lives in the device store (a web app cannot run
  // off a file). The BACKUP is a plain JSON snapshot in a file the user
  // chooses. Where the File System Access API exists (Chrome / Android),
  // the app links that file once and silently rewrites it after every
  // change (debounced, via Store.onWrite). Elsewhere (iOS Safari...) the
  // same snapshot goes out through the share sheet or a download.
  let backupHandle = null;       // linked file, permission granted
  let backupPending = null;      // linked file, needs a tap to re-grant
  let backupTimer = null;
  const fsSupported = () => typeof window.showSaveFilePicker === "function";

  // Tiny IndexedDB store just for the file handle: handles are structured-
  // cloneable but NOT serializable, so localStorage cannot hold them.
  const BACKUP_DB = "forja-fs", BACKUP_OS = "handles";
  function idbOpen() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(BACKUP_DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(BACKUP_OS);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const rq = db.transaction(BACKUP_OS).objectStore(BACKUP_OS).get(key);
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(BACKUP_OS, "readwrite");
      tx.objectStore(BACKUP_OS).put(val, key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  }

  function markBackupDone(kind) {
    try { localStorage.setItem("forja:backupAt", JSON.stringify({ t: Date.now(), kind })); } catch (e) {}
    renderBackupStatus();
  }
  let warnedBackupGuard = false;
  async function writeBackup() {
    if (!backupHandle) return;
    // Never mirror a knowingly-bad load: if any stored blob failed to parse,
    // the linked file may hold the only good copy of that data.
    if (corruptKeys.length) return;
    // Shrink guard: an empty in-memory history over a backup that has
    // sessions means a fresh/failed load (or a re-link before importing) —
    // overwriting would destroy the only copy. Import the file first.
    if (!state.hist.length) {
      try {
        const f = await backupHandle.getFile();
        if (f.size > 2) {
          const prev = JSON.parse(await f.text());
          if (prev && Array.isArray(prev.hist) && prev.hist.length > 0) {
            if (!warnedBackupGuard) {
              warnedBackupGuard = true;
              toast("Copia automática en pausa: el archivo vinculado tiene sesiones y la app ninguna. Impórtalo (o desvincula) antes de sobrescribir.");
            }
            renderBackupStatus();
            return false;
          }
        }
      } catch (e) { /* unreadable existing file: nothing to protect */ }
    }
    const w = await backupHandle.createWritable();
    await w.write(JSON.stringify(exportPayload(), null, 2));
    await w.close();
    markBackupDone("auto");
    return true;
  }
  function scheduleBackup() {
    if (!backupHandle) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(() => { writeBackup().catch(() => {}); }, 1500);
  }
  async function linkBackupFile() {
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: "forja-backup.json",
        types: [{ description: "Copia FORJA (JSON)", accept: { "application/json": [".json"] } }],
      });
      backupHandle = h; backupPending = null;
      await idbSet("backup", h);
      const wrote = await writeBackup();   // first snapshot right away
      if (wrote) toast("Copia automática vinculada");
    } catch (e) { /* picker cancelled */ }
    renderBackupStatus();
  }
  async function relinkBackupFile() {
    if (!backupPending) return;
    try {
      const perm = await backupPending.requestPermission({ mode: "readwrite" });
      if (perm === "granted") {
        backupHandle = backupPending; backupPending = null;
        const wrote = await writeBackup();
        if (wrote) toast("Copia automática reactivada");
      }
    } catch (e) {}
    renderBackupStatus();
  }
  async function unlinkBackupFile() {
    backupHandle = null; backupPending = null;
    try { await idbSet("backup", null); } catch (e) {}
    renderBackupStatus(); toast("Copia automática desvinculada");
  }
  // Share sheet fallback (mobile: "save to Files / Drive"). Falls back to a
  // classic download when files cannot be shared.
  async function shareBackup() {
    try {
      const file = new File([JSON.stringify(exportPayload(), null, 2)],
        "forja-backup-" + new Date().toISOString().slice(0, 10) + ".json", { type: "application/json" });
      if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error("no-files");
      await navigator.share({ files: [file], title: "Copia FORJA" });
      markBackupDone("manual");
    } catch (e) { if (e && e.name !== "AbortError") exportData(); }
  }
  function backupAgeText() {
    try {
      const j = JSON.parse(localStorage.getItem("forja:backupAt"));
      if (!j) return "Sin copias todavía.";
      const when = new Date(j.t).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      return "Última copia: " + when + (j.kind === "auto" ? " · automática" : "");
    } catch (e) { return "Sin copias todavía."; }
  }
  function renderBackupStatus() {
    const st = $("#backup-status"); if (!st) return;
    const bits = [backupAgeText()];
    if (backupHandle) bits.push("Copia automática activa → " + (backupHandle.name || "archivo vinculado") + ".");
    else if (backupPending) bits.push("Archivo vinculado; reactívala para seguir copiando.");
    st.textContent = bits.join(" ");
    $("#btn-link-backup").classList.toggle("hidden", !fsSupported() || !!backupHandle || !!backupPending);
    $("#btn-relink-backup").classList.toggle("hidden", !backupPending);
    $("#btn-unlink-backup").classList.toggle("hidden", !backupHandle);
    $("#btn-share-backup").classList.toggle("hidden", typeof navigator.share !== "function");
  }
  async function initBackup() {
    // The timer checkpoint is volatile session state, not user data: it must
    // not rewrite the backup file every few seconds during a workout.
    Store.onWrite = k => { if (String(k).indexOf("forja:") === 0 && k !== K.TIMER) scheduleBackup(); };
    if (fsSupported() && typeof indexedDB !== "undefined") {
      try {
        const h = await idbGet("backup");
        if (h) {
          const perm = await h.queryPermission({ mode: "readwrite" });
          if (perm === "granted") backupHandle = h; else backupPending = h;
        }
      } catch (e) {}
    }
    renderBackupStatus();
  }

  // ---- CSV / spreadsheet import of past sessions -----------------------
  // Reads a table with a header row. Recognized columns (accent/case
  // insensitive): Fecha, Bloque/Orden, Ejercicio, Carga(kg), Serie 1..N,
  // Notas. Computed columns (Reps Totales, Volumen) are ignored. Each date
  // becomes one manual session preserving per-set reps, kg and notes.
  const deaccent = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

  function parseSessionsCsv(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n").filter(l => l.trim() !== "");
    if (lines.length < 2) throw new Error("sin datos");
    const delim = (lines[0].match(/\t/g) || []).length >= (lines[0].match(/,/g) || []).length ? "\t" : ",";
    const cells = l => l.split(delim).map(c => c.trim());
    const header = cells(lines[0]).map(deaccent);

    const find = pred => header.findIndex(pred);
    const idx = {
      date:  find(h => h.includes("fecha")),
      order: find(h => h.includes("bloque") || h.includes("orden")),
      name:  find(h => h.includes("ejercicio")),
      kg:    find(h => h.includes("carga") || h === "kg" || h.includes("peso")),
      note:  find(h => h.includes("nota")),
    };
    const setCols = [];
    header.forEach((h, i) => { if (/^serie\b/.test(h) || /^set\b/.test(h)) setCols.push(i); });
    if (idx.date < 0 || idx.name < 0) throw new Error("faltan columnas Fecha/Ejercicio");

    const toISO = s => {
      const m = (s || "").match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
      if (!m) { const d = new Date(s); return isNaN(d) ? null : d.toISOString(); }
      let [, dd, mm, yy] = m; yy = yy.length === 2 ? "20" + yy : yy;
      const d = new Date(+yy, +mm - 1, +dd, 12, 0, 0);
      return isNaN(d) ? null : d.toISOString();
    };
    const num = v => { const n = parseFloat(String(v).replace(",", ".")); return isNaN(n) ? null : n; };
    const repOf = v => { v = String(v).trim(); if (!v || v[0] === "=") return null; const n = parseInt(v, 10); return isNaN(n) ? null : n; };

    const byDate = new Map();
    for (let i = 1; i < lines.length; i++) {
      const c = cells(lines[i]);
      const iso = toISO(c[idx.date]);
      const name = (c[idx.name] || "").trim();
      if (!iso || !name) continue;
      const sets = setCols.map(ci => repOf(c[ci])).filter(n => n != null);
      const ex = {
        order: idx.order >= 0 ? (c[idx.order] || "").trim() : "",
        name,
        kg: idx.kg >= 0 ? num(c[idx.kg]) : null,
        sets,
        note: idx.note >= 0 ? (c[idx.note] || "").trim() : "",
      };
      if (!byDate.has(iso)) byDate.set(iso, []);
      byDate.get(iso).push(ex);
    }
    if (!byDate.size) throw new Error("sin filas válidas");

    return [...byDate.entries()].map(([iso, exercises]) => ({
      id: nextId(), date: iso, manual: true, completed: true, exercises,
    }));
  }

  function importCsvSessions(text) {
    let sessions;
    try { sessions = parseSessionsCsv(text); }
    catch (err) { toast("CSV no válido: " + err.message); return; }
    state.hist = state.hist.concat(sessions).sort((a, b) => new Date(b.date) - new Date(a.date));
    saveHistory(); renderHistory();
    const exTotal = sessions.reduce((a, s) => a + s.exercises.length, 0);
    toast(`Importadas ${sessions.length} sesiones (${exTotal} ejercicios)`);
  }

  // ---- Generic controls (segmented + chips)
  function fillSelectOptions() {
    const fill = (sel, pairs, def) => {
      const node = $(sel); if (!node) return;
      node.innerHTML = pairs.map(([v, t]) => `<option value="${v}"${String(v) === String(def) ? " selected" : ""}>${t}</option>`).join("");
    };
    const cap = k => k[0] + k.slice(1).toLowerCase();
    fill("#f-pattern", Object.keys(F.PAT_LABEL).map(k => [k, F.PAT_LABEL[k]]));
    fill("#f-dynamics", Object.keys(F.DIN_LABEL).map(k => [k, F.DIN_LABEL[k]]));
    fill("#f-symmetry", ["BILATERAL", "UNILATERAL", "ALTERNATING"].map(k => [k, cap(k)]));
    fill("#f-cns", ["HIGH", "MEDIUM", "LOW"].map(k => [k, cap(k)]));
    fill("#f-load", [[1, "Ligera"], [2, "Media"], [3, "Pesada"]], 2);
    fill("#f-tier", [["FUNDAMENTAL", "Fundamental"], ["ACCESSORY", "Accesorio"], ["OPTIONAL", "Opcional"]], "ACCESSORY");
  }

  function wireSeg(groupSel, onPick) {
    const group = $(groupSel);
    group.querySelectorAll("button").forEach(b => {
      b.onclick = () => {
        group.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        onPick(b.dataset.val);
      };
    });
  }
  function setSeg(groupSel, val) {
    $(groupSel).querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.val === String(val))));
  }

  // ---- Navigation
  function showView(name) {
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
    document.querySelectorAll(".nav button").forEach(b => b.setAttribute("aria-current", String(b.dataset.view === name)));
    if (name === "hist") renderHistory();
    if (name === "pool") renderPool();
    if (name === "prog") renderProgram();
  }

  // ---- Init
  async function init() {
    await loadAll();
    // Corrupt blobs were parked under "<key>:corrupt" by loadAll — tell the
    // user instead of silently starting over (and see writeBackup's guard).
    if (corruptKeys.length) {
      setTimeout(() => toast("Aviso: datos guardados ilegibles (" + corruptKeys.join(", ") +
        "). Se conservó una copia interna; restaura desde tu backup si algo falta."), 400);
    }
    fillSelectOptions();

    // reflect cfg in controls
    setSeg("#seg-objective", state.cfg.objective);
    // focus chips — reflect saved state
    document.querySelectorAll("#focus-chips .chip").forEach(ch => {
      const keys = (ch.dataset.val || "").split(",");
      const active = keys.some(k => state.cfg.focus.includes(k));
      ch.setAttribute("aria-pressed", String(active));
    });
    setSeg("#seg-vol", state.cfg.volumeMode);
    setSeg("#seg-balance", state.cfg.balance);
    setSeg("#seg-vary", state.cfg.vary ? "yes" : "no");
    setSeg("#seg-sameweight", state.cfg.sameWeight ? "yes" : "no");
    setSeg("#seg-sex", state.cfg.profile.sex);
    setSeg("#seg-level", state.cfg.profile.level);
    setSeg("#seg-energy", state.cfg.readiness.energy);
    setSeg("#seg-sleep", state.cfg.readiness.sleep);
    document.querySelectorAll("#sore-chips .chip").forEach(ch => {
      const keys = (ch.dataset.val || "").split(",");
      ch.setAttribute("aria-pressed", String(keys.some(k => state.cfg.readiness.sore.includes(k))));
    });
    updateReadinessHint();
    $("#kg-min-val").textContent = state.cfg.weightMin; $("#kg-max-val").textContent = state.cfg.weightMax;
    $("#chip-barbell").setAttribute("aria-pressed", String(state.cfg.equipment.includes("BARBELL")));
    $("#m-range").value = state.cfg.minutes; $("#m-read").textContent = state.cfg.minutes;
    $("#tol-val").textContent = state.cfg.tolerance;
    $("#tol-wrap").classList.toggle("hidden", state.cfg.balance !== "HARD");
    ["A", "B", "C"].forEach(k => { $("#est-" + k + "-val").textContent = state.cfg.structure[k]; });
    applyFocusUI(); applyVolumeUI(); updatePinnedCount();

    // Routine mode: generator vs manual builder.
    const applyMode = () => {
      const manual = state.cfg.mode === "manual";
      $("#mode-auto").classList.toggle("hidden", manual);
      $("#mode-manual").classList.toggle("hidden", !manual);
      if (manual) renderBuilder();
    };
    applyModeRef = applyMode;   // let loadRoutine (module scope) reach it
    setSeg("#seg-mode", state.cfg.mode);
    applyMode();
    wireSeg("#seg-mode", v => { state.cfg.mode = v; saveConfig(); applyMode(); });
    document.querySelectorAll(".mk-add").forEach(b => {
      b.onclick = () => {
        const k = b.dataset.block;
        if (!filteredPool().length) { toast("No hay ejercicios disponibles"); return; }
        // Toggle the searchable picker for this block (one open at a time).
        mkPicker.block = mkPicker.block === k ? null : k;
        mkPicker.text = "";
        renderBuilder();
      };
    });
    $("#btn-componer").onclick = composeManual;
    setSeg("#seg-mk-obj", state.cfg.manualObjective);
    wireSeg("#seg-mk-obj", v => { state.cfg.manualObjective = v; saveConfig(); renderBuilder(); });
    // Bridge to the generator: the draft's exercises become pins (keeping
    // their block) and the generator fills the rest under the declared
    // objective. Composition stays the trainee's; completion is the engine's.
    $("#btn-mk-complete").onclick = () => {
      const rows = [];
      ["A", "B", "C"].forEach(k => state.cfg.manual[k].forEach(it => rows.push({ name: it.name, block: k })));
      if (!rows.length) { toast("Añade ejercicios primero"); return; }
      state.cfg.pinned = rows;
      if (F.TEMPLATES[state.cfg.manualObjective]) {
        state.cfg.objective = state.cfg.manualObjective;
        setSeg("#seg-objective", state.cfg.objective);
        updateReadinessHint();
      }
      state.cfg.mode = "auto"; setSeg("#seg-mode", "auto"); applyMode();
      updatePinnedCount(); saveConfig();
      generateRoutine();
      toast("Tus ejercicios quedan fijados; el generador completó el resto");
    };

    wireSeg("#seg-objective", v => { state.cfg.objective = v; updateReadinessHint(); saveConfig(); });
    // focus chips — multi-select, shortcuts expand to multiple keys
    document.querySelectorAll("#focus-chips .chip").forEach(ch => {
      ch.onclick = () => {
        const keys = (ch.dataset.val || "").split(",");
        const isOn = ch.getAttribute("aria-pressed") === "true";
        if (isOn) {
          // deselect: remove all keys this chip covers
          state.cfg.focus = state.cfg.focus.filter(k => !keys.includes(k));
        } else {
          // select: add keys not already present
          keys.forEach(k => { if (!state.cfg.focus.includes(k)) state.cfg.focus.push(k); });
        }
        // re-render all chip states (a key may belong to multiple chips)
        document.querySelectorAll("#focus-chips .chip").forEach(c => {
          const ks = (c.dataset.val || "").split(",");
          c.setAttribute("aria-pressed", String(ks.some(k => state.cfg.focus.includes(k))));
        });
        applyFocusUI(); saveConfig();
      };
    });
    wireSeg("#seg-vol", v => { state.cfg.volumeMode = v; applyVolumeUI(); saveConfig(); });
    wireSeg("#seg-balance", v => {
      state.cfg.balance = v; $("#tol-wrap").classList.toggle("hidden", v !== "HARD"); saveConfig();
    });
    wireSeg("#seg-vary", v => { state.cfg.vary = (v === "yes"); saveConfig(); });
    setSeg("#seg-focus-mode", state.cfg.focusSoft ? "soft" : "hard");
    wireSeg("#seg-focus-mode", v => { state.cfg.focusSoft = (v === "soft"); applyFocusUI(); saveConfig(); });
    wireSeg("#seg-sameweight", v => {
      state.cfg.sameWeight = (v === "yes"); saveConfig();
      if (state.routine) renderRoutine(state.routine, $("#routine-out"), { min: state.cfg.weightMin, max: state.cfg.weightMax }, true);
    });

    // Daily readiness (mood / sleep / soreness) — bends the next generated
    // session to the trainee's day. Persists so the last check is the default.
    wireSeg("#seg-energy", v => { state.cfg.readiness.energy = +v; updateReadinessHint(); saveConfig(); });
    wireSeg("#seg-sleep", v => { state.cfg.readiness.sleep = v; updateReadinessHint(); saveConfig(); });
    document.querySelectorAll("#sore-chips .chip").forEach(ch => {
      ch.onclick = () => {
        const keys = (ch.dataset.val || "").split(",");
        const isOn = ch.getAttribute("aria-pressed") === "true";
        if (isOn) state.cfg.readiness.sore = state.cfg.readiness.sore.filter(k => !keys.includes(k));
        else keys.forEach(k => { if (!state.cfg.readiness.sore.includes(k)) state.cfg.readiness.sore.push(k); });
        ch.setAttribute("aria-pressed", String(!isOn));
        updateReadinessHint(); saveConfig();
      };
    });

    // Adjustable kettlebell: min/max in 2 kg steps, keeping min < max.
    const refreshKg = () => { $("#kg-min-val").textContent = state.cfg.weightMin; $("#kg-max-val").textContent = state.cfg.weightMax; };
    $("#kg-min-dec").onclick = () => { state.cfg.weightMin = Math.max(4, state.cfg.weightMin - 2); refreshKg(); saveConfig(); };
    $("#kg-min-inc").onclick = () => { state.cfg.weightMin = Math.min(state.cfg.weightMax - 2, state.cfg.weightMin + 2); refreshKg(); saveConfig(); };
    $("#kg-max-dec").onclick = () => { state.cfg.weightMax = Math.max(state.cfg.weightMin + 2, state.cfg.weightMax - 2); refreshKg(); saveConfig(); };
    $("#kg-max-inc").onclick = () => { state.cfg.weightMax = Math.min(48, state.cfg.weightMax + 2); refreshKg(); saveConfig(); };

    ["A", "B", "C"].forEach(k => {
      $("#est-" + k + "-dec").onclick = () => { state.cfg.structure[k] = Math.max(0, state.cfg.structure[k] - 1); $("#est-" + k + "-val").textContent = state.cfg.structure[k]; saveConfig(); };
      $("#est-" + k + "-inc").onclick = () => { state.cfg.structure[k] = Math.min(6, state.cfg.structure[k] + 1); $("#est-" + k + "-val").textContent = state.cfg.structure[k]; saveConfig(); };
    });

    // Profile (cold-start seeding of suggested kg)
    const LEVEL_LABEL = { BEG: "Principiante", INTER: "Intermedio", ADV: "Avanzado" };
    const refreshProfile = () => {
      const p = state.cfg.profile;
      $("#bw-val").textContent = p.bodyweight ? p.bodyweight : "—";
      const bits = [];
      if (p.bodyweight) bits.push(p.bodyweight + " kg");
      if (p.sex) bits.push(p.sex === "F" ? "Mujer" : "Hombre");
      bits.push(LEVEL_LABEL[p.level] || "Intermedio");
      $("#profile-sub").textContent = "· " + bits.join(" · ");
    };
    $("#bw-dec").onclick = () => { const c = state.cfg.profile.bodyweight || 70; state.cfg.profile.bodyweight = Math.max(35, c - 1); refreshProfile(); saveConfig(); };
    $("#bw-inc").onclick = () => { const c = state.cfg.profile.bodyweight || 69; state.cfg.profile.bodyweight = Math.min(180, c + 1); refreshProfile(); saveConfig(); };
    wireSeg("#seg-sex", v => { state.cfg.profile.sex = v; refreshProfile(); saveConfig(); });
    wireSeg("#seg-level", v => { state.cfg.profile.level = v; refreshProfile(); saveConfig(); });
    refreshProfile();

    $("#btn-pin-toggle").onclick = () => {
      const panel = $("#pin-panel"); const open = panel.classList.contains("hidden");
      panel.classList.toggle("hidden"); if (open) renderPinned();
    };

    $("#chip-barbell").onclick = () => {
      const on = $("#chip-barbell").getAttribute("aria-pressed") !== "true";
      $("#chip-barbell").setAttribute("aria-pressed", String(on));
      state.cfg.equipment = on ? ["KB", "FLOOR", "BARBELL"] : ["KB", "FLOOR"];
      prunePinned(); updatePinnedCount();
      if (!$("#pin-panel").classList.contains("hidden")) renderPinned();
      if (state.cfg.mode === "manual") renderBuilder();   // barbell rows may (dis)appear
      saveConfig();
    };

    $("#m-range").oninput = e => { state.cfg.minutes = parseInt(e.target.value, 10); $("#m-read").textContent = state.cfg.minutes; };
    $("#m-range").onchange = saveConfig;

    $("#tol-dec").onclick = () => { state.cfg.tolerance = Math.max(0, state.cfg.tolerance - 1); $("#tol-val").textContent = state.cfg.tolerance; saveConfig(); };
    $("#tol-inc").onclick = () => { state.cfg.tolerance = Math.min(3, state.cfg.tolerance + 1); $("#tol-val").textContent = state.cfg.tolerance; saveConfig(); };

    $("#btn-generar").onclick = generateRoutine;
    $("#btn-regenerar").onclick = generateRoutine;
    $("#btn-guardar").onclick = () => { if (saveToHistory()) toast("Guardada en el historial"); };
    $("#btn-train").onclick = () => startTimer(state.routine);
    $("#btn-save-template").onclick = saveCurrentAsTemplate;
    renderTemplates();

    $("#btn-add-toggle").onclick = () => {
      const panel = $("#pool-form"); const open = panel.classList.contains("hidden");
      if (open) { resetForm(); panel.classList.remove("hidden"); } else panel.classList.add("hidden");
    };
    $("#btn-add").onclick = saveExercise;
    $("#btn-add-cancel").onclick = () => { $("#pool-form").classList.add("hidden"); resetForm(); };

    // Pool search + filters
    $("#pool-search").oninput = e => { poolFilter.text = e.target.value; renderPool(); };
    $("#pool-filter-toggle").onclick = () => $("#pool-filters").classList.toggle("hidden");

    $("#btn-export").onclick = exportData;
    $("#btn-share-backup").onclick = shareBackup;
    $("#btn-link-backup").onclick = linkBackupFile;
    $("#btn-relink-backup").onclick = relinkBackupFile;
    $("#btn-unlink-backup").onclick = unlinkBackupFile;
    initBackup();
    $("#btn-import-trigger").onclick = () => $("#import-file").click();
    $("#import-file").onchange = e => { if (e.target.files[0]) { importData(e.target.files[0]); e.target.value = ""; } };

    // CSV / spreadsheet import of past sessions
    $("#btn-csv-import").onclick = () => {
      const txt = $("#csv-input").value;
      if (!txt.trim()) { toast("Pega una tabla o sube un archivo primero"); return; }
      importCsvSessions(txt); $("#csv-input").value = "";
    };
    $("#csv-file").onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = ev => { importCsvSessions(String(ev.target.result)); };
      reader.readAsText(f); e.target.value = "";
    };

    document.querySelectorAll(".nav button").forEach(b => b.onclick = () => showView(b.dataset.view));

    showView("gen");

    // A checkpointed workout means a refresh or the OS killed the app
    // mid-session: offer to resume it exactly where it stopped.
    const savedT = await loadJson(K.TIMER);
    if (savedT && savedT.routine && savedT.routine.blocks) {
      const h = savedT.histId != null ? state.hist.find(x => x.id === savedT.histId) : null;
      if (window.confirm("Hay un entrenamiento a medias. ¿Reanudarlo donde quedó?")) {
        if (!h) {
          // The workout ran on a live unsaved routine: restore it as the
          // current one so finishing can still save to history.
          state.routine = savedT.routine;
          renderRoutine(state.routine, $("#routine-out"), { min: state.cfg.weightMin, max: state.cfg.weightMax }, true);
        }
        startTimer(savedT.routine, h || null, savedT);
      } else {
        // Salvage what was already logged before discarding the checkpoint.
        if (h && Array.isArray(savedT.done) && savedT.done.length) {
          h.performed = groupPerformed(savedT.done); saveHistory(); renderHistory();
        }
        clearTimerState();
      }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
