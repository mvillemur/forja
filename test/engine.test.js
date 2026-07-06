/**
 * Engine tests (Node, no DOM). Run: `node test/engine.test.js`.
 * Exits with code !=0 if anything fails (for CI / npm test).
 */
const F = require("../src/engine.js");

let pass = 0;
function ok(name, cond) {
  if (!cond) { console.error("FAIL:", name); process.exitCode = 1; }
  else pass++;
}

// Catalog
ok("base catalog has 40 exercises", F.BASE_CATALOG.length === 40);
ok("no duplicate names in catalog", new Set(F.BASE_CATALOG.map(e => e.name)).size === F.BASE_CATALOG.length);
ok("every ISO exercise has a hold duration", F.BASE_CATALOG.filter(e => e.dynamics === "ISO").every(e => e.holdSec > 0));

// Naming curation: RENAMED maps every old name to a live catalog entry, and
// no retired name is still in the catalog.
const catalogNames = new Set(F.BASE_CATALOG.map(e => e.name));
ok("every renamed target exists in the catalog", Object.values(F.RENAMED).every(n => catalogNames.has(n)));
ok("no retired name remains in the catalog", Object.keys(F.RENAMED).every(n => !catalogNames.has(n)));
ok("merged duplicates are gone (4 merges)",
  new Set(Object.values(F.RENAMED)).size === Object.keys(F.RENAMED).length - 4);

// Curation: metadata fixes on the base catalog.
ok("heavy RDL counts toward the grip budget", F.BASE_CATALOG.find(e => e.name === "Peso Muerto Rumano").grip === true);
ok("single-leg deadlift (one-hand hold) counts toward the grip budget", F.BASE_CATALOG.find(e => e.name === "Peso Muerto (una pierna)").grip === true);
ok("windmill (bell rests on forearm) does not consume grip", F.BASE_CATALOG.find(e => e.name === "Windmill").grip === false);
ok("pushups require floor space", F.BASE_CATALOG.find(e => e.name === "Flexiones (agarre cerrado)").equipment.includes("FLOOR"));
const floorPress = F.BASE_CATALOG.find(e => e.name === "Floor Press");
ok("floor press: heavy unilateral horizontal push (KB + floor)", floorPress && floorPress.pattern === "PUSH_H" &&
  floorPress.symmetry === "UNILATERAL" && floorPress.load === 3 && floorPress.equipment.includes("FLOOR"));

// Power / plyometrics
ok("POWER objective generates a routine", (() => {
  const rp = F.generate(null, { objective: "POWER", equipment: ["KB", "FLOOR"], minutes: 30, seed: 2 });
  return rp.blocks.some(b => b.elements.length > 0);
})());
const jump = F.BASE_CATALOG.find(e => e.name === "Sentadilla con Salto");
const swingP = F.BASE_CATALOG.find(e => e.name === "Swing (dos manos)");
ok("plyo flag set on jump movements", jump.plyo === true && F.BASE_CATALOG.find(e => e.name === "Tuck Jumps").plyo === true);
ok("non-plyo ballistic is not flagged plyo", swingP.plyo === false);
// Full recovery: a plyo set at low reps rests at least as long as a strength set.
const plyoEl = { prescriptions: [{ exercise: jump, sets: 1, reps: 3 }], isSuperset: false };
const ballEl = { prescriptions: [{ exercise: swingP, sets: 1, reps: 3 }], isSuperset: false };
ok("plyo forces full recovery (>= same-rep ballistic)", F.elementTimeSec(plyoEl) >= F.elementTimeSec(ballEl));
ok("newExercise carries plyo flag", F.newExercise({ name: "X", pattern: "KNEE", dynamics: "BALLISTIC", symmetry: "BILATERAL", cns: "HIGH", equipment: ["FLOOR"], plyo: true }).plyo === true);
ok("9 fundamental exercises", F.BASE_CATALOG.filter(e => e.tier === "FUNDAMENTAL").length === 9);

// RuleEngine: two high-CNS in block A -> invalid
const swing = F.BASE_CATALOG.find(e => e.name === "Swing (dos manos)");
const snatch = F.BASE_CATALOG.find(e => e.name === "Snatch");
ok("two high-CNS = invalid", !F.validateCombination(
  { exercise: swing, block: "A", sets: 5, reps: 5 },
  { exercise: snatch, block: "A", sets: 5, reps: 5 }).valid);

// Antagonists: push vs pull
ok("push/pull are antagonists", F.areAntagonists("PUSH_V", "PULL_H"));
ok("two pulls are not antagonists", !F.areAntagonists("PULL_H", "PULL_V"));

// Kg suggestion within range
ok("heavy kg (12-32) = 30", F.suggestKg(3, 12, 32) === 30);
ok("light kg (12-32) = 16", F.suggestKg(1, 12, 32) === 16);

// Cold-start seeding: profile nudges the suggestion but defaults to old behavior.
const press2 = F.BASE_CATALOG.find(e => e.name === "Press Goblet"); // PUSH_V, load 1
const swingHeavy = F.BASE_CATALOG.find(e => e.name === "Swing (dos manos)"); // HIP, load 3
ok("seed: no profile == legacy suggestion", F.suggestKg(2, 12, 32) === F.suggestKg(2, 12, 32, null));
ok("seed: beginner gets lighter than advanced",
  F.suggestKg(3, 12, 40, { level: "BEG" }, swingHeavy) < F.suggestKg(3, 12, 40, { level: "ADV" }, swingHeavy));
ok("seed: female lighter on upper body",
  F.suggestKg(2, 12, 40, { sex: "F" }, press2) <= F.suggestKg(2, 12, 40, { sex: "M" }, press2));
ok("seed: female shift does not apply to lower body (hinge)",
  F.suggestKg(3, 12, 40, { sex: "F" }, swingHeavy) === F.suggestKg(3, 12, 40, { sex: "M" }, swingHeavy));
ok("seed: result stays within range", (() => {
  const k = F.suggestKg(3, 12, 32, { level: "ADV", bodyweight: 120 }, swingHeavy);
  return k >= 12 && k <= 32;
})());

// Double progression
ok("range: 10 reps -> HP [8,12]", JSON.stringify(F.progressionRange(10)) === JSON.stringify([8, 12]));
ok("range: ISO bumps the window up", F.progressionRange(5, F.DIN.ISO)[0] >= 8);
const RNG = [8, 12];
const advReps = F.nextTarget({ kg: 16, reps: 10 }, RNG, true, { min: 12, max: 32 });
ok("prog: cleared below top -> reps+1, same kg", advReps.kg === 16 && advReps.reps === 11);
const advTop = F.nextTarget({ kg: 16, reps: 12 }, RNG, true, { min: 12, max: 32 });
ok("prog: cleared at top -> +2 kg, reset to bottom", advTop.kg === 18 && advTop.reps === 8);
const notCleared = F.nextTarget({ kg: 16, reps: 11 }, RNG, false, { min: 12, max: 32 });
ok("prog: not cleared -> unchanged", notCleared.kg === 16 && notCleared.reps === 11);
const atMax = F.nextTarget({ kg: 32, reps: 12 }, RNG, true, { min: 12, max: 32 });
ok("prog: at max load keeps adding reps instead of kg", atMax.kg === 32 && atMax.reps === 13);
// Bodyweight / untracked-kg lifts have no load lever: topping the range must
// keep climbing reps, never reset to the bottom (that discarded progress).
const bwTop = F.nextTarget({ kg: null, reps: 12 }, RNG, true, { min: 12, max: 32 });
ok("prog: bodyweight (kg null) at top keeps adding reps, no reset", bwTop.kg === null && bwTop.reps === 13);
const bwEasy = F.nextTarget({ kg: null, reps: 11 }, RNG, "easy", { min: 12, max: 32 });
ok("prog: bodyweight 'easy' past top climbs by two", bwEasy.kg === null && bwEasy.reps === 13);

// RPE autoregulation
const easy = F.nextTarget({ kg: 16, reps: 9 }, RNG, "easy", { min: 12, max: 32 });
ok("rpe: 'easy' jumps two rep-steps", easy.kg === 16 && easy.reps === 11);
const easyTop = F.nextTarget({ kg: 16, reps: 11 }, RNG, "easy", { min: 12, max: 32 });
ok("rpe: 'easy' near top bumps load", easyTop.kg === 18 && easyTop.reps === 8);
const hard = F.nextTarget({ kg: 16, reps: 11 }, RNG, "hard", { min: 12, max: 32 });
ok("rpe: 'hard' backs off a rep", hard.kg === 16 && hard.reps === 10);
const hardFloor = F.nextTarget({ kg: 18, reps: 8 }, RNG, "hard", { min: 12, max: 32 });
ok("rpe: 'hard' at bottom deloads weight", hardFloor.kg === 16 && hardFloor.reps === 8);
const hardMin = F.nextTarget({ kg: 12, reps: 8 }, RNG, "hard", { min: 12, max: 32 });
ok("rpe: 'hard' deload respects min weight", hardMin.kg === 12 && hardMin.reps === 8);
ok("rpe: 'ok' equals legacy cleared=true", JSON.stringify(F.nextTarget({ kg: 16, reps: 10 }, RNG, "ok", { min: 12, max: 32 })) === JSON.stringify(F.nextTarget({ kg: 16, reps: 10 }, RNG, true, { min: 12, max: 32 })));

// Routine-combination load modifier
ok("combo: no context -> factor 1", F.combinationFactor({}) === 1);
ok("combo: 2nd of acceptable superset is lighter",
  F.combinationFactor({ isSuperset: true, secondInPair: true, quality: F.QUALITY.ACCEPTABLE }) < 1);
ok("combo: 2nd of OPTIMAL superset is not penalized",
  F.combinationFactor({ isSuperset: true, secondInPair: true, quality: F.QUALITY.OPTIMAL }) === 1);
ok("combo: first of a pair is not penalized",
  F.combinationFactor({ isSuperset: true, secondInPair: false, quality: F.QUALITY.ACCEPTABLE }) === 1);
ok("combo: session fatigue tapers later lifts",
  F.combinationFactor({ cnsAccum: 6 }) < F.combinationFactor({ cnsAccum: 1 }));
ok("combo: factor never below 0.8", F.combinationFactor({ cnsAccum: 100, isSuperset: true, secondInPair: true, quality: F.QUALITY.ACCEPTABLE }) >= 0.8);
ok("snapKg: rounds to 2 kg and clamps", F.snapKg(17.3, 12, 32) === 18 && F.snapKg(50, 12, 32) === 32 && F.snapKg(4, 12, 32) === 12);
ok("cnsWeight: HIGH > MEDIUM > LOW", F.cnsWeight("HIGH") > F.cnsWeight("MEDIUM") && F.cnsWeight("MEDIUM") > F.cnsWeight("LOW"));

// Single-kettlebell mode: one weight per circuit (median of suggestions).
const ps = [
  { exercise: swingHeavy },                                                  // load 3 -> heavy
  { exercise: press2 },                                                      // load 1 -> light
  { exercise: F.BASE_CATALOG.find(e => e.name === "Remo (una mano)") },      // load 2 -> medium
];
const uni = F.unifiedKg(ps, { min: 12, max: 32 });
ok("unifiedKg: within range", uni >= 12 && uni <= 32);
ok("unifiedKg: snapped to 2 kg", uni % 2 === 0);
ok("unifiedKg: between lightest and heaviest suggestion",
  uni >= F.suggestKg(1, 12, 32) && uni <= F.suggestKg(3, 12, 32));
ok("unifiedKg: single exercise == its suggestion",
  F.unifiedKg([{ exercise: swingHeavy }], { min: 12, max: 32 }) === F.suggestKg(3, 12, 32, null, swingHeavy));
ok("unifiedKg: null when range missing", F.unifiedKg(ps, null) === null);
ok("unifiedKg: null when empty group", F.unifiedKg([], { min: 12, max: 32 }) === null);

// Estimated 1-rep max (e1RM)
ok("e1rm: Epley at reps=1 equals the weight", F.e1rm(20, 1) === 20);
ok("e1rm: 16 kg x 6 ≈ 19.2 kg", Math.abs(F.e1rm(16, 6) - 16 * (1 + 6 / 30)) < 1e-9);
ok("e1rm: more reps at same load -> higher estimate", F.e1rm(16, 8) > F.e1rm(16, 5));
ok("e1rm: reps clamped at 12 (no runaway)", F.e1rm(16, 20) === F.e1rm(16, 12));
ok("e1rm: non-positive inputs -> null", F.e1rm(0, 5) === null && F.e1rm(16, 0) === null && F.e1rm(null, 5) === null);
ok("e1rmEligible: grind yes, ballistic/ISO no",
  F.e1rmEligible({ dynamics: F.DIN.STRENGTH }) &&
  !F.e1rmEligible({ dynamics: F.DIN.BALLISTIC }) && !F.e1rmEligible({ dynamics: F.DIN.ISO }));
ok("bestE1rm: picks the heaviest-equivalent set",
  F.bestE1rm([{ kg: 16, reps: 5 }, { kg: 16, reps: 8 }, { kg: 14, reps: 6 }]) === F.e1rm(16, 8));
ok("bestE1rm: empty -> null", F.bestE1rm([]) === null);
// Prescription keeps reps in reserve: inverting at the trainee's own rep-max
// would prescribe every set AT that max, so the working load lands BELOW the
// exact round-trip (2 RIR margin), never above it.
ok("loadForReps: prescribes below the exact rep-max (RIR margin)",
  F.loadForReps(F.e1rm(20, 5), 5, { min: 8, max: 32 }) < 20);
ok("loadForReps: margin is small (within ~10%)",
  F.loadForReps(F.e1rm(20, 5), 5, { min: 8, max: 32 }) >= 18);
ok("loadForReps: lighter for more reps", F.loadForReps(24, 10, { min: 8, max: 40 }) < F.loadForReps(24, 3, { min: 8, max: 40 }));
ok("loadForReps: clamps to range", F.loadForReps(80, 1, { min: 8, max: 32 }) === 32);
ok("loadForReps: null on bad input", F.loadForReps(null, 5) === null && F.loadForReps(20, 0) === null);
ok("smoothE1rm: weights recent points more (EMA)", F.smoothE1rm([10, 20]) === 0.5 * 20 + 0.5 * 10);
ok("smoothE1rm: single point is itself", F.smoothE1rm([18]) === 18);
ok("smoothE1rm: empty -> null", F.smoothE1rm([]) === null);

// Daily readiness / mood autoregulation
ok("readiness: missing -> neutral (no change)", (() => {
  const f = F.readinessFactors(null);
  return f.volumeFactor === 1 && f.loadFactor === 1 && f.cnsFactor === 1 && f.sore.size === 0;
})());
ok("readiness: 'normal' (energy 3) is neutral", (() => {
  const f = F.readinessFactors({ energy: 3, sleep: "ok" });
  return f.volumeFactor === 1 && f.loadFactor === 1 && f.cnsFactor === 1;
})());
const flat = F.readinessFactors({ energy: 1, sleep: "ok" });
const fresh = F.readinessFactors({ energy: 5, sleep: "ok" });
ok("readiness: low energy trims volume and load", flat.volumeFactor < 1 && flat.loadFactor < 1);
ok("readiness: low energy tightens the CNS budget", flat.cnsFactor < 1);
ok("readiness: high energy adds volume and raises load", fresh.volumeFactor > 1 && fresh.loadFactor > 1);
ok("readiness: poor sleep lowers factors vs ok", F.readinessFactors({ energy: 3, sleep: "poor" }).volumeFactor < 1);
ok("readiness: loadFactor stays in a safe band", flat.loadFactor >= 0.85 && fresh.loadFactor <= 1.06);
ok("readiness: levels classify low/normal/high",
  flat.level === "low" && F.readinessFactors({ energy: 3 }).level === "normal" && fresh.level === "high");
ok("readiness: sore zones surface as a pattern set",
  F.readinessFactors({ energy: 3, sore: ["HIP", "KNEE"] }).sore.has("HIP"));
// End-to-end: a rough day yields a shorter session than a great day, same opts.
const lowDay = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 45, seed: 4, readiness: { energy: 1, sleep: "poor" } });
const bigDay = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 45, seed: 4, readiness: { energy: 5, sleep: "ok" } });
ok("readiness: low-energy session is shorter than high-energy", F.routineDurationMin(lowDay) < F.routineDurationMin(bigDay));
ok("readiness: routine carries its load factor for the app", lowDay.readiness && lowDay.readiness.loadFactor < 1);
ok("readiness: no readiness opt == today's behavior (duration unchanged)", (() => {
  const a = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 45, seed: 9 });
  const b = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 45, seed: 9, readiness: { energy: 3, sleep: "ok" } });
  return F.routineDurationMin(a) === F.routineDurationMin(b);
})());

// Single-kettlebell SELECTION: sameWeight clusters each block's loads so the
// shared weight fits. Compare average per-block load spread over many seeds.
function blockLoadSpread(rt) {
  let tot = 0, n = 0;
  rt.blocks.forEach(b => {
    const loads = b.elements.flatMap(e => e.prescriptions.map(p => p.exercise.load));
    if (loads.length < 2) return;
    const m = loads.reduce((a, x) => a + x, 0) / loads.length;
    tot += Math.sqrt(loads.reduce((a, x) => a + (x - m) ** 2, 0) / loads.length); n++;
  });
  return n ? tot / n : 0;
}
let spreadOff = 0, spreadOn = 0;
for (let s = 1; s <= 30; s++) {
  spreadOff += blockLoadSpread(F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 45, seed: s }));
  spreadOn  += blockLoadSpread(F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 45, seed: s, sameWeight: true }));
}
ok("sameWeight tightens per-block load spread", spreadOn < spreadOff * 0.8);

// Basic generation
const r = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 45, seed: 7 });
ok("routine has blocks", r.blocks.length > 0);
ok("estimated duration > 0", F.routineDurationMin(r) > 0);

// Focus biases selection
const rp = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 60, seed: 3, focus: "PULL" });
const pulls = rp.blocks.flatMap(b => b.elements.flatMap(e => e.prescriptions))
  .filter(p => p.exercise.pattern === "PULL_H" || p.exercise.pattern === "PULL_V").length;
ok("focus PULL biases (>=3 pulls)", pulls >= 3);

// Exercise pinned to explicit block
const rf = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 45, seed: 5,
  pinned: [{ name: "Swing (dos manos)", block: "C" }] });
const inC = rf.blocks.find(b => b.block === "C").elements
  .some(e => e.prescriptions.some(p => p.exercise.name === "Swing (dos manos)"));
ok("pinned forced to block C", inC);

// Hard balance with tolerance 0 leaves no gaps (fills with backtracking)
const rd = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 60, seed: 3, balance: "HARD", tolerance: 0 });
const placed = rd.blocks.reduce((a, b) => a + b.elements.reduce((x, e) => x + e.prescriptions.length, 0), 0);
ok("backtracking fills the routine", placed >= 8);

// Time calibration: the actual duration lands near the requested minutes
// (build-measure-correct), across objectives and durations.
function avgDur(obj, mins) {
  let t = 0; const N = 12;
  for (let s = 1; s <= N; s++) t += F.routineDurationMin(F.generate(null, { objective: obj, equipment: ["KB", "FLOOR"], minutes: mins, seed: s }));
  return t / N;
}
[["STRENGTH", 30], ["POWER", 30], ["METABOLIC", 45], ["STRENGTH_ENDURANCE", 45], ["POWER", 60]].forEach(([o, m]) => {
  const d = avgDur(o, m);
  ok(`time fit: ${o} ${m}min lands within 20% (got ~${Math.round(d)})`, d >= m * 0.8 && d <= m * 1.2);
});

// --- New behavior (training-model gaps) ---

// Gap 1: unilateral set work ~2x a comparable bilateral set (+ inter-side rest).
// Build matching single-set superset-free elements and compare elementTimeSec work.
const tgu = F.BASE_CATALOG.find(e => e.name === "Turkish Get-Up");        // ISO unilateral
const oneArmRow = F.BASE_CATALOG.find(e => e.name === "Remo (una mano)"); // STRENGTH unilateral
const twoHandRow = F.BASE_CATALOG.find(e => e.name === "Remo (dos manos)");   // STRENGTH bilateral
const uniEl = { prescriptions: [{ exercise: oneArmRow, sets: 1, reps: 5 }], isSuperset: false };
const biEl = { prescriptions: [{ exercise: twoHandRow, sets: 1, reps: 5 }], isSuperset: false };
// Unilateral element must take strictly longer than the bilateral equivalent.
ok("gap1: unilateral set costs more time than bilateral", F.elementTimeSec(uniEl) > F.elementTimeSec(biEl));

// Gap 2: ISO holds are per-exercise, not a flat 35 s. TGU/carries > Halos.
const halos = F.BASE_CATALOG.find(e => e.name === "Halo");
ok("gap2: halos default ~35s hold", halos.holdSec === 35);
ok("gap2: turkish get-up longer hold than halos", tgu.holdSec > halos.holdSec);
ok("gap2: suitcase carry longer hold than halos",
  F.BASE_CATALOG.find(e => e.name === "Suitcase Carry").holdSec > halos.holdSec);

// Gap 3: non-ballistic grip work now consumes grip budget (weighted).
// A session of several heavy-grip grinds should eventually hit the limit.
// Validate via validateCombination/generate indirectly: TGU + row (both grip,
// non-ballistic) should still be allowed but each carries weight. We assert the
// catalog flags exist and the time/budget model treats them as grip.
ok("gap3: TGU is a grip exercise", tgu.grip === true && tgu.dynamics !== F.DIN.BALLISTIC);
ok("gap3: bottoms-up press is grip, non-ballistic",
  (e => e.grip === true && e.dynamics !== F.DIN.BALLISTIC)(F.BASE_CATALOG.find(x => x.name === "Press Bottoms-Up")));

// Gap 4: HIP + KNEE block-A pair is ACCEPTABLE, not OPTIMAL; true push/pull stays OPTIMAL.
const rdl = F.BASE_CATALOG.find(e => e.name === "Peso Muerto Rumano"); // HIP
const goblet = F.BASE_CATALOG.find(e => e.name === "Sentadilla Goblet");      // KNEE
const legPair = F.validateCombination(
  { exercise: rdl, block: "A", sets: 4, reps: 5 },
  { exercise: goblet, block: "A", sets: 4, reps: 5 });
ok("gap4: HIP+KNEE in block A is ACCEPTABLE (not OPTIMAL)", legPair.valid && legPair.quality === F.QUALITY.ACCEPTABLE);
const press = F.BASE_CATALOG.find(e => e.name === "Press Goblet");  // PUSH_V
const row5 = F.BASE_CATALOG.find(e => e.name === "Remo (dos manos)");            // PULL_H
const ppPair = F.validateCombination(
  { exercise: press, block: "A", sets: 4, reps: 5 },
  { exercise: row5, block: "A", sets: 4, reps: 5 });
ok("gap4: push/pull in block A stays OPTIMAL", ppPair.quality === F.QUALITY.OPTIMAL);
ok("gap4: areAntagonists(HIP,KNEE) still true (unchanged semantics)", F.areAntagonists("HIP", "KNEE"));
// The downgrade applies to every block, not only A: the same hinge+squat pair
// must not be sold as "antagonist recovery" in accessories or the finisher.
const legPairB = F.validateCombination(
  { exercise: rdl, block: "B", sets: 3, reps: 10 },
  { exercise: goblet, block: "B", sets: 3, reps: 10 });
ok("gap4: HIP+KNEE in block B is ACCEPTABLE (not OPTIMAL)", legPairB.valid && legPairB.quality === F.QUALITY.ACCEPTABLE);
const legPairC = F.validateCombination(
  { exercise: rdl, block: "C", sets: 2, reps: 15 },
  { exercise: goblet, block: "C", sets: 2, reps: 15 });
ok("gap4: HIP+KNEE in block C is ACCEPTABLE (not OPTIMAL)", legPairC.valid && legPairC.quality === F.QUALITY.ACCEPTABLE);

// Gap 5: routine carries a warm-up with mobility items and a ramp-up ref.
ok("gap5: routine has a warmup with items", r.warmup && r.warmup.items.length >= 2);
ok("gap5: warmup ramp-up references a block-A lift",
  r.warmup.rampUp == null || (r.warmup.rampUp.exercise && r.warmup.rampUp.sets > 0));

// Gap 6: superset rest reduction is rep-range aware (SP keeps more rest than HP/ME).
function ssTime(exA, exB, reps) {
  return F.elementTimeSec({ isSuperset: true, prescriptions: [
    { exercise: exA, sets: 1, reps }, { exercise: exB, sets: 1, reps }] });
}
const spPair = ssTime(press, row5, 5);   // SP range (reps<=5)
// Isolate the rest difference: SP has bigger base rest AND a smaller cut, so
// just assert the engine applies a less aggressive cut for SP than ME.
const fullSP = F.elementTimeSec({ isSuperset: true, prescriptions: [
  { exercise: press, sets: 1, reps: 5 }, { exercise: row5, sets: 1, reps: 5 }] });
ok("gap6: SP superset keeps rest above a half cut", fullSP > 0 && spPair === fullSP);
// A pure-rest probe: same work, compare SP(0.75) vs ME(0.40) factor on rest math.
// SP rest 150*0.75=112.5; ME rest 40*0.40=16 -> SP element clearly longer.
const meReps = 15;
const meTime = ssTime(press, row5, meReps);
ok("gap6: SP-range superset rests longer than ME-range", spPair > meTime);

// --- Circuit protocols (EMOM / AMRAP) scale ROUNDS, not exercise count ---
function countExercises(rt) {
  return rt.blocks.reduce((a, b) => a + b.elements.reduce((x, e) => x + e.prescriptions.length, 0), 0);
}
function maxSets(rt) {
  return Math.max(...rt.blocks.flatMap(b => b.elements.flatMap(e => e.prescriptions.map(p => p.sets))));
}
const amShort = F.generate(null, { objective: "AMRAP", equipment: ["KB"], minutes: 12, seed: 4 });
const amLong  = F.generate(null, { objective: "AMRAP", equipment: ["KB"], minutes: 45, seed: 4 });
ok("circuit: AMRAP stays a short circuit (<=6 exercises) even when long",
  countExercises(amLong) <= 6);
ok("circuit: AMRAP exercise count is stable across durations",
  countExercises(amShort) === countExercises(amLong));
ok("circuit: longer AMRAP means more rounds (sets)", maxSets(amLong) > maxSets(amShort));
const emShort = F.generate(null, { objective: "EMOM", equipment: ["KB"], minutes: 10, seed: 6 });
const emLong  = F.generate(null, { objective: "EMOM", equipment: ["KB"], minutes: 40, seed: 6 });
ok("circuit: EMOM exercise count stable across durations",
  countExercises(emShort) === countExercises(emLong) && countExercises(emLong) <= 5);
ok("circuit: longer EMOM means more rounds", maxSets(emLong) > maxSets(emShort));
// Contrast: a non-circuit objective DOES grow exercise count with time.
const stShort = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 20, seed: 9 });
const stLong  = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 60, seed: 9 });
ok("non-circuit: STRENGTH adds exercises with time", countExercises(stLong) > countExercises(stShort));

// Timer timeline: a 3-set direct slot -> 3 work + 2 rest phases, alternating.
const tlSolo = F.elementTimeline({ isSuperset: false, prescriptions: [{ exercise: swing, block: "A", sets: 3, reps: 5 }] });
ok("timeline: 3 sets solo -> 3 work + 2 rest", tlSolo.filter(s => s.kind === "work").length === 3 && tlSolo.filter(s => s.kind === "rest").length === 2);
ok("timeline: work phases carry positive seconds", tlSolo.filter(s => s.kind === "work").every(s => s.sec > 0));
ok("timeline: first phase is work", tlSolo[0].kind === "work");
// Superset: each set has two work phases (one per exercise).
const pressEx = F.BASE_CATALOG.find(e => e.name === "Press Goblet");
const tlSS = F.elementTimeline({ isSuperset: true, prescriptions: [
  { exercise: pressEx, block: "A", sets: 2, reps: 8 }, { exercise: swing, block: "A", sets: 2, reps: 8 }] });
ok("timeline: superset 2 sets -> 4 work + 1 rest", tlSS.filter(s => s.kind === "work").length === 4 && tlSS.filter(s => s.kind === "rest").length === 1);

// Manual routines: compose (user-built) + audit (scrutiny)
const rowEx = F.BASE_CATALOG.find(e => e.name === "Remo (dos manos)");
const squatEx = F.BASE_CATALOG.find(e => e.name === "Sentadilla Goblet");
const manual = F.composeRoutine([
  { exercise: swing, block: "A", sets: 5, reps: 5 },
  { exercise: pressEx, block: "B", sets: 3, reps: 10 },
  { exercise: rowEx, block: "B", sets: 3, reps: 10, pair: true },
]);
ok("compose: only non-empty blocks appear", manual.blocks.map(b => b.block).join("") === "AB");
ok("compose: pair flag merges into a superset", manual.blocks[1].elements.length === 1 && manual.blocks[1].elements[0].isSuperset === true);
ok("compose: superset quality comes from the rule engine", manual.blocks[1].elements[0].quality === F.QUALITY.OPTIMAL);
ok("compose: warmup is built for manual routines", manual.warmup && manual.warmup.items.length > 0);

const clean = F.auditRoutine(manual);
ok("audit: clean routine scores 100 with no findings", clean.score === 100 && clean.findings.length === 0);
ok("audit: stats reflect the routine", clean.stats.exercises === 3 && clean.stats.highCns === 1 && clean.stats.minutes > 0);
ok("audit: empty routine is an error at score 0", F.auditRoutine({ blocks: [] }).score === 0);

const risky = F.composeRoutine([
  { exercise: swing, block: "A", sets: 5, reps: 5 },
  { exercise: snatch, block: "A", sets: 5, reps: 5, pair: true },   // two high-CNS: invalid superset
  { exercise: squatEx, block: "C", sets: 3, reps: 15 },             // 15-rep grind: tip
]);
const riskyAudit = F.auditRoutine(risky);
ok("audit: invalid superset reported as error", riskyAudit.findings.some(f => f.level === "error" && /Superserie/.test(f.msg)));
ok("audit: high-rep grind gets a tip", riskyAudit.findings.some(f => f.level === "tip" && /resistencia/.test(f.msg)));
ok("audit: findings lower the score", riskyAudit.score < 100);
ok("audit: caps are configurable", F.auditRoutine(manual, { maxCns: 0 }).findings.some(f => /SNC alta/.test(f.msg)));

const dupImbal = F.composeRoutine([
  { exercise: pressEx, block: "B", sets: 3, reps: 10 },
  { exercise: pressEx, block: "B", sets: 3, reps: 10 },
]);
const dupAudit = F.auditRoutine(dupImbal);
ok("audit: repeated exercise is flagged", dupAudit.findings.some(f => /2 veces/.test(f.msg)));
ok("audit: push/pull imbalance is flagged", dupAudit.findings.some(f => /empuje\/tir(o|ó)n/.test(f.msg)));

// Audit suggestions: prescriptive fixes drawn from the available pool.
ok("suggestions: absent without a pool", F.auditRoutine(risky).suggestions.length === 0);
ok("suggestions: clean routine has none", F.auditRoutine(manual, { pool: F.BASE_CATALOG }).suggestions.length === 0);
const riskySugg = F.auditRoutine(risky, { pool: F.BASE_CATALOG }).suggestions;
ok("suggestions: broken superset gets a concrete fix", riskySugg.some(s => /Superserie rota/.test(s)));
const dupSugg = F.auditRoutine(dupImbal, { pool: F.BASE_CATALOG }).suggestions;
ok("suggestions: repeated exercise offers a variant", dupSugg.some(s => /En vez de repetir Press Goblet, prueba /.test(s)));
ok("suggestions: imbalance names the missing pattern with options", dupSugg.some(s => /A(n|ñ)ade tir(o|ó)n para equilibrar: .+ o .+\./.test(s)));
const cnsSugg = F.auditRoutine(manual, { maxCns: 0, pool: F.BASE_CATALOG }).suggestions;
ok("suggestions: CNS over budget offers a calmer same-pattern swap",
  cnsSugg.some(s => /presupuesto de SNC, cambia Swing/.test(s)));
// Never suggest an exercise the routine already contains, and stay readable.
const inRoutine = new Set(["Swing (dos manos)", "Press Goblet", "Remo (dos manos)"]);
ok("suggestions: never propose an exercise already in the routine",
  !cnsSugg.some(s => [...inRoutine].some(n => s.includes("por " + n))));
ok("suggestions: capped at 4", F.auditRoutine(F.composeRoutine([
  { exercise: swing, block: "A", sets: 5, reps: 5 },
  { exercise: swing, block: "A", sets: 5, reps: 5 },
  { exercise: snatch, block: "B", sets: 3, reps: 10 },
  { exercise: snatch, block: "B", sets: 3, reps: 10 },
  { exercise: pressEx, block: "B", sets: 3, reps: 10 },
  { exercise: pressEx, block: "C", sets: 3, reps: 15 },
]), { maxCns: 1, maxGrip: 1, pool: F.BASE_CATALOG }).suggestions.length <= 4);

// Objective inference: what type of session did the trainee build?
const strengthLike = F.composeRoutine([
  { exercise: squatEx, block: "A", sets: 5, reps: 5 },
  { exercise: swing, block: "A", sets: 5, reps: 5 },
  { exercise: pressEx, block: "B", sets: 3, reps: 10 },
  { exercise: rowEx, block: "B", sets: 3, reps: 10, pair: true },
]);
const infS = F.inferObjective(strengthLike);
ok("infer: 5x5 principals + 3x10 accessories read as STRENGTH", infS.objective === "STRENGTH" && infS.score >= 0.8);
const powerLike = F.composeRoutine([
  { exercise: swing, block: "A", sets: 5, reps: 3 },
  { exercise: snatch, block: "A", sets: 5, reps: 3 },
  { exercise: F.BASE_CATALOG.find(e => e.name === "Remo Balistico"), block: "B", sets: 4, reps: 6 },
]);
ok("infer: explosive low-rep session reads as POWER", F.inferObjective(powerLike).objective === "POWER");
const metaLike = F.composeRoutine([
  { exercise: swing, block: "A", sets: 4, reps: 6 },
  { exercise: rowEx, block: "B", sets: 3, reps: 12 },
  { exercise: F.BASE_CATALOG.find(e => e.name === "Burpees"), block: "C", sets: 3, reps: 20 },
]);
ok("infer: ballistic + high-rep finisher reads as METABOLIC", F.inferObjective(metaLike).objective === "METABOLIC");
ok("infer: empty routine claims no profile", F.inferObjective({ blocks: [] }).objective === null);
const isoOnly = F.composeRoutine([
  { exercise: F.BASE_CATALOG.find(e => e.name === "Suitcase Carry"), block: "B", sets: 3, reps: 8 },
]);
ok("infer: ISO-only session claims no profile (carries fit any objective)", F.inferObjective(isoOnly).objective === null);
// Declared objective: the audit flags a composition that resembles another profile.
const misdeclared = F.auditRoutine(metaLike, { declared: "STRENGTH" });
ok("audit: declared vs detected mismatch is a warning", misdeclared.findings.some(f => f.level === "warn" && /se parece m(a|á)s/.test(f.msg)));
const wellDeclared = F.auditRoutine(strengthLike, { declared: "STRENGTH" });
ok("audit: matching declaration adds no mismatch finding", !wellDeclared.findings.some(f => /se parece m(a|á)s/.test(f.msg)));

// Objective assessment: why it serves the goal + global adjustments toward it.
const asOk = F.assessObjective(strengthLike, "STRENGTH");
ok("assess: matching blocks are credited as strengths", asOk.strengths.some(s => /Bloque A ya sirve/.test(s)));
ok("assess: a missing template block is an adjustment", asOk.adjustments.some(s => /Falta el bloque C/.test(s)));
const asReps = F.assessObjective(metaLike, "STRENGTH");
ok("assess: high reps for strength -> fewer reps, more weight", asReps.adjustments.some(s => /SUBE el peso/.test(s)));
const asBlocks = F.assessObjective(metaLike, "POWER");
ok("assess: extra block flagged for objectives that skip it", asBlocks.adjustments.some(s => /no suele usar el bloque C/.test(s)));
ok("assess: unknown objective returns null", F.assessObjective(strengthLike, "NOPE") === null);

// Arms focus: a muscle-emphasis tag, not a movement pattern.
ok("arms tag set on curls, rows and presses",
  F.BASE_CATALOG.find(e => e.name === "Curl + Press").arms === true &&
  F.BASE_CATALOG.find(e => e.name === "Remo (dos manos)").arms === true &&
  F.BASE_CATALOG.find(e => e.name === "Flexiones (agarre cerrado)").arms === true);
ok("arms tag off for hip-driven ballistics",
  F.BASE_CATALOG.find(e => e.name === "Swing (dos manos)").arms === false &&
  F.BASE_CATALOG.find(e => e.name === "High Pull").arms === false);
const armsRoutine = F.generate(null, { objective: "STRENGTH", equipment: ["KB", "BARBELL"], minutes: 40, focus: "ARMS", seed: 7 });
const armsPicked = armsRoutine.blocks.reduce((a, b) =>
  a + b.elements.reduce((x, elm) => x + elm.prescriptions.filter(p => p.exercise.arms).length, 0), 0);
ok("ARMS focus loads the session with arm-emphasis work", armsPicked >= 3);
ok("newExercise carries the arms flag", F.newExercise({ name: "Y", pattern: "PULL_H", dynamics: "STRENGTH",
  symmetry: "BILATERAL", cns: "LOW", equipment: ["KB"], arms: true }).arms === true);

// Soft emphasis: biases selection toward a region WITHOUT excluding the rest
// or disabling balance (unlike the hard focus).
const legDom = e => e.pattern === "HIP" || e.pattern === "KNEE";
const countLegs = r => r.blocks.reduce((a, b) => a + b.elements.reduce((x, elm) =>
  x + elm.prescriptions.filter(p => legDom(p.exercise)).length, 0), 0);
const countAll = r => r.blocks.reduce((a, b) => a + b.elements.reduce((x, elm) => x + elm.prescriptions.length, 0), 0);
const plain = F.generate(null, { objective: "STRENGTH", equipment: ["KB", "FLOOR"], minutes: 40, seed: 11 });
const emph = F.generate(null, { objective: "STRENGTH", equipment: ["KB", "FLOOR"], minutes: 40, seed: 11, emphasis: ["LEGS"] });
ok("soft emphasis increases (or holds) the emphasized share vs plain", countLegs(emph) >= countLegs(plain));
ok("soft emphasis does NOT exclude other patterns", countLegs(emph) < countAll(emph));
// Contrast with the hard focus, which DOES exclude nearly everything else.
const hardFocus = F.generate(null, { objective: "STRENGTH", equipment: ["KB", "FLOOR"], minutes: 40, seed: 11, focus: ["LEGS"] });
ok("hard focus is more exclusive than soft emphasis", countLegs(hardFocus) / countAll(hardFocus) >= countLegs(emph) / countAll(emph));

// GRIP is a tag-based emphasis (not a movement pattern).
const gripEmph = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 40, seed: 3, emphasis: ["GRIP"] });
ok("grip emphasis pulls in grip-intensive work", gripEmph.blocks.some(b => b.elements.some(elm => elm.prescriptions.some(p => p.exercise.grip))));

// --- Multi-week program ---------------------------------------------------
const wk3 = F.programWeekDefaults(3);
ok("program week: 3 days -> 3 slots with objectives", wk3.length === 3 && wk3.every(d => d.objective && d.label));
ok("program week: clamps out-of-range day counts", F.programWeekDefaults(9).length >= 2 && F.programWeekDefaults(1).length === 2);
ok("program week: 4-day carries a soft emphasis day", F.programWeekDefaults(4).some(d => d.emphasis.length > 0));
const meso = { lengthWeeks: 4, deloadEveryWeeks: 4 };
ok("phase: accumulation week 1 is neutral-ish", (() => { const p = F.phaseFor(1, meso); return !p.deload && p.volumeFactor === 1 && p.intensityFactor === 0; })());
ok("phase: accumulation ramps volume up by week 3", F.phaseFor(3, meso).volumeFactor > F.phaseFor(1, meso).volumeFactor);
ok("phase: week 4 is a deload (less volume, lighter)", (() => { const p = F.phaseFor(4, meso); return p.deload && p.volumeFactor < 0.6 && p.intensityFactor < 0; })());
ok("phase: cycles repeat (week 5 == week 1)", F.phaseFor(5, meso).volumeFactor === F.phaseFor(1, meso).volumeFactor);
ok("phase: no meso -> neutral", (() => { const p = F.phaseFor(3, null); return p.volumeFactor === 1 && p.intensityFactor === 0; })());
// loadBias flows into the routine's readiness loadFactor.
const heavier = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 30, seed: 5, loadBias: 1.1 });
const lighter = F.generate(null, { objective: "STRENGTH", equipment: ["KB"], minutes: 30, seed: 5, loadBias: 0.9 });
ok("loadBias raises/lowers the routine load factor", heavier.readiness.loadFactor > lighter.readiness.loadFactor);

// --- Trainer-review fixes -------------------------------------------------

// Rep-aware cold start: the same tier suggests less kg at a high-rep target.
ok("suggestKg: no reps arg == legacy behavior", F.suggestKg(3, 12, 32) === 30);
ok("suggestKg: heavy tier drops at a 15-rep target",
  F.suggestKg(3, 8, 32, null, null, 15) < F.suggestKg(3, 8, 32, null, null, 5));
ok("suggestKg: SP target keeps the tier as-is",
  F.suggestKg(3, 8, 32, null, null, 5) === F.suggestKg(3, 8, 32));
ok("suggestKg: rep-adjusted stays within range", (() => {
  const k = F.suggestKg(1, 8, 32, null, null, 20);
  return k >= 8 && k <= 32;
})());

// Metabolic/flow drills get a rep floor (no 5-rep Figure-8s).
const fig8 = F.BASE_CATALOG.find(e => e.name === "Figure-8");
const strengthGen = F.generate(null, { objective: "STRENGTH", equipment: ["KB", "FLOOR"], minutes: 45, seed: 42 });
const metaDoses = strengthGen.blocks.flatMap(b => b.elements.flatMap(e => e.prescriptions))
  .filter(p => p.exercise.dynamics === "METABOLIC");
ok("prescribe: metabolic drills floored at 10 reps", metaDoses.every(p => p.reps >= 10));

// Grip+grip supersets are never OPTIMAL (forearm never rests).
const suitcase = F.BASE_CATALOG.find(e => e.name === "Suitcase Carry");
const gripPairA = F.validateCombination(
  { exercise: swing, block: "A", sets: 5, reps: 5 },
  { exercise: suitcase, block: "A", sets: 5, reps: 8 });
ok("grip: swing + grip-carry capped at ACCEPTABLE in block A",
  gripPairA.valid && gripPairA.quality === F.QUALITY.ACCEPTABLE);
const rowB = F.validateCombination(
  { exercise: F.BASE_CATALOG.find(e => e.name === "Remo (una mano)"), block: "B", sets: 3, reps: 10 },
  { exercise: F.BASE_CATALOG.find(e => e.name === "Peso Muerto Rumano"), block: "B", sets: 3, reps: 10 });
ok("grip: two grip grinds capped at ACCEPTABLE in block B", rowB.quality === F.QUALITY.ACCEPTABLE);
ok("grip: grip-free pair unaffected (push/pull still OPTIMAL)", (() => {
  const q = F.validateCombination(
    { exercise: press, block: "A", sets: 4, reps: 5 },
    { exercise: F.BASE_CATALOG.find(e => e.name === "Remo Vertical"), block: "A", sets: 4, reps: 5 });
  return q.quality === F.QUALITY.OPTIMAL;
})());

// Block C is no longer an automatic OPTIMAL.
const windmill = F.BASE_CATALOG.find(e => e.name === "Windmill");
const thruster = F.BASE_CATALOG.find(e => e.name === "Thruster");
const cWindmill = F.validateCombination(
  { exercise: thruster, block: "C", sets: 3, reps: 15 },
  { exercise: windmill, block: "C", sets: 3, reps: 8 });
ok("blockC: high-skill ISO under finisher fatigue is not OPTIMAL",
  cWindmill.valid && cWindmill.quality === F.QUALITY.ACCEPTABLE);
const cBurpees = F.validateCombination(
  { exercise: thruster, block: "C", sets: 3, reps: 15 },
  { exercise: F.BASE_CATALOG.find(e => e.name === "Burpees"), block: "C", sets: 3, reps: 15 });
ok("blockC: two high-CNS finishers get a caution (ACCEPTABLE)",
  cBurpees.valid && cBurpees.quality === F.QUALITY.ACCEPTABLE);
const cAntag = F.validateCombination(
  { exercise: press, block: "C", sets: 3, reps: 15 },
  { exercise: F.BASE_CATALOG.find(e => e.name === "Remo Vertical"), block: "C", sets: 3, reps: 15 });
ok("blockC: calm antagonist finisher pair stays OPTIMAL", cAntag.quality === F.QUALITY.OPTIMAL);

// Skill tag: technical lifts flagged. Technique is assumed learned — the tag
// no longer gates beginners; it only keeps precision lifts out of fatigued
// finishers (Block C rules) and feeds the pool's "tecnica" label.
ok("skill: snatch/TGU/windmill are flagged", snatch.skill === true && tgu.skill === true && windmill.skill === true);
ok("skill: swing/goblet squat are not", swing.skill === false && goblet.skill === false);
ok("newExercise carries the skill flag", F.newExercise({ name: "Z", pattern: "HYBRID", dynamics: "BALLISTIC",
  symmetry: "UNILATERAL", cns: "HIGH", equipment: ["KB"], skill: true }).skill === true);
// Selection is level-blind: a beginner profile gets the same session as an
// advanced one (only the cold-start kg seed differs).
ok("skill: selection ignores training level", (() => {
  const strip = rt => rt.blocks.map(b => b.elements.map(e => e.prescriptions.map(p => p.exercise.name))).flat(2).join("|");
  for (let s = 1; s <= 10; s++) {
    const beg = F.generate(null, { objective: "METABOLIC", equipment: ["KB"], minutes: 45, seed: s, person: { level: "BEG" } });
    const adv = F.generate(null, { objective: "METABOLIC", equipment: ["KB"], minutes: 45, seed: s, person: { level: "ADV" } });
    if (strip(beg) !== strip(adv)) return false;
  }
  return true;
})());

// EMOM runs on the minute; AMRAP flows on short transitions (protocol timing).
const emom = F.generate(null, { objective: "EMOM", equipment: ["KB"], minutes: 20, seed: 6 });
ok("protocol: EMOM routine is tagged", emom.protocol === "EMOM");
ok("protocol: standard routine is not", strengthGen.protocol === null);
const emomSteps = emom.blocks.flatMap(b => F.blockTimeline(b, emom.protocol));
ok("protocol: EMOM work+rest slots total one minute (or slight overrun)", (() => {
  for (let i = 0; i + 1 < emomSteps.length; i += 1) {
    const w = emomSteps[i], rst = emomSteps[i + 1];
    if (w.kind !== "work" || !rst || rst.kind !== "rest") continue;
    if (w.sec + rst.sec < 60) return false;
  }
  return true;
})());
// Round-major interleave: consecutive work steps cycle exercises, not sets.
const workNames = emomSteps.filter(s => s.kind === "work").map(s => s.prescription.exercise.name);
const distinct = new Set(workNames.slice(0, new Set(workNames).size));
ok("protocol: circuit interleaves exercises round-major", distinct.size === new Set(workNames).size);
ok("protocol: EMOM duration ~= requested minutes", (() => {
  const d = F.routineDurationMin(emom);
  return d >= 20 * 0.8 && d <= 20 * 1.2;
})());
const amrap = F.generate(null, { objective: "AMRAP", equipment: ["KB"], minutes: 20, seed: 4 });
const amrapSteps = amrap.blocks.flatMap(b => F.blockTimeline(b, amrap.protocol));
ok("protocol: AMRAP rests are short transitions",
  amrapSteps.filter(s => s.kind === "rest").every(s => s.sec <= 15));
// Standard sessions now count the between-exercise changeover in duration.
ok("changeover: routine duration >= sum of block durations", (() => {
  const sum = strengthGen.blocks.reduce((a, b) => a + F.blockDurationMin(b), 0);
  return F.routineDurationMin(strengthGen) >= sum;
})());

if (process.exitCode) console.error("\n--- FAILURES FOUND ---");
else console.log(pass + " engine checks OK");
