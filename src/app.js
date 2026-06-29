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
 *   - `state.custom`    : exercises added by the user.
 *   - `state.removed`   : names of hidden base exercises.
 *   - `state.overrides` : field overrides by name for base exercises.
 *   The effective pool (`state.pool`) is ALWAYS recomputed from the current
 *   base catalog (FORJA.BASE_CATALOG) applying those three layers. This way,
 *   expanding the base catalog makes new exercises appear without breaking user data.
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
        if (mode === "local") return localStorage.getItem(k);
        return k in mem ? mem[k] : null;
      } catch (e) { return k in mem ? mem[k] : null; }
    }
    async function set(k, v) {
      try {
        if (mode === "win") { await window.storage.set(k, v); return; }
        if (mode === "local") { localStorage.setItem(k, v); return; }
        mem[k] = v;
      } catch (e) { mem[k] = v; }
    }
    return { get, set, get mode() { return mode; } };
  })();

  const K = { HIST: "forja:hist", POOL: "forja:pool", CUSTOM: "forja:custom", REMOVED: "forja:removed", OVERRIDES: "forja:overrides", CFG: "forja:cfg", KG: "forja:kg" };
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

  const state = {
    cfg: { objective:"STRENGTH", focus:[], equipment:["KB"], weightMin:12, weightMax:32,
           volumeMode:"time", minutes:45, structure:{ A:4, B:4, C:2 },
           balance:"NONE", tolerance:1, pinned:[], vary:true,
           profile:{ bodyweight:null, sex:"", level:"INTER" } },
    custom: [],       // exercises added by the user
    removed: [],      // names of hidden base exercises
    overrides: {},    // name -> edited fields of base exercises
    pool: [],         // computed
    hist: [],
    routine: null,
    editing: null,    // name of the exercise being edited, or null
    kg: {},           // name -> last kg the user dialed in for that exercise (persisted)
  };
  // UI-only filters for the pin panel (not persisted): tag -> selected values.
  const pinFilter = { pattern: [], dynamics: [], tier: [] };
  let manualEditId = null;   // id of the manual session currently being edited
  // Monotonic id generator: history/session ids must be unique even when two
  // are minted within the same millisecond (e.g. a save and a CSV import, or
  // several sessions in one import). Seeded above any existing id on load.
  let _idSeq = 0;
  const nextId = () => { const t = Date.now(); _idSeq = Math.max(_idSeq + 1, t); return _idSeq; };
  const clone = e => Object.assign({}, e, { equipment: e.equipment.slice() });
  const isBaseExercise = n => F.BASE_CATALOG.some(e => e.name === n);
  function computePool() {
    const base = F.BASE_CATALOG.filter(e => !state.removed.includes(e.name)).map(e => {
      const c = clone(e); const ov = state.overrides[e.name];
      return ov ? Object.assign(c, ov, { name: e.name }) : c;
    });
    state.pool = base.concat(state.custom.map(clone));
  }

  const $ = s => document.querySelector(s);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1900);
  }

  // ---- Persistence
  async function loadAll() {
    try { const h = await Store.get(K.HIST); if (h) state.hist = JSON.parse(h); } catch (e) {}
    try { const c = await Store.get(K.CFG); if (c) Object.assign(state.cfg, JSON.parse(c)); } catch (e) {}
    // Migrate old single-string focus ("FULL"/"LEGS"/...) to array model.
    if (!Array.isArray(state.cfg.focus)) {
      state.cfg.focus = (state.cfg.focus && state.cfg.focus !== "FULL") ? [state.cfg.focus] : [];
    }
    if (!state.cfg.profile || typeof state.cfg.profile !== "object") {
      state.cfg.profile = { bodyweight: null, sex: "", level: "INTER" };
    }
    let loaded = false;
    try {
      const cu = await Store.get(K.CUSTOM); const rm = await Store.get(K.REMOVED);
      if (cu != null || rm != null) { state.custom = cu ? JSON.parse(cu) : []; state.removed = rm ? JSON.parse(rm) : []; loaded = true; }
    } catch (e) {}
    if (!loaded) {
      // Migration from old model (full pool) -> custom + removed.
      // Only the original 24 can be marked as 'removed'; new base additions
      // (expanded catalog) should always appear after migration.
      try {
        const old = await Store.get(K.POOL);
        if (old) {
          const arr = JSON.parse(old);
          const baseNames = new Set(F.BASE_CATALOG.map(e => e.name));
          const have = new Set(arr.map(e => e.name));
          state.custom = arr.filter(e => !baseNames.has(e.name));
          state.removed = LEGACY_BASE.filter(n => !have.has(n));
          savePoolState();
        }
      } catch (e) {}
    }
    try { const ov = await Store.get(K.OVERRIDES); if (ov) state.overrides = JSON.parse(ov); } catch (e) {}
    try { const kg = await Store.get(K.KG); if (kg) state.kg = JSON.parse(kg); } catch (e) {}
    computePool();
    // Seed the id sequence above any id already in history.
    state.hist.forEach(h => { if (typeof h.id === "number") _idSeq = Math.max(_idSeq, h.id); });
    // Migration: pinned as strings -> objects {name, block}
    state.cfg.pinned = (state.cfg.pinned || []).map(f => typeof f === "string" ? { name: f, block: "AUTO" } : f);
  }
  const saveHistory = () => Store.set(K.HIST, JSON.stringify(state.hist));
  const savePoolState = () => {
    Store.set(K.CUSTOM, JSON.stringify(state.custom));
    Store.set(K.REMOVED, JSON.stringify(state.removed));
    Store.set(K.OVERRIDES, JSON.stringify(state.overrides));
  };
  const saveConfig = () => Store.set(K.CFG, JSON.stringify(state.cfg));
  const saveKg = () => Store.set(K.KG, JSON.stringify(state.kg));

  // ---- Formatting
  const dose = p => {
    const perSide = p.exercise.symmetry === F.SIM.UNILATERAL;
    if (p.exercise.dynamics === F.DIN.ISO) {
      const sec = p.exercise.holdSec || 35;
      return `${p.sets}x ~${sec}s` + (perSide ? " / lado" : "");
    }
    return `${p.sets}x${p.reps}` + (perSide ? " / lado" : "");
  };

  // ---- Render: routine
  function renderRoutine(r, into, range, editable) {
    into.innerHTML = "";
    if (!r) return;
    range = range || { min: state.cfg.weightMin, max: state.cfg.weightMax };
    const head = el("div", "routine-head");
    head.appendChild(el("div", "routine-title", r.template));
    head.appendChild(el("div", "routine-dur", `~${F.routineDurationMin(r)} min`));
    into.appendChild(head);

    if (r.warmup && r.warmup.items && r.warmup.items.length) {
      const wu = el("div", "block warmup");
      const wh = el("div", "block-head");
      wh.appendChild(el("div", "block-name", "Calentamiento · preparacion"));
      wu.appendChild(wh);
      const ul = el("ul", "warmup-list");
      r.warmup.items.forEach(it => ul.appendChild(el("li", null, it)));
      wu.appendChild(ul);
      into.appendChild(wu);
    }

    const blockName = { A: "Principal", B: "Accesorios", C: "Finalizador" };
    r.blocks.forEach(br => {
      if (!br.elements.length) return;
      const blk = el("div", "block");
      const bh = el("div", "block-head");
      bh.appendChild(el("div", "block-name", `Bloque <b>${br.block}</b> · ${blockName[br.block]}`));
      bh.appendChild(el("div", "block-dur", `~${F.blockDurationMin(br)} min`));
      blk.appendChild(bh);

      br.elements.forEach(item => {
        const node = el("div", "element" + (item.isSuperset ? " ss" : ""));
        const tag = el("div", "el-tag");
        tag.appendChild(el("span", "el-kind", item.isSuperset ? "Superserie" : "Set directo"));
        tag.appendChild(el("span", "quality q-" + item.quality, F.QUALITY_NAME[item.quality]));
        node.appendChild(tag);
        item.prescriptions.forEach(p => {
          const name = p.exercise.name;
          const ex = el("div", "exercise");
          const st = el("div", "stripe"); st.style.background = STRIPE[p.exercise.pattern] || "#6b7280";
          ex.appendChild(st);
          const body = el("div", "ex-body");
          const star = p.exercise.tier === "FUNDAMENTAL" ? '<span class="star">★</span> ' : "";
          body.appendChild(el("div", "ex-name", star + name));
          body.appendChild(el("div", "ex-meta", `${F.PAT_LABEL[p.exercise.pattern]} · SNC ${p.exercise.cns}`));
          ex.appendChild(body);
          const doseEl = el("div", "ex-dose");
          doseEl.appendChild(el("div", null, dose(p)));
          const baseKg = F.suggestKg(p.exercise.load, range.min, range.max, state.cfg.profile, p.exercise);
          if (baseKg != null) {
            const savedKg = state.kg[name];
            if (editable) {
              // Default to the kg the user last dialed in for this exercise;
              // fall back to the engine's suggestion. Persisted on change.
              let curKg = savedKg != null ? savedKg : baseKg;
              curKg = Math.max(range.min, Math.min(range.max, curKg));
              const kgRow = el("div", "ex-kg-row");
              const dec = el("button", "kg-adj", "−");
              const kgSpan = el("span", "ex-kg", curKg + " kg");
              const inc = el("button", "kg-adj", "+");
              const set = v => { curKg = Math.max(range.min, Math.min(range.max, v)); kgSpan.textContent = curKg + " kg"; state.kg[name] = curKg; saveKg(); };
              dec.onclick = () => set(curKg - 2);
              inc.onclick = () => set(curKg + 2);
              kgRow.appendChild(dec); kgRow.appendChild(kgSpan); kgRow.appendChild(inc);
              doseEl.appendChild(kgRow);
              if (savedKg == null) doseEl.appendChild(el("div", "ex-kg-hint", "sugerido"));
            } else {
              // Show the user's last kg if known, else the suggestion.
              doseEl.appendChild(el("div", "ex-kg", (savedKg != null ? savedKg : baseKg) + " kg"));
            }
          }
          ex.appendChild(doseEl);
          if (editable) {
            const isPinned = pinnedIndex(name) >= 0;
            const pinBtn = el("button", "icon-btn pin-ex" + (isPinned ? " on" : ""), "★");
            pinBtn.title = isPinned ? "Desfijar" : "Fijar para regenerar";
            pinBtn.onclick = () => {
              const idx = pinnedIndex(name);
              if (idx >= 0) {
                state.cfg.pinned.splice(idx, 1);
                pinBtn.className = "icon-btn pin-ex";
                pinBtn.title = "Fijar para regenerar";
              } else {
                state.cfg.pinned.push({ name, block: br.block });
                pinBtn.className = "icon-btn pin-ex on";
                pinBtn.title = "Desfijar";
              }
              updatePinnedCount();
              saveConfig();
            };
            ex.appendChild(pinBtn);
          }
          node.appendChild(ex);
        });
        node.appendChild(el("div", "el-note", item.note));
        blk.appendChild(node);
      });
      into.appendChild(blk);
    });
  }

  // ---- Guided workout timer --------------------------------------------
  // Flattens a routine into an ordered list of work/rest phases (from the
  // engine's per-element timeline) and drives a full-screen countdown.
  let timer = null;
  function timerDose(p) {
    const perSide = p.exercise.symmetry === F.SIM.UNILATERAL;
    if (p.exercise.dynamics === F.DIN.ISO) return `~${p.exercise.holdSec || 35}s` + (perSide ? " / lado" : "");
    return `${p.reps} reps` + (perSide ? " / lado" : "");
  }
  function buildTimerSteps(routine) {
    const steps = [];
    routine.blocks.forEach(br => br.elements.forEach(elm => {
      // 30 s changeover before every element except the very first.
      if (steps.length) steps.push({ kind: "rest", sec: 30, label: "Cambio de ejercicio", block: br.block });
      F.elementTimeline(elm).forEach(ph => steps.push(Object.assign({ block: br.block }, ph)));
    }));
    return steps;
  }
  function ensureTimerOverlay() {
    let o = $("#timer-overlay");
    if (o) return o;
    o = el("div", "timer-overlay hidden"); o.id = "timer-overlay";
    o.innerHTML =
      '<div class="timer-inner">' +
      '<div class="timer-top"><span id="t-step" class="timer-step"></span>' +
      '<button id="t-close" class="timer-x" title="Cerrar">✕</button></div>' +
      '<div id="t-kind" class="timer-kind"></div>' +
      '<div id="t-name" class="timer-name"></div>' +
      '<div id="t-sub" class="timer-sub"></div>' +
      '<div id="t-count" class="timer-count">0:00</div>' +
      '<div id="t-next" class="timer-next"></div>' +
      '<div class="timer-controls">' +
      '<button id="t-prev" class="btn btn-ghost">‹</button>' +
      '<button id="t-pause" class="btn btn-forge">Pausa</button>' +
      '<button id="t-skip" class="btn btn-ghost">›</button>' +
      '</div></div>';
    document.body.appendChild(o);
    return o;
  }
  function startTimer(routine) {
    if (!routine || !routine.blocks) return;
    const steps = buildTimerSteps(routine);
    if (!steps.length) { toast("Rutina vacia"); return; }
    if (timer) clearInterval(timer.tick);
    const o = ensureTimerOverlay(); o.classList.remove("hidden");
    const T = timer = { i: 0, remaining: 0, paused: false, tick: null };
    const fmt = sec => Math.floor(sec / 60) + ":" + String(Math.max(0, sec) % 60).padStart(2, "0");
    function render() {
      const s = steps[T.i];
      $("#t-step").textContent = `Paso ${T.i + 1} / ${steps.length}`;
      o.classList.toggle("rest", s.kind === "rest");
      if (s.kind === "work") {
        $("#t-kind").textContent = "TRABAJO · Bloque " + s.block;
        $("#t-name").textContent = s.prescription.exercise.name;
        $("#t-sub").textContent = `Serie ${s.setNo}/${s.totalSets} · ${timerDose(s.prescription)}`;
      } else {
        $("#t-kind").textContent = "DESCANSO";
        $("#t-name").textContent = s.label || "Descanso";
        $("#t-sub").textContent = "";
      }
      const nxt = steps[T.i + 1];
      $("#t-next").textContent = nxt
        ? "Sigue: " + (nxt.kind === "work" ? nxt.prescription.exercise.name : (nxt.label || "descanso"))
        : "Ultima fase";
      $("#t-count").textContent = fmt(T.remaining);
    }
    function load(i) { T.i = Math.max(0, Math.min(steps.length - 1, i)); T.remaining = steps[T.i].sec; render(); }
    function finish() { toast("Entrenamiento completado"); stop(); }
    function stop() { clearInterval(T.tick); o.classList.add("hidden"); timer = null; }
    function onTick() {
      if (T.paused) return;
      T.remaining--;
      if (T.remaining <= 0) {
        if (navigator.vibrate) navigator.vibrate(120);
        if (T.i >= steps.length - 1) { $("#t-count").textContent = "0:00"; finish(); return; }
        load(T.i + 1); return;
      }
      $("#t-count").textContent = fmt(T.remaining);
    }
    $("#t-pause").onclick = () => { T.paused = !T.paused; $("#t-pause").textContent = T.paused ? "Reanudar" : "Pausa"; };
    $("#t-prev").onclick = () => load(T.i - 1);
    $("#t-skip").onclick = () => { if (T.i >= steps.length - 1) finish(); else load(T.i + 1); };
    $("#t-close").onclick = stop;
    load(0);
    T.tick = setInterval(onTick, 1000);
  }

  // ---- Generate
  function filteredPool() { return F.filterByEquipment(state.pool, state.cfg.equipment); }

  function calcRecent() {
    if (!state.cfg.vary) return null;
    const rec = {}; const weights = [4, 2, 1];   // last 3 sessions, decaying
    state.hist.slice(0, 3).forEach((h, idx) => {
      const w = weights[idx] || 0;
      h.routine.blocks.forEach(b => b.elements.forEach(el => el.prescriptions.forEach(p => {
        rec[p.exercise.name] = (rec[p.exercise.name] || 0) + w;
      })));
    });
    return rec;
  }

  function generateRoutine() {
    const c = state.cfg;
    const opts = { objective: c.objective, focus: c.focus.length ? c.focus : ["FULL"], equipment: c.equipment,
      balance: c.balance, tolerance: c.tolerance, pinned: c.pinned, recent: calcRecent(), seed: null };
    if (c.volumeMode === "structure") opts.structure = c.structure; else opts.minutes = c.minutes;
    const r = F.generate(state.pool, opts);
    state.routine = r;
    renderRoutine(r, $("#routine-out"), { min: c.weightMin, max: c.weightMax }, true);
    $("#save-row").classList.remove("hidden");
    saveConfig();
  }

  function applyFocusUI() {
    const off = state.cfg.focus.length > 0;
    $("#card-balance").classList.toggle("disabled", off);
    $("#balance-note").classList.toggle("hidden", !off);
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
    const valid = new Set(filteredPool().map(e => e.name));
    state.cfg.pinned = state.cfg.pinned.filter(f => valid.has(f.name));
  }
  const pinnedIndex = n => state.cfg.pinned.findIndex(f => f.name === n);
  // Exercises matching the equipment AND the active tag filters.
  function pinPoolFiltered() {
    return filteredPool().filter(e =>
      (!pinFilter.pattern.length  || pinFilter.pattern.includes(e.pattern)) &&
      (!pinFilter.dynamics.length || pinFilter.dynamics.includes(e.dynamics)) &&
      (!pinFilter.tier.length     || pinFilter.tier.includes(e.tier)));
  }

  function renderPinFilters() {
    const host = $("#pin-filters"); host.innerHTML = "";
    const groups = [
      { key: "pattern",  label: "Patron",   labels: F.PAT_LABEL },
      { key: "dynamics", label: "Dinamica", labels: F.DIN_LABEL },
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
    if (!list.length) wrap.appendChild(el("div", "pin-empty", "Ningun ejercicio coincide con los filtros."));
    list.forEach(e => {
      const b = el("button", "chip fijado", e.name);
      b.setAttribute("aria-pressed", String(pinnedIndex(e.name) >= 0));
      b.onclick = () => {
        const i = pinnedIndex(e.name);
        if (i >= 0) state.cfg.pinned.splice(i, 1); else state.cfg.pinned.push({ name: e.name, block: "AUTO" });
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
        const up = el("button", "kg-adj", "▲"); up.title = "Subir"; up.disabled = i === 0; up.onclick = () => move(i, -1);
        const dn = el("button", "kg-adj", "▼"); dn.title = "Bajar"; dn.disabled = i === state.cfg.pinned.length - 1; dn.onclick = () => move(i, 1);
        ord.appendChild(up); ord.appendChild(dn);
        left.appendChild(ord);
        left.appendChild(el("span", "pin-asig-name", f.name));
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

  function saveToHistory() {
    if (!state.routine) return;
    const r = state.routine;
    state.hist.unshift({
      id: nextId(),
      date: new Date().toISOString(),
      objective: state.cfg.objective, minutes: state.cfg.minutes, balance: state.cfg.balance,
      duration: F.routineDurationMin(r), routine: r, completed: false, range: { min: state.cfg.weightMin, max: state.cfg.weightMax },
    });
    saveHistory(); toast("Guardada en el historial"); renderHistory();
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
        if (ex.order) detail.appendChild(el("div", "label", ex.order));
      }
      const item = el("div", "manual-ex");
      const top = el("div", "manual-ex-top");
      top.appendChild(el("span", "manual-ex-name", ex.name));
      if (ex.kg != null) top.appendChild(el("span", "manual-ex-kg", ex.kg + " kg"));
      item.appendChild(top);
      const reps = ex.sets.reduce((a, n) => a + n, 0);
      const series = ex.sets.length ? ex.sets.join(" · ") : "—";
      item.appendChild(el("div", "manual-ex-sets", `Series: ${series}  ·  ${reps} reps  ·  ${Math.round(exVol(ex))} kg`));
      if (ex.note) item.appendChild(el("div", "manual-ex-note", ex.note));
      detail.appendChild(item);
    });

    const actions = el("div", "hist-actions");
    if (editing) {
      const save = el("button", "icon-btn on", "✓"); save.title = "Guardar cambios";
      save.onclick = () => { manualEditId = null; saveHistory(); renderHistory(); toast("Registro actualizado"); };
      actions.appendChild(save);
    } else {
      const edit = el("button", "icon-btn", "✎"); edit.title = "Editar registro";
      edit.onclick = () => { manualEditId = h.id; renderHistory(); };
      const okBtn = el("button", "icon-btn" + (h.completed ? " on" : ""), "✓");
      okBtn.title = "Marcar completada";
      okBtn.onclick = () => { h.completed = !h.completed; saveHistory(); renderHistory(); };
      actions.appendChild(edit); actions.appendChild(okBtn);
    }
    const del = el("button", "icon-btn del", "✕"); del.title = "Eliminar";
    del.onclick = () => { manualEditId = null; state.hist = state.hist.filter(x => x.id !== h.id); saveHistory(); renderHistory(); toast("Sesion eliminada"); };
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

    const add = el("button", "btn btn-ghost", "+ Anadir ejercicio");
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
    if (!h.routine) return 0;
    const range = h.range || { min: state.cfg.weightMin, max: state.cfg.weightMax };
    let vol = 0;
    h.routine.blocks.forEach(b => b.elements.forEach(elm => elm.prescriptions.forEach(p => {
      const name = p.exercise.name;
      const kg = state.kg[name] != null ? state.kg[name] : (F.suggestKg(p.exercise.load, range.min, range.max, state.cfg.profile, p.exercise) || 0);
      vol += kg * p.sets * p.reps;
    })));
    return Math.round(vol);
  }

  function renderStats() {
    const host = $("#hist-stats"); host.innerHTML = "";
    if (state.hist.length < 2) return;   // not enough data to be interesting
    const card = el("div", "card stats-card");
    card.appendChild(el("div", "label", "Progreso · volumen por sesion"));

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
    row.appendChild(fig(week, "ult. 7 dias"));
    card.appendChild(row);
    host.appendChild(card);
  }

  // ---- Render: history
  function renderHistory() {
    renderStats();
    const list = $("#hist-list"); list.innerHTML = "";
    if (!state.hist.length) {
      list.appendChild(el("div", "empty", "<b>Sin sesiones todavia</b>Genera una rutina y guardala para llevar el registro."));
      return;
    }
    state.hist.forEach(h => {
      if (h.manual) { list.appendChild(renderManualCard(h)); return; }
      const card = el("div", "card");
      card.style.padding = "0";
      const row = el("div", "hist-item");
      const meta = el("div", "hist-meta");
      const d = new Date(h.date);
      const dateStr = d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) + " " +
        d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
      meta.appendChild(el("div", "hist-title", (h.objective === "STRENGTH" ? "Fuerza" : "Metabolico")));
      meta.appendChild(el("div", "hist-sub", `${dateStr} · ~${h.duration} min · balance ${h.balance.toLowerCase()}`));
      meta.style.cursor = "pointer";
      const detail = el("div"); detail.style.padding = "0 14px 14px"; detail.classList.add("hidden");
      meta.onclick = () => {
        if (detail.classList.contains("hidden")) { renderRoutine(h.routine, detail, h.range); detail.classList.remove("hidden"); }
        else detail.classList.add("hidden");
      };
      const actions = el("div", "hist-actions");
      const trainBtn = el("button", "icon-btn", "▶"); trainBtn.title = "Entrenar con temporizador";
      trainBtn.onclick = () => startTimer(h.routine);
      const okBtn = el("button", "icon-btn" + (h.completed ? " on" : ""), "✓");
      okBtn.title = "Marcar completada";
      okBtn.onclick = () => { h.completed = !h.completed; saveHistory(); renderHistory(); };
      const del = el("button", "icon-btn del", "✕"); del.title = "Eliminar";
      del.onclick = () => { state.hist = state.hist.filter(x => x.id !== h.id); saveHistory(); renderHistory(); toast("Sesion eliminada"); };
      actions.appendChild(trainBtn); actions.appendChild(okBtn); actions.appendChild(del);
      row.appendChild(meta); row.appendChild(actions);
      card.appendChild(row); card.appendChild(detail);
      list.appendChild(card);
    });
  }

  // ---- Render: pool
  function renderPool() {
    const list = $("#pool-list"); list.innerHTML = "";
    const sorted = state.pool.slice().sort((a, b) => a.pattern.localeCompare(b.pattern) || a.name.localeCompare(b.name));
    sorted.forEach(e => {
      const card = el("div", "card"); card.style.padding = "0";
      const row = el("div", "pool-item");
      const st = el("div", "stripe"); st.style.background = STRIPE[e.pattern] || "#6b7280"; st.style.minHeight = "42px";
      row.appendChild(st);
      const body = el("div", "ex-body");
      body.appendChild(el("div", "ex-name", e.name));
      const tags = el("div", "pool-tags");
      tags.appendChild(el("span", "tag", F.PAT_LABEL[e.pattern]));
      tags.appendChild(el("span", "tag", F.DIN_LABEL[e.dynamics].split("/")[0]));
      if (e.tier === "FUNDAMENTAL") tags.appendChild(el("span", "tag tier-fund", "★ fundamental"));
      else if (e.tier === "OPTIONAL") tags.appendChild(el("span", "tag", "opcional"));
      tags.appendChild(el("span", "tag snc-" + e.cns, "SNC " + e.cns));
      if (e.grip) tags.appendChild(el("span", "tag", "agarre"));
      tags.appendChild(el("span", "tag", "carga " + F.LOAD_LABEL[e.load].toLowerCase()));
      tags.appendChild(el("span", "tag", e.equipment.join("+")));
      if (state.overrides[e.name]) tags.appendChild(el("span", "tag", "editado"));
      body.appendChild(tags);
      row.appendChild(body);
      row.style.cursor = "pointer";
      row.onclick = () => openForEdit(e);
      const del = el("button", "icon-btn del", "✕"); del.title = "Quitar del pool";
      del.onclick = (ev) => {
        ev.stopPropagation();
        if (isBaseExercise(e.name)) { if (!state.removed.includes(e.name)) state.removed.push(e.name); }
        else { state.custom = state.custom.filter(x => x.name !== e.name); }
        state.cfg.pinned = state.cfg.pinned.filter(f => f.name !== e.name);
        computePool(); savePoolState(); saveConfig(); renderPool(); updatePinnedCount(); toast("Quitado del pool");
      };
      row.appendChild(del);
      card.appendChild(row); list.appendChild(card);
    });
    $("#pool-count").textContent = state.pool.length + " ejercicios";
  }

  function readForm() {
    const equipment = [];
    if ($("#f-eq-kb").checked) equipment.push(F.EQ.KB);
    if ($("#f-eq-barbell").checked) equipment.push(F.EQ.BARBELL);
    if ($("#f-eq-floor").checked) equipment.push(F.EQ.FLOOR);
    if (!equipment.length) equipment.push(F.EQ.FLOOR);
    return { pattern: $("#f-pattern").value, dynamics: $("#f-dynamics").value,
      symmetry: $("#f-symmetry").value, cns: $("#f-cns").value, equipment,
      grip: $("#f-grip").checked, load: parseInt($("#f-load").value, 10), tier: $("#f-tier").value };
  }
  function fillForm(e) {
    $("#f-name").value = e.name;
    $("#f-pattern").value = e.pattern; $("#f-dynamics").value = e.dynamics;
    $("#f-symmetry").value = e.symmetry; $("#f-cns").value = e.cns;
    $("#f-load").value = String(e.load); $("#f-tier").value = e.tier;
    $("#f-grip").checked = !!e.grip;
    $("#f-eq-kb").checked = e.equipment.includes("KB");
    $("#f-eq-barbell").checked = e.equipment.includes("BARBELL");
    $("#f-eq-floor").checked = e.equipment.includes("FLOOR");
  }
  function resetForm() {
    state.editing = null;
    $("#pool-form-title").textContent = "Nuevo ejercicio";
    $("#btn-add").textContent = "Anadir al pool";
    $("#f-name").value = ""; $("#f-name").disabled = false;
    $("#f-pattern").selectedIndex = 0; $("#f-dynamics").selectedIndex = 0;
    $("#f-symmetry").selectedIndex = 0; $("#f-cns").selectedIndex = 0;
    $("#f-load").value = "2"; $("#f-tier").value = "ACCESSORY";
    $("#f-grip").checked = false;
    $("#f-eq-kb").checked = true; $("#f-eq-barbell").checked = false; $("#f-eq-floor").checked = false;
  }
  function openForEdit(e) {
    state.editing = e.name;
    fillForm(e);
    $("#f-name").disabled = true;   // name is the key; not renamed when editing
    $("#pool-form-title").textContent = "Editar: " + e.name;
    $("#btn-add").textContent = "Guardar cambios";
    $("#pool-form").classList.remove("hidden");
    const pf = $("#pool-form"); if (pf.scrollIntoView) pf.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function saveExercise() {
    const fields = readForm();
    if (state.editing) {
      const name = state.editing;
      if (isBaseExercise(name)) state.overrides[name] = fields;             // modification over the base
      else state.custom = state.custom.map(x => x.name === name ? F.newExercise(Object.assign({ name }, fields)) : x);
      computePool(); savePoolState(); renderPool();
      $("#pool-form").classList.add("hidden"); resetForm(); toast("Cambios guardados");
      return;
    }
    const name = $("#f-name").value.trim();
    if (!name) { toast("Ponle un nombre"); return; }
    if (state.pool.some(e => e.name.toLowerCase() === name.toLowerCase())) { toast("Ese nombre ya existe"); return; }
    state.custom.push(F.newExercise(Object.assign({ name }, fields)));
    computePool(); savePoolState(); renderPool();
    $("#pool-form").classList.add("hidden"); resetForm(); toast("Ejercicio anadido");
  }

  // ---- Export / Import
  function exportData() {
    const payload = JSON.stringify({
      version: 1,
      date: new Date().toISOString(),
      hist: state.hist,
      custom: state.custom,
      removed: state.removed,
      overrides: state.overrides,
    }, null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    a.download = "forja-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data || typeof data !== "object") throw new Error("invalid");
        state.hist = Array.isArray(data.hist) ? data.hist : state.hist;
        state.custom = Array.isArray(data.custom) ? data.custom : state.custom;
        state.removed = Array.isArray(data.removed) ? data.removed : state.removed;
        state.overrides = (data.overrides && typeof data.overrides === "object") ? data.overrides : state.overrides;
        await Promise.all([
          Store.set(K.HIST, JSON.stringify(state.hist)),
          savePoolState(),
        ]);
        computePool();
        renderPool();
        toast(`Importado: ${state.hist.length} sesiones, ${state.custom.length} ejercicios propios`);
      } catch (_) {
        toast("Error al importar: archivo no valido");
      }
    };
    reader.readAsText(file);
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
    if (!byDate.size) throw new Error("sin filas validas");

    return [...byDate.entries()].map(([iso, exercises]) => ({
      id: nextId(), date: iso, manual: true, completed: true, exercises,
    }));
  }

  function importCsvSessions(text) {
    let sessions;
    try { sessions = parseSessionsCsv(text); }
    catch (err) { toast("CSV no valido: " + err.message); return; }
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
  }

  // ---- Init
  async function init() {
    await loadAll();
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
    setSeg("#seg-sex", state.cfg.profile.sex);
    setSeg("#seg-level", state.cfg.profile.level);
    $("#kg-min-val").textContent = state.cfg.weightMin; $("#kg-max-val").textContent = state.cfg.weightMax;
    $("#chip-barbell").setAttribute("aria-pressed", String(state.cfg.equipment.includes("BARBELL")));
    $("#m-range").value = state.cfg.minutes; $("#m-read").textContent = state.cfg.minutes;
    $("#tol-val").textContent = state.cfg.tolerance;
    $("#tol-wrap").classList.toggle("hidden", state.cfg.balance !== "HARD");
    ["A", "B", "C"].forEach(k => { $("#est-" + k + "-val").textContent = state.cfg.structure[k]; });
    applyFocusUI(); applyVolumeUI(); updatePinnedCount();

    wireSeg("#seg-objective", v => { state.cfg.objective = v; saveConfig(); });
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
      state.cfg.equipment = on ? ["KB", "BARBELL"] : ["KB"];
      prunePinned(); updatePinnedCount();
      if (!$("#pin-panel").classList.contains("hidden")) renderPinned();
      saveConfig();
    };

    $("#m-range").oninput = e => { state.cfg.minutes = parseInt(e.target.value, 10); $("#m-read").textContent = state.cfg.minutes; };
    $("#m-range").onchange = saveConfig;

    $("#tol-dec").onclick = () => { state.cfg.tolerance = Math.max(0, state.cfg.tolerance - 1); $("#tol-val").textContent = state.cfg.tolerance; saveConfig(); };
    $("#tol-inc").onclick = () => { state.cfg.tolerance = Math.min(3, state.cfg.tolerance + 1); $("#tol-val").textContent = state.cfg.tolerance; saveConfig(); };

    $("#btn-generar").onclick = generateRoutine;
    $("#btn-regenerar").onclick = generateRoutine;
    $("#btn-guardar").onclick = saveToHistory;
    $("#btn-train").onclick = () => startTimer(state.routine);

    $("#btn-add-toggle").onclick = () => {
      const panel = $("#pool-form"); const open = panel.classList.contains("hidden");
      if (open) { resetForm(); panel.classList.remove("hidden"); } else panel.classList.add("hidden");
    };
    $("#btn-add").onclick = saveExercise;
    $("#btn-add-cancel").onclick = () => { $("#pool-form").classList.add("hidden"); resetForm(); };

    $("#btn-export").onclick = exportData;
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
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
