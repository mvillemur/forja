/**
 * FORJA — Motor de reglas (engine.js)
 * ===================================
 * Logica PURA de generacion de rutinas de kettlebell. No toca el DOM ni el
 * almacenamiento: recibe datos y devuelve datos, asi que es testeable en Node
 * y reutilizable. Se expone como `window.FORJA` (navegador) y `module.exports`
 * (Node) — patron UMD al final del archivo.
 *
 * MODELO DE DATOS
 *   Ejercicio: { nombre, patron, dinamica, simetria, snc, equip[], agarre,
 *                carga (1..3), tier }  — ver CATALOGO_BASE.
 *   Prescripcion: { ej, bloque, series, reps }.
 *   SerieAsignada: { prescripciones[1..2], calidad, nota, esSuperserie }.
 *   Rutina: { plantilla, bloques: [{ bloque, elementos: SerieAsignada[] }] }.
 *
 * LOS 4 CRITERIOS (Enums como strings, serializables)
 *   PAT  patron de movimiento     DIN  tipo de dinamica
 *   SIM  simetria                 SNC  demanda del sistema nervioso
 *
 * COMO SE ARMA UNA RUTINA (pipeline)
 *   generar(pool, opts)
 *     -> elige PLANTILLA (por objetivo) y la escala por tiempo o estructura
 *     -> construirRutina(): filtra por equipamiento y arma cada bloque con:
 *          · RuleEngine (validarCombinacion): decide si dos ejercicios forman
 *            una superserie valida y con que calidad, segun el bloque.
 *          · PresupuestoFatiga: limita SNC alta y balisticos de agarre/sesion.
 *          · BalanceTracker: reparte patrones (modo suave/duro) y aplica foco,
 *            tier y penalizacion por uso reciente via `prioridad`.
 *          · armarGreedy / armarBacktrack: seleccion y emparejamiento. El modo
 *            DURO usa backtracking para no dejar huecos en la cuota de balance.
 *          · preplace: coloca primero los ejercicios FIJADOS por el usuario.
 *
 * FUNDAMENTO (resumen): superseries antagonistas (APS) para recuperar el grupo
 * en reposo sin perder rendimiento; el agarre es el eslabon limitante entre
 * balisticos; no acumular SNC alta; descanso activo = core de baja demanda.
 *
 * El archivo NO debe ganar dependencias ni I/O: si algo necesita el DOM o el
 * navegador, va en app.js.
 */
(function (root) {
  "use strict";

  // --- Enums como strings (serializables) ---------------------------------
  const PAT = { CADERA:"CADERA", RODILLA:"RODILLA", TIRON_H:"TIRON_H", TIRON_V:"TIRON_V",
                EMPUJE_H:"EMPUJE_H", EMPUJE_V:"EMPUJE_V", CORE:"CORE", HIBRIDO:"HIBRIDO" };
  const DIN = { FUERZA:"FUERZA", BALISTICO:"BALISTICO", ISO:"ISO", METABOLICO:"METABOLICO" };
  const SIM = { BILATERAL:"BILATERAL", UNILATERAL:"UNILATERAL", ALTERNO:"ALTERNO" };
  const SNC = { ALTA:"ALTA", MEDIA:"MEDIA", BAJA:"BAJA" };
  const EQ  = { KB:"KB", BARRA:"BARRA", SUELO:"SUELO" };
  const CAR = { LIGERA:1, MEDIA:2, PESADA:3 };
  const TIER = { FUNDAMENTAL:"FUNDAMENTAL", ACCESORIO:"ACCESORIO", OPCIONAL:"OPCIONAL" };
  const TIER_LABEL = { FUNDAMENTAL:"Fundamental", ACCESORIO:"Accesorio", OPCIONAL:"Opcional" };
  const TIER_BONUS = { FUNDAMENTAL:3, ACCESORIO:0, OPCIONAL:-2 };
  const BLO = { A:"A", B:"B", C:"C" };
  const RAN = { FP:"FP", HIP:"HIP", MET:"MET" };
  const CAL = { OPTIMA:3, ACEPTABLE:2, INVALIDA:0 };
  const CAL_NOMBRE = { 3:"OPTIMA", 2:"ACEPTABLE", 0:"INVALIDA" };

  const PAT_LABEL = { CADERA:"Cadera", RODILLA:"Rodilla", TIRON_H:"Tiron horiz.",
    TIRON_V:"Tiron vert.", EMPUJE_H:"Empuje horiz.", EMPUJE_V:"Empuje vert.",
    CORE:"Core / estab.", HIBRIDO:"Hibrido" };
  const DIN_LABEL = { FUERZA:"Fuerza/Hipertrofia", BALISTICO:"Balistico/Potencia",
    ISO:"Isometrico/Transporte", METABOLICO:"Metabolico" };
  const CAR_LABEL = { 1:"Ligera", 2:"Media", 3:"Pesada" };

  // --- Catalogo base (24) -------------------------------------------------
  function ej(nombre, patron, dinamica, simetria, snc, equip, agarre, carga) {
    return { nombre, patron, dinamica, simetria, snc, equip,
             agarre: !!agarre, carga: carga || CAR.MEDIA, tier: TIER.ACCESORIO };
  }
  const CATALOGO_BASE = [
    ej("Peso Muerto Rumano / Fijo", PAT.CADERA, DIN.FUERZA, SIM.BILATERAL, SNC.MEDIA, [EQ.KB], false, CAR.PESADA),
    ej("Kettlebell Swings (Dos manos)", PAT.CADERA, DIN.BALISTICO, SIM.BILATERAL, SNC.ALTA, [EQ.KB], true, CAR.PESADA),
    ej("Alternating Swings", PAT.CADERA, DIN.BALISTICO, SIM.ALTERNO, SNC.ALTA, [EQ.KB], true, CAR.MEDIA),
    ej("Swing Cleans", PAT.HIBRIDO, DIN.BALISTICO, SIM.UNILATERAL, SNC.ALTA, [EQ.KB], true, CAR.MEDIA),
    ej("Dead Cleans", PAT.HIBRIDO, DIN.BALISTICO, SIM.UNILATERAL, SNC.ALTA, [EQ.KB], true, CAR.MEDIA),
    ej("Sentadilla Goblet", PAT.RODILLA, DIN.FUERZA, SIM.BILATERAL, SNC.MEDIA, [EQ.KB], false, CAR.PESADA),
    ej("Goblet Clean Squat", PAT.HIBRIDO, DIN.BALISTICO, SIM.BILATERAL, SNC.ALTA, [EQ.KB], true, CAR.MEDIA),
    ej("Pit Squats", PAT.RODILLA, DIN.FUERZA, SIM.BILATERAL, SNC.MEDIA, [EQ.KB], false, CAR.PESADA),
    ej("Alt Lunges", PAT.RODILLA, DIN.FUERZA, SIM.ALTERNO, SNC.MEDIA, [EQ.KB], false, CAR.MEDIA),
    ej("Remo a una mano", PAT.TIRON_H, DIN.FUERZA, SIM.UNILATERAL, SNC.MEDIA, [EQ.KB], true, CAR.MEDIA),
    ej("Two Hand Row", PAT.TIRON_H, DIN.FUERZA, SIM.BILATERAL, SNC.MEDIA, [EQ.KB], true, CAR.MEDIA),
    ej("Bent Rows (Alternating)", PAT.TIRON_H, DIN.FUERZA, SIM.ALTERNO, SNC.MEDIA, [EQ.KB], true, CAR.MEDIA),
    ej("Upright Row", PAT.TIRON_V, DIN.FUERZA, SIM.BILATERAL, SNC.BAJA, [EQ.KB], false, CAR.LIGERA),
    ej("Dominadas Neutras", PAT.TIRON_V, DIN.FUERZA, SIM.BILATERAL, SNC.ALTA, [EQ.BARRA], true, CAR.MEDIA),
    ej("Clean & Press Combinado", PAT.HIBRIDO, DIN.BALISTICO, SIM.UNILATERAL, SNC.ALTA, [EQ.KB], true, CAR.MEDIA),
    ej("Goblet Shoulder Press", PAT.EMPUJE_V, DIN.FUERZA, SIM.BILATERAL, SNC.MEDIA, [EQ.KB], false, CAR.LIGERA),
    ej("Rotational Press", PAT.EMPUJE_V, DIN.FUERZA, SIM.UNILATERAL, SNC.MEDIA, [EQ.KB], false, CAR.LIGERA),
    ej("Dead Clean Push Press", PAT.HIBRIDO, DIN.BALISTICO, SIM.UNILATERAL, SNC.ALTA, [EQ.KB], true, CAR.MEDIA),
    ej("Close Grip Pushup", PAT.EMPUJE_H, DIN.FUERZA, SIM.BILATERAL, SNC.MEDIA, [EQ.SUELO], false, CAR.MEDIA),
    ej("Halos", PAT.CORE, DIN.ISO, SIM.BILATERAL, SNC.BAJA, [EQ.KB], false, CAR.LIGERA),
    ej("Kneeling Around The Worlds", PAT.CORE, DIN.ISO, SIM.BILATERAL, SNC.BAJA, [EQ.KB], false, CAR.LIGERA),
    ej("Half-Racked Marches", PAT.CORE, DIN.ISO, SIM.UNILATERAL, SNC.BAJA, [EQ.KB], true, CAR.MEDIA),
    ej("Goblet Overhead March", PAT.CORE, DIN.ISO, SIM.BILATERAL, SNC.MEDIA, [EQ.KB], false, CAR.LIGERA),
    ej("Burpees", PAT.HIBRIDO, DIN.METABOLICO, SIM.BILATERAL, SNC.ALTA, [EQ.SUELO], false, CAR.LIGERA),
    // --- Ampliacion: clasicos con una sola kettlebell ---
    ej("Turkish Get-Up", PAT.CORE, DIN.ISO, SIM.UNILATERAL, SNC.ALTA, [EQ.KB], true, CAR.MEDIA),
    ej("One-Arm Snatch", PAT.HIBRIDO, DIN.BALISTICO, SIM.UNILATERAL, SNC.ALTA, [EQ.KB], true, CAR.MEDIA),
    ej("Windmill", PAT.CORE, DIN.ISO, SIM.UNILATERAL, SNC.MEDIA, [EQ.KB], true, CAR.LIGERA),
    ej("Bottoms-Up Press", PAT.EMPUJE_V, DIN.FUERZA, SIM.UNILATERAL, SNC.MEDIA, [EQ.KB], true, CAR.LIGERA),
    ej("Single-Leg Deadlift", PAT.CADERA, DIN.FUERZA, SIM.UNILATERAL, SNC.MEDIA, [EQ.KB], false, CAR.MEDIA),
    ej("Suitcase Carry", PAT.CORE, DIN.ISO, SIM.UNILATERAL, SNC.BAJA, [EQ.KB], true, CAR.MEDIA),
    ej("Thruster", PAT.HIBRIDO, DIN.METABOLICO, SIM.BILATERAL, SNC.ALTA, [EQ.KB], false, CAR.MEDIA),
    ej("Figure-8", PAT.CORE, DIN.METABOLICO, SIM.ALTERNO, SNC.MEDIA, [EQ.KB], true, CAR.LIGERA),
  ];

  // Tier: ejercicios fundamentales (compuestos, multiarticulares, alto valor) y opcionales.
  const _FUNDAMENTALES = new Set([
    "Peso Muerto Rumano / Fijo", "Kettlebell Swings (Dos manos)", "Sentadilla Goblet",
    "Goblet Clean Squat", "Clean & Press Combinado", "Dead Clean Push Press",
    "Thruster", "One-Arm Snatch", "Turkish Get-Up",
  ]);
  const _OPCIONALES = new Set([
    "Upright Row", "Halos", "Kneeling Around The Worlds", "Figure-8", "Rotational Press",
  ]);
  CATALOGO_BASE.forEach(e => {
    e.tier = _FUNDAMENTALES.has(e.nombre) ? TIER.FUNDAMENTAL
           : _OPCIONALES.has(e.nombre) ? TIER.OPCIONAL : TIER.ACCESORIO;
  });

  // --- Volumen y modelo de tiempo -----------------------------------------
  function clasificarVolumen(reps) { return reps <= 5 ? RAN.FP : reps <= 11 ? RAN.HIP : RAN.MET; }

  const TEMPO = { FUERZA:3.0, BALISTICO:1.2, METABOLICO:2.0, ISO:0.0 };
  const DESCANSO = { FP:150, HIP:75, MET:40 };
  const HOLD_ISO = 35, TRANS_SS = 20;
  const LIMITES_SERIES = { FP:[3,6], HIP:[3,5], MET:[3,5] };

  function trabajoSerie(e, reps) { return e.dinamica === DIN.ISO ? HOLD_ISO : reps * TEMPO[e.dinamica]; }
  function descansoSerie(reps) { return DESCANSO[clasificarVolumen(reps)]; }

  function tiempoElementoSeg(el) {
    const s = el.prescripciones[0].series;
    if (el.esSuperserie) {
      const [a, b] = el.prescripciones;
      const work = trabajoSerie(a.ej, a.reps) + trabajoSerie(b.ej, b.reps);
      const rest = Math.max(descansoSerie(a.reps), descansoSerie(b.reps)) * 0.5;
      return s * (work + rest + TRANS_SS);
    }
    const p = el.prescripciones[0];
    return s * (trabajoSerie(p.ej, p.reps) + descansoSerie(p.reps));
  }
  function duracionRutinaMin(rutina) {
    let t = 0; rutina.bloques.forEach(br => br.elementos.forEach(el => t += tiempoElementoSeg(el)));
    return Math.round(t / 60);
  }
  function duracionBloqueMin(br) {
    return Math.round(br.elementos.reduce((a, el) => a + tiempoElementoSeg(el), 0) / 60);
  }

  // --- Antagonismo --------------------------------------------------------
  const FAM_EMPUJE = new Set([PAT.EMPUJE_H, PAT.EMPUJE_V]);
  const FAM_TIRON = new Set([PAT.TIRON_H, PAT.TIRON_V]);
  const FAM_PIERNA = new Set([PAT.CADERA, PAT.RODILLA]);
  function sonAntagonistas(p1, p2) {
    if (p1 === PAT.CORE || p2 === PAT.CORE) return true;
    if (FAM_PIERNA.has(p1) && FAM_PIERNA.has(p2) && p1 !== p2) return true;
    return (FAM_EMPUJE.has(p1) && FAM_TIRON.has(p2)) || (FAM_TIRON.has(p1) && FAM_EMPUJE.has(p2));
  }
  function esDescansoActivo(e) { return e.patron === PAT.CORE && e.snc === SNC.BAJA; }

  // --- RuleEngine ---------------------------------------------------------
  function R(valida, calidad, motivos) { return { valida, calidad, motivos }; }
  function rango(p) { return clasificarVolumen(p.reps); }

  function validarCombinacion(a, b) {
    if (a.bloque !== b.bloque) return R(false, CAL.INVALIDA, ["Bloques distintos; no forman superserie."]);
    if (a.bloque === BLO.A) return validarA(a, b);
    if (a.bloque === BLO.B) return validarB(a, b);
    return R(true, CAL.OPTIMA, ["Finalizador: combinacion libre."]);
  }
  function validarA(a, b) {
    const ea = a.ej, eb = b.ej;
    if (ea.snc === SNC.ALTA && eb.snc === SNC.ALTA)
      return R(false, CAL.INVALIDA, ["Dos de SNC alta degradan la fuerza/potencia."]);
    if (ea.agarre && eb.agarre && ea.dinamica === DIN.BALISTICO && eb.dinamica === DIN.BALISTICO)
      return R(false, CAL.INVALIDA, ["Dos balisticos de agarre: fallo de agarre prematuro."]);
    const rangos = new Set([rango(a), rango(b)]);
    if (rangos.has(RAN.FP) && rangos.has(RAN.MET))
      return R(false, CAL.INVALIDA, ["Fuerza 1-5 + metabolico 12+: interferencia."]);
    if (ea.patron === eb.patron && ea.patron !== PAT.CORE)
      return R(false, CAL.INVALIDA, ["Mismo patron: fatiga local, no antagonista."]);
    if (esDescansoActivo(ea) !== esDescansoActivo(eb))
      return R(true, CAL.OPTIMA, ["Lift principal + core de baja demanda: descanso activo ideal."]);
    if (sonAntagonistas(ea.patron, eb.patron))
      return R(true, CAL.OPTIMA, ["Superserie antagonista (APS): el grupo en reposo se recupera."]);
    return R(true, CAL.ACEPTABLE, ["Viable, pero no antagonista: prioriza pares opuestos."]);
  }
  function validarB(a, b) {
    const ea = a.ej, eb = b.ej;
    if (ea.agarre && eb.agarre && ea.dinamica === DIN.BALISTICO && eb.dinamica === DIN.BALISTICO)
      return R(true, CAL.ACEPTABLE, ["Riesgo de agarre; reduce reps o intercala core."]);
    if (sonAntagonistas(ea.patron, eb.patron))
      return R(true, CAL.OPTIMA, ["Par antagonista en accesorios: eficiente."]);
    if (ea.patron === eb.patron && new Set([rango(a), rango(b)]).has(RAN.HIP))
      return R(true, CAL.ACEPTABLE, ["Mismo patron en hipertrofia: volumen dirigido."]);
    return R(true, CAL.ACEPTABLE, ["Combinacion de accesorios aceptable."]);
  }

  // --- Presupuesto de fatiga ---------------------------------------------
  function nuevoPresupuesto(maxSnc, maxAgarre) {
    return {
      maxSnc, maxAgarre, snc: 0, agarre: 0,
      _ag(e) { return e.agarre && e.dinamica === DIN.BALISTICO; },
      permite(e) {
        if (e.snc === SNC.ALTA && this.snc >= this.maxSnc) return false;
        if (this._ag(e) && this.agarre >= this.maxAgarre) return false;
        return true;
      },
      consumir(e) { if (e.snc === SNC.ALTA) this.snc++; if (this._ag(e)) this.agarre++; },
      snapshot() { return [this.snc, this.agarre]; },
      restore(s) { this.snc = s[0]; this.agarre = s[1]; },
    };
  }

  // --- Balance de patrones -----------------------------------------------
  const CATEG = {
    EMPUJE_H:"EMPUJE", EMPUJE_V:"EMPUJE", TIRON_H:"TIRON", TIRON_V:"TIRON",
    CADERA:"CADERA", RODILLA:"RODILLA", CORE:"NEUTRO", HIBRIDO:"NEUTRO",
  };
  const ANTAG_CAT = { EMPUJE:"TIRON", TIRON:"EMPUJE", CADERA:"RODILLA", RODILLA:"CADERA" };

  function nuevoBalance(modo, tol) {
    return {
      modo, tol: tol == null ? 1 : tol, conteo: {},
      _cat(e) { return CATEG[e.patron]; },
      _n(c) { return this.conteo[c] || 0; },
      permite(e) {
        if (this.modo !== "DURO") return true;
        const c = this._cat(e); if (c === "NEUTRO") return true;
        return (this._n(c) + 1) - this._n(ANTAG_CAT[c]) <= this.tol;
      },
      bonus(e) {
        if (this.modo === "NINGUNO") return 0;
        const c = this._cat(e); if (c === "NEUTRO") return 0;
        return Math.max(0, this._n(ANTAG_CAT[c]) - this._n(c));
      },
      registrar(e) { const c = this._cat(e); if (c !== "NEUTRO") this.conteo[c] = this._n(c) + 1; },
      snapshot() { return Object.assign({}, this.conteo); },
      restore(s) { this.conteo = Object.assign({}, s); },
    };
  }

  // --- Plantillas ---------------------------------------------------------
  function esquema(bloque, n, series, reps, dins, emparejar) {
    return { bloque, n, series, reps, dins: new Set(dins), emparejar: emparejar !== false };
  }
  const PLANTILLAS = {
    FUERZA: {
      nombre: "Fuerza (full-body)", maxSnc: 2, maxAgarre: 2,
      bloques: [
        esquema(BLO.A, 4, 5, 5, [DIN.FUERZA, DIN.BALISTICO]),
        esquema(BLO.B, 4, 3, 10, [DIN.FUERZA]),
        esquema(BLO.C, 2, 3, 15, [DIN.METABOLICO, DIN.BALISTICO]),
      ],
    },
    METABOLICO: {
      nombre: "Acondicionamiento metabolico", maxSnc: 4, maxAgarre: 3,
      bloques: [
        esquema(BLO.A, 2, 4, 6, [DIN.BALISTICO]),
        esquema(BLO.B, 4, 3, 12, [DIN.FUERZA, DIN.BALISTICO]),
        esquema(BLO.C, 2, 4, 20, [DIN.METABOLICO]),
      ],
    },
  };

  // --- Escalado por minutos ----------------------------------------------
  function tempoRep(esq) {
    const dins = [...esq.dins].filter(d => d !== DIN.ISO);
    const use = dins.length ? dins : [DIN.FUERZA];
    return use.reduce((a, d) => a + TEMPO[d], 0) / use.length;
  }
  function estimarEsquemaSeg(esq) {
    const work = esq.reps * tempoRep(esq);
    const rest = DESCANSO[clasificarVolumen(esq.reps)];
    const restEf = esq.emparejar ? rest * 0.6 : rest;
    return esq.n * esq.series * (work + restEf);
  }
  function escalarPlantilla(base, minutos) {
    const objetivo = minutos * 60;
    const baseTotal = base.bloques.reduce((a, b) => a + estimarEsquemaSeg(b), 0) || 1;
    const factor = Math.max(0.3, Math.min(2.5, objetivo / baseTotal));
    const sf = Math.sqrt(factor);
    const conSeries = base.bloques.map(b => {
      const [lo, hi] = LIMITES_SERIES[clasificarVolumen(b.reps)];
      const ns = Math.min(hi, Math.max(lo, Math.round(b.series * sf)));
      return esquema(b.bloque, b.n, ns, b.reps, [...b.dins], b.emparejar);
    });
    const tUnit = conSeries.map(b => estimarEsquemaSeg(esquema(b.bloque, 1, b.series, b.reps, [...b.dins], b.emparejar)));
    const denom = conSeries.reduce((a, b, i) => a + b.n * tUnit[i], 0) || 1;
    const k = objetivo / denom;
    const bloques = conSeries.map(b => esquema(b.bloque, Math.max(1, Math.round(k * b.n)), b.series, b.reps, [...b.dins], b.emparejar));
    return { nombre: base.nombre, maxSnc: base.maxSnc, maxAgarre: base.maxAgarre, bloques };
  }

  // --- RNG sembrado -------------------------------------------------------
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

  // --- Ensamblador --------------------------------------------------------
  function prescribir(e, esq) {
    let reps = esq.reps;
    if (e.dinamica === DIN.ISO) reps = Math.max(reps, 8);
    return { ej: e, bloque: esq.bloque, series: esq.series, reps };
  }
  function prioridad(e, esq, bal) {
    let s = 0;
    if (esq.dins.has(e.dinamica)) s += 4;
    if (esq.bloque === BLO.A && e.patron !== PAT.CORE) s += 2;
    s += 2 * bal.bonus(e);
    if (bal.foco && bal.foco.has(e.patron)) s += 6;   // foco muscular: domina la seleccion
    s += TIER_BONUS[e.tier] || 0;                     // fundamentales arriba, opcionales abajo
    if (bal.recientes) s -= (bal.recientes[e.nombre] || 0);  // evitar repetir lo reciente
    return s;
  }

  // Sugerencia de kg para una pesa ajustable: mapea el tier de carga (ligera/
  // media/pesada) dentro del rango disponible del usuario, redondeado a 2 kg.
  function sugerirKg(carga, min, max) {
    if (min == null || max == null) return null;
    const frac = { 1: 0.15, 2: 0.5, 3: 0.85 }[carga];
    const kg = Math.round((min + (frac == null ? 0.5 : frac) * (max - min)) / 2) * 2;
    return Math.max(min, Math.min(max, kg));
  }

  // Aviso de carga relativa: "bajo" = la pesa se queda corta para el ejercicio;
  // "alto" = la pesa es excesiva para un movimiento ligero/tecnico.
  function cargaAviso(carga, pesoKb) {
    if (!pesoKb) return null;
    const d = carga - pesoKb;
    if (d >= 2) return "bajo";
    if (d <= -2) return "alto";
    return null;
  }
  function serie(presc, calidad, nota) {
    return { prescripciones: presc, calidad, nota, esSuperserie: presc.length === 2 };
  }

  function filtrarEquipo(pool, disp) {
    const set = new Set(disp); set.add(EQ.SUELO);
    return pool.filter(e => e.equip.every(q => set.has(q)));
  }

  function elegirPartner(pa, cands, esq, pres, bal) {
    let mejor = null, key = [-1, -1];
    for (const c of cands) {
      if (!pres.permite(c) || !bal.permite(c)) continue;
      const res = validarCombinacion(pa, prescribir(c, esq));
      if (!res.valida) continue;
      const k = [res.calidad, bal.bonus(c)];
      if (k[0] > key[0] || (k[0] === key[0] && k[1] > key[1])) { mejor = c; key = k; }
    }
    return mejor;
  }

  // Coloca primero los ejercicios fijados por el usuario (con pareja si procede).
  function preplace(obligatorios, esq, pool, usados, pres, bal, rng, reservados) {
    reservados = reservados || new Set();
    const elementos = [];
    const pend = (obligatorios || []).filter(e => !usados.has(e));
    for (let i = 0; i < pend.length; i++) {
      const prim = pend[i];
      if (usados.has(prim)) continue;
      usados.add(prim); pres.consumir(prim); bal.registrar(prim);
      const pa = prescribir(prim, esq);
      let part = null;
      if (esq.emparejar) {
        const otrosFijados = pend.slice(i + 1).filter(e => !usados.has(e));
        part = elegirPartner(pa, otrosFijados, esq, pres, bal);
        if (!part) {
          const libres = pool.filter(e => !usados.has(e) && !reservados.has(e) && !pend.includes(e));
          part = elegirPartner(pa, libres, esq, pres, bal);
        }
      }
      if (part) {
        usados.add(part); pres.consumir(part); bal.registrar(part);
        const res = validarCombinacion(pa, prescribir(part, esq));
        elementos.push(serie([pa, prescribir(part, esq)], res.calidad, "Fijado · " + res.motivos.join(" | ")));
      } else {
        elementos.push(serie([pa], CAL.ACEPTABLE, "Fijado · set directo."));
      }
    }
    return elementos;
  }

  function armarGreedy(esq, pool, usados, pres, bal, rng, obligatorios, reservados) {
    reservados = reservados || new Set();
    const elementos = preplace(obligatorios, esq, pool, usados, pres, bal, rng, reservados);
    let colocados = elementos.reduce((a, el) => a + el.prescripciones.length, 0);
    const disp = shuffle(pool.filter(e => !usados.has(e) && !reservados.has(e)), rng);
    while (colocados < esq.n) {
      const cands = disp.filter(e => !usados.has(e) && pres.permite(e) && bal.permite(e));
      if (!cands.length) break;
      let prim = cands[0], best = prioridad(prim, esq, bal);
      for (const c of cands) { const p = prioridad(c, esq, bal); if (p > best) { best = p; prim = c; } }
      usados.add(prim); pres.consumir(prim); bal.registrar(prim);
      const pa = prescribir(prim, esq);
      if (esq.emparejar && (colocados + 1) < esq.n) {
        const resto = disp.filter(e => !usados.has(e));
        const part = elegirPartner(pa, resto, esq, pres, bal);
        if (part) {
          usados.add(part); pres.consumir(part); bal.registrar(part);
          const res = validarCombinacion(pa, prescribir(part, esq));
          elementos.push(serie([pa, prescribir(part, esq)], res.calidad, res.motivos.join(" | ")));
          colocados += 2; continue;
        }
      }
      elementos.push(serie([pa], CAL.ACEPTABLE, "Set directo: sin pareja antagonista disponible."));
      colocados += 1;
    }
    return { bloque: esq.bloque, elementos };
  }

  function armarBacktrack(esq, pool, usados, pres, bal, rng, obligatorios, reservados) {
    reservados = reservados || new Set();
    const objetivo = esq.n;
    const aplicar = e => { usados.add(e); pres.consumir(e); bal.registrar(e); };
    const pre = preplace(obligatorios, esq, pool, usados, pres, bal, rng, reservados);  // fijados ya consumidos
    const disp = shuffle(pool.filter(e => !usados.has(e) && !reservados.has(e)), rng);
    const LIMITE = 4000, BP = 8, BPART = 6;
    const validos = () => disp.filter(e => !usados.has(e) && pres.permite(e) && bal.permite(e));
    const nColoc = els => els.reduce((a, el) => a + el.prescripciones.length, 0);
    const score = els => [nColoc(els), els.reduce((a, el) => a + el.calidad, 0)];

    function genMoves(restantes) {
      const cands = validos().sort((x, y) => prioridad(y, esq, bal) - prioridad(x, esq, bal)).slice(0, BP);
      const moves = [];
      if (esq.emparejar && restantes >= 2) {
        for (const prim of cands) {
          const sb = bal.snapshot(), sp = pres.snapshot();
          aplicar(prim);
          const pa = prescribir(prim, esq);
          const partners = [];
          for (const part of validos()) {
            if (part === prim) continue;
            const res = validarCombinacion(pa, prescribir(part, esq));
            if (res.valida) partners.push([res.calidad, bal.bonus(part), part, res]);
          }
          partners.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
          usados.delete(prim); bal.restore(sb); pres.restore(sp);
          for (const [, , part, res] of partners.slice(0, BPART))
            moves.push([[prim, part], serie([prescribir(prim, esq), prescribir(part, esq)], res.calidad, res.motivos.join(" | "))]);
        }
      }
      for (const prim of cands)
        moves.push([[prim], serie([prescribir(prim, esq)], CAL.ACEPTABLE, "Set directo: sin pareja viable bajo la cuota de balance.")]);
      return moves;
    }

    let mejor = { els: pre.slice(), score: score(pre) }, nodos = 0;
    function dfs(els) {
      nodos++;
      const sc = score(els);
      if (sc[0] > mejor.score[0] || (sc[0] === mejor.score[0] && sc[1] > mejor.score[1]))
        mejor = { els: els.slice(), score: sc };
      if (sc[0] >= objetivo) return true;
      if (nodos > LIMITE) return false;
      for (const [exs, el] of genMoves(objetivo - sc[0])) {
        const sb = bal.snapshot(), sp = pres.snapshot();
        exs.forEach(aplicar); els.push(el);
        if (dfs(els)) return true;
        els.pop(); exs.forEach(e => usados.delete(e)); bal.restore(sb); pres.restore(sp);
      }
      return false;
    }
    dfs(pre.slice());

    let relajado = false;
    if (mejor.score[0] < objetivo) {
      const tol0 = bal.tol; bal.tol += 1; mejor = { els: pre.slice(), score: score(pre) }; nodos = 0;
      dfs(pre.slice()); bal.tol = tol0; relajado = true;
    }
    const elementos = mejor.els;
    // los fijados (0..pre.length) ya estan consumidos; aplicar solo lo añadido por el DFS
    for (let i = pre.length; i < elementos.length; i++)
      elementos[i].prescripciones.forEach(p => aplicar(p.ej));
    if (relajado) elementos.forEach(el => { if (!/Fijado/.test(el.nota)) el.nota += "  [+tolerancia: balance relajado para evitar hueco]"; });
    return { bloque: esq.bloque, elementos };
  }

  function inferirBloque(e, plantilla) {
    for (const b of plantilla.bloques) if (b.dins.has(e.dinamica)) return b.bloque;
    const ids = plantilla.bloques.map(b => b.bloque);
    return ids.indexOf(BLO.B) >= 0 ? BLO.B : ids[0];
  }

  function plantillaPorEstructura(base, estructura) {
    const bloques = base.bloques
      .filter(b => (estructura[b.bloque] || 0) > 0)
      .map(b => esquema(b.bloque, estructura[b.bloque], b.series, b.reps, [...b.dins], b.emparejar));
    return { nombre: base.nombre, maxSnc: base.maxSnc, maxAgarre: base.maxAgarre, bloques };
  }

  function construirRutina(plantilla, disp, pesoKb, semilla, balance, tol, foco, fijadosNombres, recientes) {
    const rng = makeRng(semilla);
    const poolBase = plantilla.__pool || CATALOGO_BASE;
    const pool = filtrarEquipo(poolBase, disp);
    const usados = new Set();
    const pres = nuevoPresupuesto(plantilla.maxSnc, plantilla.maxAgarre);
    const bal = nuevoBalance(balance || "NINGUNO", tol);
    bal.foco = foco || null;
    bal.pesoKb = pesoKb || null;
    bal.recientes = recientes || null;

    // Resolver fijados. Cada uno puede ser un nombre (string) o {nombre, bloque}.
    // bloque "AUTO"/ausente -> inferir por dinamica. Si el bloque pedido no existe
    // en la plantilla, se infiere y, en ultimo caso, va al primer bloque.
    const idsPlantilla = plantilla.bloques.map(b => b.bloque);
    const porBloque = {};
    (fijadosNombres || []).forEach(f => {
      const nombre = typeof f === "string" ? f : f.nombre;
      const pedido = typeof f === "string" ? null : f.bloque;
      const e = pool.find(x => x.nombre === nombre);
      if (!e) return;
      let b = (pedido && pedido !== "AUTO" && idsPlantilla.indexOf(pedido) >= 0) ? pedido : inferirBloque(e, plantilla);
      if (idsPlantilla.indexOf(b) < 0) b = idsPlantilla[0];
      (porBloque[b] = porBloque[b] || []).push(e);
    });

    const reservados = new Set();
    Object.keys(porBloque).forEach(b => porBloque[b].forEach(e => reservados.add(e)));

    const bloques = plantilla.bloques.map(esq => {
      const obl = porBloque[esq.bloque] || [];
      const esqAjustado = obl.length > esq.n
        ? esquema(esq.bloque, obl.length, esq.series, esq.reps, [...esq.dins], esq.emparejar)
        : esq;
      const armar = bal.modo === "DURO" ? armarBacktrack : armarGreedy;
      return armar(esqAjustado, pool, usados, pres, bal, rng, obl, reservados);
    });
    return { plantilla: plantilla.nombre, bloques };
  }

  // --- API de alto nivel --------------------------------------------------
  const FOCO_PAT = {
    PIERNAS: [PAT.CADERA, PAT.RODILLA],
    EMPUJE: [PAT.EMPUJE_H, PAT.EMPUJE_V],
    PULL: [PAT.TIRON_H, PAT.TIRON_V],
  };
  const FOCO_LABEL = { FULL: "Full-body", PIERNAS: "Piernas", EMPUJE: "Empuje / hombros", PULL: "Pull / tiron" };

  function generar(pool, opts) {
    opts = opts || {};
    const obj = (opts.objetivo || "FUERZA").toUpperCase();
    const base = PLANTILLAS[obj] || PLANTILLAS.FUERZA;

    let plantilla;
    if (opts.estructura && Object.values(opts.estructura).some(n => n > 0))
      plantilla = plantillaPorEstructura(base, opts.estructura);
    else
      plantilla = escalarPlantilla(base, opts.minutos || 45);
    plantilla.maxSnc = base.maxSnc; plantilla.maxAgarre = base.maxAgarre;
    plantilla.__pool = pool || CATALOGO_BASE;

    const focoKey = (opts.foco || "FULL").toUpperCase();
    const foco = FOCO_PAT[focoKey] ? new Set(FOCO_PAT[focoKey]) : null;
    // El foco desequilibra a proposito: anula el balance mientras este activo.
    const balance = foco ? "NINGUNO" : (opts.balance || "NINGUNO").toUpperCase();

    return construirRutina(plantilla, opts.equipo || [EQ.KB], opts.pesoKb || null,
      opts.semilla == null ? null : opts.semilla, balance,
      opts.tolerancia == null ? 1 : opts.tolerancia, foco, opts.fijados || [], opts.recientes || null);
  }

  function nuevoEjercicio(campos) {
    const e = ej(campos.nombre.trim(), campos.patron, campos.dinamica, campos.simetria,
      campos.snc, campos.equip, campos.agarre, campos.carga || CAR.MEDIA);
    e.tier = campos.tier || TIER.ACCESORIO;
    return e;
  }

  const API = {
    PAT, DIN, SIM, SNC, EQ, CAR, BLO, RAN, CAL, CAL_NOMBRE, TIER, TIER_LABEL,
    PAT_LABEL, DIN_LABEL, CAR_LABEL, FOCO_LABEL,
    CATALOGO_BASE, PLANTILLAS,
    clasificarVolumen, tiempoElementoSeg, duracionRutinaMin, duracionBloqueMin,
    sonAntagonistas, validarCombinacion, generar, nuevoEjercicio, filtrarEquipo, cargaAviso, sugerirKg,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.FORJA = API;
})(typeof self !== "undefined" ? self : this);
