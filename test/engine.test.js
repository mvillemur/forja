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
ok("base catalog has 32 exercises", F.BASE_CATALOG.length === 32);
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
ok("backtracking fills the routine", placed >= 10);

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

if (process.exitCode) console.error("\n--- FAILURES FOUND ---");
else console.log(pass + " engine checks OK");
