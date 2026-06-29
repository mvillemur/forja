/**
 * Pruebas del motor (Node, sin DOM). Ejecuta: `node test/engine.test.js`.
 * Salida con codigo !=0 si algo falla (para CI / npm test).
 */
const F = require("../src/engine.js");

let pass = 0;
function ok(nombre, cond) {
  if (!cond) { console.error("FALLO:", nombre); process.exitCode = 1; }
  else pass++;
}

// Catalogo
ok("catalogo base = 32", F.CATALOGO_BASE.length === 32);
ok("hay 9 fundamentales", F.CATALOGO_BASE.filter(e => e.tier === "FUNDAMENTAL").length === 9);

// RuleEngine: dos SNC alta en bloque A -> invalida
const swing = F.CATALOGO_BASE.find(e => e.nombre === "Kettlebell Swings (Dos manos)");
const snatch = F.CATALOGO_BASE.find(e => e.nombre === "One-Arm Snatch");
ok("dos SNC alta = invalida", !F.validarCombinacion(
  { ej: swing, bloque: "A", series: 5, reps: 5 },
  { ej: snatch, bloque: "A", series: 5, reps: 5 }).valida);

// Antagonistas: empuje vs tiron
ok("empuje/tiron son antagonistas", F.sonAntagonistas("EMPUJE_V", "TIRON_H"));
ok("dos tirones no antagonistas", !F.sonAntagonistas("TIRON_H", "TIRON_V"));

// Sugerencia de kg dentro del rango
ok("kg pesada (12-32) = 30", F.sugerirKg(3, 12, 32) === 30);
ok("kg ligera (12-32) = 16", F.sugerirKg(1, 12, 32) === 16);

// Generacion basica
const r = F.generar(null, { objetivo: "FUERZA", equipo: ["KB"], minutos: 45, semilla: 7 });
ok("rutina tiene bloques", r.bloques.length > 0);
ok("duracion estimada > 0", F.duracionRutinaMin(r) > 0);

// Foco sesga la seleccion
const rp = F.generar(null, { objetivo: "FUERZA", equipo: ["KB"], minutos: 60, semilla: 3, foco: "PULL" });
const pulls = rp.bloques.flatMap(b => b.elementos.flatMap(e => e.prescripciones))
  .filter(p => p.ej.patron === "TIRON_H" || p.ej.patron === "TIRON_V").length;
ok("foco PULL sesga (>=3 tirones)", pulls >= 3);

// Ejercicio fijado a un bloque explicito
const rf = F.generar(null, { objetivo: "FUERZA", equipo: ["KB"], minutos: 45, semilla: 5,
  fijados: [{ nombre: "Kettlebell Swings (Dos manos)", bloque: "C" }] });
const enC = rf.bloques.find(b => b.bloque === "C").elementos
  .some(e => e.prescripciones.some(p => p.ej.nombre === "Kettlebell Swings (Dos manos)"));
ok("fijado forzado al bloque C", enC);

// Balance duro con tolerancia 0 no deja huecos (rellena con backtracking)
const rd = F.generar(null, { objetivo: "FUERZA", equipo: ["KB"], minutos: 60, semilla: 3, balance: "DURO", tolerancia: 0 });
const colocados = rd.bloques.reduce((a, b) => a + b.elementos.reduce((x, e) => x + e.prescripciones.length, 0), 0);
ok("backtracking llena la rutina", colocados >= 10);

if (process.exitCode) console.error("\n--- HAY FALLOS ---");
else console.log(pass + " comprobaciones del motor OK");
