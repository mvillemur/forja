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

if (process.exitCode) console.error("\n--- FAILURES FOUND ---");
else console.log(pass + " engine checks OK");
