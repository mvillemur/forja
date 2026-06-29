/**
 * FORJA — build.js
 * Generates `dist/forja.html`: a SELF-CONTAINED version (single file) of the
 * app, useful for copying to mobile and opening without a server. Inlines CSS
 * and JS, converts the manifest and icon to data: URIs, and replaces the
 * service worker registration (which needs a served sw.js) with a Blob-based
 * registration.
 *
 * Normal development does NOT need this build: just serve the folder
 * (see README). This script only produces the single-file deliverable.
 *
 * Usage:  node build.js
 */
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const read = (p) => fs.readFileSync(path.join(dir, p), "utf8");

const indexHtml = read("index.html");
const styles = read("styles.css");
const engine = read("src/engine.js");
const app = read("src/app.js");
const iconSvg = read("assets/icon.svg").trim();
const manifestObj = JSON.parse(read("manifest.webmanifest"));
const swCode = read("sw.js");

// Icon and manifest as data: URIs (the single file has no neighboring files).
const iconUri = "data:image/svg+xml," + encodeURIComponent(iconSvg);
manifestObj.icons = [{ src: iconUri, sizes: "any", type: "image/svg+xml", purpose: "any" }];
const manifestUri = "data:application/manifest+json," + encodeURIComponent(JSON.stringify(manifestObj));

// SW registration via Blob (no sw.js alongside the single file).
const swInline =
  '<script>\n(function(){try{if("serviceWorker" in navigator && location.protocol.indexOf("http")===0){' +
  "var b=new Blob([" + JSON.stringify(swCode) + '],{type:"text/javascript"});' +
  "navigator.serviceWorker.register(URL.createObjectURL(b)).catch(function(){});}}catch(e){}})();\n</script>";

let out = indexHtml
  // Inline styles, icon and manifest
  .replace('<link rel="icon" href="assets/icon.svg">', `<link rel="icon" href="${iconUri}">`)
  .replace('<link rel="apple-touch-icon" href="assets/icon.svg">', `<link rel="apple-touch-icon" href="${iconUri}">`)
  .replace('<link rel="manifest" href="manifest.webmanifest">', `<link rel="manifest" href="${manifestUri}">`)
  .replace('<link rel="stylesheet" href="styles.css">', `<style>\n${styles}\n</style>`)
  // Inline scripts (engine + app); SW registration switches to Blob
  .replace('<script src="src/engine.js"></script>', `<script>\n${engine}\n</script>`)
  .replace('<script src="src/app.js"></script>', `<script>\n${app}\n</script>`)
  .replace('<script src="src/pwa.js"></script>', swInline);

fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
fs.writeFileSync(path.join(dir, "dist", "forja.html"), out);
console.log("dist/forja.html generated: " + out.length + " bytes");
