/**
 * Pruebas de interfaz con jsdom sobre el build autocontenido (dist/forja.html).
 * Ejecuta: `node test/dom.test.js` (requiere haber hecho `node build.js` antes;
 * `npm test` lo encadena). Valida el flujo principal sin navegador real.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "dist", "forja.html"), "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://forja.local/" });
const { window } = dom;
const d = window.document;

window.addEventListener("error", (e) => {
  console.error("ERROR DE RUNTIME:", (e.error && e.error.stack) || e.message);
  process.exit(1);
});

setTimeout(() => {
  let code = 0;
  const ok = (n, c) => { if (!c) { console.error("FALLO:", n); code = 1; } };

  d.querySelector("#btn-generar").click();
  ok("genera elementos", d.querySelectorAll("#rutina-out .element").length > 0);
  ok("muestra kg sugeridos", d.querySelectorAll("#rutina-out .ex-kg").length > 0);

  d.querySelector("#btn-guardar").click();
  d.querySelector('.nav button[data-view="hist"]').click();
  ok("historial registra la sesion", d.querySelectorAll("#hist-list .card").length === 1);

  d.querySelector('.nav button[data-view="pool"]').click();
  ok("pool muestra 32 ejercicios", d.querySelectorAll("#pool-list .card").length === 32);

  d.querySelector('.nav button[data-view="guia"]').click();
  ok("guia con 8 secciones", d.querySelectorAll("#view-guia .acc").length === 8);

  if (code) console.error("\n--- HAY FALLOS DE UI ---");
  else console.log("pruebas de UI OK");
  process.exit(code);
}, 250);
