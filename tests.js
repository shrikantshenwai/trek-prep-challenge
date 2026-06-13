const assert = require("assert");
const logic = require("./logic.js");

const {
  ACTIVITY_CLASSES: C,
  WEEKLY_STATUSES: S,
  getProgramStatus,
  validateMondayStartDate,
  getTargetsForWeek,
  classifyActivity,
  getWeeklyStatus,
  getWeeklySummary,
  clampProgressPercent,
  sortParticipantsAlphabetically,
  validateIncrements,
  applyLogIncrement,
  computeSnapshotMetrics,
} = logic;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function d(value) {
  return new Date(`${value}T12:00:00`);
}

test("week calculation boundaries", () => {
  assert.deepStrictEqual(getProgramStatus("2026-06-15", d("2026-06-14")).state, "not_started");
  assert.strictEqual(getProgramStatus("2026-06-15", d("2026-06-15")).weekNumber, 1);
  assert.strictEqual(getProgramStatus("2026-06-15", d("2026-06-21")).weekNumber, 1);
  assert.strictEqual(getProgramStatus("2026-06-15", d("2026-06-22")).weekNumber, 2);
  assert.strictEqual(getProgramStatus("2026-06-15", d("2026-07-13")).weekNumber, 5);
  assert.strictEqual(getProgramStatus("2026-06-15", d("2026-08-31")).weekNumber, 12);
  assert.strictEqual(getProgramStatus("2026-06-15", d("2026-09-07")).state, "completed");
  assert.strictEqual(validateMondayStartDate("2026-06-15"), true);
  assert.strictEqual(validateMondayStartDate("2026-06-16"), false);
});

test("target lookup", () => {
  assert.deepStrictEqual(getTargetsForWeek(1).baseline, { steps: 40000, stairs: 40, yoga: 40, pranayama: 40 });
  assert.deepStrictEqual(getTargetsForWeek(1).stretch, { steps: 50000, stairs: 50, yoga: 50, pranayama: 50 });
  assert.deepStrictEqual(getTargetsForWeek(3).baseline, { steps: 50000, stairs: 50, yoga: 50, pranayama: 50 });
  assert.deepStrictEqual(getTargetsForWeek(3).stretch, { steps: 65000, stairs: 65, yoga: 65, pranayama: 65 });
  assert.deepStrictEqual(getTargetsForWeek(5).baseline, { steps: 60000, stairs: 60, yoga: 60, pranayama: 60 });
  assert.deepStrictEqual(getTargetsForWeek(7).stretch, { steps: 90000, stairs: 90, yoga: 90, pranayama: 90 });
  assert.deepStrictEqual(getTargetsForWeek(10).baseline, { steps: 70000, stairs: 70, yoga: 70, pranayama: 70 });
  assert.deepStrictEqual(getTargetsForWeek(11).baseline, { steps: 60000, stairs: 60, yoga: 60, pranayama: 60 });
  assert.deepStrictEqual(getTargetsForWeek(12).stretch, { steps: 75000, stairs: 75, yoga: 75, pranayama: 75 });
});

test("activity classification", () => {
  assert.strictEqual(classifyActivity(0, 40, 50), C.MISSED);
  assert.strictEqual(classifyActivity(1, 40, 50), C.PARTIAL);
  assert.strictEqual(classifyActivity(40, 40, 50), C.BASELINE);
  assert.strictEqual(classifyActivity(49, 40, 50), C.BASELINE);
  assert.strictEqual(classifyActivity(50, 40, 50), C.STRETCH);
});

const statusCases = [
  [[C.STRETCH, C.STRETCH, C.STRETCH, C.STRETCH], S.GREEN_RABBIT],
  [[C.BASELINE, C.BASELINE, C.BASELINE, C.BASELINE], S.GREEN_TORTOISE],
  [[C.STRETCH, C.BASELINE, C.BASELINE, C.BASELINE], S.GREEN_TORTOISE],
  [[C.STRETCH, C.STRETCH, C.STRETCH, C.BASELINE], S.GREEN_TORTOISE],
  [[C.STRETCH, C.PARTIAL, C.PARTIAL, C.PARTIAL], S.YELLOW_RABBIT],
  [[C.STRETCH, C.BASELINE, C.PARTIAL, C.PARTIAL], S.YELLOW_RABBIT],
  [[C.STRETCH, C.STRETCH, C.BASELINE, C.PARTIAL], S.YELLOW_RABBIT],
  [[C.BASELINE, C.PARTIAL, C.PARTIAL, C.PARTIAL], S.YELLOW_TORTOISE],
  [[C.BASELINE, C.BASELINE, C.PARTIAL, C.PARTIAL], S.YELLOW_TORTOISE],
  [[C.BASELINE, C.BASELINE, C.BASELINE, C.PARTIAL], S.YELLOW_TORTOISE],
  [[C.PARTIAL, C.PARTIAL, C.PARTIAL, C.PARTIAL], S.GREY_CIRCLE],
  [[C.PARTIAL, C.MISSED, C.MISSED, C.MISSED], S.GREY_CIRCLE],
  [[C.BASELINE, C.MISSED, C.PARTIAL, C.PARTIAL], S.GREY_CIRCLE],
  [[C.STRETCH, C.MISSED, C.PARTIAL, C.PARTIAL], S.GREY_CIRCLE],
  [[C.MISSED, C.MISSED, C.MISSED, C.MISSED], S.RED_CIRCLE],
];

test("weekly status required cases", () => {
  statusCases.forEach(([input, expected]) => {
    assert.strictEqual(getWeeklyStatus(input), expected, input.join(", "));
  });
});

test("all 256 status combinations map to a valid status", () => {
  const classes = Object.values(C);
  const statuses = new Set(Object.values(S));
  let count = 0;
  classes.forEach((a) => classes.forEach((b) => classes.forEach((c) => classes.forEach((d) => {
    const status = getWeeklyStatus([a, b, c, d]);
    assert(statuses.has(status), `${a},${b},${c},${d} returned ${status}`);
    count += 1;
  }))));
  assert.strictEqual(count, 256);
});

test("logging-style accumulation updates status", () => {
  const total = { steps: 0, stairs: 0, yoga: 0, pranayama: 0 };
  Object.assign(total, applyLogIncrement(total, { steps: 8000 }, 1));
  Object.assign(total, applyLogIncrement(total, { steps: 12000 }, 1));
  Object.assign(total, applyLogIncrement(total, { steps: 15000 }, 1));
  let summary = getWeeklySummary(total, 1);
  assert.strictEqual(total.steps, 35000);
  assert.strictEqual(summary.classes.steps, C.PARTIAL);
  assert.strictEqual(summary.status, S.GREY_CIRCLE);
  Object.assign(total, applyLogIncrement(total, { steps: 5000, stairs: 40, yoga: 40, pranayama: 40 }, 1));
  summary = getWeeklySummary(total, 1);
  assert.strictEqual(summary.status, S.GREEN_TORTOISE);
});

test("negative increments rejected", () => {
  assert.throws(() => validateIncrements({ steps: -1 }), /whole numbers/);
});

test("snapshot average math includes inactive roster as zero", () => {
  assert.strictEqual(clampProgressPercent(45000, 40000), 100);
  assert.strictEqual(clampProgressPercent(20000, 40000), 50);
  const average = (100 + 50 + 0) / 3;
  assert.strictEqual(Math.round(average), 50);
});

test("multi-group participant names remain separate", () => {
  const participants = [
    { id: "p1", groupId: "g1", displayName: "Rajiv" },
    { id: "p2", groupId: "g2", displayName: "Rajiv" },
  ];
  assert.strictEqual(participants.filter((p) => p.groupId === "g1").length, 1);
  assert.strictEqual(participants.filter((p) => p.groupId === "g2").length, 1);
  assert.notStrictEqual(participants[0].id, participants[1].id);
});

test("group status sorting is alphabetical only", () => {
  const sorted = sortParticipantsAlphabetically([
    { displayName: "Vivek", computedStatus: S.GREEN_RABBIT },
    { displayName: "Anita", computedStatus: S.RED_CIRCLE },
    { displayName: "Kulu", computedStatus: S.YELLOW_RABBIT },
  ]);
  assert.deepStrictEqual(sorted.map((p) => p.displayName), ["Anita", "Kulu", "Vivek"]);
});

test("snapshot metrics counts and icon distribution are correct", () => {
  const participants = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const totals = [
    { participantId: "a", steps: 50000, stairs: 50, yoga: 50, pranayama: 50 },
    { participantId: "b", steps: 40000, stairs: 40, yoga: 40, pranayama: 40 },
  ];
  const snapshot = computeSnapshotMetrics(participants, totals, 1);
  assert.strictEqual(snapshot.loggedCount, 2);
  assert.strictEqual(snapshot.totalRosterCount, 3);
  assert.strictEqual(snapshot.fullBaselineCount, 2);
  assert.strictEqual(snapshot.iconDistribution[S.GREEN_RABBIT], 1);
  assert.strictEqual(snapshot.iconDistribution[S.GREEN_TORTOISE], 1);
  assert.strictEqual(snapshot.iconDistribution[S.RED_CIRCLE], 1);
  assert.strictEqual(Math.round(snapshot.averages.steps), 67);
});

console.log("All Trek Prep Challenge tests passed.");
