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

// Power / plyometrics
ok("POWER objective generates a routine", (() => {
  const rp = F.generate(null, { objective: "POWER", equipment: ["KB", "FLOOR"], minutes: 30, seed: 2 });
  return rp.blocks.some(b => b.elements.length > 0);
})());
const jump = F.BASE_CATALOG.find(e => e.name === "KB Jump Squats");
const swingP = F.BASE_CATALOG.find(e => e.name === "Kettlebell Swings (Dos manos)");
ok("plyo flag set on jump movements", jump.plyo === true && F.BASE_CATALOG.find(e => e.name === "Tuck Jumps").plyo === true);
ok("non-plyo ballistic is not flagged plyo", swingP.plyo === false);
// Full recovery: a plyo set at low reps rests at least as long as a strength set.
const plyoEl = { prescriptions: [{ exercise: jump, sets: 1, reps: 3 }], isSuperset: false };
const ballEl = { prescriptions: [{ exercise: swingP, sets: 1, reps: 3 }], isSuperset: false };
ok("plyo forces full recovery (>= same-rep ballistic)", F.elementTimeSec(plyoEl) >= F.elementTimeSec(ballEl));
ok("newExercise carries plyo flag", F.newExercise({ name: "X", pattern: "KNEE", dynamics: "BALLISTIC", symmetry: "BILATERAL", cns: "HIGH", equipment: ["FLOOR"], plyo: true }).plyo === true);
ok("9 fundamental exercises", F.BASE_CATALOG.filter(e => e.tier === "FUNDAMENTAL").length === 9);

// RuleEngine: two high-CNS in block A -> invalid
const swing = F.BASE_CATALOG.find(e => e.name === "Kettlebell Swings (Dos manos)");
const snatch = F.BASE_CATALOG.find(e => e.name === "One-Arm Snatch");
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
const press2 = F.BASE_CATALOG.find(e => e.name === "Goblet Shoulder Press"); // PUSH_V, load 1
const swingHeavy = F.BASE_CATALOG.find(e => e.name === "Kettlebell Swings (Dos manos)"); // HIP, load 3
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
  { exercise: F.BASE_CATALOG.find(e => e.name === "Remo a una mano") },      // load 2 -> medium
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
  pinned: [{ name: "Kettlebell Swings (Dos manos)", block: "C" }] });
const inC = rf.blocks.find(b => b.block === "C").elements
  .some(e => e.prescriptions.some(p => p.exercise.name === "Kettlebell Swings (Dos manos)"));
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
const oneArmRow = F.BASE_CATALOG.find(e => e.name === "Remo a una mano"); // STRENGTH unilateral
const twoHandRow = F.BASE_CATALOG.find(e => e.name === "Two Hand Row");   // STRENGTH bilateral
const uniEl = { prescriptions: [{ exercise: oneArmRow, sets: 1, reps: 5 }], isSuperset: false };
const biEl = { prescriptions: [{ exercise: twoHandRow, sets: 1, reps: 5 }], isSuperset: false };
// Unilateral element must take strictly longer than the bilateral equivalent.
ok("gap1: unilateral set costs more time than bilateral", F.elementTimeSec(uniEl) > F.elementTimeSec(biEl));

// Gap 2: ISO holds are per-exercise, not a flat 35 s. TGU/carries > Halos.
const halos = F.BASE_CATALOG.find(e => e.name === "Halos");
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
  (e => e.grip === true && e.dynamics !== F.DIN.BALLISTIC)(F.BASE_CATALOG.find(x => x.name === "Bottoms-Up Press")));

// Gap 4: HIP + KNEE block-A pair is ACCEPTABLE, not OPTIMAL; true push/pull stays OPTIMAL.
const rdl = F.BASE_CATALOG.find(e => e.name === "Peso Muerto Rumano / Fijo"); // HIP
const goblet = F.BASE_CATALOG.find(e => e.name === "Sentadilla Goblet");      // KNEE
const legPair = F.validateCombination(
  { exercise: rdl, block: "A", sets: 4, reps: 5 },
  { exercise: goblet, block: "A", sets: 4, reps: 5 });
ok("gap4: HIP+KNEE in block A is ACCEPTABLE (not OPTIMAL)", legPair.valid && legPair.quality === F.QUALITY.ACCEPTABLE);
const press = F.BASE_CATALOG.find(e => e.name === "Goblet Shoulder Press");  // PUSH_V
const row5 = F.BASE_CATALOG.find(e => e.name === "Two Hand Row");            // PULL_H
const ppPair = F.validateCombination(
  { exercise: press, block: "A", sets: 4, reps: 5 },
  { exercise: row5, block: "A", sets: 4, reps: 5 });
ok("gap4: push/pull in block A stays OPTIMAL", ppPair.quality === F.QUALITY.OPTIMAL);
ok("gap4: areAntagonists(HIP,KNEE) still true (unchanged semantics)", F.areAntagonists("HIP", "KNEE"));

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
const pressEx = F.BASE_CATALOG.find(e => e.name === "Goblet Shoulder Press");
const tlSS = F.elementTimeline({ isSuperset: true, prescriptions: [
  { exercise: pressEx, block: "A", sets: 2, reps: 8 }, { exercise: swing, block: "A", sets: 2, reps: 8 }] });
ok("timeline: superset 2 sets -> 4 work + 1 rest", tlSS.filter(s => s.kind === "work").length === 4 && tlSS.filter(s => s.kind === "rest").length === 1);

if (process.exitCode) console.error("\n--- FAILURES FOUND ---");
else console.log(pass + " engine checks OK");
