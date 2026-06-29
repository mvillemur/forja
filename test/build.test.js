/**
 * Sanity-checks the single-file build (dist/forja.html), produced by build.js
 * from index.html + styles.css + src/*.js. `npm test` runs build.js first, so
 * this asserts the build actually inlined everything and didn't silently emit a
 * broken/empty file. Drift between a STALE committed dist and current source is
 * caught separately by `npm run check:dist` (build + `git diff --exit-code`),
 * intended for CI on a clean checkout.
 */
const fs = require("fs");
const path = require("path");

const distPath = path.join(__dirname, "..", "dist", "forja.html");
let fail = 0;
const ok = (name, cond) => { console.log((cond ? "ok  " : "FAIL") + " - " + name); if (!cond) fail++; };

const exists = fs.existsSync(distPath);
ok("dist/forja.html exists after build", exists);

if (exists) {
  const html = fs.readFileSync(distPath, "utf8");
  ok("no external src=src/ script refs remain (engine + app inlined)", !/<script src="src\//.test(html));
  ok("no external stylesheet link remains (styles inlined)", !/<link rel="stylesheet" href="styles\.css">/.test(html));
  ok("engine is present (FORJA exposed)", html.includes(".FORJA"));
  ok("dist build is non-trivial in size", html.length > 20000);
}

if (fail) { console.error(`\n${fail} build check(s) failed`); process.exit(1); }
console.log("\nbuild checks passed");
