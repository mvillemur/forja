/**
 * FORJA — Capa de interfaz (app.js)
 * =================================
 * Responsable de TODO lo que toca el DOM y el navegador. No contiene logica de
 * entrenamiento: esa vive en `engine.js` (window.FORJA). Aqui se gestionan:
 *
 *   - Estado de la app (`state`): configuracion, pool de ejercicios e historial.
 *   - Almacenamiento offline en cascada (window.storage -> localStorage -> RAM).
 *   - Render de la rutina, el historial, el pool y los formularios.
 *   - Eventos de la interfaz (segmented controls, steppers, chips, navegacion).
 *
 * Modelo de datos del pool (clave de la mantenibilidad):
 *   - `state.custom`    : ejercicios añadidos por el usuario.
 *   - `state.removed`   : nombres de ejercicios base ocultados.
 *   - `state.overrides` : modificaciones por nombre sobre ejercicios base.
 *   El pool efectivo (`state.pool`) se RECOMPUTA siempre desde el catalogo base
 *   actual (FORJA.CATALOGO_BASE) aplicando esas tres capas. Asi, ampliar el
 *   catalogo base hace aparecer los nuevos ejercicios sin romper lo del usuario.
 *
 * Dependencias: window.FORJA (engine.js). Sin librerias externas.
 */
(function () {
  "use strict";
  const F = window.FORJA;

  // ---- Almacenamiento en cascada: window.storage -> localStorage -> memoria
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

  const K = { HIST: "forja:hist", POOL: "forja:pool", CUSTOM: "forja:custom", REMOVED: "forja:removed", OVERRIDES: "forja:overrides", CFG: "forja:cfg" };
  // Nombres del catalogo original (24): referencia para migrar sin ocultar altas nuevas.
  const LEGACY_BASE = [
    "Peso Muerto Rumano / Fijo", "Kettlebell Swings (Dos manos)", "Alternating Swings", "Swing Cleans",
    "Dead Cleans", "Sentadilla Goblet", "Goblet Clean Squat", "Pit Squats", "Alt Lunges", "Remo a una mano",
    "Two Hand Row", "Bent Rows (Alternating)", "Upright Row", "Dominadas Neutras", "Clean & Press Combinado",
    "Goblet Shoulder Press", "Rotational Press", "Dead Clean Push Press", "Close Grip Pushup", "Halos",
    "Kneeling Around The Worlds", "Half-Racked Marches", "Goblet Overhead March", "Burpees",
  ];

  const STRIPE = { CADERA:"#e8742c", RODILLA:"#e6b450", TIRON_H:"#6fa8c7", TIRON_V:"#5b93b8",
    EMPUJE_H:"#b98cc9", EMPUJE_V:"#a978bf", CORE:"#7fae6a", HIBRIDO:"#d9533b" };

  const state = {
    cfg: { objetivo:"FUERZA", foco:"FULL", equipo:["KB"], pesoMin:12, pesoMax:32,
           modoVol:"tiempo", minutos:45, estructura:{ A:4, B:4, C:2 },
           balance:"NINGUNO", tolerancia:1, fijados:[], variar:true },
    custom: [],       // ejercicios añadidos por el usuario
    removed: [],      // nombres de ejercicios base ocultados
    overrides: {},    // nombre -> campos editados de ejercicios base
    pool: [],         // computado
    hist: [],
    rutina: null,
    editando: null,   // nombre del ejercicio en edicion, o null
  };
  const clon = e => Object.assign({}, e, { equip: e.equip.slice() });
  const esBase = n => F.CATALOGO_BASE.some(e => e.nombre === n);
  function recomputePool() {
    const base = F.CATALOGO_BASE.filter(e => !state.removed.includes(e.nombre)).map(e => {
      const c = clon(e); const ov = state.overrides[e.nombre];
      return ov ? Object.assign(c, ov, { nombre: e.nombre }) : c;
    });
    state.pool = base.concat(state.custom.map(clon));
  }

  const $ = s => document.querySelector(s);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1900);
  }

  // ---- Persistencia
  async function loadAll() {
    try { const h = await Store.get(K.HIST); if (h) state.hist = JSON.parse(h); } catch (e) {}
    try { const c = await Store.get(K.CFG); if (c) Object.assign(state.cfg, JSON.parse(c)); } catch (e) {}
    let cargados = false;
    try {
      const cu = await Store.get(K.CUSTOM); const rm = await Store.get(K.REMOVED);
      if (cu != null || rm != null) { state.custom = cu ? JSON.parse(cu) : []; state.removed = rm ? JSON.parse(rm) : []; cargados = true; }
    } catch (e) {}
    if (!cargados) {
      // Migracion desde el modelo antiguo (pool completo) -> custom + removed.
      // Solo los 24 originales pueden marcarse como 'removidos'; las altas base
      // posteriores (catalogo ampliado) siempre deben aparecer tras migrar.
      try {
        const old = await Store.get(K.POOL);
        if (old) {
          const arr = JSON.parse(old);
          const baseNames = new Set(F.CATALOGO_BASE.map(e => e.nombre));
          const have = new Set(arr.map(e => e.nombre));
          state.custom = arr.filter(e => !baseNames.has(e.nombre));
          state.removed = LEGACY_BASE.filter(n => !have.has(n));
          savePoolState();
        }
      } catch (e) {}
    }
    try { const ov = await Store.get(K.OVERRIDES); if (ov) state.overrides = JSON.parse(ov); } catch (e) {}
    recomputePool();
    // Migracion: fijados como strings -> objetos {nombre, bloque}
    state.cfg.fijados = (state.cfg.fijados || []).map(f => typeof f === "string" ? { nombre: f, bloque: "AUTO" } : f);
  }
  const saveHist = () => Store.set(K.HIST, JSON.stringify(state.hist));
  const savePoolState = () => {
    Store.set(K.CUSTOM, JSON.stringify(state.custom));
    Store.set(K.REMOVED, JSON.stringify(state.removed));
    Store.set(K.OVERRIDES, JSON.stringify(state.overrides));
  };
  const saveCfg = () => Store.set(K.CFG, JSON.stringify(state.cfg));

  // ---- Formato
  const dosis = p => p.ej.dinamica === F.DIN.ISO ? `${p.series}x ~35s` : `${p.series}x${p.reps}`;

  // ---- Render: rutina
  function renderRutina(r, into, rango) {
    into.innerHTML = "";
    if (!r) return;
    rango = rango || { min: state.cfg.pesoMin, max: state.cfg.pesoMax };
    const head = el("div", "routine-head");
    head.appendChild(el("div", "routine-title", r.plantilla));
    head.appendChild(el("div", "routine-dur", `~${F.duracionRutinaMin(r)} min`));
    into.appendChild(head);

    const nombreBloque = { A: "Principal", B: "Accesorios", C: "Finalizador" };
    r.bloques.forEach(br => {
      if (!br.elementos.length) return;
      const blk = el("div", "block");
      const bh = el("div", "block-head");
      bh.appendChild(el("div", "block-name", `Bloque <b>${br.bloque}</b> · ${nombreBloque[br.bloque]}`));
      bh.appendChild(el("div", "block-dur", `~${F.duracionBloqueMin(br)} min`));
      blk.appendChild(bh);

      br.elementos.forEach(item => {
        const node = el("div", "element" + (item.esSuperserie ? " ss" : ""));
        const tag = el("div", "el-tag");
        tag.appendChild(el("span", "el-kind", item.esSuperserie ? "Superserie" : "Set directo"));
        tag.appendChild(el("span", "quality q-" + item.calidad, F.CAL_NOMBRE[item.calidad]));
        node.appendChild(tag);
        item.prescripciones.forEach(p => {
          const ex = el("div", "exercise");
          const st = el("div", "stripe"); st.style.background = STRIPE[p.ej.patron] || "#6b7280";
          ex.appendChild(st);
          const body = el("div", "ex-body");
          const estrella = p.ej.tier === "FUNDAMENTAL" ? '<span class="star">★</span> ' : "";
          body.appendChild(el("div", "ex-name", estrella + p.ej.nombre));
          body.appendChild(el("div", "ex-meta", `${F.PAT_LABEL[p.ej.patron]} · SNC ${p.ej.snc}`));
          ex.appendChild(body);
          const dose = el("div", "ex-dose");
          dose.appendChild(el("div", null, dosis(p)));
          const kg = F.sugerirKg(p.ej.carga, rango.min, rango.max);
          if (kg != null) dose.appendChild(el("div", "ex-kg", kg + " kg"));
          ex.appendChild(dose);
          node.appendChild(ex);
        });
        node.appendChild(el("div", "el-note", item.nota));
        blk.appendChild(node);
      });
      into.appendChild(blk);
    });
  }

  // ---- Generar
  function poolFiltrado() { return F.filtrarEquipo(state.pool, state.cfg.equipo); }

  function calcRecientes() {
    if (!state.cfg.variar) return null;
    const rec = {}; const pesos = [4, 2, 1];   // ultimas 3 sesiones, decayendo
    state.hist.slice(0, 3).forEach((h, idx) => {
      const w = pesos[idx] || 0;
      h.rutina.bloques.forEach(b => b.elementos.forEach(el => el.prescripciones.forEach(p => {
        rec[p.ej.nombre] = (rec[p.ej.nombre] || 0) + w;
      })));
    });
    return rec;
  }

  function generar() {
    const c = state.cfg;
    const opts = { objetivo: c.objetivo, foco: c.foco, equipo: c.equipo,
      balance: c.balance, tolerancia: c.tolerancia, fijados: c.fijados, recientes: calcRecientes(), semilla: null };
    if (c.modoVol === "estructura") opts.estructura = c.estructura; else opts.minutos = c.minutos;
    const r = F.generar(state.pool, opts);
    state.rutina = r;
    renderRutina(r, $("#rutina-out"), { min: c.pesoMin, max: c.pesoMax });
    $("#save-row").classList.remove("hidden");
    saveCfg();
  }

  function applyFocoUI() {
    const off = state.cfg.foco !== "FULL";
    $("#card-balance").classList.toggle("disabled", off);
    $("#balance-nota").classList.toggle("hidden", !off);
  }
  function applyVolUI() {
    const est = state.cfg.modoVol === "estructura";
    $("#vol-tiempo").classList.toggle("hidden", est);
    $("#vol-estructura").classList.toggle("hidden", !est);
  }
  function updateFijarCount() {
    const n = state.cfg.fijados.length;
    $("#fijar-count").textContent = n ? "(" + n + ")" : "";
  }
  function pruneFijados() {
    const validos = new Set(poolFiltrado().map(e => e.nombre));
    state.cfg.fijados = state.cfg.fijados.filter(f => validos.has(f.nombre));
  }
  const fijIndex = n => state.cfg.fijados.findIndex(f => f.nombre === n);
  function renderFijar() {
    const wrap = $("#fijar-chips"); wrap.innerHTML = "";
    poolFiltrado().slice().sort((a, b) => a.nombre.localeCompare(b.nombre)).forEach(e => {
      const b = el("button", "chip fijado", e.nombre);
      b.setAttribute("aria-pressed", String(fijIndex(e.nombre) >= 0));
      b.onclick = () => {
        const i = fijIndex(e.nombre);
        if (i >= 0) state.cfg.fijados.splice(i, 1); else state.cfg.fijados.push({ nombre: e.nombre, bloque: "AUTO" });
        updateFijarCount(); saveCfg(); renderFijar();
      };
      wrap.appendChild(b);
    });
    // Asignacion de bloque por cada fijado
    const asig = $("#fijar-asignados"); asig.innerHTML = "";
    if (state.cfg.fijados.length) {
      asig.appendChild(el("div", "label", "Bloque de cada fijado"));
      state.cfg.fijados.forEach(f => {
        const row = el("div", "est-row");
        row.appendChild(el("span", null, f.nombre));
        const sel = document.createElement("select");
        ["AUTO", "A", "B", "C"].forEach(o => { const op = document.createElement("option"); op.value = o; op.textContent = o === "AUTO" ? "Auto" : "Bloque " + o; if (f.bloque === o) op.selected = true; sel.appendChild(op); });
        sel.style.cssText = "padding:6px 8px;border-radius:8px;border:1px solid var(--line-2);background:var(--bg-2);color:var(--ink);font-size:13px;";
        sel.onchange = () => { f.bloque = sel.value; saveCfg(); };
        row.appendChild(sel);
        asig.appendChild(row);
      });
    }
  }

  function guardarHist() {
    if (!state.rutina) return;
    const r = state.rutina;
    state.hist.unshift({
      id: Date.now(),
      fecha: new Date().toISOString(),
      objetivo: state.cfg.objetivo, minutos: state.cfg.minutos, balance: state.cfg.balance,
      dur: F.duracionRutinaMin(r), rutina: r, completada: false, rango: { min: state.cfg.pesoMin, max: state.cfg.pesoMax },
    });
    saveHist(); toast("Guardada en el historial"); renderHist();
  }

  // ---- Render: historial
  function renderHist() {
    const list = $("#hist-list"); list.innerHTML = "";
    if (!state.hist.length) {
      list.appendChild(el("div", "empty", "<b>Sin sesiones todavia</b>Genera una rutina y guardala para llevar el registro."));
      return;
    }
    state.hist.forEach(h => {
      const card = el("div", "card");
      card.style.padding = "0";
      const row = el("div", "hist-item");
      const meta = el("div", "hist-meta");
      const d = new Date(h.fecha);
      const fecha = d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) + " " +
        d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
      meta.appendChild(el("div", "hist-title", (h.objetivo === "FUERZA" ? "Fuerza" : "Metabolico")));
      meta.appendChild(el("div", "hist-sub", `${fecha} · ~${h.dur} min · balance ${h.balance.toLowerCase()}`));
      meta.style.cursor = "pointer";
      const detalle = el("div"); detalle.style.padding = "0 14px 14px"; detalle.classList.add("hidden");
      meta.onclick = () => {
        if (detalle.classList.contains("hidden")) { renderRutina(h.rutina, detalle, h.rango); detalle.classList.remove("hidden"); }
        else detalle.classList.add("hidden");
      };
      const actions = el("div", "hist-actions");
      const ok = el("button", "icon-btn" + (h.completada ? " on" : ""), "✓");
      ok.title = "Marcar completada";
      ok.onclick = () => { h.completada = !h.completada; saveHist(); renderHist(); };
      const del = el("button", "icon-btn del", "✕"); del.title = "Eliminar";
      del.onclick = () => { state.hist = state.hist.filter(x => x.id !== h.id); saveHist(); renderHist(); toast("Sesion eliminada"); };
      actions.appendChild(ok); actions.appendChild(del);
      row.appendChild(meta); row.appendChild(actions);
      card.appendChild(row); card.appendChild(detalle);
      list.appendChild(card);
    });
  }

  // ---- Render: pool
  function renderPool() {
    const list = $("#pool-list"); list.innerHTML = "";
    const ordenado = state.pool.slice().sort((a, b) => a.patron.localeCompare(b.patron) || a.nombre.localeCompare(b.nombre));
    ordenado.forEach(e => {
      const card = el("div", "card"); card.style.padding = "0";
      const row = el("div", "pool-item");
      const st = el("div", "stripe"); st.style.background = STRIPE[e.patron] || "#6b7280"; st.style.minHeight = "42px";
      row.appendChild(st);
      const body = el("div", "ex-body");
      body.appendChild(el("div", "ex-name", e.nombre));
      const tags = el("div", "pool-tags");
      tags.appendChild(el("span", "tag", F.PAT_LABEL[e.patron]));
      tags.appendChild(el("span", "tag", F.DIN_LABEL[e.dinamica].split("/")[0]));
      if (e.tier === "FUNDAMENTAL") tags.appendChild(el("span", "tag tier-fund", "★ fundamental"));
      else if (e.tier === "OPCIONAL") tags.appendChild(el("span", "tag", "opcional"));
      tags.appendChild(el("span", "tag snc-" + e.snc, "SNC " + e.snc));
      if (e.agarre) tags.appendChild(el("span", "tag", "agarre"));
      tags.appendChild(el("span", "tag", "carga " + F.CAR_LABEL[e.carga].toLowerCase()));
      tags.appendChild(el("span", "tag", e.equip.join("+")));
      if (state.overrides[e.nombre]) tags.appendChild(el("span", "tag", "editado"));
      body.appendChild(tags);
      row.appendChild(body);
      row.style.cursor = "pointer";
      row.onclick = () => abrirEdicion(e);
      const del = el("button", "icon-btn del", "✕"); del.title = "Quitar del pool";
      del.onclick = (ev) => {
        ev.stopPropagation();
        if (esBase(e.nombre)) { if (!state.removed.includes(e.nombre)) state.removed.push(e.nombre); }
        else { state.custom = state.custom.filter(x => x.nombre !== e.nombre); }
        state.cfg.fijados = state.cfg.fijados.filter(f => f.nombre !== e.nombre);
        recomputePool(); savePoolState(); saveCfg(); renderPool(); updateFijarCount(); toast("Quitado del pool");
      };
      row.appendChild(del);
      card.appendChild(row); list.appendChild(card);
    });
    $("#pool-count").textContent = state.pool.length + " ejercicios";
  }

  function leerForm() {
    const equip = [];
    if ($("#f-eq-kb").checked) equip.push(F.EQ.KB);
    if ($("#f-eq-barra").checked) equip.push(F.EQ.BARRA);
    if ($("#f-eq-suelo").checked) equip.push(F.EQ.SUELO);
    if (!equip.length) equip.push(F.EQ.SUELO);
    return { patron: $("#f-patron").value, dinamica: $("#f-dinamica").value,
      simetria: $("#f-simetria").value, snc: $("#f-snc").value, equip,
      agarre: $("#f-agarre").checked, carga: parseInt($("#f-carga").value, 10), tier: $("#f-tier").value };
  }
  function rellenarForm(e) {
    $("#f-nombre").value = e.nombre;
    $("#f-patron").value = e.patron; $("#f-dinamica").value = e.dinamica;
    $("#f-simetria").value = e.simetria; $("#f-snc").value = e.snc;
    $("#f-carga").value = String(e.carga); $("#f-tier").value = e.tier;
    $("#f-agarre").checked = !!e.agarre;
    $("#f-eq-kb").checked = e.equip.includes("KB");
    $("#f-eq-barra").checked = e.equip.includes("BARRA");
    $("#f-eq-suelo").checked = e.equip.includes("SUELO");
  }
  function resetForm() {
    state.editando = null;
    $("#pool-form-title").textContent = "Nuevo ejercicio";
    $("#btn-add").textContent = "Anadir al pool";
    $("#f-nombre").value = ""; $("#f-nombre").disabled = false;
    $("#f-patron").selectedIndex = 0; $("#f-dinamica").selectedIndex = 0;
    $("#f-simetria").selectedIndex = 0; $("#f-snc").selectedIndex = 0;
    $("#f-carga").value = "2"; $("#f-tier").value = "ACCESORIO";
    $("#f-agarre").checked = false;
    $("#f-eq-kb").checked = true; $("#f-eq-barra").checked = false; $("#f-eq-suelo").checked = false;
  }
  function abrirEdicion(e) {
    state.editando = e.nombre;
    rellenarForm(e);
    $("#f-nombre").disabled = true;   // el nombre es la clave; no se renombra al editar
    $("#pool-form-title").textContent = "Editar: " + e.nombre;
    $("#btn-add").textContent = "Guardar cambios";
    $("#pool-form").classList.remove("hidden");
    const pf = $("#pool-form"); if (pf.scrollIntoView) pf.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function guardarEjercicio() {
    const campos = leerForm();
    if (state.editando) {
      const nombre = state.editando;
      if (esBase(nombre)) state.overrides[nombre] = campos;             // modificacion sobre el base
      else state.custom = state.custom.map(x => x.nombre === nombre ? F.nuevoEjercicio(Object.assign({ nombre }, campos)) : x);
      recomputePool(); savePoolState(); renderPool();
      $("#pool-form").classList.add("hidden"); resetForm(); toast("Cambios guardados");
      return;
    }
    const nombre = $("#f-nombre").value.trim();
    if (!nombre) { toast("Ponle un nombre"); return; }
    if (state.pool.some(e => e.nombre.toLowerCase() === nombre.toLowerCase())) { toast("Ese nombre ya existe"); return; }
    state.custom.push(F.nuevoEjercicio(Object.assign({ nombre }, campos)));
    recomputePool(); savePoolState(); renderPool();
    $("#pool-form").classList.add("hidden"); resetForm(); toast("Ejercicio anadido");
  }

  // ---- Controles genericos (segmented + chips)
  function fillSelectOptions() {
    const fill = (sel, pares, def) => {
      const node = $(sel); if (!node) return;
      node.innerHTML = pares.map(([v, t]) => `<option value="${v}"${String(v) === String(def) ? " selected" : ""}>${t}</option>`).join("");
    };
    const cap = k => k[0] + k.slice(1).toLowerCase();
    fill("#f-patron", Object.keys(F.PAT_LABEL).map(k => [k, F.PAT_LABEL[k]]));
    fill("#f-dinamica", Object.keys(F.DIN_LABEL).map(k => [k, F.DIN_LABEL[k]]));
    fill("#f-simetria", ["BILATERAL", "UNILATERAL", "ALTERNO"].map(k => [k, cap(k)]));
    fill("#f-snc", ["ALTA", "MEDIA", "BAJA"].map(k => [k, cap(k)]));
    fill("#f-carga", [[1, "Ligera"], [2, "Media"], [3, "Pesada"]], 2);
    fill("#f-tier", [["FUNDAMENTAL", "Fundamental"], ["ACCESORIO", "Accesorio"], ["OPCIONAL", "Opcional"]], "ACCESORIO");
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

  // ---- Navegacion
  function showView(name) {
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
    document.querySelectorAll(".nav button").forEach(b => b.setAttribute("aria-current", String(b.dataset.view === name)));
    if (name === "hist") renderHist();
    if (name === "pool") renderPool();
  }

  // ---- Init
  async function init() {
    await loadAll();
    fillSelectOptions();

    // reflejar cfg en controles
    setSeg("#seg-objetivo", state.cfg.objetivo);
    setSeg("#seg-foco", state.cfg.foco);
    setSeg("#seg-vol", state.cfg.modoVol);
    setSeg("#seg-balance", state.cfg.balance);
    setSeg("#seg-variar", state.cfg.variar ? "si" : "no");
    $("#kg-min-val").textContent = state.cfg.pesoMin; $("#kg-max-val").textContent = state.cfg.pesoMax;
    $("#chip-barra").setAttribute("aria-pressed", String(state.cfg.equipo.includes("BARRA")));
    $("#m-range").value = state.cfg.minutos; $("#m-read").textContent = state.cfg.minutos;
    $("#tol-val").textContent = state.cfg.tolerancia;
    $("#tol-wrap").classList.toggle("hidden", state.cfg.balance !== "DURO");
    ["A", "B", "C"].forEach(k => { $("#est-" + k + "-val").textContent = state.cfg.estructura[k]; });
    applyFocoUI(); applyVolUI(); updateFijarCount();

    wireSeg("#seg-objetivo", v => { state.cfg.objetivo = v; saveCfg(); });
    wireSeg("#seg-foco", v => { state.cfg.foco = v; applyFocoUI(); saveCfg(); });
    wireSeg("#seg-vol", v => { state.cfg.modoVol = v; applyVolUI(); saveCfg(); });
    wireSeg("#seg-balance", v => {
      state.cfg.balance = v; $("#tol-wrap").classList.toggle("hidden", v !== "DURO"); saveCfg();
    });
    wireSeg("#seg-variar", v => { state.cfg.variar = (v === "si"); saveCfg(); });

    // Pesa ajustable: min/max en pasos de 2 kg, manteniendo min < max.
    const refreshKg = () => { $("#kg-min-val").textContent = state.cfg.pesoMin; $("#kg-max-val").textContent = state.cfg.pesoMax; };
    $("#kg-min-dec").onclick = () => { state.cfg.pesoMin = Math.max(4, state.cfg.pesoMin - 2); refreshKg(); saveCfg(); };
    $("#kg-min-inc").onclick = () => { state.cfg.pesoMin = Math.min(state.cfg.pesoMax - 2, state.cfg.pesoMin + 2); refreshKg(); saveCfg(); };
    $("#kg-max-dec").onclick = () => { state.cfg.pesoMax = Math.max(state.cfg.pesoMin + 2, state.cfg.pesoMax - 2); refreshKg(); saveCfg(); };
    $("#kg-max-inc").onclick = () => { state.cfg.pesoMax = Math.min(48, state.cfg.pesoMax + 2); refreshKg(); saveCfg(); };

    ["A", "B", "C"].forEach(k => {
      $("#est-" + k + "-dec").onclick = () => { state.cfg.estructura[k] = Math.max(0, state.cfg.estructura[k] - 1); $("#est-" + k + "-val").textContent = state.cfg.estructura[k]; saveCfg(); };
      $("#est-" + k + "-inc").onclick = () => { state.cfg.estructura[k] = Math.min(6, state.cfg.estructura[k] + 1); $("#est-" + k + "-val").textContent = state.cfg.estructura[k]; saveCfg(); };
    });

    $("#btn-fijar-toggle").onclick = () => {
      const panel = $("#fijar-panel"); const abrir = panel.classList.contains("hidden");
      panel.classList.toggle("hidden"); if (abrir) renderFijar();
    };

    $("#chip-barra").onclick = () => {
      const on = $("#chip-barra").getAttribute("aria-pressed") !== "true";
      $("#chip-barra").setAttribute("aria-pressed", String(on));
      state.cfg.equipo = on ? ["KB", "BARRA"] : ["KB"];
      pruneFijados(); updateFijarCount();
      if (!$("#fijar-panel").classList.contains("hidden")) renderFijar();
      saveCfg();
    };

    $("#m-range").oninput = e => { state.cfg.minutos = parseInt(e.target.value, 10); $("#m-read").textContent = state.cfg.minutos; };
    $("#m-range").onchange = saveCfg;

    $("#tol-dec").onclick = () => { state.cfg.tolerancia = Math.max(0, state.cfg.tolerancia - 1); $("#tol-val").textContent = state.cfg.tolerancia; saveCfg(); };
    $("#tol-inc").onclick = () => { state.cfg.tolerancia = Math.min(3, state.cfg.tolerancia + 1); $("#tol-val").textContent = state.cfg.tolerancia; saveCfg(); };

    $("#btn-generar").onclick = generar;
    $("#btn-regenerar").onclick = generar;
    $("#btn-guardar").onclick = guardarHist;

    $("#btn-add-toggle").onclick = () => {
      const panel = $("#pool-form"); const abrir = panel.classList.contains("hidden");
      if (abrir) { resetForm(); panel.classList.remove("hidden"); } else panel.classList.add("hidden");
    };
    $("#btn-add").onclick = guardarEjercicio;
    $("#btn-add-cancel").onclick = () => { $("#pool-form").classList.add("hidden"); resetForm(); };

    document.querySelectorAll(".nav button").forEach(b => b.onclick = () => showView(b.dataset.view));

    showView("gen");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
