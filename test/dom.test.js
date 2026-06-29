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

  // Persisted per-exercise kg: a freshly generated routine marks kg as
  // "sugerido"; nudging it stores the value and clears the hint on re-render.
  ok("kg shows a 'sugerido' hint before the user sets it", d.querySelectorAll("#routine-out .ex-kg-hint").length > 0);
  const incKg = d.querySelector("#routine-out .ex-kg-row .kg-adj:last-child");
  ok("editable routine exposes kg steppers", !!incKg);
  incKg.click();

  d.querySelector("#btn-guardar").click();
  d.querySelector('.nav button[data-view="hist"]').click();
  ok("history records the session", d.querySelectorAll("#hist-list .card").length === 1);

  // Workout timer: training a saved session opens the overlay with phases.
  const trainBtn = [...d.querySelectorAll("#hist-list .icon-btn")].find(b => b.textContent === "▶");
  ok("saved session has a train button", !!trainBtn);
  trainBtn.click();
  const overlay = d.querySelector("#timer-overlay");
  ok("timer overlay opens", overlay && !overlay.classList.contains("hidden"));
  ok("timer shows a step counter", /Paso 1 \//.test(d.querySelector("#t-step").textContent));
  ok("timer shows a countdown", /\d+:\d\d/.test(d.querySelector("#t-count").textContent));
  d.querySelector("#t-skip").click();
  ok("timer advances on skip", /Paso 2 \//.test(d.querySelector("#t-step").textContent));
  d.querySelector("#t-close").click();
  ok("timer closes", d.querySelector("#timer-overlay").classList.contains("hidden"));

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

  // Progress stats: with >=2 sessions a trend chart + figures render.
  ok("stats card renders with multiple sessions", !!d.querySelector("#hist-stats .stats-card"));
  ok("stats chart draws one bar per session shown", d.querySelectorAll("#hist-stats .stats-svg rect").length >= 2);
  manual[0].click(); // expand newest (21/06)
  ok("manual card shows per-set reps", /20 · 20 · 20 · 20/.test(d.querySelector("#hist-list").textContent));

  // Edit a manual register: change a note and reps, save, verify persisted.
  const editBtn = [...d.querySelectorAll("#hist-list .icon-btn")].find(b => b.textContent === "✎");
  ok("manual card has an edit button", !!editBtn);
  editBtn.click();
  const noteInp = [...d.querySelectorAll("#hist-list .manual-input")].find(i => i.value === "Foco agarre.");
  ok("editor exposes the note field", !!noteInp);
  noteInp.value = "Nota editada"; noteInp.dispatchEvent(new window.Event("input"));
  const repsInp = [...d.querySelectorAll("#hist-list .manual-input")].find(i => i.value === "20 20 20 20");
  repsInp.value = "22 22 22 22"; repsInp.dispatchEvent(new window.Event("input"));
  const editingCard = d.querySelector("#hist-list .manual-edit").closest(".card");
  const saveBtn = [...editingCard.querySelectorAll(".icon-btn")].find(b => b.textContent === "✓");
  saveBtn.click();
  const histTxt = d.querySelector("#hist-list").textContent;
  ok("edited note persists", /Nota editada/.test(histTxt));
  ok("edited reps persist", /22 · 22 · 22 · 22/.test(histTxt));

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
