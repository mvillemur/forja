/**
 * FORJA — build.js
 * Genera `dist/forja.html`: una version AUTOCONTENIDA (un solo archivo) de la
 * app, util para copiar al movil y abrir sin servidor. Inlinea CSS y JS,
 * convierte el manifest y el icono a data: URIs, y reemplaza el registro del
 * service worker (que necesita un sw.js servido) por un registro via Blob.
 *
 * El desarrollo normal NO necesita este build: basta servir la carpeta
 * (ver README). Este script solo produce el entregable de un archivo.
 *
 * Uso:  node build.js
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

// Icono y manifest como data: URIs (el single-file no tiene archivos vecinos).
const iconUri = "data:image/svg+xml," + encodeURIComponent(iconSvg);
manifestObj.icons = [{ src: iconUri, sizes: "any", type: "image/svg+xml", purpose: "any" }];
const manifestUri = "data:application/manifest+json," + encodeURIComponent(JSON.stringify(manifestObj));

// Registro de SW por Blob (no hay sw.js junto al archivo unico).
const swInline =
  '<script>\n(function(){try{if("serviceWorker" in navigator && location.protocol.indexOf("http")===0){' +
  "var b=new Blob([" + JSON.stringify(swCode) + '],{type:"text/javascript"});' +
  "navigator.serviceWorker.register(URL.createObjectURL(b)).catch(function(){});}}catch(e){}})();\n</script>";

let out = indexHtml
  // Estilos e icono/manifest inline
  .replace('<link rel="icon" href="assets/icon.svg">', `<link rel="icon" href="${iconUri}">`)
  .replace('<link rel="apple-touch-icon" href="assets/icon.svg">', `<link rel="apple-touch-icon" href="${iconUri}">`)
  .replace('<link rel="manifest" href="manifest.webmanifest">', `<link rel="manifest" href="${manifestUri}">`)
  .replace('<link rel="stylesheet" href="styles.css">', `<style>\n${styles}\n</style>`)
  // Scripts inline (engine + app); el registro de SW pasa a Blob
  .replace('<script src="src/engine.js"></script>', `<script>\n${engine}\n</script>`)
  .replace('<script src="src/app.js"></script>', `<script>\n${app}\n</script>`)
  .replace('<script src="src/pwa.js"></script>', swInline);

fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
fs.writeFileSync(path.join(dir, "dist", "forja.html"), out);
console.log("dist/forja.html generado: " + out.length + " bytes");
