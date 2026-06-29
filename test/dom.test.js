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

  d.querySelector('.nav button[data-view="pool"]').click();
  ok("pool shows 32 exercises", d.querySelectorAll("#pool-list .card").length === 32);

  d.querySelector('.nav button[data-view="guia"]').click();
  ok("guide has 8 sections", d.querySelectorAll("#view-guia .acc").length === 8);

  if (code) console.error("\n--- UI TEST FAILURES ---");
  else console.log("UI tests OK");
  process.exit(code);
}, 250);
