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

  // Arms focus: a muscle-emphasis tag (not a pattern) that boosts
  // elbow-flexion/extension work in selection.
  const armsChip = d.querySelector('#focus-chips .chip[data-val="ARMS"]');
  ok("arms focus chip renders", !!armsChip);
  armsChip.click();
  d.querySelector("#btn-generar").click();
  ok("arms focus fills the session with arm-emphasis work",
    [...d.querySelectorAll("#routine-out .ex-name")].filter(n => /Curl|Remo|Dominadas|Press|Flexiones/.test(n.textContent)).length >= 2);
  armsChip.click();   // reset focus for the rest of the flow

  // Daily readiness: a "low energy" check surfaces a hint and still generates a
  // session; soreness toggles too. (The duration/load effect is covered
  // deterministically in the engine tests, which the random UI seed can't be.)
  ok("readiness controls render", !!d.querySelector("#seg-energy") && d.querySelectorAll("#sore-chips .chip").length === 4);
  ok("normal energy hides the readiness hint", d.querySelector("#readiness-hint").classList.contains("hidden"));
  d.querySelector('#seg-energy button[data-val="1"]').click();
  ok("low-energy surfaces a readiness hint", !d.querySelector("#readiness-hint").classList.contains("hidden"));
  ok("low-energy + strength suggests an easier objective", /metabolico|tecnica/i.test(d.querySelector("#readiness-hint").textContent));
  const soreChip = d.querySelector('#sore-chips .chip[data-val="HIP,KNEE"]');
  soreChip.click();
  ok("sore zone toggles on", soreChip.getAttribute("aria-pressed") === "true");
  d.querySelector("#btn-generar").click();
  ok("still generates a routine on a rough day", d.querySelectorAll("#routine-out .element").length > 0);
  d.querySelector('#seg-energy button[data-val="3"]').click();
  soreChip.click(); // reset to normal for the rest of the flow
  d.querySelector("#btn-generar").click();

  // Persisted per-exercise kg: a freshly generated routine marks kg as
  // "sugerido"; nudging it stores the value and clears the hint on re-render.
  ok("kg shows a 'sugerido' hint before the user sets it", d.querySelectorAll("#routine-out .ex-kg-hint").length > 0);
  const incKg = d.querySelector("#routine-out .ex-kg-row .kg-adj:last-child");
  ok("editable routine exposes kg steppers", !!incKg);
  incKg.click();

  // Double progression + RPE: the live routine shows Facil/OK/Duro buttons and
  // a rep target; tapping "OK" advances the target shown on the card.
  ok("editable routine shows RPE feedback buttons", d.querySelectorAll("#routine-out .prog-fb .prog-btn").length >= 3);
  const beforeTgt = d.querySelector("#routine-out .prog-target").textContent;
  d.querySelector("#routine-out .prog-btn.prog-ok").click();
  const afterTgt = d.querySelector("#routine-out .prog-target").textContent;
  ok("RPE 'OK' advances the rep target", afterTgt !== beforeTgt);

  // Same-weight mode: progression must bump the SHARED circuit weight (the
  // displayed kg key matches the renderer's), then restore a normal routine.
  d.querySelector('#seg-sameweight button[data-val="yes"]').click();
  d.querySelector("#btn-generar").click();
  const swBefore = [...d.querySelectorAll("#routine-out .ex-kg")].map(n => n.textContent).join("|");
  for (let i = 0; i < 6; i++) { const b = d.querySelector("#routine-out .prog-btn.prog-ok"); if (b) b.click(); }
  const swAfter = [...d.querySelectorAll("#routine-out .ex-kg")].map(n => n.textContent).join("|");
  ok("same-weight: progression updates the shared circuit weight", swAfter !== swBefore);
  d.querySelector('#seg-sameweight button[data-val="no"]').click();
  d.querySelector("#btn-generar").click();

  d.querySelector("#btn-guardar").click();
  d.querySelector('.nav button[data-view="hist"]').click();
  ok("history records the session", d.querySelectorAll("#hist-list .card").length === 1);

  // Edit the saved routine: sets/reps/kg persist on the session itself.
  const rEdit = [...d.querySelectorAll("#hist-list .icon-btn")].find(b => b.title === "Editar rutina");
  ok("saved routine has an edit button", !!rEdit);
  rEdit.click();
  ok("routine editor lists the prescriptions", d.querySelectorAll("#hist-list .red-row").length > 0);
  ok("routine editor offers a kg stepper", !!d.querySelector("#hist-list .red-kg"));
  // Swap the first slot's exercise; the editor repaints keeping the draft.
  const edSel = d.querySelector("#hist-list .red-row .mk-select");
  ok("routine editor lets you change the exercise", !!edSel && edSel.options.length > 1);
  const newName = [...edSel.options].map(o => o.value).find(v => v !== edSel.value);
  edSel.value = newName; edSel.dispatchEvent(new window.Event("change"));
  ok("swap keeps the editor open on the same draft", d.querySelectorAll("#hist-list .red-row").length > 0);
  // Then adjust kg and reps on the repainted editor.
  const edKg = d.querySelector("#hist-list .red-kg");
  edKg.querySelector(".kg-adj:last-child").click();   // +2 kg
  const kgTxt = edKg.querySelector(".mk-val").textContent;
  const edReps = d.querySelector("#hist-list .red-reps");
  if (edReps) edReps.querySelector(".kg-adj:last-child").click();
  [...d.querySelectorAll("#hist-list .btn")].find(b => /Guardar cambios/.test(b.textContent)).click();
  d.querySelector("#hist-list .hist-meta").click();   // reopen detail, view mode
  ok("swapped exercise persists on the saved session",
    [...d.querySelectorAll("#hist-list .ex-name")].some(n => n.textContent.includes(newName)));
  ok("edited kg persists on the saved session",
    [...d.querySelectorAll("#hist-list .ex-kg")].some(n => n.textContent === kgTxt));
  d.querySelector("#hist-list .hist-meta").click();   // collapse for the rest

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

  // Timer performance capture: the flow starts with the warm-up, rest phases
  // offer the set-log strip, and driving the session to the end auto-marks it
  // completed with the performed sets attached.
  trainBtn.click();
  ok("timer starts with the warm-up", /PREPARACION|CALENTAMIENTO/.test(d.querySelector("#t-kind").textContent));
  let sawLogStrip = false, guard = 0;
  while (!d.querySelector("#timer-overlay").classList.contains("hidden") && guard++ < 400) {
    if (!d.querySelector("#t-log").classList.contains("hidden")) sawLogStrip = true;
    d.querySelector("#t-skip").click();
  }
  ok("timer reaches the end without stalling", d.querySelector("#timer-overlay").classList.contains("hidden"));
  ok("rest phases offer the set-log strip", sawLogStrip);
  const doneBtn = [...d.querySelectorAll("#hist-list .icon-btn")].find(b => b.textContent === "✓");
  ok("finishing the timer auto-completes the session", doneBtn && doneBtn.classList.contains("on"));
  const storedHist = JSON.parse(window.localStorage.getItem("forja:hist"));
  ok("performed sets persist on the session (kg + reps per set)",
    Array.isArray(storedHist[0].performed) && storedHist[0].performed.length > 0 &&
    storedHist[0].performed.every(x => typeof x.name === "string" && Array.isArray(x.sets) && x.sets.length > 0));

  // CSV import: a tab-separated table with header maps each date to a session.
  const csv = [
    "Fecha\tBloque / Orden\tEjercicio\tCarga (kg)\tSerie 1\tSerie 2\tSerie 3\tSerie 4\tReps Totales\tNotas Tecnicas",
    "15/06/2026\tBloque A\tPeso Muerto Rumano\t18\t16\t10\t10\t\t=SUMA(E2:H2)\tRitmo controlado.",
    "15/06/2026\tBloque B\tSentadilla Goblet\t16\t8\t8\t8\t\t=SUMA(E3:H3)\tMovilidad.",
    "21/06/2026\tEjercicio 1\tPeso Muerto\t27\t20\t20\t20\t20\t=SUMA(E4:H4)\tFoco agarre.",
    "21/06/2026\tEjercicio 2\tSentadilla Goblet\t20\t6\t6\t6\t\t=SUMA(E5:H5)\tMas pesado.",
  ].join("\n");
  d.querySelector("#csv-input").value = csv;
  d.querySelector("#btn-csv-import").click();
  ok("CSV import adds 2 dated sessions", d.querySelectorAll("#hist-list .card").length === 3);
  const manual = [...d.querySelectorAll("#hist-list .hist-title")].filter(n => /Registro/.test(n.textContent));
  ok("CSV sessions render as manual cards", manual.length === 2);

  // Progress stats: with >=2 sessions a trend chart + figures render.
  ok("stats card renders with multiple sessions", !!d.querySelector("#hist-stats .stats-card"));
  ok("stats chart draws one bar per session shown", d.querySelectorAll("#hist-stats .stats-svg rect").length >= 2);

  // Estimated strength (e1RM): a grind logged across two dated sessions shows
  // up in the panel with a value and an upward trend.
  ok("e1RM panel renders for tracked grinds", !!d.querySelector("#hist-stats .e1rm-row"));
  ok("e1RM panel lists the tracked exercise", /Sentadilla Goblet/.test(d.querySelector("#hist-stats").textContent));
  ok("e1RM shows a trend after 2+ points", !!d.querySelector("#hist-stats .e1rm-trend.up"));

  manual[0].click(); // expand newest (21/06)
  ok("manual card shows per-set reps", /20 · 20 · 20 · 20/.test(d.querySelector("#hist-list").textContent));

  // Edit a manual register: change a note and reps, save, verify persisted.
  const editBtn = [...d.querySelectorAll("#hist-list .icon-btn")]
    .find(b => b.textContent === "✎" && b.title !== "Editar rutina");   // manual-log editor, not the routine editor
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

  // Manual routine builder: compose a routine by hand and get it scrutinized.
  d.querySelector('.nav button[data-view="gen"]').click();
  d.querySelector('#seg-mode button[data-val="manual"]').click();
  ok("manual mode shows the builder", !d.querySelector("#mode-manual").classList.contains("hidden"));
  ok("manual mode hides the generator", d.querySelector("#mode-auto").classList.contains("hidden"));
  // Declared objective: recommended (★) exercises rank first in the picker
  // and new rows take the objective's sets x reps for the block.
  d.querySelector('#seg-mk-obj button[data-val="POWER"]').click();
  d.querySelector('.mk-add[data-block="A"]').click();
  const recChips = d.querySelectorAll("#mk-A .mk-pick-chips .chip.mk-rec");
  const firstChip = d.querySelector("#mk-A .mk-pick-chips .chip");
  ok("declared objective recommends fitting exercises first",
    recChips.length > 0 && firstChip.classList.contains("mk-rec") && /★/.test(firstChip.textContent));
  firstChip.click();
  ok("declared objective prefills the template's sets x reps",
    /5x/.test(d.querySelector("#mk-A .mk-val").textContent) &&
    /3 reps/.test(d.querySelectorAll("#mk-A .mk-val")[1].textContent));
  d.querySelector("#mk-A .mk-rm").click();   // clean the row
  d.querySelector('#seg-mk-obj button[data-val="AUTO"]').click();   // back to Auto

  // "+ Anadir" opens a searchable picker; the query narrows the chips and
  // tapping one adds the row.
  d.querySelector('.mk-add[data-block="A"]').click();
  ok("add opens a searchable picker", !!d.querySelector("#mk-A .mk-pick"));
  const mkSearch = d.querySelector("#mk-A .mk-pick-search");
  const allChips = d.querySelectorAll("#mk-A .mk-pick-chips .chip").length;
  // Tag/category search: "balistico" (dynamics) matches swings by what they are.
  mkSearch.value = "balistico"; mkSearch.dispatchEvent(new window.Event("input"));
  const tagChips = [...d.querySelectorAll("#mk-A .mk-pick-chips .chip")];
  ok("picker search matches by tag/category", tagChips.length > 0 && tagChips.length < allChips &&
    tagChips.some(c => /Swing/.test(c.textContent)));
  mkSearch.value = "tiron balistico"; mkSearch.dispatchEvent(new window.Event("input"));
  const comboChips = [...d.querySelectorAll("#mk-A .mk-pick-chips .chip")];
  ok("picker search ANDs multiple terms", comboChips.length > 0 && comboChips.length < tagChips.length &&
    comboChips.every(c => /Row|Remo/.test(c.textContent)));
  mkSearch.value = "swing"; mkSearch.dispatchEvent(new window.Event("input"));
  const hitChips = d.querySelectorAll("#mk-A .mk-pick-chips .chip");
  ok("picker search narrows the exercises", hitChips.length > 0 && hitChips.length < allChips);
  hitChips[0].click();
  ok("picking adds the row and closes the picker",
    d.querySelectorAll("#mk-A .mk-row").length === 1 && !d.querySelector("#mk-A .mk-pick") &&
    /swing/i.test(d.querySelector("#mk-A .mk-select").value));
  const addB = () => { d.querySelector('.mk-add[data-block="B"]').click(); d.querySelector("#mk-B .mk-pick-chips .chip").click(); };
  addB(); addB();
  ok("builder renders one row per added exercise", d.querySelectorAll("#mk-A .mk-row").length === 1 && d.querySelectorAll("#mk-B .mk-row").length === 2);
  // Weight: KB rows expose a kg stepper (suggested until nudged); nudging it
  // fixes the weight, which the composed routine then displays.
  const kgVal = [...d.querySelectorAll("#mk-A .mk-val")].find(n => / kg$/.test(n.textContent));
  ok("builder rows expose a kg stepper", !!kgVal && kgVal.classList.contains("mk-kg-sug"));
  kgVal.parentNode.querySelector(".kg-adj:last-child").click();   // +2 kg
  ok("nudging kg fixes the weight", !kgVal.classList.contains("mk-kg-sug"));
  const chosenKg = parseInt(kgVal.textContent, 10);
  const pairBtn = d.querySelector("#mk-B .mk-pair");
  ok("second row offers a superset link", !!pairBtn);
  pairBtn.click();
  d.querySelector("#btn-componer").click();
  ok("composing renders the manual routine", d.querySelectorAll("#routine-out .element").length === 2);
  ok("composed routine uses the chosen weight", [...d.querySelectorAll("#routine-out .ex-kg")].some(n => n.textContent === chosenKg + " kg"));
  ok("paired rows render as a superset", d.querySelectorAll("#routine-out .element.ss").length === 1);
  ok("scrutiny card renders with a score", !!d.querySelector("#audit-out .audit-card") && /\/100/.test(d.querySelector("#audit-out .audit-score").textContent));
  ok("scrutiny identifies the routine type", /Perfil detectado|Perfil mixto/.test(d.querySelector("#audit-out .audit-infer").textContent));
  ok("scrutiny assesses the routine against its objective", /Para (Fuerza|Metabolico|Resistencia|Potencia)/.test(d.querySelector("#audit-out .audit-card").textContent));
  ok("assessment lists strengths or global adjustments", d.querySelectorAll("#audit-out .audit-item.aud-good, #audit-out .audit-item.aud-adj").length > 0);
  ok("scrutiny flags the duplicated exercise", [...d.querySelectorAll("#audit-out .audit-item")].some(n => /veces/.test(n.textContent)));
  ok("scrutiny offers suggestions after the findings", !!d.querySelector("#audit-out .audit-sug-label") &&
    d.querySelectorAll("#audit-out .audit-item.aud-sug").length > 0);
  d.querySelector("#btn-guardar").click();
  d.querySelector('.nav button[data-view="hist"]').click();
  ok("manual session lands in history as 'Creada por mi'", /Creada por mi/.test(d.querySelector("#hist-list .hist-title").textContent));
  // Scrutinize later: expanding a saved session offers an audit button.
  d.querySelector("#hist-list .hist-meta").click();
  const laterAudit = d.querySelector("#hist-list .audit-btn");
  ok("saved session detail offers Escrutinio", !!laterAudit);
  laterAudit.click();
  ok("Escrutinio renders the audit in the detail", !!d.querySelector("#hist-list .audit-card"));
  // Bridge: "Completar con el generador" pins the draft rows (with their
  // block) and hands off to the generator, which fills the rest.
  d.querySelector('.nav button[data-view="gen"]').click();
  d.querySelector('#seg-mode button[data-val="manual"]').click();
  d.querySelector("#btn-mk-complete").click();
  ok("bridge switches back to the generator", !d.querySelector("#mode-auto").classList.contains("hidden"));
  ok("bridge pins the draft exercises", d.querySelector("#pin-count").textContent === "(3)");
  ok("bridge generates a completed routine", d.querySelectorAll("#routine-out .element").length > 0);

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
  ok("pool shows 39 exercises", d.querySelectorAll("#pool-list .card").length === 39);
  ok("pool shows a plyometric tag", /pliometrico/i.test(d.querySelector("#pool-list").textContent));

  // Pool search narrows the list by name; clearing restores it.
  const search = d.querySelector("#pool-search");
  search.value = "swing"; search.dispatchEvent(new window.Event("input"));
  const swingHits = d.querySelectorAll("#pool-list .card").length;
  ok("pool search narrows by name", swingHits > 0 && swingHits < 39);
  search.value = "cadera"; search.dispatchEvent(new window.Event("input"));
  const catHits = d.querySelectorAll("#pool-list .card").length;
  ok("pool search matches by category too", catHits > 0 && catHits < 39);
  search.value = "brazos"; search.dispatchEvent(new window.Event("input"));
  const armHits = d.querySelectorAll("#pool-list .card").length;
  ok("pool search matches the arms tag", armHits > 0 && armHits < 39);
  search.value = ""; search.dispatchEvent(new window.Event("input"));
  ok("clearing pool search restores the list", d.querySelectorAll("#pool-list .card").length === 39);
  // A tag filter narrows the pool too.
  const pf = d.querySelector("#pool-filters .filter-chip");
  ok("pool exposes tag filters", !!pf);
  pf.click();
  ok("pool tag filter narrows the list", d.querySelectorAll("#pool-list .card").length < 39);
  pf.click(); // reset

  // Pause an exercise: it leaves selection (generator, picker, pins) but
  // stays in the pool, dimmed, and reactivates with everything intact.
  const swingCard = [...d.querySelectorAll("#pool-list .pool-item")].find(r => /Swing \(dos manos\)/.test(r.textContent));
  ok("pool card offers a pause button", !!swingCard && swingCard.querySelector(".icon-btn").textContent === "⏸");
  swingCard.querySelector(".icon-btn").click();
  const pausedCard = [...d.querySelectorAll("#pool-list .pool-item")].find(r => /Swing \(dos manos\)/.test(r.textContent));
  ok("paused exercise stays listed with a 'pausado' tag", !!pausedCard && /pausado/.test(pausedCard.textContent) && pausedCard.classList.contains("paused"));
  d.querySelector('.nav button[data-view="gen"]').click();
  d.querySelector('#seg-mode button[data-val="auto"]').click();
  d.querySelector("#btn-generar").click();
  ok("paused exercise never enters a generated routine",
    ![...d.querySelectorAll("#routine-out .ex-name")].some(n => /Swing \(dos manos\)/.test(n.textContent)));
  d.querySelector('#seg-mode button[data-val="manual"]').click();
  d.querySelector('.mk-add[data-block="A"]').click();
  const pkSearch = d.querySelector("#mk-A .mk-pick-search");
  pkSearch.value = "dos manos"; pkSearch.dispatchEvent(new window.Event("input"));
  ok("paused exercise is missing from the builder picker",
    ![...d.querySelectorAll("#mk-A .mk-pick-chips .chip")].some(c => /Swing \(dos manos\)/.test(c.textContent)));
  d.querySelector('.mk-add[data-block="A"]').click();   // close picker
  d.querySelector('#seg-mode button[data-val="auto"]').click();
  d.querySelector('.nav button[data-view="pool"]').click();
  const resumeCard = [...d.querySelectorAll("#pool-list .pool-item")].find(r => /Swing \(dos manos\)/.test(r.textContent));
  resumeCard.querySelector(".icon-btn").click();   // ▶ reactivate
  ok("reactivated exercise loses the paused state",
    ![...d.querySelectorAll("#pool-list .pool-item")].find(r => /Swing \(dos manos\)/.test(r.textContent)).classList.contains("paused"));

  // Backup card: status line renders; auto-backup controls only appear when
  // the browser has the File System Access API (jsdom does not).
  ok("backup card shows copy status", /Sin copias|Ultima copia/.test(d.querySelector("#backup-status").textContent));
  ok("auto-backup link stays hidden without FS Access", d.querySelector("#btn-link-backup").classList.contains("hidden"));
  ok("share button hidden without navigator.share", d.querySelector("#btn-share-backup").classList.contains("hidden"));

  d.querySelector('.nav button[data-view="guia"]').click();
  ok("guide has 16 sections", d.querySelectorAll("#view-guia .acc").length === 16);
  ok("guide cites a bibliography", d.querySelectorAll("#view-guia .ref").length >= 5);
  ok("guide documents e1RM for users", /e1RM/.test(d.querySelector("#view-guia").textContent));
  ok("guide documents daily readiness", /llegas hoy/i.test(d.querySelector("#view-guia").textContent));

  // ---- Catalog rename migration: a fresh app load with OLD-name user data
  // in storage must remap every name-keyed store to the curated names.
  const dom2 = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://forja.local/",
    beforeParse(w) {
      w.localStorage.setItem("forja:kg", JSON.stringify({ "Kettlebell Swings (Dos manos)": 24, "Swing Cleans": 16, "Dead Cleans": 20 }));
      w.localStorage.setItem("forja:prog", JSON.stringify({ "Two Hand Row": 9 }));
      w.localStorage.setItem("forja:removed", JSON.stringify(["Upright Row", "Swing Cleans"]));
      w.localStorage.setItem("forja:cfg", JSON.stringify({ pinned: [{ name: "Two Hand Row", block: "A" }] }));
    },
  });
  dom2.window.addEventListener("error", (e) => {
    console.error("RUNTIME ERROR (migration run):", (e.error && e.error.stack) || e.message);
    process.exit(1);
  });
  setTimeout(() => {
    const ls = dom2.window.localStorage;
    const kg = JSON.parse(ls.getItem("forja:kg"));
    ok("migration: kg keys follow renames", kg["Swing (dos manos)"] === 24 && kg["Kettlebell Swings (Dos manos)"] == null);
    ok("migration: merged kg keeps the heavier working weight", kg["Clean (una mano)"] === 20);
    const prog = JSON.parse(ls.getItem("forja:prog"));
    ok("migration: rep targets follow renames", prog["Remo (dos manos)"] === 9);
    const removed = JSON.parse(ls.getItem("forja:removed"));
    ok("migration: removals follow renames", removed.includes("Remo Vertical"));
    ok("migration: a half-removed merge stays available", !removed.includes("Clean (una mano)"));
    const cfg = JSON.parse(ls.getItem("forja:cfg"));
    ok("migration: pins follow renames", cfg.pinned.some(f => f.name === "Remo (dos manos)"));

    if (code) console.error("\n--- UI TEST FAILURES ---");
    else console.log("UI tests OK");
    process.exit(code);
  }, 250);
}, 250);
