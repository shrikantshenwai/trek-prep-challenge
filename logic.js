(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TrekLogic = api;
})(typeof self !== "undefined" ? self : this, function () {
  const ACTIVITY_CLASSES = {
    MISSED: "MISSED",
    PARTIAL: "PARTIAL",
    BASELINE: "BASELINE",
    STRETCH: "STRETCH",
  };

  const WEEKLY_STATUSES = {
    GREEN_RABBIT: "GREEN_RABBIT",
    GREEN_TORTOISE: "GREEN_TORTOISE",
    YELLOW_RABBIT: "YELLOW_RABBIT",
    YELLOW_TORTOISE: "YELLOW_TORTOISE",
    GREY_CIRCLE: "GREY_CIRCLE",
    RED_CIRCLE: "RED_CIRCLE",
  };

  const ACTIVITY_KEYS = ["steps", "stairs", "yoga", "pranayama"];

  const BASELINE_TARGETS = [
    { from: 1, to: 2, steps: 40000, stairs: 40, yoga: 40, pranayama: 40 },
    { from: 3, to: 4, steps: 50000, stairs: 50, yoga: 50, pranayama: 50 },
    { from: 5, to: 6, steps: 60000, stairs: 60, yoga: 60, pranayama: 60 },
    { from: 7, to: 10, steps: 70000, stairs: 70, yoga: 70, pranayama: 70 },
    { from: 11, to: 12, steps: 60000, stairs: 60, yoga: 60, pranayama: 60 },
  ];

  const STRETCH_TARGETS = [
    { from: 1, to: 2, steps: 50000, stairs: 50, yoga: 50, pranayama: 50 },
    { from: 3, to: 4, steps: 65000, stairs: 65, yoga: 65, pranayama: 65 },
    { from: 5, to: 6, steps: 80000, stairs: 80, yoga: 80, pranayama: 80 },
    { from: 7, to: 10, steps: 90000, stairs: 90, yoga: 90, pranayama: 90 },
    { from: 11, to: 12, steps: 75000, stairs: 75, yoga: 75, pranayama: 75 },
  ];

  function parseLocalDate(value) {
    if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    const [year, month, day] = String(value).split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function formatDate(date) {
    const local = parseLocalDate(date);
    const month = String(local.getMonth() + 1).padStart(2, "0");
    const day = String(local.getDate()).padStart(2, "0");
    return `${local.getFullYear()}-${month}-${day}`;
  }

  function addDays(date, days) {
    const next = parseLocalDate(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function daysBetween(startDate, endDate) {
    const start = parseLocalDate(startDate);
    const end = parseLocalDate(endDate);
    return Math.floor((end - start) / 86400000);
  }

  function isMonday(date) {
    return parseLocalDate(date).getDay() === 1;
  }

  function validateMondayStartDate(date) {
    return isMonday(date);
  }

  function getProgramStatus(startDate, today = new Date()) {
    const offset = daysBetween(startDate, today);
    if (offset < 0) return { state: "not_started", label: "Program not started", weekNumber: null };
    if (offset >= 84) return { state: "completed", label: "Program completed", weekNumber: null };
    const weekNumber = Math.floor(offset / 7) + 1;
    return { state: "active", label: `Week ${weekNumber} of 12`, weekNumber };
  }

  function getWeekRange(startDate, weekNumber) {
    const weekStartDate = addDays(startDate, (weekNumber - 1) * 7);
    const weekEndDate = addDays(weekStartDate, 6);
    return { weekStartDate: formatDate(weekStartDate), weekEndDate: formatDate(weekEndDate) };
  }

  function getTargetsForWeek(weekNumber) {
    const baseline = BASELINE_TARGETS.find((row) => weekNumber >= row.from && weekNumber <= row.to);
    const stretch = STRETCH_TARGETS.find((row) => weekNumber >= row.from && weekNumber <= row.to);
    if (!baseline || !stretch) throw new Error(`Invalid week number: ${weekNumber}`);
    return {
      baseline: pickActivities(baseline),
      stretch: pickActivities(stretch),
    };
  }

  function pickActivities(row) {
    return ACTIVITY_KEYS.reduce((memo, key) => {
      memo[key] = row[key];
      return memo;
    }, {});
  }

  function classifyActivity(actual, baselineTarget, stretchTarget) {
    if (actual === 0) return ACTIVITY_CLASSES.MISSED;
    if (actual >= stretchTarget) return ACTIVITY_CLASSES.STRETCH;
    if (actual >= baselineTarget) return ACTIVITY_CLASSES.BASELINE;
    return ACTIVITY_CLASSES.PARTIAL;
  }

  function classifyWeeklyTotals(totals, weekNumber) {
    const targets = getTargetsForWeek(weekNumber);
    return ACTIVITY_KEYS.reduce((memo, key) => {
      memo[key] = classifyActivity(Number(totals[key] || 0), targets.baseline[key], targets.stretch[key]);
      return memo;
    }, {});
  }

  function getWeeklyStatus(classes) {
    const values = Array.isArray(classes) ? classes : ACTIVITY_KEYS.map((key) => classes[key]);
    const allStretch = values.every((value) => value === ACTIVITY_CLASSES.STRETCH);
    if (allStretch) return WEEKLY_STATUSES.GREEN_RABBIT;

    const allAtLeastBaseline = values.every(
      (value) => value === ACTIVITY_CLASSES.BASELINE || value === ACTIVITY_CLASSES.STRETCH
    );
    if (allAtLeastBaseline) return WEEKLY_STATUSES.GREEN_TORTOISE;

    const hasStretch = values.includes(ACTIVITY_CLASSES.STRETCH);
    const hasBaseline = values.includes(ACTIVITY_CLASSES.BASELINE);
    const hasPartial = values.includes(ACTIVITY_CLASSES.PARTIAL);
    const hasMissed = values.includes(ACTIVITY_CLASSES.MISSED);

    if (hasStretch && hasPartial && !hasMissed) return WEEKLY_STATUSES.YELLOW_RABBIT;
    if (hasBaseline && !hasStretch && hasPartial && !hasMissed) return WEEKLY_STATUSES.YELLOW_TORTOISE;

    const hasAnyActivity = values.some((value) => value !== ACTIVITY_CLASSES.MISSED);
    if (hasAnyActivity) return WEEKLY_STATUSES.GREY_CIRCLE;
    return WEEKLY_STATUSES.RED_CIRCLE;
  }

  function getWeeklySummary(totals, weekNumber) {
    const targets = getTargetsForWeek(weekNumber);
    const classes = classifyWeeklyTotals(totals, weekNumber);
    return {
      targets,
      classes,
      status: getWeeklyStatus(classes),
    };
  }

  function progressPercent(actual, target) {
    return target === 0 ? 0 : (Number(actual || 0) / target) * 100;
  }

  function clampProgressPercent(actual, target) {
    return Math.min(100, progressPercent(actual, target));
  }

  function sortParticipantsAlphabetically(participants) {
    return [...participants].sort((a, b) =>
      String(a.displayName || "").localeCompare(String(b.displayName || ""), undefined, { sensitivity: "base" })
    );
  }

  function validateIncrements(increments) {
    ACTIVITY_KEYS.forEach((key) => {
      const value = Number(increments[key] || 0);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("Activity values must be whole numbers greater than or equal to zero.");
      }
    });
    return true;
  }

  function applyLogIncrement(existingTotals, increments, weekNumber) {
    validateIncrements(increments);
    const nextTotals = { ...existingTotals };
    ACTIVITY_KEYS.forEach((key) => {
      nextTotals[key] = Number(nextTotals[key] || 0) + Number(increments[key] || 0);
    });
    const summary = getWeeklySummary(nextTotals, weekNumber);
    ACTIVITY_KEYS.forEach((key) => {
      nextTotals[`${key}Class`] = summary.classes[key];
    });
    nextTotals.computedStatus = summary.status;
    return nextTotals;
  }

  function computeSnapshotMetrics(participants, weeklyTotals, weekNumber) {
    const totalsByParticipant = new Map(weeklyTotals.map((total) => [total.participantId, total]));
    const iconDistribution = Object.values(WEEKLY_STATUSES).reduce((memo, status) => {
      memo[status] = 0;
      return memo;
    }, {});
    const targets = getTargetsForWeek(weekNumber);
    const averageSums = ACTIVITY_KEYS.reduce((memo, key) => {
      memo[key] = 0;
      return memo;
    }, {});
    let loggedCount = 0;
    let fullBaselineCount = 0;

    participants.forEach((participant) => {
      const total = totalsByParticipant.get(participant.id) || {};
      const summary = getWeeklySummary(total, weekNumber);
      const anyLogged = ACTIVITY_KEYS.some((key) => Number(total[key] || 0) > 0);
      if (anyLogged) loggedCount += 1;
      iconDistribution[summary.status] += 1;
      if (summary.status === WEEKLY_STATUSES.GREEN_RABBIT || summary.status === WEEKLY_STATUSES.GREEN_TORTOISE) {
        fullBaselineCount += 1;
      }
      ACTIVITY_KEYS.forEach((key) => {
        averageSums[key] += clampProgressPercent(total[key], targets.baseline[key]);
      });
    });

    const averages = ACTIVITY_KEYS.reduce((memo, key) => {
      memo[key] = participants.length ? averageSums[key] / participants.length : 0;
      return memo;
    }, {});

    return {
      loggedCount,
      totalRosterCount: participants.length,
      fullBaselineCount,
      iconDistribution,
      averages,
    };
  }

  return {
    ACTIVITY_CLASSES,
    WEEKLY_STATUSES,
    ACTIVITY_KEYS,
    BASELINE_TARGETS,
    STRETCH_TARGETS,
    parseLocalDate,
    formatDate,
    addDays,
    daysBetween,
    isMonday,
    validateMondayStartDate,
    getProgramStatus,
    getWeekRange,
    getTargetsForWeek,
    classifyActivity,
    classifyWeeklyTotals,
    getWeeklyStatus,
    getWeeklySummary,
    progressPercent,
    clampProgressPercent,
    sortParticipantsAlphabetically,
    validateIncrements,
    applyLogIncrement,
    computeSnapshotMetrics,
  };
});
