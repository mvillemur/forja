/**
 * UI tests with jsdom against the self-contained build (dist/forja.html).
 * Run: `node test/dom.test.js` (requires `node build.js` to have run first;
 * `npm test` chains it). Validates the main flow without a real browser.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "dist", "forja.html"), "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://forja.local/" });
const { window } = dom;
const d = window.document;

window.addEventListener("error", (e) => {
  console.error("RUNTIME ERROR:", (e.error && e.error.stack) || e.message);
  process.exit(1);
});

setTimeout(() => {
  let code = 0;
  const ok = (n, c) => { if (!c) { console.error("FAIL:", n); code = 1; } };

  d.querySelector("#btn-generar").click();
  ok("generates elements", d.querySelectorAll("#routine-out .element").length > 0);
  ok("shows suggested kg", d.querySelectorAll("#routine-out .ex-kg").length > 0);

  d.querySelector("#btn-guardar").click();
  d.querySelector('.nav button[data-view="hist"]').click();
  ok("history records the session", d.querySelectorAll("#hist-list .card").length === 1);

  // CSV import: a tab-separated table with header maps each date to a session.
  const csv = [
    "Fecha\tBloque / Orden\tEjercicio\tCarga (kg)\tSerie 1\tSerie 2\tSerie 3\tSerie 4\tReps Totales\tNotas Tecnicas",
    "15/06/2026\tBloque A\tPeso Muerto Rumano\t18\t16\t10\t10\t\t=SUMA(E2:H2)\tRitmo controlado.",
    "15/06/2026\tBloque B\tHalos\t14\t8\t8\t8\t\t=SUMA(E3:H3)\tMovilidad.",
    "21/06/2026\tEjercicio 1\tPeso Muerto\t27\t20\t20\t20\t20\t=SUMA(E4:H4)\tFoco agarre.",
  ].join("\n");
  d.querySelector("#csv-input").value = csv;
  d.querySelector("#btn-csv-import").click();
  ok("CSV import adds 2 dated sessions", d.querySelectorAll("#hist-list .card").length === 3);
  const manual = [...d.querySelectorAll("#hist-list .hist-title")].filter(n => /Registro/.test(n.textContent));
  ok("CSV sessions render as manual cards", manual.length === 2);
  manual[0].click(); // expand newest (21/06)
  ok("manual card shows per-set reps", /20 · 20 · 20 · 20/.test(d.querySelector("#hist-list").textContent));

  // Pin panel: opening it renders tag filters, and a filter narrows the list.
  d.querySelector("#btn-pin-toggle").click();
  ok("pin panel shows tag filters", d.querySelectorAll("#pin-filters .filter-chip").length > 0);
  const allPins = d.querySelectorAll("#pin-chips .chip.fijado").length;
  ok("pin panel lists exercises", allPins > 0);
  const firstFilter = d.querySelector("#pin-filters .filter-chip");
  firstFilter.click();
  const filteredPins = d.querySelectorAll("#pin-chips .chip.fijado").length;
  ok("a tag filter narrows the pin list", filteredPins > 0 && filteredPins < allPins);
  firstFilter.click(); // reset

  d.querySelector('.nav button[data-view="pool"]').click();
  ok("pool shows 32 exercises", d.querySelectorAll("#pool-list .card").length === 32);

  d.querySelector('.nav button[data-view="guia"]').click();
  ok("guide has 9 sections", d.querySelectorAll("#view-guia .acc").length === 9);

  if (code) console.error("\n--- UI TEST FAILURES ---");
  else console.log("UI tests OK");
  process.exit(code);
}, 250);
