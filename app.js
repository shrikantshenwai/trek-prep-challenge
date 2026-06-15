const {
  ACTIVITY_CLASSES,
  WEEKLY_STATUSES,
  ACTIVITY_KEYS,
  validateMondayStartDate,
  getProgramStatus,
  getWeekRange,
  getTargetsForWeek,
  getWeeklySummary,
  progressPercent,
  clampProgressPercent,
  sortParticipantsAlphabetically,
  validateIncrements,
  applyLogIncrement,
  computeSnapshotMetrics,
} = window.TrekLogic;

const STORAGE_KEY = "trek-prep-challenge-v1";
const DEVICE_KEY = "trek-prep-device-key";
const app = document.getElementById("app");
const EMPTY_STATE = { groups: [], participants: [], logs: [], totals: [] };
const CLOUD_COLLECTIONS = {
  groups: "trekPrepGroups",
  admins: "trekPrepAdmins",
  participants: "trekPrepParticipants",
  logs: "trekPrepLogs",
  totals: "trekPrepTotals",
};

const activityMeta = {
  steps: { label: "Steps", unit: "steps", helper: "Enter new steps since last log", icon: "shoe", max: 200000 },
  stairs: { label: "Stairs", unit: "flights", helper: "Enter new flights since last log", icon: "stairs", max: 500 },
  yoga: { label: "Yoga", unit: "min", helper: "Enter new minutes since last log", icon: "lotus", max: 600 },
  pranayama: { label: "Pranayama", unit: "min", helper: "Enter new minutes since last log", icon: "breath", max: 600 },
};

const statusLabels = {
  GREEN_RABBIT: "Green Rabbit",
  GREEN_TORTOISE: "Green Tortoise",
  YELLOW_RABBIT: "Yellow Rabbit",
  YELLOW_TORTOISE: "Yellow Tortoise",
  GREY_CIRCLE: "Grey Circle",
  RED_CIRCLE: "Red Circle",
};

let state = { ...EMPTY_STATE };
let cloudDb = null;
let storageMode = "local";
let activeTab = "my";
let selectedWeek = getDefaultSelectedWeek();
let selectedTrailWeek = null;

function readState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { ...EMPTY_STATE };
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return { ...EMPTY_STATE };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function normalizeState(nextState) {
  return {
    groups: Array.isArray(nextState.groups) ? nextState.groups : [],
    participants: Array.isArray(nextState.participants) ? nextState.participants : [],
    logs: Array.isArray(nextState.logs) ? nextState.logs : [],
    totals: Array.isArray(nextState.totals) ? nextState.totals : [],
  };
}

function isFirebaseConfigured() {
  const firebaseSettings = window.TREK_FIREBASE;
  return Boolean(
    firebaseSettings &&
      firebaseSettings.enabled &&
      firebaseSettings.config &&
      firebaseSettings.config.apiKey &&
      !String(firebaseSettings.config.apiKey).startsWith("PASTE_") &&
      window.firebase &&
      window.firebase.firestore
  );
}

async function initializeStorage() {
  state = readState();
  if (!isFirebaseConfigured()) {
    storageMode = "local";
    return;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(window.TREK_FIREBASE.config);
    cloudDb = firebase.firestore();
    storageMode = "cloud";
    await loadCloudState();
    saveState();
  } catch (error) {
    console.warn("Firebase unavailable, falling back to local storage.", error);
    cloudDb = null;
    storageMode = "local";
  }
}

async function loadCloudState() {
  const localState = readState();
  const query = params();
  const publicSlug = query.get("g");
  const adminRoute = getAdminRoute(query);
  const adminToken = adminRoute.token;
  if (adminToken) {
    const adminDoc = await cloudDb.collection(CLOUD_COLLECTIONS.admins).doc(adminToken).get();
    if (!adminDoc.exists) {
      state = localState;
      return;
    }
    await loadCloudGroupBundle(adminRoute.groupId || adminDoc.data().groupId, adminToken);
    return;
  }
  if (publicSlug) {
    await loadCloudGroupBundle(publicSlug, null);
    return;
  }
  await loadCloudDashboard(localState);
}

async function loadCloudGroupBundle(groupId, adminToken) {
  const groupDoc = await cloudDb.collection(CLOUD_COLLECTIONS.groups).doc(groupId).get();
  if (!groupDoc.exists) {
    state = { ...EMPTY_STATE };
    return;
  }
  const [participants, logs, totals] = await Promise.all([
    readCloudCollection(CLOUD_COLLECTIONS.participants, groupId),
    readCloudCollection(CLOUD_COLLECTIONS.logs, groupId),
    readCloudCollection(CLOUD_COLLECTIONS.totals, groupId),
  ]);
  const group = groupDoc.data();
  if (adminToken) group.adminToken = adminToken;
  state = normalizeState({ groups: [group], participants, logs, totals });
}

async function loadCloudDashboard(localState) {
  const [groupsSnapshot, adminTokens, participants, logs, totals] = await Promise.all([
    cloudDb.collection(CLOUD_COLLECTIONS.groups).get(),
    readCloudAdminTokens(),
    readCloudCollection(CLOUD_COLLECTIONS.participants),
    readCloudCollection(CLOUD_COLLECTIONS.logs),
    readCloudCollection(CLOUD_COLLECTIONS.totals),
  ]);
  const localTokens = new Map(localState.groups.map((group) => [group.id, group.adminToken]).filter((entry) => entry[1]));
  const cloudTokens = new Map(adminTokens.map((admin) => [admin.groupId, admin.token]).filter((entry) => entry[0] && entry[1]));
  const groups = groupsSnapshot.docs.map((doc) => {
    const group = doc.data();
    if (!group.adminToken && cloudTokens.has(group.id)) group.adminToken = cloudTokens.get(group.id);
    if (!group.adminToken && localTokens.has(group.id)) group.adminToken = localTokens.get(group.id);
    return group;
  });
  state = normalizeState({ groups, participants, logs, totals });
}

async function readCloudAdminTokens() {
  try {
    const snapshot = await cloudDb.collection(CLOUD_COLLECTIONS.admins).get();
    return snapshot.docs.map((doc) => ({ token: doc.id, ...doc.data() }));
  } catch (error) {
    console.warn("Admin token list unavailable until Firestore rules are published.", error);
    return [];
  }
}

async function readCloudCollection(collectionName, groupId) {
  const ref = cloudDb.collection(collectionName);
  const snapshot = groupId ? await ref.where("groupId", "==", groupId).get() : await ref.get();
  return snapshot.docs.map((doc) => doc.data());
}

async function saveRecord(collectionName, record) {
  saveState();
  if (!cloudDb) return;
  await cloudDb.collection(collectionName).doc(record.id).set(cleanRecord(collectionName, record));
}

async function saveAdminToken(group) {
  saveState();
  if (!cloudDb || !group.adminToken) return;
  await cloudDb.collection(CLOUD_COLLECTIONS.admins).doc(group.adminToken).set({
    groupId: group.id,
    createdAt: group.createdAt || new Date().toISOString(),
  });
}

async function deleteRecords(collectionName, records) {
  saveState();
  if (!cloudDb || !records.length) return;
  const batch = cloudDb.batch();
  records.forEach((record) => {
    batch.delete(cloudDb.collection(collectionName).doc(record.id));
  });
  await batch.commit();
}

function cleanRecord(collectionName, record) {
  const cleaned = JSON.parse(JSON.stringify(record));
  return cleaned;
}

function renderLoading() {
  app.innerHTML = `
    <section class="hero">
      ${logoMarkup()}
      <div class="hero-copy">
        <p class="eyebrow">Loading camp</p>
        <h1>Trek Prep Challenge</h1>
        <p class="subtle">Connecting to shared group data.</p>
      </div>
    </section>
  `;
}

function getDeviceKey() {
  let key = localStorage.getItem(DEVICE_KEY);
  if (!key) {
    key = makeId("device");
    localStorage.setItem(DEVICE_KEY, key);
  }
  return key;
}

function makeId(prefix) {
  if (crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function makeSlug(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36) || "trek-group";
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

function params() {
  return new URLSearchParams(window.location.search);
}

function getAdminRoute(query = params()) {
  const adminValue = query.get("admin");
  const token = query.get("token") || (adminValue && adminValue !== "1" ? adminValue : "");
  return {
    dashboard: adminValue === "1" && !token && !query.get("group"),
    groupId: query.get("group") || "",
    token,
  };
}

function currentContext() {
  const query = params();
  const publicSlug = query.get("g");
  const adminRoute = getAdminRoute(query);
  const adminToken = adminRoute.token;
  const group = adminToken
    ? state.groups.find((item) => item.adminToken === adminToken && (!adminRoute.groupId || item.id === adminRoute.groupId))
    : state.groups.find((item) => item.publicSlug === publicSlug);
  const adminMode = Boolean(adminToken && group);
  const participant = group && !adminMode ? findReturningParticipant(group.id) : null;
  return { publicSlug, adminToken, adminDashboard: adminRoute.dashboard, requestedGroupId: adminRoute.groupId, group, adminMode, participant };
}

function findReturningParticipant(groupId) {
  const savedId = localStorage.getItem(`trek-prep-participant-${groupId}`);
  const deviceKey = getDeviceKey();
  return state.participants.find((item) => item.groupId === groupId && (item.id === savedId || item.deviceKey === deviceKey));
}

function normalizeParticipantName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function findParticipantsByName(groupId, displayName) {
  const normalized = normalizeParticipantName(displayName);
  if (!normalized) return [];
  return state.participants.filter(
    (participant) => participant.groupId === groupId && normalizeParticipantName(participant.displayName) === normalized
  );
}

function choosePrimaryParticipant(participants) {
  return [...participants].sort((left, right) => {
    const leftStats = getParticipantStats(left.id);
    const rightStats = getParticipantStats(right.id);
    if (rightStats.logs !== leftStats.logs) return rightStats.logs - leftStats.logs;
    if (rightStats.activityTotal !== leftStats.activityTotal) return rightStats.activityTotal - leftStats.activityTotal;
    return String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
  })[0];
}

function getDefaultSelectedWeek() {
  return 1;
}

function today() {
  return new Date();
}

function effectiveToday(group) {
  return group.testModeEnabled ? window.TrekLogic.parseLocalDate(group.startDate) : today();
}

function render() {
  const context = currentContext();
  if (!context.group) {
    renderAdminCreate(context);
    return;
  }
  const status = getProgramStatus(context.group.startDate, effectiveToday(context.group));
  if (context.adminMode) {
    if (activeTab !== "setup" && activeTab !== "group" && activeTab !== "snapshot") activeTab = "setup";
    selectedWeek = clampWeek(selectedWeek || status.weekNumber || 1);
    renderMain(context, status);
    return;
  }
  if (!context.participant) {
    renderJoin(context, status);
    return;
  }
  if (activeTab === "snapshot") activeTab = "my";
  renderMain(context, status);
}

function renderAdminCreate(context) {
  const missingLinkMessage = context.publicSlug || context.adminToken || context.requestedGroupId ? `<div class="notice error">That group link was not found in the shared database.</div>` : "";
  const existingGroups = state.groups.length
    ? `
      <section class="card">
        <h2>Existing Groups</h2>
        <p class="subtle">Manage your trek-prep groups from this dashboard.</p>
        <div class="details">${state.groups.map((group) => existingGroupMarkup(group)).join("")}</div>
      </section>
    `
    : `<section class="card"><h2>Existing Groups</h2><div class="empty">No groups found yet.</div></section>`;
  app.innerHTML = `
    <section class="hero">
      ${logoMarkup()}
      <div class="hero-copy">
        <p class="eyebrow">Organiser dashboard</p>
        <h1>Trek Prep Challenge</h1>
        <p class="subtle">Create and manage independent 12-week prep camps with public participant links and private admin links.</p>
        <p class="subtle">${storageStatusText()}</p>
      </div>
    </section>
    ${missingLinkMessage}
    <section class="card start-here-card">
      <h2>Your Start Here Page</h2>
      <p class="subtle">Bookmark this organiser dashboard for yourself. Use it to manage groups, copy links, reset test data, or jump into your own participant view.</p>
      <div class="link-box">${getAdminDashboardLink()}</div>
      <button class="button ghost" type="button" data-copy="${encodeURIComponent(getAdminDashboardLink())}">Copy My Admin Dashboard Link</button>
    </section>
    ${existingGroups}
    <form class="card" id="createGroupForm">
      <h2>Create New Prep Group</h2>
      <label class="field"><span>Group name</span><input name="name" required maxlength="80" placeholder="NITK85 Kishtwar Trek Group" /></label>
      <label class="field"><span>Trek name or description</span><input name="trekName" required maxlength="120" placeholder="Kishtwar high-altitude prep" /></label>
      <label class="field"><span>12-week Monday start date</span><input name="startDate" required type="date" /></label>
      <label class="field"><span>Optional notes</span><textarea name="description" maxlength="300" placeholder="Shared accountability, steady preparation, no rankings."></textarea></label>
      <button class="button" type="submit">Create Group</button>
      <div id="createMessage"></div>
    </form>
    <div id="modalRoot"></div>
  `;
  document.getElementById("createGroupForm").addEventListener("submit", createGroup);
  bindCopyButtons();
  bindResetButtons();
}

function existingGroupMarkup(group) {
  const links = getGroupLinks(group);
  const participants = getParticipantsForGroup(group.id);
  const logs = state.logs.filter((log) => log.groupId === group.id);
  const totals = state.totals.filter((total) => total.groupId === group.id);
  const status = getProgramStatus(group.startDate, effectiveToday(group));
  const adminActions = links.adminLink
    ? `
      <a class="button" href="${links.adminHref}">Open Admin Snapshot</a>
      <button class="button ghost" type="button" data-copy="${encodeURIComponent(links.adminLink)}">Copy Admin Link</button>
      <button class="button ghost danger" type="button" data-reset-group="${escapeHtml(group.id)}">Reset This Group Data</button>
    `
    : `<div class="notice error">Admin link unavailable for this older group on this device. Open the original admin link once, then save settings to refresh it.</div>`;
  return `
    <div class="saved-group">
      <div>
        <strong>${escapeHtml(group.name)}</strong>
        <span class="subtle">${escapeHtml(group.trekName)} - ${formatDisplayDate(group.startDate)}${group.testModeEnabled ? " - Testing mode on" : ""}</span>
      </div>
      <div class="details compact-details">
        <div class="detail-row"><span>Current week status</span><strong>${escapeHtml(status.label)}</strong></div>
        <div class="detail-row"><span>Participants</span><strong>${participants.length}</strong></div>
        <div class="detail-row"><span>Log entries</span><strong>${logs.length}</strong></div>
        <div class="detail-row"><span>Weekly totals</span><strong>${totals.length}</strong></div>
      </div>
      <strong>Public participant link</strong>
      <div class="link-box">${links.publicLink}</div>
      ${links.adminLink ? `<strong>Admin/manage link</strong><div class="link-box">${links.adminLink}</div>` : ""}
      <div class="button-row">
        <a class="button secondary" href="${links.publicHref}">Open My Status</a>
        <button class="button ghost" type="button" data-copy="${encodeURIComponent(links.publicLink)}">Copy Public Link</button>
        ${adminActions}
      </div>
    </div>
  `;
}
async function createGroup(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const startDate = form.get("startDate");
  const message = document.getElementById("createMessage");
  if (!validateMondayStartDate(startDate)) {
    message.innerHTML = `<div class="notice error">Please select a Monday start date so the 12-week plan runs cleanly Monday to Sunday.</div>`;
    return;
  }
  const publicSlug = makeSlug(form.get("name"));
  const group = {
    id: publicSlug,
    name: form.get("name").trim(),
    trekName: form.get("trekName").trim(),
    description: form.get("description").trim(),
    startDate,
    createdAt: new Date().toISOString(),
    publicSlug,
    adminToken: makeId("admin").replace(/_/g, "-"),
    isActive: true,
  };
  state.groups.push(group);
  await saveRecord(CLOUD_COLLECTIONS.groups, group);
  await saveAdminToken(group);
  const links = getGroupLinks(group);
  render();
  setTimeout(() => {
    const freshMessage = document.getElementById("createMessage");
    if (!freshMessage) return;
    freshMessage.innerHTML = `
      <div class="notice">Group created. Share the public link with participants and keep the admin link private.</div>
      <div class="details">
        <strong>Public group link</strong>
        <div class="link-box">${links.publicLink}</div>
        <button class="button ghost" type="button" data-copy="${encodeURIComponent(links.publicLink)}">Copy public link</button>
        <strong>Admin link</strong>
        <div class="link-box">${links.adminLink}</div>
        <button class="button ghost" type="button" data-copy="${encodeURIComponent(links.adminLink)}">Copy admin link</button>
        <a class="button secondary" href="${links.publicHref}">Open public camp</a>
        <a class="button" href="${links.adminHref}">Open admin snapshot</a>
      </div>
    `;
    bindCopyButtons();
  }, 0);
}

function getGroupLinks(group) {
  const base = `${location.origin}${location.pathname}`;
  const adminToken = group.adminToken || getAdminRoute().token || "";
  const adminQuery = adminToken
    ? `?admin=1&group=${encodeURIComponent(group.id)}&token=${encodeURIComponent(adminToken)}`
    : "";
  return {
    publicHref: `?g=${encodeURIComponent(group.publicSlug)}`,
    adminHref: adminQuery,
    publicLink: `${base}?g=${encodeURIComponent(group.publicSlug)}`,
    adminLink: adminQuery ? `${base}${adminQuery}` : "",
  };
}

function getAdminDashboardLink() {
  return `${location.origin}${location.pathname}?admin=1`;
}

function renderJoin(context, programStatus) {
  const participants = getParticipantsForGroup(context.group.id);
  const participantButtons = participants.length
    ? `
      <section class="card">
        <h2>Already Joined?</h2>
        <p class="subtle">Tap your name below to continue. Do not enter your name again if you are already listed here.</p>
        <div class="roster-claim-list">
        ${participants
          .map(
            (participant) => `
              <button class="button ghost roster-claim-button" type="button" data-claim-participant="${escapeHtml(participant.id)}">
                Continue as ${escapeHtml(participant.displayName)}
              </button>
            `
          )
          .join("")}
        </div>
      </section>
    `
    : "";
  app.innerHTML = `
    <section class="hero">
      ${logoMarkup()}
      <div class="hero-copy">
        <p class="eyebrow">12-week fitness program</p>
        <h1>Trek Prep Challenge</h1>
      </div>
    </section>
    <section class="card">
      <h2>${escapeHtml(context.group.name)}</h2>
      <p class="subtle">${escapeHtml(context.group.trekName)}</p>
      ${context.group.description ? `<p>${escapeHtml(context.group.description)}</p>` : ""}
      <div class="details">
        <div class="detail-row"><span>Start date</span><strong>${formatDisplayDate(context.group.startDate)}</strong></div>
        <div class="detail-row"><span>Program status</span><span class="pill">${programStatus.label}</span></div>
      </div>
    </section>
    ${participantButtons}
    <form class="card" id="joinForm">
      <h2>New Users</h2>
      <p class="subtle">If your name is not listed above, enter your name here.</p>
      <label class="field"><span>Your display name</span><input name="displayName" required maxlength="50" autocomplete="name" placeholder="Rajiv" /></label>
      <button class="button" type="submit">Join Camp</button>
      <div id="joinMessage"></div>
    </form>
    <section class="card">
      <h2>Weekly Status Icons</h2>
      <div class="legend">${legendMarkup()}</div>
    </section>
  `;
  document.getElementById("joinForm").addEventListener("submit", joinGroup);
  bindClaimParticipantButtons();
}

async function joinGroup(event) {
  event.preventDefault();
  const context = currentContext();
  const displayName = new FormData(event.currentTarget).get("displayName").trim();
  const message = document.getElementById("joinMessage");
  if (!displayName || displayName.length > 50) {
    message.innerHTML = `<div class="notice error">Please enter a name up to 50 characters.</div>`;
    return;
  }
  const existingMatches = findParticipantsByName(context.group.id, displayName);
  if (existingMatches.length) {
    await claimParticipant(choosePrimaryParticipant(existingMatches).id);
    return;
  }
  const participant = {
    id: makeId("participant"),
    groupId: context.group.id,
    displayName,
    deviceKey: getDeviceKey(),
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  state.participants.push(participant);
  localStorage.setItem(`trek-prep-participant-${context.group.id}`, participant.id);
  ensureTotalsForParticipant(context.group, participant.id);
  await saveRecord(CLOUD_COLLECTIONS.participants, participant);
  await Promise.all(
    state.totals
      .filter((total) => total.groupId === context.group.id && total.participantId === participant.id)
      .map((total) => saveRecord(CLOUD_COLLECTIONS.totals, total))
  );
  activeTab = "my";
  render();
}

function bindClaimParticipantButtons() {
  app.querySelectorAll("[data-claim-participant]").forEach((button) => {
    button.addEventListener("click", () => claimParticipant(button.dataset.claimParticipant));
  });
}

async function claimParticipant(participantId) {
  const context = currentContext();
  const participant = state.participants.find((item) => item.groupId === context.group.id && item.id === participantId);
  const message = document.getElementById("joinMessage");
  if (!participant) {
    if (message) message.innerHTML = `<div class="notice error">That roster name was not found. Please refresh and try again.</div>`;
    return;
  }
  participant.deviceKey = getDeviceKey();
  participant.lastSeenAt = new Date().toISOString();
  localStorage.setItem(`trek-prep-participant-${context.group.id}`, participant.id);
  ensureTotalsForParticipant(context.group, participant.id);
  await saveRecord(CLOUD_COLLECTIONS.participants, participant);
  await Promise.all(
    state.totals
      .filter((total) => total.groupId === context.group.id && total.participantId === participant.id)
      .map((total) => saveRecord(CLOUD_COLLECTIONS.totals, total))
  );
  activeTab = "my";
  render();
}

function renderMain(context, programStatus) {
  app.innerHTML = `
    <header class="topbar">
      ${logoMarkup("small")}
      <div>
        <p class="eyebrow">${context.adminMode ? "Organiser view" : "12 Week Preparation Plan"}</p>
        <h2>${activeTab === "setup" ? "Admin Setup" : activeTab === "snapshot" ? "Snapshot" : activeTab === "group" ? "Group Status" : "My Status"}</h2>
        <p class="subtle">${context.adminMode ? escapeHtml(context.group.name) : escapeHtml(context.participant.displayName)}</p>
      </div>
    </header>
    <nav class="tabs" style="--tab-count:${context.adminMode ? 3 : 2}">
      ${context.adminMode ? "" : tabButton("my", "My Status", activeTab)}
      ${context.adminMode ? tabButton("setup", "Admin Setup", activeTab) : ""}
      ${tabButton("group", "Group Status", activeTab)}
      ${context.adminMode ? tabButton("snapshot", "Snapshot", activeTab) : ""}
    </nav>
    <div id="view"></div>
  `;
  app.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      activeTab = button.dataset.tab;
      render();
    });
  });
  if (activeTab === "setup" && context.adminMode) renderAdminSetup(context, programStatus);
  else if (activeTab === "group") renderGroupStatus(context, programStatus);
  else if (activeTab === "snapshot" && context.adminMode) renderSnapshot(context, programStatus);
  else renderMyStatus(context, programStatus);
}

function tabButton(key, label, current) {
  return `<button class="tab ${current === key ? "is-active" : ""}" data-tab="${key}" type="button">${label}</button>`;
}

function renderMyStatus(context, programStatus) {
  const view = document.getElementById("view");
  const currentWeek = programStatus.weekNumber;
  const participant = context.participant;
  ensureTotalsForParticipant(context.group, participant.id);
  view.innerHTML = `
    <section class="card">
      <div class="activity-head">
        <div>
          <h2>Your 12-Week Trail</h2>
          <p class="subtle">${programStatus.label}</p>
        </div>
        <span class="pill">${context.group.name}</span>
      </div>
      ${trailMarkup(context.group, participant.id, currentWeek)}
      <p class="subtle">${trailSummary(context.group, participant.id, currentWeek)}</p>
    </section>
    ${logCardMarkup(context, programStatus)}
  `;
  const form = document.getElementById("logForm");
  if (form) form.addEventListener("submit", saveLog);
}

function renderAdminSetup(context, programStatus) {
  const view = document.getElementById("view");
  const links = getGroupLinks(context.group);
  const rosterCleanup = rosterCleanupMarkup(context.group);
  view.innerHTML = `
    <section class="card">
      <h2>Group Settings</h2>
      <p class="subtle">Edit the camp details before sharing the participant link widely.</p>
      <p class="subtle">${storageStatusText()}</p>
      ${context.group.testModeEnabled ? `<div class="notice">Testing mode is on. The public camp behaves as active Week 1 today, even if the official start date is later.</div>` : ""}
      <form id="adminSettingsForm">
        <label class="field"><span>Group name</span><input name="name" required maxlength="80" value="${escapeHtml(context.group.name)}" /></label>
        <label class="field"><span>Trek name or description</span><input name="trekName" required maxlength="120" value="${escapeHtml(context.group.trekName)}" /></label>
        <label class="field"><span>Official Monday start date</span><input name="startDate" required type="date" value="${escapeHtml(context.group.startDate)}" /></label>
        <label class="field"><span>Optional notes</span><textarea name="description" maxlength="300">${escapeHtml(context.group.description || "")}</textarea></label>
        <label class="check-row">
          <input name="testModeEnabled" type="checkbox" ${context.group.testModeEnabled ? "checked" : ""} />
          <span>Testing mode: make this camp active today as Week 1</span>
        </label>
        <button class="button" type="submit">Save Settings</button>
        <div id="settingsMessage"></div>
      </form>
    </section>
    <section class="card">
      <h2>Your Links</h2>
      <div class="details">
        <strong>For everyone else: public participant link</strong>
        <div class="link-box">${links.publicLink}</div>
        <button class="button ghost" type="button" data-copy="${encodeURIComponent(links.publicLink)}">Copy Public Link</button>
        <a class="button secondary" href="${links.publicHref}">Open My Status</a>
        <strong>For you only: private admin/manage link</strong>
        <div class="link-box">${links.adminLink}</div>
        <button class="button ghost" type="button" data-copy="${encodeURIComponent(links.adminLink)}">Copy Admin Link</button>
      </div>
    </section>
    ${rosterCleanup}
    <section class="card danger-zone">
      <h2>Danger Zone</h2>
      <p class="subtle">Use this only before launching a group or if you want to clear test entries. This will remove all participants, logs, and weekly totals for this group. The group link and start date will remain unchanged.</p>
      <button class="button danger" type="button" data-reset-group="${escapeHtml(context.group.id)}">Reset This Group Data</button>
      <div id="resetMessage"></div>
    </section>
    <div id="modalRoot"></div>
  `;
  document.getElementById("adminSettingsForm").addEventListener("submit", saveAdminSettings);
  bindCopyButtons();
  bindResetButtons();
  bindRosterCleanupButtons();
}

function storageStatusText() {
  return storageMode === "cloud"
    ? "Database: shared Firebase Firestore"
    : "Database: local browser storage until Firebase config is added";
}

async function saveAdminSettings(event) {
  event.preventDefault();
  const context = currentContext();
  const form = new FormData(event.currentTarget);
  const message = document.getElementById("settingsMessage");
  const startDate = form.get("startDate");
  if (!validateMondayStartDate(startDate)) {
    message.innerHTML = `<div class="notice error">Please select a Monday start date so the 12-week plan runs cleanly Monday to Sunday. Use testing mode if you want to try the camp today before launch.</div>`;
    return;
  }
  context.group.name = form.get("name").trim();
  context.group.trekName = form.get("trekName").trim();
  context.group.description = form.get("description").trim();
  context.group.startDate = startDate;
  context.group.testModeEnabled = form.get("testModeEnabled") === "on";
  context.group.updatedAt = new Date().toISOString();
  state.totals
    .filter((total) => total.groupId === context.group.id)
    .forEach((total) => {
      const range = getWeekRange(context.group.startDate, total.weekNumber);
      total.weekStartDate = range.weekStartDate;
      total.weekEndDate = range.weekEndDate;
      updateWeeklyComputedFields(context.group, total);
    });
  await saveRecord(CLOUD_COLLECTIONS.groups, context.group);
  await Promise.all(
    state.totals
      .filter((total) => total.groupId === context.group.id)
      .map((total) => saveRecord(CLOUD_COLLECTIONS.totals, total))
  );
  render();
  setTimeout(() => {
    const freshMessage = document.getElementById("settingsMessage");
    if (freshMessage) freshMessage.innerHTML = `<div class="notice">Settings saved.</div>`;
  }, 0);
}

function bindResetButtons() {
  app.querySelectorAll("[data-reset-group]").forEach((button) => {
    button.addEventListener("click", () => openResetWarning(button.dataset.resetGroup));
  });
}

function getResetCounts(groupId) {
  return {
    participants: state.participants.filter((participant) => participant.groupId === groupId).length,
    logs: state.logs.filter((log) => log.groupId === groupId).length,
    totals: state.totals.filter((total) => total.groupId === groupId).length,
  };
}

function getModalRoot() {
  let root = document.getElementById("modalRoot");
  if (!root) {
    root = document.createElement("div");
    root.id = "modalRoot";
    app.appendChild(root);
  }
  return root;
}

function closeResetModal() {
  getModalRoot().innerHTML = "";
}

function openResetWarning(groupId) {
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) return;
  const counts = getResetCounts(groupId);
  getModalRoot().innerHTML = `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="resetTitle">
        <h2 id="resetTitle">Reset group data?</h2>
        <p>This will permanently delete all participants, log entries, and weekly totals for this group only. The group itself, start date, public link, and admin link will remain unchanged. Other groups will not be affected.</p>
        <div class="details">
          <div class="detail-row"><span>Selected group</span><strong>${escapeHtml(group.name)}</strong></div>
          <div class="detail-row"><span>Participants to delete</span><strong>${counts.participants}</strong></div>
          <div class="detail-row"><span>Log entries to delete</span><strong>${counts.logs}</strong></div>
          <div class="detail-row"><span>Weekly totals to delete</span><strong>${counts.totals}</strong></div>
        </div>
        <div class="button-row modal-actions">
          <button class="button ghost" type="button" id="cancelReset">Cancel</button>
          <button class="button danger" type="button" id="continueReset">Continue</button>
        </div>
      </section>
    </div>
  `;
  document.getElementById("cancelReset").addEventListener("click", closeResetModal);
  document.getElementById("continueReset").addEventListener("click", () => openResetConfirm(groupId));
}

function openResetConfirm(groupId) {
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) return;
  const counts = getResetCounts(groupId);
  getModalRoot().innerHTML = `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="confirmResetTitle">
        <h2 id="confirmResetTitle">Type RESET to confirm</h2>
        <p class="subtle">This will clear ${counts.participants} participants, ${counts.logs} log entries, and ${counts.totals} weekly total records for ${escapeHtml(group.name)}.</p>
        <label class="field"><span>Confirmation</span><input id="resetConfirmInput" autocomplete="off" placeholder="RESET" /></label>
        <div id="resetModalMessage"></div>
        <div class="button-row modal-actions">
          <button class="button ghost" type="button" id="cancelReset">Cancel</button>
          <button class="button danger" type="button" id="confirmReset" disabled>Confirm Reset</button>
        </div>
      </section>
    </div>
  `;
  const input = document.getElementById("resetConfirmInput");
  const confirmButton = document.getElementById("confirmReset");
  document.getElementById("cancelReset").addEventListener("click", closeResetModal);
  input.addEventListener("input", () => {
    confirmButton.disabled = input.value !== "RESET";
  });
  confirmButton.addEventListener("click", () => resetGroupData(groupId));
  input.focus();
}

async function resetGroupData(groupId) {
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) return;
  const modalMessage = document.getElementById("resetModalMessage");
  const confirmButton = document.getElementById("confirmReset");
  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.textContent = "Resetting...";
  }
  try {
    const removedLogs = state.logs.filter((log) => log.groupId === groupId);
    const removedTotals = state.totals.filter((total) => total.groupId === groupId);
    const removedParticipants = state.participants.filter((participant) => participant.groupId === groupId);
    await deleteRecords(CLOUD_COLLECTIONS.logs, removedLogs);
    await deleteRecords(CLOUD_COLLECTIONS.totals, removedTotals);
    await deleteRecords(CLOUD_COLLECTIONS.participants, removedParticipants);
    state.logs = state.logs.filter((log) => log.groupId !== groupId);
    state.totals = state.totals.filter((total) => total.groupId !== groupId);
    state.participants = state.participants.filter((participant) => participant.groupId !== groupId);
    localStorage.removeItem(`trek-prep-participant-${groupId}`);
    selectedTrailWeek = null;
    saveState();
    closeResetModal();
    render();
    setTimeout(() => {
      const message = document.getElementById("resetMessage") || document.getElementById("createMessage");
      if (message) message.innerHTML = `<div class="notice">Group data reset successfully. This group is ready for launch.</div>`;
    }, 0);
  } catch (error) {
    if (modalMessage) modalMessage.innerHTML = `<div class="notice error">${escapeHtml(error.message || "Reset failed. Please try again.")}</div>`;
    if (confirmButton) {
      confirmButton.disabled = false;
      confirmButton.textContent = "Confirm Reset";
    }
  }
}

function rosterCleanupMarkup(group) {
  const participants = getParticipantsForGroup(group.id);
  const duplicateGroups = getDuplicateParticipantGroups(group.id);
  const emptyParticipants = participants.filter((participant) => isEmptyParticipant(participant.id));
  if (!participants.length) return "";
  return `
    <section class="card">
      <h2>Roster Cleanup</h2>
      <p class="subtle">Fix duplicate names without clearing the real activity people already logged.</p>
      ${
        duplicateGroups.length
          ? `
            <div class="notice">
              ${duplicateGroups.length} duplicate name ${duplicateGroups.length === 1 ? "set" : "sets"} found. Merge keeps the row with the most logged activity and moves the duplicate data into it.
            </div>
            <button class="button" type="button" data-merge-duplicates="${escapeHtml(group.id)}">Merge Same-Name Duplicates</button>
          `
          : `<div class="notice">No same-name duplicates found.</div>`
      }
      <div class="roster-admin-list">
        ${participants.map((participant) => rosterAdminRowMarkup(participant)).join("")}
      </div>
      <div id="rosterMessage"></div>
    </section>
  `;
}

function rosterAdminRowMarkup(participant) {
  const stats = getParticipantStats(participant.id);
  const removable = stats.logs === 0 && stats.activityTotal === 0;
  return `
    <div class="roster-admin-row">
      <div>
        <strong>${escapeHtml(participant.displayName)}</strong>
        <p class="subtle">${stats.logs} logs - ${stats.nonZeroWeeks} active weeks</p>
      </div>
      ${
        removable
          ? `<button class="button ghost danger compact-button" type="button" data-remove-empty-participant="${escapeHtml(participant.id)}">Remove Empty</button>`
          : `<span class="pill">Keep data</span>`
      }
    </div>
  `;
}

function bindRosterCleanupButtons() {
  app.querySelectorAll("[data-merge-duplicates]").forEach((button) => {
    button.addEventListener("click", () => mergeSameNameDuplicates(button.dataset.mergeDuplicates));
  });
  app.querySelectorAll("[data-remove-empty-participant]").forEach((button) => {
    button.addEventListener("click", () => removeEmptyParticipant(button.dataset.removeEmptyParticipant));
  });
}

function getDuplicateParticipantGroups(groupId) {
  const byName = new Map();
  state.participants
    .filter((participant) => participant.groupId === groupId)
    .forEach((participant) => {
      const name = normalizeParticipantName(participant.displayName);
      if (!name) return;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(participant);
    });
  return [...byName.values()].filter((participants) => participants.length > 1);
}

function getParticipantStats(participantId) {
  const logs = state.logs.filter((log) => log.participantId === participantId);
  const totals = state.totals.filter((total) => total.participantId === participantId);
  const activityTotal = totals.reduce(
    (sum, total) => sum + ACTIVITY_KEYS.reduce((activitySum, key) => activitySum + Number(total[key] || 0), 0),
    0
  );
  const nonZeroWeeks = totals.filter((total) => ACTIVITY_KEYS.some((key) => Number(total[key] || 0) > 0)).length;
  return { logs: logs.length, activityTotal, nonZeroWeeks };
}

function isEmptyParticipant(participantId) {
  const stats = getParticipantStats(participantId);
  return stats.logs === 0 && stats.activityTotal === 0;
}

async function mergeSameNameDuplicates(groupId) {
  const message = document.getElementById("rosterMessage");
  const duplicateGroups = getDuplicateParticipantGroups(groupId);
  if (!duplicateGroups.length) {
    if (message) message.innerHTML = `<div class="notice">No duplicate names to merge.</div>`;
    return;
  }
  try {
    for (const duplicateGroup of duplicateGroups) {
      const primary = choosePrimaryParticipant(duplicateGroup);
      const duplicates = duplicateGroup.filter((participant) => participant.id !== primary.id);
      for (const duplicate of duplicates) {
        await mergeParticipantInto(groupId, duplicate.id, primary.id);
      }
    }
    saveState();
    render();
    setTimeout(() => {
      const freshMessage = document.getElementById("rosterMessage");
      if (freshMessage) freshMessage.innerHTML = `<div class="notice">Duplicate roster names merged. Existing logs were kept.</div>`;
    }, 0);
  } catch (error) {
    if (message) message.innerHTML = `<div class="notice error">${escapeHtml(error.message || "Merge failed. Please try again.")}</div>`;
  }
}

async function mergeParticipantInto(groupId, fromParticipantId, toParticipantId) {
  if (fromParticipantId === toParticipantId) return;
  const group = state.groups.find((item) => item.id === groupId);
  const fromParticipant = state.participants.find((participant) => participant.id === fromParticipantId && participant.groupId === groupId);
  const toParticipant = state.participants.find((participant) => participant.id === toParticipantId && participant.groupId === groupId);
  if (!group || !fromParticipant || !toParticipant) throw new Error("Could not find both roster entries for merge.");

  const movedLogs = state.logs.filter((log) => log.groupId === groupId && log.participantId === fromParticipantId);
  if (movedLogs.length) await deleteRecords(CLOUD_COLLECTIONS.logs, movedLogs);
  movedLogs.forEach((log) => {
    log.participantId = toParticipantId;
  });
  await Promise.all(movedLogs.map((log) => saveRecord(CLOUD_COLLECTIONS.logs, log)));

  const sourceTotals = state.totals.filter((total) => total.groupId === groupId && total.participantId === fromParticipantId);
  const totalsToDelete = [];
  const totalsToSave = [];
  sourceTotals.forEach((sourceTotal) => {
    const targetTotal = state.totals.find(
      (total) => total.groupId === groupId && total.participantId === toParticipantId && total.weekNumber === sourceTotal.weekNumber
    );
    if (targetTotal) {
      ACTIVITY_KEYS.forEach((key) => {
        targetTotal[key] = Number(targetTotal[key] || 0) + Number(sourceTotal[key] || 0);
      });
      updateWeeklyComputedFields(group, targetTotal);
      totalsToSave.push(targetTotal);
      totalsToDelete.push(sourceTotal);
    } else {
      sourceTotal.participantId = toParticipantId;
      updateWeeklyComputedFields(group, sourceTotal);
      totalsToSave.push(sourceTotal);
    }
  });
  if (totalsToDelete.length) await deleteRecords(CLOUD_COLLECTIONS.totals, totalsToDelete);
  state.totals = state.totals.filter((total) => !totalsToDelete.some((deleted) => deleted.id === total.id));
  await Promise.all(totalsToSave.map((total) => saveRecord(CLOUD_COLLECTIONS.totals, total)));

  await deleteRecords(CLOUD_COLLECTIONS.participants, [fromParticipant]);
  state.participants = state.participants.filter((participant) => participant.id !== fromParticipantId);
  if (localStorage.getItem(`trek-prep-participant-${groupId}`) === fromParticipantId) {
    localStorage.setItem(`trek-prep-participant-${groupId}`, toParticipantId);
  }
}

async function removeEmptyParticipant(participantId) {
  const participant = state.participants.find((item) => item.id === participantId);
  const message = document.getElementById("rosterMessage");
  if (!participant) return;
  if (!isEmptyParticipant(participantId)) {
    if (message) message.innerHTML = `<div class="notice error">This roster entry has activity. Merge it instead of removing it.</div>`;
    return;
  }
  if (!confirm(`Remove empty roster entry for ${participant.displayName}?`)) return;
  try {
    const emptyTotals = state.totals.filter((total) => total.participantId === participantId);
    await deleteRecords(CLOUD_COLLECTIONS.totals, emptyTotals);
    await deleteRecords(CLOUD_COLLECTIONS.participants, [participant]);
    state.totals = state.totals.filter((total) => total.participantId !== participantId);
    state.participants = state.participants.filter((item) => item.id !== participantId);
    if (localStorage.getItem(`trek-prep-participant-${participant.groupId}`) === participantId) {
      localStorage.removeItem(`trek-prep-participant-${participant.groupId}`);
    }
    saveState();
    render();
    setTimeout(() => {
      const freshMessage = document.getElementById("rosterMessage");
      if (freshMessage) freshMessage.innerHTML = `<div class="notice">Empty roster entry removed.</div>`;
    }, 0);
  } catch (error) {
    if (message) message.innerHTML = `<div class="notice error">${escapeHtml(error.message || "Remove failed. Please try again.")}</div>`;
  }
}

function logCardMarkup(context, programStatus) {
  if (programStatus.state === "not_started") {
    return `<section class="card"><h2>Log This Week</h2><div class="notice">Program not started yet.</div></section>`;
  }
  if (programStatus.state === "completed") {
    return `<section class="card"><h2>Log This Week</h2><div class="notice">Program completed.</div></section>`;
  }
  const weekNumber = programStatus.weekNumber;
  const totals = getWeeklyTotal(context.group.id, context.participant.id, weekNumber);
  const targets = getTargetsForWeek(weekNumber);
  const daysLeft = daysLeftThisWeek(context.group, weekNumber);
  return `
    <form class="card" id="logForm">
      <h2>Log This Week</h2>
      <p class="subtle">Progress vs Baseline Target - ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left this week</p>
      ${ACTIVITY_KEYS.map((key) => activityRowMarkup(key, totals, targets)).join("")}
      <button class="button" id="saveLogButton" type="submit">Save This Log</button>
      <div id="logMessage"></div>
    </form>
  `;
}

function activityRowMarkup(key, totals, targets) {
  const meta = activityMeta[key];
  const actual = Number(totals[key] || 0);
  const baseline = targets.baseline[key];
  const stretch = targets.stretch[key];
  const percent = progressPercent(actual, baseline);
  const visible = clampProgressPercent(actual, baseline);
  return `
    <div class="activity-row">
      <div class="activity-head">
        <div>
          <div class="activity-title"><span class="glyph">${activityGlyph(meta.icon)}</span>${meta.label}</div>
          <div class="subtle">${numberFormat(actual)} ${meta.unit} logged - baseline ${numberFormat(baseline)} - stretch ${numberFormat(stretch)}</div>
        </div>
        <strong>${Math.round(percent)}%</strong>
      </div>
      <div class="bar"><span style="width:${visible}%"></span></div>
      <div class="increment-grid">
        <label class="field">
          <span class="subtle">${meta.helper}</span>
          <input name="${key}" inputmode="numeric" min="0" step="1" type="number" value="0" />
        </label>
        <span class="pill">+${key === "steps" ? "Steps" : key === "stairs" ? "Stairs" : "min"}</span>
      </div>
    </div>
  `;
}

async function saveLog(event) {
  event.preventDefault();
  const context = currentContext();
  const programStatus = getProgramStatus(context.group.startDate, effectiveToday(context.group));
  const button = document.getElementById("saveLogButton");
  const message = document.getElementById("logMessage");
  button.disabled = true;
  button.textContent = "Saving...";

  try {
    if (programStatus.state !== "active") throw new Error("Logging is available only during the active 12-week program.");
    const weekNumber = programStatus.weekNumber;
    const form = new FormData(event.currentTarget);
    const increments = {};
    for (const key of ACTIVITY_KEYS) {
      const value = Number(form.get(key));
      increments[key] = value;
    }
    validateIncrements(increments);
    const high = ACTIVITY_KEYS.some((key) => increments[key] > activityMeta[key].max);
    if (high && !confirm("This seems unusually high. Please confirm before saving.")) return;
    const totalIncrement = ACTIVITY_KEYS.reduce((sum, key) => sum + increments[key], 0);
    if (totalIncrement === 0 && !confirm("All increments are zero. Save this log anyway?")) return;

    const log = {
      id: makeId("log"),
      groupId: context.group.id,
      participantId: context.participant.id,
      weekNumber,
      createdAt: new Date().toISOString(),
      stepsIncrement: increments.steps,
      stairsIncrement: increments.stairs,
      yogaIncrement: increments.yoga,
      pranayamaIncrement: increments.pranayama,
    };
    state.logs.push(log);
    const total = getWeeklyTotal(context.group.id, context.participant.id, weekNumber);
    Object.assign(total, applyLogIncrement(total, increments, weekNumber));
    updateWeeklyComputedFields(context.group, total);
    await saveRecord(CLOUD_COLLECTIONS.logs, log);
    await saveRecord(CLOUD_COLLECTIONS.totals, total);
    selectedTrailWeek = weekNumber;
    render();
    setTimeout(() => {
      const logMessage = document.getElementById("logMessage");
      if (logMessage) logMessage.innerHTML = `<div class="notice">Log saved. Your Week ${weekNumber} trail has been updated.</div>`;
    }, 0);
  } catch (error) {
    message.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = "Save This Log";
  }
}

function renderGroupStatus(context, programStatus) {
  const view = document.getElementById("view");
  const participants = getParticipantsForGroup(context.group.id);
  view.innerHTML = `
    <section class="card">
      <h2>12-Week Trails</h2>
      <p class="subtle">Alphabetical - no ranking</p>
      ${participants.length ? participants.map((p) => participantTrailMarkup(context.group, p, programStatus.weekNumber)).join("") : `<div class="empty">No one has joined this camp yet.</div>`}
    </section>
  `;
}

function participantTrailMarkup(group, participant, currentWeek) {
  return `
    <div class="participant">
      <div class="participant-name">${escapeHtml(participant.displayName)}</div>
      ${trailMarkup(group, participant.id, currentWeek, false)}
    </div>
  `;
}

function renderSnapshot(context, programStatus) {
  const view = document.getElementById("view");
  selectedWeek = clampWeek(selectedWeek || programStatus.weekNumber || 1);
  const snapshot = computeSnapshot(context.group, selectedWeek);
  view.innerHTML = `
    <section class="card">
      <div class="activity-head">
        <div>
          <h2>Week Snapshot</h2>
          <p class="subtle">Organiser view</p>
        </div>
        <select id="weekSelect" aria-label="Select week">
          ${Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}" ${selectedWeek === index + 1 ? "selected" : ""}>W${index + 1}</option>`).join("")}
        </select>
      </div>
    </section>
    <section class="card snapshot-grid">
      <h2>Participation</h2>
      <div class="metric-row"><span>Logged count</span><strong>${snapshot.loggedCount}</strong></div>
      <div class="metric-row"><span>Total roster count</span><strong>${snapshot.totalRosterCount}</strong></div>
      <div class="metric-row"><span>Full baseline count</span><strong>${snapshot.fullBaselineCount}</strong></div>
    </section>
    <section class="card snapshot-grid">
      <h2>Icon Distribution</h2>
      ${Object.keys(statusLabels).map((status) => distributionRow(status, snapshot.iconDistribution[status])).join("")}
    </section>
    <section class="card snapshot-grid">
      <h2>Group Average vs Baseline</h2>
      ${ACTIVITY_KEYS.map((key) => averageRow(key, snapshot.averages[key])).join("")}
    </section>
    <section class="card">
      <h2>WhatsApp Summary</h2>
      <textarea class="summary-box" readonly id="summaryText">${escapeHtml(snapshot.whatsappSummary)}</textarea>
      <button class="button" type="button" id="copySummary">Copy Summary</button>
      <div id="copyMessage"></div>
    </section>
  `;
  document.getElementById("weekSelect").addEventListener("change", (event) => {
    selectedWeek = Number(event.target.value);
    render();
  });
  document.getElementById("copySummary").addEventListener("click", () => copyText(snapshot.whatsappSummary, "copyMessage"));
}

function distributionRow(status, count) {
  return `
    <div class="dist-row">
      ${statusIcon(status)}
      <span>${statusLabels[status]}</span>
      <strong>${count}</strong>
    </div>
  `;
}

function averageRow(key, average) {
  return `
    <div>
      <div class="activity-head">
        <strong>${activityMeta[key].label}</strong>
        <strong>${Math.round(average)}%</strong>
      </div>
      <div class="bar"><span style="width:${Math.min(100, average)}%"></span></div>
    </div>
  `;
}

function computeSnapshot(group, weekNumber) {
  const participants = getParticipantsForGroup(group.id);
  const weeklyTotals = participants.map((participant) => {
    const total = getWeeklyTotal(group.id, participant.id, weekNumber);
    updateWeeklyComputedFields(group, total);
    return total;
  });
  const metrics = computeSnapshotMetrics(participants, weeklyTotals, weekNumber);

  return {
    ...metrics,
    whatsappSummary: buildWhatsAppSummary(
      group,
      weekNumber,
      metrics.loggedCount,
      metrics.totalRosterCount,
      metrics.fullBaselineCount,
      metrics.iconDistribution,
      metrics.averages
    ),
  };
}

function buildWhatsAppSummary(group, weekNumber, loggedCount, total, fullBaselineCount, distribution, averages) {
  return `Week ${weekNumber} Trek Prep Snapshot

${loggedCount}/${total} logged some activity this week.
${fullBaselineCount} hit full baseline.

This week's trail:
- Green Rabbit: ${distribution.GREEN_RABBIT}
- Green Tortoise: ${distribution.GREEN_TORTOISE}
- Yellow Rabbit: ${distribution.YELLOW_RABBIT}
- Yellow Tortoise: ${distribution.YELLOW_TORTOISE}
- Grey - showed up below baseline: ${distribution.GREY_CIRCLE}
- Red - no activity logged: ${distribution.RED_CIRCLE}

Group average vs baseline:
- Steps: ${Math.round(averages.steps)}%
- Stairs: ${Math.round(averages.stairs)}%
- Yoga: ${Math.round(averages.yoga)}%
- Pranayama: ${Math.round(averages.pranayama)}%

Good work, buddies. Keep showing up - consistency beats intensity.`;
}

function trailMarkup(group, participantId, currentWeek, interactive = true) {
  return `
    <div class="trail-wrap">
      <div class="trail">
        ${Array.from({ length: 12 }, (_, index) => {
          const week = index + 1;
          const total = getWeeklyTotal(group.id, participantId, week);
          updateWeeklyComputedFields(group, total);
          const isFuture = currentWeek && week > currentWeek;
          const status = isFuture ? null : total.computedStatus;
          return `
            <button class="week-dot ${week === currentWeek ? "is-current" : ""} ${currentWeek && week < currentWeek ? "is-locked" : ""}" type="button" ${interactive ? `data-week="${week}"` : "disabled"}>
              <span class="icon-shell">${status ? statusIcon(status) : `<span class="status-icon placeholder"></span>`}</span>
              <span>W${week}</span>
            </button>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function getParticipantsForGroup(groupId) {
  return sortParticipantsAlphabetically(state.participants.filter((participant) => participant.groupId === groupId));
}

function ensureTotalsForParticipant(group, participantId) {
  for (let week = 1; week <= 12; week += 1) {
    getWeeklyTotal(group.id, participantId, week);
  }
}

function getWeeklyTotal(groupId, participantId, weekNumber) {
  let total = state.totals.find(
    (item) => item.groupId === groupId && item.participantId === participantId && item.weekNumber === weekNumber
  );
  if (!total) {
    const group = state.groups.find((item) => item.id === groupId);
    const range = getWeekRange(group.startDate, weekNumber);
    total = {
      id: makeId("total"),
      groupId,
      participantId,
      weekNumber,
      weekStartDate: range.weekStartDate,
      weekEndDate: range.weekEndDate,
      steps: 0,
      stairs: 0,
      yoga: 0,
      pranayama: 0,
      computedStatus: WEEKLY_STATUSES.RED_CIRCLE,
      locked: false,
      updatedAt: new Date().toISOString(),
    };
    updateWeeklyComputedFields(group, total);
    state.totals.push(total);
  }
  return total;
}

function updateWeeklyComputedFields(group, total) {
  const summary = getWeeklySummary(total, total.weekNumber);
  ACTIVITY_KEYS.forEach((key) => {
    total[`${key}Class`] = summary.classes[key];
  });
  total.computedStatus = summary.status;
  const programStatus = getProgramStatus(group.startDate, effectiveToday(group));
  total.locked = programStatus.state === "completed" || (programStatus.weekNumber && total.weekNumber < programStatus.weekNumber);
  total.updatedAt = new Date().toISOString();
}

function trailSummary(group, participantId, currentWeek) {
  if (!currentWeek) return "The trail is ready. Logging opens on the Monday start date.";
  let completed = 0;
  let green = 0;
  for (let week = 1; week <= currentWeek; week += 1) {
    const total = getWeeklyTotal(group.id, participantId, week);
    if (week < currentWeek) completed += 1;
    if (total.computedStatus === WEEKLY_STATUSES.GREEN_RABBIT || total.computedStatus === WEEKLY_STATUSES.GREEN_TORTOISE) {
      green += 1;
    }
  }
  const currentStatus = statusLabels[getWeeklyTotal(group.id, participantId, currentWeek).computedStatus];
  const completedText = completed > 0 ? `W1-W${completed} complete - ` : "";
  return `${completedText}W${currentWeek} in progress - Current week ${currentStatus} - ${green}/${currentWeek} green so far`;
}

function daysLeftThisWeek(group, weekNumber) {
  const range = getWeekRange(group.startDate, weekNumber);
  const diff = window.TrekLogic.daysBetween(effectiveToday(group), range.weekEndDate);
  return Math.max(0, diff);
}

function clampWeek(week) {
  return Math.max(1, Math.min(12, Number(week) || 1));
}

function bindCopyButtons() {
  app.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => copyText(decodeURIComponent(button.dataset.copy), null, button));
  });
}

async function copyText(text, messageId, button) {
  await navigator.clipboard.writeText(text);
  if (messageId) document.getElementById(messageId).innerHTML = `<div class="notice">Copied for WhatsApp.</div>`;
  if (button) {
    const old = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = old), 1200);
  }
}

function statusIcon(status) {
  const colorMap = {
    GREEN_RABBIT: "#4f8f56",
    GREEN_TORTOISE: "#4f8f56",
    YELLOW_RABBIT: "#e0a458",
    YELLOW_TORTOISE: "#e0a458",
    GREY_CIRCLE: "#9b9a92",
    RED_CIRCLE: "#c95c49",
  };
  const animal = status.includes("RABBIT") ? rabbitPath() : status.includes("TORTOISE") ? tortoisePath() : "";
  return `
    <svg class="status-icon" viewBox="0 0 40 40" role="img" aria-label="${statusLabels[status]}">
      <circle cx="20" cy="20" r="18" fill="${colorMap[status]}" />
      ${animal}
    </svg>
  `;
}

function rabbitPath() {
  return `
    <path d="M16 24c-2.2-.7-3.6-2-3.6-4 0-2.5 2.1-4.3 5.2-4.3h3.1c3.5 0 6.5 2.3 6.5 5.5 0 3.1-2.5 5.2-6.2 5.2h-6.5c-.8 0-1.3-.9-.8-1.6l2.3-.8z" fill="#fff"/>
    <path d="M18 16c-1.4-2.7-1.5-6.3.2-8 .4-.4 1-.2 1.3.3l2.4 7.7M22 16c.2-3 1.6-6.2 3.8-7.2.6-.3 1.2.3 1.1.9l-1.9 7" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    <circle cx="25.3" cy="19.8" r="1.1" fill="#2e3a33"/>
  `;
}

function tortoisePath() {
  return `
    <path d="M11.8 22.5c.6-5 4.4-8.1 9.2-8.1 4.2 0 7.4 2.8 7.9 7.1l2.4.5c.8.2 1.3.9 1.2 1.7-.2.8-.9 1.3-1.7 1.2l-2-.4c-1.2 2.3-3.9 3.6-7.6 3.6h-5.5c-2.8 0-4.4-2.4-3.9-5.6z" fill="#fff"/>
    <path d="M16 26l-1.6 2.7M24.6 26l1.7 2.7M15.5 18.8h10.2M18 15.8l5.1 11" stroke="#2e3a33" stroke-width="1.4" stroke-linecap="round" opacity=".55"/>
    <circle cx="30.3" cy="22.5" r=".9" fill="#2e3a33"/>
  `;
}

function logoMarkup(size = "large") {
  const className = size === "small" ? "logo" : "logo";
  return `
    <svg class="${className}" viewBox="0 0 64 64" aria-label="Trek Prep Challenge logo">
      <circle cx="32" cy="32" r="30" fill="#2e3a33"/>
      <path d="M10 43l15-21 9 13 7-9 13 17H10z" fill="#f5efe4"/>
      <path d="M25 22l4 10 5 3-9-13z" fill="#8fa98c"/>
      <path d="M10 45h44" stroke="#c1623b" stroke-width="4" stroke-linecap="round"/>
    </svg>
  `;
}

function legendMarkup() {
  return `
    ${legendItem("GREEN_RABBIT", "Stretch met in all 4 activities")}
    ${legendItem("GREEN_TORTOISE", "Baseline met in all 4 activities")}
    ${legendItem("YELLOW_RABBIT", "Stretch in at least 1, progress in the rest")}
    ${legendItem("YELLOW_TORTOISE", "Baseline in at least 1, progress in the rest, no stretch")}
    ${legendItem("GREY_CIRCLE", "Below baseline, but something logged")}
    ${legendItem("RED_CIRCLE", "Nothing logged")}
  `;
}

function legendItem(status, description) {
  return `<div class="legend-item">${statusIcon(status)}<div><strong>${statusLabels[status]}</strong><br><span class="subtle">${description}</span></div></div>`;
}

function activityGlyph() {
  return "+";
}

function classLabel(value) {
  return {
    [ACTIVITY_CLASSES.MISSED]: "Missed",
    [ACTIVITY_CLASSES.PARTIAL]: "Partial",
    [ACTIVITY_CLASSES.BASELINE]: "Baseline",
    [ACTIVITY_CLASSES.STRETCH]: "Stretch",
  }[value];
}

function formatDisplayDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
    window.TrekLogic.parseLocalDate(value)
  );
}

function numberFormat(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function boot() {
  renderLoading();
  await initializeStorage();
  render();
}

boot();
