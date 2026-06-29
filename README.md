# FORJA — Generador de rutinas de kettlebell

App web (PWA) para generar rutinas de entrenamiento con **una sola kettlebell**
(idealmente ajustable). Funciona **offline**, se **instala** en el movil y guarda
tu historial en el dispositivo. La logica de programacion deportiva vive en un
**motor de reglas** en JavaScript puro, separado de la interfaz.

No usa frameworks ni dependencias en tiempo de ejecucion: HTML + CSS + JS plano.

---

## Caracteristicas

- **Motor de reglas** que arma rutinas en bloques (Principal / Accesorios /
  Finalizador) con superseries antagonistas, gestion de fatiga y modelo de tiempo.
- **Objetivo** (fuerza / metabolico) y **foco** muscular (piernas / empuje / pull).
- **Balance de patrones** (ninguno / suave / duro con backtracking) para equilibrar
  empuje-tiron y cadera-rodilla.
- **Volumen por tiempo** (eliges minutos) o **por estructura** (eliges nº de ejercicios).
- **Fijar ejercicios** concretos y asignarles bloque; el resto se autocompleta.
- **Variar**: evita repetir lo de sesiones recientes (rota ejercicios).
- **Pesa ajustable**: define tu rango y cada ejercicio sugiere sus kg.
- **Pool editable**: añadir, editar y quitar ejercicios (32 de fabrica).
- **Historial** de sesiones con detalle y marca de completada.
- **Guia** integrada que explica cada concepto.

---

## Estructura del proyecto

```
forja/
├── index.html              App (enlaza estilos y scripts; PWA real)
├── styles.css              Estilos (tokens de diseno en :root)
├── manifest.webmanifest    Manifest PWA
├── sw.js                   Service worker (precache offline del app shell)
├── assets/
│   └── icon.svg            Icono de la app
├── src/
│   ├── engine.js           MOTOR de reglas (sin DOM). Define window.FORJA.
│   ├── app.js              INTERFAZ: estado, almacenamiento, render, eventos.
│   └── pwa.js              Registro del service worker.
├── build.js                Genera dist/forja.html (version de un solo archivo).
├── dist/
│   └── forja.html          Build autocontenido (para copiar al movil).
├── test/
│   ├── engine.test.js      Pruebas del motor (Node).
│   └── dom.test.js         Pruebas de interfaz (jsdom).
├── package.json
└── README.md
```

**Separacion clave:** `src/engine.js` no toca el DOM ni el almacenamiento —
solo recibe datos y devuelve datos. Toda la logica deportiva esta ahi y es
testeable en Node. `src/app.js` se encarga de pantalla, eventos y persistencia.

---

## Desarrollo

La app carga scripts y (en modo instalado) un service worker, asi que conviene
servirla por HTTP en vez de abrir el archivo directamente:

```bash
npm run serve          # python3 -m http.server 8000
# luego abre http://localhost:8000
```

Editas `src/*.js`, `styles.css` o `index.html` y recargas. No hay paso de
compilacion para desarrollar.

> Nota: abrir `index.html` con `file://` tambien funciona para probar la logica,
> pero el service worker no se registra bajo `file://` (sin precache offline).

### Build de un solo archivo

Para llevar la app al movil como un unico fichero (sin servidor):

```bash
npm run build          # genera dist/forja.html
```

`dist/forja.html` inlinea CSS y JS y embebe icono/manifest como `data:` URIs.
Funciona offline al abrirlo porque no depende de la red.

### Tests

```bash
npm test               # build + pruebas de motor (Node) + UI (jsdom)
```

---

## Despliegue como PWA

Sube la carpeta (todo menos `node_modules/`) a cualquier hosting estatico con
HTTPS — por ejemplo **GitHub Pages**:

1. Sube el repo a GitHub.
2. Settings → Pages → Deploy from branch → `main` / `root`.
3. Abre la URL en el movil y usa **"Añadir a pantalla de inicio"**.

Con HTTPS, el service worker (`sw.js`) precachea el app shell y la app abre
offline e instalada en pantalla completa.

---

## Datos y persistencia

Todo se guarda en el dispositivo (no hay servidor). El almacenamiento usa una
cascada: `window.storage` (si existe) → `localStorage` → memoria.

Claves (`forja:*`):

- `forja:cfg` — configuracion de Generar.
- `forja:hist` — historial de sesiones.
- `forja:custom` — ejercicios añadidos por el usuario.
- `forja:removed` — nombres de ejercicios base ocultados.
- `forja:overrides` — modificaciones por nombre sobre ejercicios base.

El pool efectivo se **recomputa** desde `FORJA.CATALOGO_BASE` aplicando
`overrides`, quitando `removed` y añadiendo `custom`. Asi, ampliar el catalogo
base en el codigo hace aparecer los ejercicios nuevos sin pisar lo del usuario
(hay migracion automatica desde el formato antiguo de pool completo).

---

## El motor de reglas (resumen tecnico)

`generar(pool, opts)` → elige plantilla por objetivo, la escala (tiempo o
estructura) y llama a `construirRutina`, que por cada bloque:

- **RuleEngine** (`validarCombinacion`): valida una superserie y le asigna
  calidad segun el bloque (en A las reglas son estrictas: nada de dos SNC alta,
  ni dos balisticos de agarre, ni mezclar fuerza con metabolico, ni repetir
  patron; el par ideal es antagonista o un core de descanso activo).
- **PresupuestoFatiga**: limita por sesion los ejercicios de SNC alta y los
  balisticos de agarre.
- **BalanceTracker** + `prioridad`: reparte patrones (suave/duro), aplica el
  **foco**, el **tier** (fundamental/accesorio/opcional) y una **penalizacion
  por uso reciente** (variar).
- **armarGreedy / armarBacktrack**: seleccion y emparejamiento. El modo de
  balance DURO usa backtracking para no dejar huecos en la cuota.
- **preplace**: coloca primero los ejercicios fijados por el usuario.

Modelo de tiempo: cada serie = trabajo (reps × tempo segun dinamica) + descanso
(segun rango); en superserie el descanso es compartido. El escalado por minutos
ajusta series y nº de ejercicios para acercarse a la duracion objetivo.

---

## Roadmap (ideas)

- Iconos PNG ademas del SVG para instalacion tipo tienda.
- Ayuda en contexto (iconos ⓘ junto a cada control que salten a la Guia).
- Edicion del bloque sugerido por defecto de cada ejercicio.
- Exportar/importar datos (backup del historial y del pool).
- Mas plantillas de objetivo (resistencia de fuerza, tecnica, EMOM/AMRAP).

---

## Licencia

MIT.
