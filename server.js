// NOTE: All timers are timestamp-based and survive server restarts:
// - Break timer: uses breakStartedAt (epoch ms) in state.json
// - 72h interested timer: uses interestedAt (ISO string) in state.json
// - Daily reset: uses lastReset (YYYY-MM-DD) in state.json
// Server can restart at any time without losing timer state.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const LEAD_DOCS_DIR = path.join(__dirname, 'uploads', 'lead_docs');
const AGENT_PHOTOS_DIR = path.join(__dirname, 'uploads', 'agent_photos');

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(LEAD_DOCS_DIR)) fs.mkdirSync(LEAD_DOCS_DIR, { recursive: true });
if (!fs.existsSync(AGENT_PHOTOS_DIR)) fs.mkdirSync(AGENT_PHOTOS_DIR, { recursive: true });

const BREAK_DURATION_MS = 60 * 60 * 1000; // 1 hour
const DOC_DEADLINE_MS = 72 * 60 * 60 * 1000; // 72 hours (changed from 48)

// ─── State Management ─────────────────────────────────────────────────────────
function getTodayStr() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().slice(0, 10);
}

function getTomorrowStr() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  ist.setDate(ist.getDate() + 1);
  return ist.toISOString().slice(0, 10);
}

function loadState() {
  return loadStateWithFallback();
}

function createFreshState(preserveAllowedEids) {
  // CRITICAL: Never hardcode allowedEids — always preserve existing ones (names, photos, roles).
  // If none exist yet, start with an empty object so admin can add them fresh.
  const eids = preserveAllowedEids && typeof preserveAllowedEids === 'object'
    ? preserveAllowedEids
    : {};
  return {
    numbers: [],
    agents: {},
    uploadedFiles: [],
    dialedLog: [],
    lastReset: getTodayStr(),
    allowedEids: eids
  };
}

function saveState(state) {
  // Atomic write: write to .tmp then rename so a power-cut mid-write
  // never leaves a corrupt state.json — rename is atomic on most OS/FS.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function loadStateWithFallback() {
  // Try main file first, then .tmp backup if main is corrupt/missing
  for (const f of [DATA_FILE, DATA_FILE + '.tmp']) {
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    }
  }
  return createFreshState();
}

function checkDailyReset(state) {
  const today = getTodayStr();
  if (state.lastReset !== today) {
    for (const id in state.agents) {
      state.agents[id].totalDialedToday = 0;
      state.agents[id].date = today;
      state.agents[id].active = false;
      state.agents[id].currentIndex = null;
      state.agents[id].onBreak = false;
      state.agents[id].breakStartedAt = null;
      state.agents[id].totalBreakMs = 0;
      state.agents[id].currentNumberId = null;
      state.agents[id].firstLoginToday = null;
      state.agents[id].firstLoginDate  = null;
      state.agents[id].onWashroom = false;
      state.agents[id].washroomStartedAt = null;
      state.agents[id].totalWashroomMs = 0;
      state.agents[id].onMeeting = false;
      state.agents[id].meetingStartedAt = null;
      state.agents[id].totalMeetingMs = 0;
      state.agents[id].onTlMode = false;
      state.agents[id].tlModeStartedAt = null;
      state.agents[id].totalTlModeMs = 0;
    }
    state.numbers.forEach(n => {
      if ((n.disposition === 'not_received' || n.disposition === 'switch_off' || n.disposition === 'dead') && n.retryAfter && today >= n.retryAfter && !n.permanent) {
        const dispoCount = (n.retryCounts && n.retryCounts[n.disposition]) || n.retryCount || 0;
        if (dispoCount < 2) {
          n.disposition = null;
          n.retryAfter = null;
          n.dialedBy = null;
          n.dialedAt = null;
          n.assignedTo = null;
        }
      }
    });
    state.lastReset = today;
    saveState(state);
  }
  return state;
}

let appState = loadState();
// NOTE: We do NOT overwrite allowedEids here anymore.
// If allowedEids is missing entirely (truly fresh install), start empty and let admin add EIDs.
// Previously this block hardcoded names/strings and stomped on saved roles+photos on every deploy.
if (!appState.allowedEids) {
  appState.allowedEids = {};
}
appState = checkDailyReset(appState);

for (const id in appState.agents) {
  const a = appState.agents[id];
  if (a.active && !a.onBreak) {
    a.needsAutoResume = true;
  }
  a.active = false;
}
saveState(appState);

setInterval(() => {
  try { saveState(appState); } catch {}
}, 1000);

// Broadcast admin stats every 5 seconds for live timer feel
setInterval(() => {
  try { broadcastAdminStats(); } catch {}
}, 5000);

// ─── Number helpers ───────────────────────────────────────────────────────────
function getNextNumber(agentId) {
  appState = checkDailyReset(appState);
  const now = new Date();
  const today = getTodayStr();
  const undialed = appState.numbers.find(n => {
    if (n.dialedBy || n.assignedTo) return false;
    if (n.disposition === 'discard') return false;
    if (n.disposition === 'not_interested') return false;
    if (n.permanent) return false;
    if (n.disposition === 'dead') {
      const deadCount = (n.retryCounts && n.retryCounts.dead) || n.retryCount || 0;
      if (deadCount >= 2) return false;
      if (!n.retryAfter) return false;
      if (n.retryAfter && today < n.retryAfter) return false;
    }
    if (n.disposition === 'followup' && n.followupLockedBy && n.followupLockedBy !== agentId) return false;
    if (n.disposition === 'interested') return false;
    if (n.disposition === 'not_received' || n.disposition === 'switch_off') {
      const dispoCount = (n.retryCounts && n.retryCounts[n.disposition]) || n.retryCount || 0;
      if (dispoCount >= 2) return false;
      if (n.retryAfter && today < n.retryAfter) return false;
    }
    return true;
  });
  if (!undialed) return null;
  undialed.assignedTo = agentId;
  saveState(appState);
  return undialed;
}

function markDialed(agentId, numberId) {
  appState = checkDailyReset(appState);
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return;
  const today = getTodayStr();
  num.dialedBy = agentId;
  num.dialedAt = new Date().toISOString();
  num.assignedTo = null;

  const agent = appState.agents[agentId];
  if (agent) {
    agent.totalDialedToday = (agent.totalDialedToday || 0) + 1;
    agent.date = today;
    agent.currentNumberId = null;
  }
  appState.dialedLog.push({
    phone: num.phone, agentId,
    agentName: agent ? agent.name : agentId,
    timestamp: new Date().toISOString()
  });
  saveState(appState);
  broadcastAdminStats();
}

function releaseNumber(agentId, numberId) {
  const num = appState.numbers.find(n => n.id === numberId && n.assignedTo === agentId);
  if (num) { num.assignedTo = null; saveState(appState); }
  const agent = appState.agents[agentId];
  if (agent) agent.currentNumberId = null;
}

// ─── Disposition System ───────────────────────────────────────────────────────
const VALID_DISPOSITIONS = ['dead', 'not_received', 'not_interested', 'followup', 'switch_off', 'interested', 'discard'];
const VALID_LOAN_TYPES = ['BL_Business', 'LAP_Business', 'LAP_Salaried', 'PL_Business', 'PL_Salaried'];

function applyDisposition(agentId, numberId, disposition, extra) {
  appState = checkDailyReset(appState);
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return;
  const agent = appState.agents[agentId];
  const now = new Date().toISOString();

  switch (disposition) {
    case 'dead':
      // CNC - retry counting: first time retryAfter tomorrow, second time permanent
      if (!num.retryCounts) num.retryCounts = {};
      if (!num.retryCounts.dead) num.retryCounts.dead = 0;
      num.retryCounts.dead++;
      if (!num.retryCount) num.retryCount = 0;
      num.retryCount++;
      if (num.retryCounts.dead >= 2) {
        // Permanent removal - never dial again
        num.disposition = 'dead';
        num.permanent = true;
        num.retryAfter = null;
      } else {
        num.disposition = 'dead';
        num.retryAfter = getTomorrowStr();
      }
      num.dialedBy = agentId;
      num.dialedAt = now;
      num.assignedTo = null;
      break;
    case 'not_received':
      // CNR - retry counting: first time retryAfter tomorrow, second time permanent
      if (!num.retryCounts) num.retryCounts = {};
      if (!num.retryCounts.not_received) num.retryCounts.not_received = 0;
      num.retryCounts.not_received++;
      if (!num.retryCount) num.retryCount = 0;
      num.retryCount++;
      if (num.retryCounts.not_received >= 2) {
        // Permanent removal - never dial again
        num.disposition = 'not_received';
        num.permanent = true;
        num.retryAfter = null;
      } else {
        num.disposition = 'not_received';
        num.retryAfter = getTomorrowStr();
      }
      num.dialedBy = agentId;
      num.dialedAt = now;
      num.assignedTo = null;
      break;
    case 'not_interested':
      // Permanent removal - never dial again (no 30-day window)
      num.disposition = 'not_interested';
      num.permanent = true;
      num.blockedUntil = null;
      num.dialedBy = agentId;
      num.dialedAt = now;
      num.assignedTo = null;
      break;
    case 'followup':
      // Track followup count - auto-NI after 2 followups
      if (!num.followupCount) num.followupCount = 0;
      num.followupCount++;
      if (num.followupCount > 2) {
        // Auto-convert to not_interested after 2 followups
        num.disposition = 'not_interested';
        num.permanent = true;
        num.blockedUntil = null;
        num.followupDate = null;
        num.followupTime = null;
        num.followupLockedBy = null;
        num.followupName = null;
      } else {
        num.disposition = 'followup';
        num.followupDate = extra && extra.followupDate ? extra.followupDate : null;
        num.followupTime = extra && extra.followupTime ? extra.followupTime : null;
        num.followupName = extra && extra.followupName ? extra.followupName : '';
        num.followupLockedBy = agentId;
      }
      num.dialedBy = agentId;
      num.dialedAt = now;
      num.assignedTo = null;
      break;
    case 'switch_off':
      // Switch Off - retry counting: first time retryAfter tomorrow, second time permanent
      if (!num.retryCounts) num.retryCounts = {};
      if (!num.retryCounts.switch_off) num.retryCounts.switch_off = 0;
      num.retryCounts.switch_off++;
      if (!num.retryCount) num.retryCount = 0;
      num.retryCount++;
      if (num.retryCounts.switch_off >= 2) {
        // Permanent removal - never dial again
        num.disposition = 'switch_off';
        num.permanent = true;
        num.retryAfter = null;
      } else {
        num.disposition = 'switch_off';
        num.retryAfter = getTomorrowStr();
      }
      num.dialedBy = agentId;
      num.dialedAt = now;
      num.assignedTo = null;
      break;
    case 'interested':
      num.disposition = 'interested';
      num.interestedBy = agentId;
      num.interestedAt = now;
      num.leadName = extra && extra.leadName ? extra.leadName : '';
      num.loanType = extra && extra.loanType && VALID_LOAN_TYPES.includes(extra.loanType) ? extra.loanType : '';
      num.remarks = extra && extra.remarks ? extra.remarks : '';
      num.loanAmount = extra && extra.loanAmount ? extra.loanAmount : '';
      num.employmentType = extra && extra.employmentType ? extra.employmentType : '';
      num.city = extra && extra.city ? extra.city : '';
      num.documentationComplete = false;
      num.documentationCompletedAt = null;
      num.docZipPath = null;
      num.docZipName = null;
      num.dialedBy = agentId;
      num.dialedAt = now;
      num.assignedTo = null;
      break;
    case 'discard':
      // Permanent removal - never ever dial again, dead forever
      num.disposition = 'discard';
      num.permanent = true;
      num.retryAfter = null;
      num.blockedUntil = null;
      num.dialedBy = agentId;
      num.dialedAt = now;
      num.assignedTo = null;
      break;
  }

  if (agent) {
    agent.totalDialedToday = (agent.totalDialedToday || 0) + 1;
    agent.currentNumberId = null;
  }
  appState.dialedLog.push({
    phone: num.phone, agentId,
    agentName: agent ? agent.name : agentId,
    timestamp: now,
    disposition: disposition
  });
  saveState(appState);
  broadcastAdminStats();
}

// ─── Break helpers ────────────────────────────────────────────────────────────
function startBreak(agentId) {
  const agent = appState.agents[agentId];
  if (!agent || agent.onBreak) return { error: 'Already on break or agent not found' };
  agent.onBreak = true;
  agent.breakStartedAt = Date.now();
  if (!agent.totalBreakMs) agent.totalBreakMs = 0;
  saveState(appState);
  broadcastAdminStats();
  return { success: true, breakStartedAt: agent.breakStartedAt };
}

function endBreak(agentId) {
  const agent = appState.agents[agentId];
  if (!agent || !agent.onBreak) return { error: 'Not on break' };
  const elapsed = Date.now() - (agent.breakStartedAt || Date.now());
  agent.totalBreakMs = (agent.totalBreakMs || 0) + elapsed;
  agent.onBreak = false;
  agent.breakStartedAt = null;
  saveState(appState);
  broadcastAdminStats();
  return { success: true, totalBreakMs: agent.totalBreakMs };
}

function getBreakMsRemaining(agent) {
  if (!agent.onBreak) return BREAK_DURATION_MS - (agent.totalBreakMs || 0);
  const elapsed = Date.now() - (agent.breakStartedAt || Date.now());
  return BREAK_DURATION_MS - ((agent.totalBreakMs || 0) + elapsed);
}

// ─── Washroom helpers ─────────────────────────────────────────────────────────
function startWashroom(agentId) {
  const agent = appState.agents[agentId];
  if (!agent) return { error: 'Agent not found' };
  if (agent.onWashroom) return { error: 'Already in washroom' };
  if (agent.onBreak) return { error: 'Cannot use washroom while on break' };
  if (agent.onMeeting) return { error: 'Cannot use washroom while in meeting' };
  agent.onWashroom = true;
  agent.washroomStartedAt = Date.now();
  if (!agent.totalWashroomMs) agent.totalWashroomMs = 0;
  saveState(appState);
  broadcastAdminStats();
  return { success: true, washroomStartedAt: agent.washroomStartedAt };
}

function endWashroom(agentId) {
  const agent = appState.agents[agentId];
  if (!agent || !agent.onWashroom) return { error: 'Not in washroom' };
  const elapsed = Date.now() - (agent.washroomStartedAt || Date.now());
  agent.totalWashroomMs = (agent.totalWashroomMs || 0) + elapsed;
  agent.onWashroom = false;
  agent.washroomStartedAt = null;
  saveState(appState);
  broadcastAdminStats();
  return { success: true, totalWashroomMs: agent.totalWashroomMs };
}

// ─── Meeting helpers ──────────────────────────────────────────────────────────
function startMeeting(agentId) {
  const agent = appState.agents[agentId];
  if (!agent) return { error: 'Agent not found' };
  if (agent.onMeeting) return { error: 'Already in meeting' };
  if (agent.onBreak) return { error: 'Cannot start meeting while on break' };
  if (agent.onWashroom) return { error: 'Cannot start meeting while in washroom' };
  agent.onMeeting = true;
  agent.meetingStartedAt = Date.now();
  if (!agent.totalMeetingMs) agent.totalMeetingMs = 0;
  saveState(appState);
  broadcastAdminStats();
  return { success: true, meetingStartedAt: agent.meetingStartedAt };
}

function endMeeting(agentId) {
  const agent = appState.agents[agentId];
  if (!agent || !agent.onMeeting) return { error: 'Not in meeting' };
  const elapsed = Date.now() - (agent.meetingStartedAt || Date.now());
  agent.totalMeetingMs = (agent.totalMeetingMs || 0) + elapsed;
  agent.onMeeting = false;
  agent.meetingStartedAt = null;
  saveState(appState);
  broadcastAdminStats();
  return { success: true, totalMeetingMs: agent.totalMeetingMs };
}

// ─── TL Mode helpers ──────────────────────────────────────────────────────────
function startTlMode(agentId) {
  const agent = appState.agents[agentId];
  if (!agent) return { error: 'Agent not found' };
  if (agent.onTlMode) return { error: 'Already in TL mode' };
  agent.onTlMode = true;
  agent.tlModeStartedAt = Date.now();
  if (!agent.totalTlModeMs) agent.totalTlModeMs = 0;
  saveState(appState);
  broadcastAdminStats();
  return { success: true, tlModeStartedAt: agent.tlModeStartedAt };
}

function endTlMode(agentId) {
  const agent = appState.agents[agentId];
  if (!agent || !agent.onTlMode) return { error: 'Not in TL mode' };
  const elapsed = Date.now() - (agent.tlModeStartedAt || Date.now());
  agent.totalTlModeMs = (agent.totalTlModeMs || 0) + elapsed;
  agent.onTlMode = false;
  agent.tlModeStartedAt = null;
  saveState(appState);
  broadcastAdminStats();
  return { success: true, totalTlModeMs: agent.totalTlModeMs };
}

// ─── Admin broadcast ──────────────────────────────────────────────────────────
function broadcastAdminStats() {
  const stats = getAdminStats();
  io.to('admin-room').emit('stats-update', stats);
}

function getAdminStats() {
  appState = checkDailyReset(appState);
  const total = appState.numbers.length;
  const dialed = appState.numbers.filter(n => n.dialedBy).length;
  const assigned = appState.numbers.filter(n => n.assignedTo && !n.dialedBy).length;
  const remaining = total - dialed - assigned;

  const agentStats = Object.entries(appState.agents).map(([id, a]) => {
    const liveBreakMs = a.onBreak ? (Date.now() - (a.breakStartedAt || Date.now())) : 0;
    const totalBreakMs = (a.totalBreakMs || 0) + liveBreakMs;
    const breakRemaining = Math.max(0, BREAK_DURATION_MS - totalBreakMs);

    const liveWashroomMs = a.onWashroom ? (Date.now() - (a.washroomStartedAt || Date.now())) : 0;
    const totalWashroomMs = (a.totalWashroomMs || 0) + liveWashroomMs;

    const liveMeetingMs = a.onMeeting ? (Date.now() - (a.meetingStartedAt || Date.now())) : 0;
    const totalMeetingMs = (a.totalMeetingMs || 0) + liveMeetingMs;

    const liveTlModeMs = a.onTlMode ? (Date.now() - (a.tlModeStartedAt || Date.now())) : 0;
    const totalTlModeMs = (a.totalTlModeMs || 0) + liveTlModeMs;

    const firstLogin = a.firstLoginToday || null;
    const lateLogin  = firstLogin ? (firstLogin > '10:00') : false;

    return {
      id, name: a.name, active: a.active,
      totalDialedToday: a.totalDialedToday || 0,
      date: a.date,
      onBreak: a.onBreak || false,
      totalBreakMs,
      breakRemaining,
      breakAllowedMs: BREAK_DURATION_MS,
      onWashroom: a.onWashroom || false,
      washroomStartedAt: a.washroomStartedAt || null,
      totalWashroomMs,
      onMeeting: a.onMeeting || false,
      meetingStartedAt: a.meetingStartedAt || null,
      totalMeetingMs,
      onTlMode: a.onTlMode || false,
      tlModeStartedAt: a.tlModeStartedAt || null,
      totalTlModeMs,
      firstLoginToday: firstLogin,
      lateLogin
    };
  });

  const fileStats = appState.uploadedFiles.map(f => {
    const fileNums = appState.numbers.filter(n => n.file === f.id);
    return {
      ...f,
      total: fileNums.length,
      dialed: fileNums.filter(n => n.dialedBy).length,
      remaining: fileNums.filter(n => !n.dialedBy).length
    };
  });

  return {
    total, dialed, assigned, remaining, agentStats, fileStats,
    today: getTodayStr(),
    interestedCount: appState.numbers.filter(n => n.disposition === 'interested').length,
    followupCount: appState.numbers.filter(n => n.disposition === 'followup').length,
    discardCount: appState.numbers.filter(n => n.disposition === 'discard').length,
    notInterestedCount: appState.numbers.filter(n => n.disposition === 'not_interested').length,
    comingBackTomorrow: appState.numbers.filter(n => (n.disposition === 'not_received' || n.disposition === 'switch_off' || n.disposition === 'dead') && n.retryAfter && !n.permanent && (n.retryCount || 0) < 2 && getTodayStr() < n.retryAfter).length,
    overdueInterestedCount: appState.numbers.filter(n => n.disposition === 'interested' && !n.documentationComplete && (Date.now() - new Date(n.interestedAt).getTime()) >= DOC_DEADLINE_MS).length
  };
}

// ─── Express Setup ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer for number file uploads
const numberUpload = multer({ dest: UPLOADS_DIR });

// Multer for lead document ZIP uploads — store with original name under lead_docs
const docStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LEAD_DOCS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.zip';
    cb(null, uuidv4() + ext);
  }
});
const docUpload = multer({
  storage: docStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.toLowerCase().endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  }
});

// Multer for agent photo uploads
const agentPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AGENT_PHOTOS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, (req.params.eid || 'photo') + '_' + Date.now() + ext);
  }
});
const agentPhotoUpload = multer({
  storage: agentPhotoStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

app.post('/api/admin/upload', numberUpload.single('file'), (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const fileId = uuidv4();
    const phones = [];
    const existingPhones = new Set(appState.numbers.map(n => n.phone));
    let skipped = 0;
    rows.forEach((row, i) => {
      if (i === 0 && isNaN(row[0])) return;
      const phone = String(row[0] || '').trim().replace(/\s+/g, '');
      if (!phone || phone.length < 7) return;
      if (existingPhones.has(phone)) { skipped++; return; }
      existingPhones.add(phone);
      const name = row[1] ? String(row[1]).trim() : '';
      phones.push({ id: uuidv4(), phone, name, file: fileId, assignedTo: null, dialedBy: null, dialedAt: null });
    });
    appState.numbers.push(...phones);
    appState.uploadedFiles.push({ id: fileId, name: req.file.originalname, uploadedAt: new Date().toISOString(), total: phones.length });
    saveState(appState);
    fs.unlinkSync(req.file.path);
    broadcastAdminStats();
    res.json({ success: true, count: phones.length, skipped, fileId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Lead Document ZIP Upload (Agent) ─────────────────────────────────────────
app.post('/api/agent/upload-doc-zip/:numberId', docUpload.single('docZip'), (req, res) => {
  try {
    const { numberId } = req.params;
    const { agentId } = req.body;
    if (!agentId || !numberId) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'agentId and numberId are required' });
    }
    const num = appState.numbers.find(n => n.id === numberId);
    if (!num) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Lead not found' });
    }
    if (num.disposition !== 'interested') {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Lead is not marked as interested' });
    }
    if (num.interestedBy !== agentId) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'This lead is not assigned to you' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No ZIP file uploaded' });
    }

    // Delete old zip if exists
    if (num.docZipPath && fs.existsSync(num.docZipPath)) {
      try { fs.unlinkSync(num.docZipPath); } catch {}
    }

    // Mark documentation complete now that ZIP is uploaded
    num.docZipPath = req.file.path;
    num.docZipName = req.file.originalname || 'documents.zip';
    num.docZipUploadedAt = new Date().toISOString();
    num.documentationComplete = true;
    num.documentationCompletedAt = new Date().toISOString();

    saveState(appState);
    broadcastAdminStats();
    res.json({ success: true, docZipName: num.docZipName, documentationCompletedAt: num.documentationCompletedAt });
  } catch (e) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: Download lead doc ZIP ─────────────────────────────────────────────
app.get('/api/admin/download-doc-zip/:numberId', (req, res) => {
  const { numberId } = req.params;
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return res.status(404).json({ error: 'Lead not found' });
  if (!num.docZipPath || !fs.existsSync(num.docZipPath)) {
    return res.status(404).json({ error: 'No document ZIP found for this lead' });
  }
  const downloadName = num.docZipName || 'documents.zip';
  res.download(num.docZipPath, downloadName);
});

app.get('/api/admin/stats', (req, res) => res.json(getAdminStats()));

// ─── Disposition API Endpoints ────────────────────────────────────────────────
app.post('/api/agent/disposition', (req, res) => {
  const { agentId, numberId, disposition, followupDate, followupTime, followupName, leadName, loanType, remarks, loanAmount, employmentType, city } = req.body;
  if (!agentId || !numberId || !disposition) {
    return res.status(400).json({ error: 'agentId, numberId, and disposition are required' });
  }
  if (!VALID_DISPOSITIONS.includes(disposition)) {
    return res.status(400).json({ error: 'Invalid disposition. Must be one of: ' + VALID_DISPOSITIONS.join(', ') });
  }
  applyDisposition(agentId, numberId, disposition, { followupDate, followupTime, followupName, leadName, loanType, remarks, loanAmount, employmentType, city });
  const nextNum = getNextNumber(agentId);
  const agent = appState.agents[agentId];
  if (nextNum && agent) {
    agent.currentNumberId = nextNum.id;
    saveState(appState);
  }
  res.json({ success: true, nextNumber: nextNum ? { numberId: nextNum.id, phone: nextNum.phone, name: nextNum.name || '' } : null });
});

app.get('/api/admin/interested', (req, res) => {
  const now = Date.now();
  const interested = appState.numbers.filter(n => n.disposition === 'interested' && !n.documentationComplete).map(n => {
    const agent = appState.agents[n.interestedBy];
    const elapsedMs = now - new Date(n.interestedAt).getTime();
    const hoursElapsed = elapsedMs / (1000 * 60 * 60);
    const hoursRemaining = Math.max(0, 72 - hoursElapsed);
    const overdue = hoursRemaining <= 0;
    return {
      id: n.id, phone: n.phone, name: n.leadName || n.name || '',
      loanType: n.loanType || '',
      remarks: n.remarks || '',
      loanAmount: n.loanAmount || '',
      employmentType: n.employmentType || '',
      city: n.city || '',
      interestedBy: agent ? agent.name : n.interestedBy,
      interestedByAgentId: n.interestedBy,
      interestedAt: n.interestedAt,
      documentationComplete: n.documentationComplete || false,
      documentationCompletedAt: n.documentationCompletedAt || null,
      hoursRemaining: Math.round(hoursRemaining * 100) / 100,
      overdue
    };
  });
  res.json(interested);
});

app.get('/api/admin/followups', (req, res) => {
  const followups = appState.numbers.filter(n => n.disposition === 'followup').map(n => {
    const agent = appState.agents[n.followupLockedBy];
    return {
      id: n.id, phone: n.phone, name: n.name || '',
      followupLockedBy: agent ? agent.name : n.followupLockedBy,
      followupLockedByAgentId: n.followupLockedBy,
      followupDate: n.followupDate,
      followupTime: n.followupTime,
      followupName: n.followupName || '',
      followupCount: n.followupCount || 0
    };
  });
  // Sort by nearest date and time
  followups.sort((a, b) => {
    const dateA = (a.followupDate || '9999-12-31') + ' ' + (a.followupTime || '23:59');
    const dateB = (b.followupDate || '9999-12-31') + ' ' + (b.followupTime || '23:59');
    return dateA.localeCompare(dateB);
  });
  res.json(followups);
});

app.get('/api/agent/interested/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  const now = Date.now();
  const interested = appState.numbers.filter(n => n.disposition === 'interested' && n.interestedBy === agentId && !n.documentationComplete).map(n => {
    const elapsedMs = now - new Date(n.interestedAt).getTime();
    const hoursElapsed = elapsedMs / (1000 * 60 * 60);
    const hoursRemaining = Math.max(0, 72 - hoursElapsed);
    return {
      id: n.id, phone: n.phone, name: n.leadName || n.name || '',
      loanType: n.loanType || '',
      remarks: n.remarks || '',
      loanAmount: n.loanAmount || '',
      employmentType: n.employmentType || '',
      city: n.city || '',
      interestedAt: n.interestedAt,
      documentationComplete: n.documentationComplete || false,
      documentationCompletedAt: n.documentationCompletedAt || null,
      hoursRemaining: Math.round(hoursRemaining * 100) / 100
    };
  });
  res.json(interested);
});

app.get('/api/agent/followups/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  const followups = appState.numbers.filter(n => n.disposition === 'followup' && n.followupLockedBy === agentId).map(n => ({
    id: n.id, phone: n.phone, name: n.name || '',
    followupDate: n.followupDate,
    followupTime: n.followupTime,
    followupName: n.followupName || '',
    followupCount: n.followupCount || 0
  }));
  // Sort by nearest date and time
  followups.sort((a, b) => {
    const dateA = (a.followupDate || '9999-12-31') + ' ' + (a.followupTime || '23:59');
    const dateB = (b.followupDate || '9999-12-31') + ' ' + (b.followupTime || '23:59');
    return dateA.localeCompare(dateB);
  });
  res.json(followups);
});

// Agent marks documentation complete (ONLY after uploading ZIP via upload endpoint above)
app.post('/api/agent/mark-documentation-complete', (req, res) => {
  const { agentId, numberId } = req.body;
  if (!agentId || !numberId) {
    return res.status(400).json({ error: 'agentId and numberId are required' });
  }
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return res.status(404).json({ error: 'Number not found' });
  if (num.disposition !== 'interested') return res.status(400).json({ error: 'Number is not marked as interested' });
  if (num.interestedBy !== agentId) return res.status(403).json({ error: 'This lead is not assigned to you' });
  if (!num.docZipPath) return res.status(400).json({ error: 'Please upload the document ZIP first' });
  num.documentationComplete = true;
  num.documentationCompletedAt = new Date().toISOString();
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true, numberId, documentationComplete: true, documentationCompletedAt: num.documentationCompletedAt });
});

app.post('/api/admin/transfer-interested', (req, res) => {
  const { numberId, newAgentId } = req.body;
  if (!numberId || !newAgentId) {
    return res.status(400).json({ error: 'numberId and newAgentId are required' });
  }
  if (!appState.agents[newAgentId]) {
    const eidMatch = newAgentId.match(/^emp_(\d+)$/);
    if (!eidMatch || !appState.allowedEids[eidMatch[1]]) {
      return res.status(404).json({ error: 'Target agent not found' });
    }
    const eid = eidMatch[1];
    appState.agents[newAgentId] = {
      name: getEidName(appState.allowedEids[eid]),
      employeeId: eid,
      active: false,
      totalDialedToday: 0,
      date: getTodayStr(),
      currentIndex: null,
      onBreak: false,
      breakStartedAt: null,
      totalBreakMs: 0,
      currentNumberId: null,
      firstLoginToday: null,
      firstLoginDate: null
    };
  }
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return res.status(404).json({ error: 'Number not found' });
  if (num.disposition !== 'interested') return res.status(400).json({ error: 'Number is not marked as interested' });
  num.interestedBy = newAgentId;
  num.interestedAt = new Date().toISOString();
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true, numberId, newAgentId, interestedAt: num.interestedAt });
});

app.post('/api/agent/add-interested', (req, res) => {
  const { agentId, phone, leadName, loanType, remarks, loanAmount, employmentType, city } = req.body;
  if (!agentId || !phone) {
    return res.status(400).json({ error: 'agentId and phone are required' });
  }
  if (!appState.agents[agentId]) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  if (loanType && !VALID_LOAN_TYPES.includes(loanType)) {
    return res.status(400).json({ error: 'Invalid loan type' });
  }
  const existingNumber = appState.numbers.find(n => n.phone === phone);
  if (existingNumber) {
    return res.status(409).json({ error: 'This phone number already exists in the system' });
  }
  const now = new Date().toISOString();
  const newEntry = {
    id: uuidv4(),
    phone,
    name: leadName || '',
    file: null,
    assignedTo: null,
    dialedBy: agentId,
    dialedAt: now,
    disposition: 'interested',
    interestedBy: agentId,
    interestedAt: now,
    leadName: leadName || '',
    loanType: loanType || '',
    remarks: remarks || '',
    loanAmount: loanAmount || '',
    employmentType: employmentType || '',
    city: city || '',
    documentationComplete: false,
    documentationCompletedAt: null,
    docZipPath: null,
    docZipName: null
  };
  appState.numbers.push(newEntry);
  appState.dialedLog.push({
    phone, agentId,
    agentName: appState.agents[agentId] ? appState.agents[agentId].name : agentId,
    timestamp: now,
    disposition: 'interested'
  });
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true, entry: newEntry });
});

app.get('/api/admin/agents-list', (req, res) => {
  const agentMap = {};
  for (const [id, a] of Object.entries(appState.agents)) {
    agentMap[id] = { id, name: a.name };
  }
  for (const [eid, val] of Object.entries(appState.allowedEids)) {
    const virtualId = 'emp_' + eid;
    if (!agentMap[virtualId]) {
      agentMap[virtualId] = { id: virtualId, name: getEidName(val) };
    }
  }
  res.json(Object.values(agentMap));
});

app.post('/api/agent/remove-interested', (req, res) => {
  const { agentId, numberId } = req.body;
  if (!agentId || !numberId) {
    return res.status(400).json({ error: 'agentId and numberId are required' });
  }
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return res.status(404).json({ error: 'Number not found' });
  if (num.disposition !== 'interested') return res.status(400).json({ error: 'Number is not marked as interested' });
  if (num.interestedBy !== agentId) return res.status(403).json({ error: 'This lead is not assigned to you' });
  num.disposition = 'dead';
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true });
});

app.post('/api/admin/remove-interested', (req, res) => {
  const { numberId } = req.body;
  if (!numberId) {
    return res.status(400).json({ error: 'numberId is required' });
  }
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return res.status(404).json({ error: 'Number not found' });
  num.disposition = 'dead';
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true });
});

app.post('/api/admin/update-interested', (req, res) => {
  const { numberId, loanType, remarks, loanAmount, status, employmentType, city } = req.body;
  if (!numberId) {
    return res.status(400).json({ error: 'numberId is required' });
  }
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return res.status(404).json({ error: 'Number not found' });
  if (loanType !== undefined) {
    if (loanType && !VALID_LOAN_TYPES.includes(loanType)) {
      return res.status(400).json({ error: 'Invalid loan type' });
    }
    num.loanType = loanType;
  }
  if (remarks !== undefined) num.remarks = remarks;
  if (loanAmount !== undefined) num.loanAmount = loanAmount;
  if (status !== undefined) num.adminStatus = status;
  if (employmentType !== undefined) num.employmentType = employmentType;
  if (city !== undefined) num.city = city;
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true });
});

app.post('/api/admin/update-lead-status', (req, res) => {
  const { numberId, adminStatus } = req.body;
  if (!numberId || !adminStatus) {
    return res.status(400).json({ error: 'numberId and adminStatus are required' });
  }
  const validStatuses = ['Completed', 'In Process', 'Rejected', 'Approved', 'On Hold'];
  if (!validStatuses.includes(adminStatus)) {
    return res.status(400).json({ error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') });
  }
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return res.status(404).json({ error: 'Number not found' });
  num.adminStatus = adminStatus;
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true });
});

app.get('/api/admin/completed', (req, res) => {
  const completed = appState.numbers.filter(n => n.disposition === 'interested' && n.documentationComplete).map(n => {
    const agent = appState.agents[n.interestedBy];
    return {
      id: n.id, phone: n.phone, name: n.leadName || n.name || '',
      loanType: n.loanType || '',
      remarks: n.remarks || '',
      loanAmount: n.loanAmount || '',
      employmentType: n.employmentType || '',
      city: n.city || '',
      interestedBy: agent ? agent.name : n.interestedBy,
      interestedByAgentId: n.interestedBy,
      documentationCompletedAt: n.documentationCompletedAt || null,
      adminStatus: n.adminStatus || '',
      hasDocZip: !!(n.docZipPath && fs.existsSync(n.docZipPath)),
      docZipName: n.docZipName || null
    };
  });
  res.json(completed);
});

app.get('/api/agent/completed/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  const completed = appState.numbers.filter(n => n.disposition === 'interested' && n.documentationComplete && n.interestedBy === agentId).map(n => ({
    id: n.id, phone: n.phone, name: n.leadName || n.name || '',
    loanType: n.loanType || '',
    remarks: n.remarks || '',
    loanAmount: n.loanAmount || '',
    employmentType: n.employmentType || '',
    city: n.city || '',
    documentationCompletedAt: n.documentationCompletedAt || null,
    adminStatus: n.adminStatus || '',
    hasDocZip: !!(n.docZipPath && fs.existsSync(n.docZipPath)),
    docZipName: n.docZipName || null
  }));
  res.json(completed);
});

app.delete('/api/admin/file/:fileId', (req, res) => {
  const fid = req.params.fileId;
  // SAFE DELETE: never remove interested leads when deleting a file batch —
  // they are real business data (pending docs or docs already uploaded).
  // Only wipe undisposed / non-converting numbers from that batch.
  const protectedCount = appState.numbers.filter(
    n => n.file === fid && n.disposition === 'interested'
  ).length;
  appState.numbers = appState.numbers.filter(
    n => n.file !== fid || n.disposition === 'interested'
  );
  appState.uploadedFiles = appState.uploadedFiles.filter(f => f.id !== fid);
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true, protected_interested: protectedCount });
});

app.post('/api/admin/reset-today', (req, res) => {
  for (const id in appState.agents) {
    appState.agents[id].totalDialedToday = 0;
    appState.agents[id].active = false;
    appState.agents[id].currentIndex = null;
    appState.agents[id].onBreak = false;
    appState.agents[id].breakStartedAt = null;
    appState.agents[id].totalBreakMs = 0;
    appState.agents[id].currentNumberId = null;
    appState.agents[id].firstLoginToday = null;
    appState.agents[id].firstLoginDate  = null;
    appState.agents[id].onWashroom = false;
    appState.agents[id].washroomStartedAt = null;
    appState.agents[id].totalWashroomMs = 0;
    appState.agents[id].onMeeting = false;
    appState.agents[id].meetingStartedAt = null;
    appState.agents[id].totalMeetingMs = 0;
    appState.agents[id].onTlMode = false;
    appState.agents[id].tlModeStartedAt = null;
    appState.agents[id].totalTlModeMs = 0;
  }
  appState.lastReset = getTodayStr();
  saveState(appState);
  broadcastAdminStats();
  io.emit('force-stop');
  res.json({ success: true });
});

app.post('/api/admin/clear-all', (req, res) => {
  // SAFE CLEAR: keep all interested leads (pending + documented) — they are permanent business data.
  // Only wipe undisposed numbers, file registry, and dialed log.
  appState.numbers = appState.numbers.filter(n => n.disposition === 'interested');
  appState.uploadedFiles = [];
  appState.dialedLog = [];
  for (const id in appState.agents) {
    appState.agents[id].totalDialedToday = 0;
    appState.agents[id].active = false;
    appState.agents[id].onBreak = false;
    appState.agents[id].breakStartedAt = null;
    appState.agents[id].totalBreakMs = 0;
    appState.agents[id].currentNumberId = null;
    appState.agents[id].onWashroom = false;
    appState.agents[id].washroomStartedAt = null;
    appState.agents[id].totalWashroomMs = 0;
    appState.agents[id].onMeeting = false;
    appState.agents[id].meetingStartedAt = null;
    appState.agents[id].totalMeetingMs = 0;
  }
  saveState(appState);
  broadcastAdminStats();
  io.emit('force-stop');
  res.json({ success: true });
});

app.post('/api/admin/hard-reset', (req, res) => {
  // Preserve allowedEids (names, photos, TL roles) — always kept.
  // Preserve ALL interested leads (both pending-doc and documented) — permanent business data.
  // Wipe: undisposed numbers, uploadedFiles list, dialedLog, agent daily stats.
  // Agent photos are also preserved (they belong to allowedEids, not to a session).
  const savedEids = appState.allowedEids || {};
  const savedInterested = appState.numbers.filter(n => n.disposition === 'interested');
  appState = createFreshState(savedEids);
  appState.numbers = savedInterested; // restore interested leads
  // Only delete lead doc ZIPs for leads that no longer exist (orphaned files)
  // We do NOT delete agent photos — those belong to the employee records
  const keptDocPaths = new Set(savedInterested.map(n => n.docZipPath).filter(Boolean));
  try {
    const leadFiles = fs.readdirSync(LEAD_DOCS_DIR);
    leadFiles.forEach(f => {
      if (f === '.gitkeep') return;
      const fullPath = path.join(LEAD_DOCS_DIR, f);
      if (!keptDocPaths.has(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch {}
      }
    });
  } catch {}
  saveState(appState);
  io.emit('force-stop');
  broadcastAdminStats();
  res.json({ success: true, preserved_interested: savedInterested.length });
});

app.post('/api/agent/register', (req, res) => {
  const { name, employeeId } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (!employeeId || !/^\d+$/.test(employeeId)) return res.status(400).json({ error: 'Valid numeric Employee ID required' });

  if (!appState.allowedEids[employeeId]) {
    return res.status(403).json({ error: 'Employee ID not recognised. Please contact your admin.' });
  }
  appState = checkDailyReset(appState);
  const agentId = 'emp_' + employeeId;
  const today   = getTodayStr();

  function getISTTimeStr() {
    const now = new Date();
    const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    return ist.toISOString().slice(11, 16);
  }

  if (!appState.agents[agentId]) {
    appState.agents[agentId] = {
      name, employeeId, active: false,
      totalDialedToday: 0, date: today,
      currentIndex: null, onBreak: false,
      breakStartedAt: null, totalBreakMs: 0,
      currentNumberId: null,
      firstLoginToday: getISTTimeStr(),
      firstLoginDate:  today
    };
  } else {
    appState.agents[agentId].name   = name;
    appState.agents[agentId].active = false;
    if (appState.agents[agentId].firstLoginDate !== today) {
      appState.agents[agentId].firstLoginToday = getISTTimeStr();
      appState.agents[agentId].firstLoginDate  = today;
    }
  }
  saveState(appState);
  broadcastAdminStats();

  const agent = appState.agents[agentId];
  let resumeNumber = null;
  if (agent.currentNumberId) {
    const num = appState.numbers.find(n => n.id === agent.currentNumberId);
    if (num && num.assignedTo === agentId && !num.dialedBy) {
      resumeNumber = { numberId: num.id, phone: num.phone, name: num.name || '' };
    }
  }

  const needsAutoResume = agent.needsAutoResume || false;
  if (agent.needsAutoResume) { delete agent.needsAutoResume; saveState(appState); }

  res.json({
    agentId, name, employeeId,
    resumeNumber,
    needsAutoResume,
    totalDialedToday: agent.totalDialedToday || 0,
    onBreak: agent.onBreak || false,
    breakStartedAt: agent.breakStartedAt || null,
    totalBreakMs: agent.totalBreakMs || 0,
    breakAllowedMs: BREAK_DURATION_MS,
    onWashroom: agent.onWashroom || false,
    washroomStartedAt: agent.washroomStartedAt || null,
    totalWashroomMs: agent.totalWashroomMs || 0,
    onMeeting: agent.onMeeting || false,
    meetingStartedAt: agent.meetingStartedAt || null,
    totalMeetingMs: agent.totalMeetingMs || 0,
    onTlMode: agent.onTlMode || false,
    tlModeStartedAt: agent.tlModeStartedAt || null,
    totalTlModeMs: agent.totalTlModeMs || 0
  });
});

// Break / washroom / meeting endpoints
app.post('/api/agent/break/start',    (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(startBreak(agentId)); });
app.post('/api/agent/break/end',      (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(endBreak(agentId)); });
app.post('/api/agent/washroom/start', (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(startWashroom(agentId)); });
app.post('/api/agent/washroom/end',   (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(endWashroom(agentId)); });
app.post('/api/agent/meeting/start',  (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(startMeeting(agentId)); });
app.post('/api/agent/meeting/end',    (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(endMeeting(agentId)); });

app.get('/api/agent/state/:agentId', (req, res) => {
  const agent = appState.agents[req.params.agentId];
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  let resumeNumber = null;
  if (agent.currentNumberId) {
    const num = appState.numbers.find(n => n.id === agent.currentNumberId);
    if (num && num.assignedTo === req.params.agentId && !num.dialedBy) {
      resumeNumber = { numberId: num.id, phone: num.phone, name: num.name || '' };
    }
  }
  const needsAutoResume = agent.needsAutoResume || false;
  if (agent.needsAutoResume) { delete agent.needsAutoResume; saveState(appState); }
  res.json({
    resumeNumber, needsAutoResume,
    totalDialedToday: agent.totalDialedToday || 0,
    onBreak: agent.onBreak || false,
    breakStartedAt: agent.breakStartedAt || null,
    totalBreakMs: agent.totalBreakMs || 0,
    breakAllowedMs: BREAK_DURATION_MS,
    onWashroom: agent.onWashroom || false,
    washroomStartedAt: agent.washroomStartedAt || null,
    totalWashroomMs: agent.totalWashroomMs || 0,
    onMeeting: agent.onMeeting || false,
    meetingStartedAt: agent.meetingStartedAt || null,
    totalMeetingMs: agent.totalMeetingMs || 0,
    onTlMode: agent.onTlMode || false,
    tlModeStartedAt: agent.tlModeStartedAt || null,
    totalTlModeMs: agent.totalTlModeMs || 0
  });
});

// ─── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let socketAgentId = null;
  let socketCurrentNumber = null;

  socket.on('join-admin', () => {
    socket.join('admin-room');
    socket.emit('stats-update', getAdminStats());
  });

  socket.on('disconnect', () => {
    if (socketAgentId) {
      const agent = appState.agents[socketAgentId];
      if (agent) { agent.active = false; saveState(appState); }
      broadcastAdminStats();
    }
  });

  socket.on('agent-start', ({ agentId }) => {
    socketAgentId = agentId;
    appState = checkDailyReset(appState);
    const agent = appState.agents[agentId];
    if (!agent) return socket.emit('error', 'Agent not found');
    agent.active = true;
    saveState(appState);
    broadcastAdminStats();

    if (agent.currentNumberId) {
      const num = appState.numbers.find(n => n.id === agent.currentNumberId);
      if (num && num.assignedTo === agentId && !num.dialedBy) {
        socketCurrentNumber = num.id;
        return socket.emit('show-number', {
          numberId: num.id, phone: num.phone, name: num.name || '',
          totalDialedToday: agent.totalDialedToday || 0,
          resumed: true
        });
      }
    }

    const num = getNextNumber(agentId);
    if (!num) {
      socket.emit('no-numbers');
    } else {
      socketCurrentNumber = num.id;
      agent.currentNumberId = num.id;
      saveState(appState);
      socket.emit('show-number', {
        numberId: num.id, phone: num.phone, name: num.name || '',
        totalDialedToday: agent.totalDialedToday || 0
      });
    }
  });

  socket.on('agent-next', ({ agentId, prevNumberId }) => {
    appState = checkDailyReset(appState);
    const agent = appState.agents[agentId];
    if (!agent) return socket.emit('error', 'Agent not found');

    if (prevNumberId) markDialed(agentId, prevNumberId);

    const num = getNextNumber(agentId);
    if (!num) {
      socketCurrentNumber = null;
      if (agent) agent.currentNumberId = null;
      saveState(appState);
      socket.emit('no-numbers', { totalDialedToday: agent.totalDialedToday || 0 });
    } else {
      socketCurrentNumber = num.id;
      agent.currentNumberId = num.id;
      saveState(appState);
      socket.emit('show-number', {
        numberId: num.id, phone: num.phone, name: num.name || '',
        totalDialedToday: agent.totalDialedToday || 0
      });
    }
    broadcastAdminStats();
  });

  socket.on('agent-stop', ({ agentId, currentNumberId }) => {
    const agent = appState.agents[agentId];
    if (agent) {
      agent.active = false;
      agent.currentNumberId = null;
    }
    if (currentNumberId) releaseNumber(agentId, currentNumberId);
    saveState(appState);
    broadcastAdminStats();
  });

  socket.on('agent-disposition', ({ agentId, numberId, disposition, followupDate, followupTime, followupName, leadName, loanType, remarks, loanAmount, employmentType, city }) => {
    appState = checkDailyReset(appState);
    const agent = appState.agents[agentId];
    if (!agent) return socket.emit('error', 'Agent not found');
    if (!VALID_DISPOSITIONS.includes(disposition)) return socket.emit('error', 'Invalid disposition');

    applyDisposition(agentId, numberId, disposition, { followupDate, followupTime, followupName, leadName, loanType, remarks, loanAmount, employmentType, city });

    const num = getNextNumber(agentId);
    if (!num) {
      socketCurrentNumber = null;
      if (agent) agent.currentNumberId = null;
      saveState(appState);
      socket.emit('no-numbers', { totalDialedToday: agent.totalDialedToday || 0 });
    } else {
      socketCurrentNumber = num.id;
      agent.currentNumberId = num.id;
      saveState(appState);
      socket.emit('show-number', {
        numberId: num.id, phone: num.phone, name: num.name || '',
        totalDialedToday: agent.totalDialedToday || 0
      });
    }
    broadcastAdminStats();
  });

  socket.on('agent-break-start',    ({ agentId }) => { const r = startBreak(agentId);    socket.emit('break-started', r);    io.emit('timer-update', { agentId, type: 'break', action: 'start', ...r }); broadcastAdminStats(); });
  socket.on('agent-break-end',      ({ agentId }) => { const r = endBreak(agentId);      socket.emit('break-ended', r);      io.emit('timer-update', { agentId, type: 'break', action: 'end', ...r }); broadcastAdminStats(); });
  socket.on('agent-washroom-start', ({ agentId }) => { const r = startWashroom(agentId); socket.emit('washroom-started', r); io.emit('timer-update', { agentId, type: 'washroom', action: 'start', ...r }); broadcastAdminStats(); });
  socket.on('agent-washroom-end',   ({ agentId }) => { const r = endWashroom(agentId);   socket.emit('washroom-ended', r);   io.emit('timer-update', { agentId, type: 'washroom', action: 'end', ...r }); broadcastAdminStats(); });
  socket.on('agent-meeting-start',  ({ agentId }) => { const r = startMeeting(agentId);  socket.emit('meeting-started', r);  io.emit('timer-update', { agentId, type: 'meeting', action: 'start', ...r }); broadcastAdminStats(); });
  socket.on('agent-meeting-end',    ({ agentId }) => { const r = endMeeting(agentId);    socket.emit('meeting-ended', r);    io.emit('timer-update', { agentId, type: 'meeting', action: 'end', ...r }); broadcastAdminStats(); });
  socket.on('agent-tlmode-start',   ({ agentId }) => { const r = startTlMode(agentId);   socket.emit('tlmode-started', r);   io.emit('timer-update', { agentId, type: 'tlmode', action: 'start', ...r }); broadcastAdminStats(); });
  socket.on('agent-tlmode-end',     ({ agentId }) => { const r = endTlMode(agentId);     socket.emit('tlmode-ended', r);     io.emit('timer-update', { agentId, type: 'tlmode', action: 'end', ...r }); broadcastAdminStats(); });

  socket.on('ping-alive', ({ agentId }) => {
    const agent = appState.agents[agentId];
    if (agent) appState = checkDailyReset(appState);
  });
});

// ─── Disposition Stats Endpoint ─────────────────────────────────────────────────
app.get('/api/stats/dispositions', (req, res) => {
  const period = req.query.period || 'daily';
  const agentId = req.query.agentId || null;

  const now = new Date();
  const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const istTodayStr = istNow.toISOString().slice(0, 10);

  let daysBack = 0;
  switch (period) {
    case 'daily': daysBack = 0; break;
    case 'weekly': daysBack = 7; break;
    case 'monthly': daysBack = 30; break;
    case 'yearly': daysBack = 365; break;
    default: daysBack = 0;
  }

  let cutoffDate;
  if (daysBack === 0) {
    cutoffDate = new Date(istTodayStr + 'T00:00:00.000+05:30');
  } else {
    const cutoffIST = new Date(istNow);
    cutoffIST.setDate(cutoffIST.getDate() - daysBack);
    const cutoffStr = cutoffIST.toISOString().slice(0, 10);
    cutoffDate = new Date(cutoffStr + 'T00:00:00.000+05:30');
  }

  const filteredLogs = appState.dialedLog.filter(entry => {
    if (!entry.timestamp) return false;
    const entryDate = new Date(entry.timestamp);
    if (entryDate < cutoffDate) return false;
    if (agentId && entry.agentId !== agentId) return false;
    return true;
  });

  const stats = {
    period,
    totalCalls: filteredLogs.length,
    dead: 0, not_received: 0, not_interested: 0, followup: 0, switch_off: 0, interested: 0, discard: 0
  };

  filteredLogs.forEach(entry => {
    const d = entry.disposition;
    if (d && stats.hasOwnProperty(d)) stats[d]++;
  });

  res.json(stats);
});

// ─── Admin EID Management ──────────────────────────────────────────────────────
// Helper: get agent name from allowedEids (supports both string and object format)
function getEidName(eidVal) {
  if (!eidVal) return '';
  if (typeof eidVal === 'string') return eidVal;
  if (typeof eidVal === 'object' && eidVal.name) return eidVal.name;
  return '';
}
function getEidPhoto(eidVal) {
  if (!eidVal) return null;
  if (typeof eidVal === 'object' && eidVal.photo) return eidVal.photo;
  return null;
}
function getEidRole(eidVal) {
  if (!eidVal) return 'agent';
  if (typeof eidVal === 'object' && eidVal.role) return eidVal.role;
  return 'agent';
}

app.get('/api/admin/eids', (req, res) => {
  const list = Object.entries(appState.allowedEids).map(([eid, val]) => ({
    eid,
    name: getEidName(val),
    photo: getEidPhoto(val),
    role: (typeof val === 'object' && val.role) ? val.role : 'agent'
  }));
  res.json({ eids: list });
});

app.post('/api/admin/eids', (req, res) => {
  const { eid, name } = req.body;
  if (!eid || !/^\d+$/.test(eid)) return res.status(400).json({ error: 'Valid numeric EID required' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const existing = appState.allowedEids[eid];
  const existingPhoto = getEidPhoto(existing);
  const existingRole = getEidRole(existing); // PRESERVE existing role (tl / agent)
  appState.allowedEids[eid] = { name: name.trim(), photo: existingPhoto || null, role: existingRole };
  saveState(appState);
  res.json({ success: true, eid, name: name.trim(), role: existingRole });
});

app.delete('/api/admin/eids/:eid', (req, res) => {
  const eid = req.params.eid;
  if (!appState.allowedEids[eid]) return res.status(404).json({ error: 'EID not found' });
  delete appState.allowedEids[eid];
  saveState(appState);
  res.json({ success: true });
});

// ─── Assign TL Role ────────────────────────────────────────────────────────────
app.post('/api/admin/eids/assign-tl', (req, res) => {
  const { eid } = req.body;
  if (!eid) return res.status(400).json({ error: 'EID required' });
  if (!appState.allowedEids[eid]) return res.status(404).json({ error: 'EID not found' });
  const existing = appState.allowedEids[eid];
  const name = getEidName(existing);
  const photo = getEidPhoto(existing);
  appState.allowedEids[eid] = { name, photo: photo || null, role: 'tl' };
  saveState(appState);
  res.json({ success: true, eid, role: 'tl' });
});

// ─── Remove TL Role ────────────────────────────────────────────────────────────
app.post('/api/admin/eids/remove-tl', (req, res) => {
  const { eid } = req.body;
  if (!eid) return res.status(400).json({ error: 'EID required' });
  if (!appState.allowedEids[eid]) return res.status(404).json({ error: 'EID not found' });
  const existing = appState.allowedEids[eid];
  const name = getEidName(existing);
  const photo = getEidPhoto(existing);
  appState.allowedEids[eid] = { name, photo: photo || null, role: 'agent' };
  saveState(appState);
  res.json({ success: true, eid, role: 'agent' });
});

// ─── TL Auth — check if EID has TL role ───────────────────────────────────────
app.post('/api/tl/auth', (req, res) => {
  const { employeeId, name } = req.body;
  if (!employeeId || !name) return res.status(400).json({ error: 'employeeId and name required' });
  const eidData = appState.allowedEids[employeeId];
  if (!eidData) return res.status(403).json({ error: 'Employee ID not recognised. Please contact your admin.' });
  const role = getEidRole(eidData);
  if (role !== 'tl' && role !== 'admin') {
    return res.status(403).json({ error: 'You do not have TL access. Contact your admin.' });
  }
  const agentId = 'emp_' + employeeId;
  // Register/update agent if not exists
  appState = checkDailyReset(appState);
  const today = getTodayStr();
  function getISTTimeStr() {
    const now = new Date();
    const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    return ist.toISOString().slice(11, 16);
  }
  if (!appState.agents[agentId]) {
    appState.agents[agentId] = {
      name, employeeId, active: false,
      totalDialedToday: 0, date: today,
      currentIndex: null, onBreak: false,
      breakStartedAt: null, totalBreakMs: 0,
      currentNumberId: null,
      firstLoginToday: getISTTimeStr(),
      firstLoginDate: today
    };
  } else {
    appState.agents[agentId].name = name;
    if (appState.agents[agentId].firstLoginDate !== today) {
      appState.agents[agentId].firstLoginToday = getISTTimeStr();
      appState.agents[agentId].firstLoginDate = today;
    }
  }
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true, agentId, name, employeeId, role });
});

// ─── Agent Photo Upload ─────────────────────────────────────────────────────────
app.post('/api/admin/agent-photo/:eid', agentPhotoUpload.single('photo'), (req, res) => {
  try {
    const eid = req.params.eid;
    if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });
    const photoPath = '/api/admin/agent-photo/' + eid + '?t=' + Date.now();
    const existing = appState.allowedEids[eid];
    if (existing) {
      const name = getEidName(existing);
      const role = getEidRole(existing); // PRESERVE existing TL role
      appState.allowedEids[eid] = { name, photo: req.file.path, role };
    } else {
      appState.allowedEids[eid] = { name: '', photo: req.file.path, role: 'agent' };
    }
    saveState(appState);
    res.json({ success: true, photoUrl: photoPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/agent-photo/:eid', (req, res) => {
  const eid = req.params.eid;
  const val = appState.allowedEids[eid];
  const photoPath = getEidPhoto(val);
  if (!photoPath || !fs.existsSync(photoPath)) {
    return res.status(404).json({ error: 'No photo found' });
  }
  res.sendFile(path.resolve(photoPath));
});

// ─── Rankings/Leaderboard API ─────────────────────────────────────────────────
app.get('/api/rankings', (req, res) => {
  const period = req.query.period || 'daily';

  const now = new Date();
  const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const istTodayStr = istNow.toISOString().slice(0, 10);

  let daysBack = 0;
  switch (period) {
    case 'daily': daysBack = 0; break;
    case 'weekly': daysBack = 7; break;
    case 'monthly': daysBack = 30; break;
    default: daysBack = 0;
  }

  let cutoffDate;
  if (daysBack === 0) {
    cutoffDate = new Date(istTodayStr + 'T00:00:00.000+05:30');
  } else {
    const cutoffIST = new Date(istNow);
    cutoffIST.setDate(cutoffIST.getDate() - daysBack);
    const cutoffStr = cutoffIST.toISOString().slice(0, 10);
    cutoffDate = new Date(cutoffStr + 'T00:00:00.000+05:30');
  }

  // Collect all agent IDs from dialedLog and agents registry
  const agentScores = {};

  // Initialize from known agents
  for (const [id, a] of Object.entries(appState.agents)) {
    agentScores[id] = { agentId: id, name: a.name, interested: 0, followups: 0, totalCalls: 0, notInterested: 0, discard: 0, dead: 0, switchOff: 0 };
  }

  // Also ensure agents from allowedEids appear
  for (const [eid, val] of Object.entries(appState.allowedEids)) {
    const agId = 'emp_' + eid;
    if (!agentScores[agId]) {
      agentScores[agId] = { agentId: agId, name: getEidName(val), interested: 0, followups: 0, totalCalls: 0, notInterested: 0, discard: 0, dead: 0, switchOff: 0 };
    }
  }

  // Filter dialedLog by period and tally
  appState.dialedLog.forEach(entry => {
    if (!entry.timestamp) return;
    const entryDate = new Date(entry.timestamp);
    if (entryDate < cutoffDate) return;

    const aid = entry.agentId;
    if (!agentScores[aid]) {
      agentScores[aid] = { agentId: aid, name: entry.agentName || aid, interested: 0, followups: 0, totalCalls: 0, notInterested: 0, discard: 0, dead: 0, switchOff: 0 };
    }

    agentScores[aid].totalCalls++;
    if (entry.disposition === 'interested') agentScores[aid].interested++;
    else if (entry.disposition === 'followup') agentScores[aid].followups++;
    else if (entry.disposition === 'not_interested') agentScores[aid].notInterested++;
    else if (entry.disposition === 'discard') agentScores[aid].discard++;
    else if (entry.disposition === 'dead') agentScores[aid].dead++;
    else if (entry.disposition === 'switch_off') agentScores[aid].switchOff++;
  });

  // New formula: MAX(0, MIN(100, (((100*Interested) + (25*FollowUp) - (10*NotInterested) - (15*Discard) - (2*CNC) - (2*SwitchOff)) / (TotalCalls*100)) * 100))
  const rankings = Object.values(agentScores).map(a => {
    let score = 0;
    if (a.totalCalls > 0) {
      const rawScore = ((100 * a.interested) + (25 * a.followups) - (10 * a.notInterested) - (15 * a.discard) - (2 * a.dead) - (2 * a.switchOff)) / (a.totalCalls * 100) * 100;
      score = Math.max(0, Math.min(100, rawScore));
    }
    score = Math.round(score * 100) / 100;
    // Get profile photo
    const eidMatch = a.agentId.match(/^emp_(\d+)$/);
    let profilePhoto = null;
    if (eidMatch) {
      const eidVal = appState.allowedEids[eidMatch[1]];
      const photoPath = getEidPhoto(eidVal);
      if (photoPath && fs.existsSync(photoPath)) {
        profilePhoto = '/api/admin/agent-photo/' + eidMatch[1];
      }
    }
    return { ...a, score, profilePhoto };
  });

  rankings.sort((a, b) => b.score - a.score || b.interested - a.interested);

  // Add rank and remarks
  rankings.forEach((r, i) => {
    r.rank = i + 1;
    if (i === 0 && r.score > 0) {
      r.remarks = `Top performer! Score: ${r.score}/100 with ${r.interested} interested leads and ${r.followups} followups`;
    } else if (r.score === 0 && r.totalCalls === 0) {
      r.remarks = 'No calls made yet in this period';
    } else if (r.score < 20) {
      r.remarks = 'Focus on quality calls - increase interested and followup conversions';
    } else {
      r.remarks = `Score: ${r.score}/100. ${r.interested} interested, ${r.followups} followups. Keep improving!`;
    }
  });

  const formulaDescription = 'Score (0-100) = ((100 x Interested) + (25 x FollowUp) - (10 x NotInterested) - (15 x Discard) - (2 x CNC) - (2 x SwitchOff)) / (TotalCalls x 100) x 100. Higher interested and followup calls improve your score. Not Interested, Discard, CNC and SwitchOff reduce it.';

  res.json({ rankings, formulaDescription });
});

// ─── Followup Management Endpoints ─────────────────────────────────────────────
// PUT /api/admin/followup/:numberId - Edit followup date, time, and name
app.put('/api/admin/followup/:numberId', (req, res) => {
  const { numberId } = req.params;
  const { followupDate, followupTime, followupName } = req.body;
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return res.status(404).json({ error: 'Number not found' });
  if (num.disposition !== 'followup') return res.status(400).json({ error: 'Number is not a followup' });
  if (followupDate !== undefined) num.followupDate = followupDate;
  if (followupTime !== undefined) num.followupTime = followupTime;
  if (followupName !== undefined) num.followupName = followupName;
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true, id: num.id, followupDate: num.followupDate, followupTime: num.followupTime, followupName: num.followupName || '' });
});

// DELETE /api/admin/followup/:numberId - Remove followup (lead goes to NI)
app.delete('/api/admin/followup/:numberId', (req, res) => {
  const { numberId } = req.params;
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return res.status(404).json({ error: 'Number not found' });
  if (num.disposition !== 'followup') return res.status(400).json({ error: 'Number is not a followup' });
  num.disposition = 'not_interested';
  num.permanent = true;
  num.blockedUntil = null;
  num.followupDate = null;
  num.followupTime = null;
  num.followupLockedBy = null;
  num.followupName = null;
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true });
});

// DELETE /api/agent/followup/:numberId - Agent removes followup (lead goes to NI)
app.delete('/api/agent/followup/:numberId', (req, res) => {
  const { numberId } = req.params;
  const { agentId } = req.body || {};
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return res.status(404).json({ error: 'Number not found' });
  if (num.disposition !== 'followup') return res.status(400).json({ error: 'Number is not a followup' });
  if (agentId && num.followupLockedBy && num.followupLockedBy !== agentId) {
    return res.status(403).json({ error: 'Not authorized to remove this followup' });
  }
  num.disposition = 'not_interested';
  num.permanent = true;
  num.blockedUntil = null;
  num.followupDate = null;
  num.followupTime = null;
  num.followupLockedBy = null;
  num.followupName = null;
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true });
});

// GET /api/admin/followups-by-agent - Followups grouped by agent
app.get('/api/admin/followups-by-agent', (req, res) => {
  const followups = appState.numbers.filter(n => n.disposition === 'followup');
  const grouped = {};
  followups.forEach(n => {
    const agentId = n.followupLockedBy || 'unassigned';
    if (!grouped[agentId]) {
      const agent = appState.agents[agentId];
      grouped[agentId] = { agentId, agentName: agent ? agent.name : agentId, followups: [] };
    }
    grouped[agentId].followups.push({
      id: n.id, phone: n.phone, name: n.name || '',
      followupDate: n.followupDate,
      followupTime: n.followupTime,
      followupName: n.followupName || '',
      followupCount: n.followupCount || 0
    });
  });
  // Sort each agent's followups by nearest date
  Object.values(grouped).forEach(g => {
    g.followups.sort((a, b) => {
      const dateA = (a.followupDate || '9999-12-31') + ' ' + (a.followupTime || '23:59');
      const dateB = (b.followupDate || '9999-12-31') + ' ' + (b.followupTime || '23:59');
      return dateA.localeCompare(dateB);
    });
  });
  res.json(grouped);
});

// GET /api/agent/due-followups/:agentId - Followups whose date+time has arrived (popup trigger)
app.get('/api/agent/due-followups/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const todayStr = ist.toISOString().slice(0, 10);
  const currentTime = ist.toISOString().slice(11, 16); // HH:MM

  const dueFollowups = appState.numbers.filter(n => {
    if (n.disposition !== 'followup') return false;
    if (n.followupLockedBy !== agentId) return false;
    if (!n.followupDate) return false;
    // Due if date is today and time has passed, or date is in the past
    if (n.followupDate < todayStr) return true;
    if (n.followupDate === todayStr) {
      const fTime = n.followupTime || '00:00';
      if (fTime <= currentTime) return true;
    }
    return false;
  }).map(n => ({
    id: n.id, phone: n.phone, name: n.name || '',
    followupDate: n.followupDate,
    followupTime: n.followupTime,
    followupName: n.followupName || '',
    followupCount: n.followupCount || 0
  }));

  // Sort by nearest first
  dueFollowups.sort((a, b) => {
    const dateA = (a.followupDate || '9999-12-31') + ' ' + (a.followupTime || '23:59');
    const dateB = (b.followupDate || '9999-12-31') + ' ' + (b.followupTime || '23:59');
    return dateA.localeCompare(dateB);
  });

  res.json(dueFollowups);
});

// POST /api/admin/upload-followups - Upload custom Excel with followups
const followupUpload = multer({ dest: UPLOADS_DIR });
app.post('/api/admin/upload-followups', followupUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    let added = 0;
    let skipped = 0;
    const existingPhones = new Set(appState.numbers.map(n => n.phone));

    rows.forEach((row, i) => {
      if (i === 0) return; // Skip header row
      const phone = String(row[0] || '').trim().replace(/\s+/g, '');
      if (!phone || phone.length < 7) return;
      const name = row[1] ? String(row[1]).trim() : '';
      const followupDate = row[2] ? String(row[2]).trim() : null;
      const followupTime = row[3] ? String(row[3]).trim() : null;
      const agentId = row[4] ? String(row[4]).trim() : null;
      const followupName = row[5] ? String(row[5]).trim() : '';

      if (existingPhones.has(phone)) {
        // If number exists, update its followup if not already permanently removed
        const existing = appState.numbers.find(n => n.phone === phone);
        if (existing && existing.disposition !== 'discard' && existing.disposition !== 'interested' && !existing.permanent) {
          if (!existing.followupCount) existing.followupCount = 0;
          if (existing.followupCount >= 2) {
            // Enforce 2-max cap: auto-convert to NI
            existing.disposition = 'not_interested';
            existing.permanent = true;
            existing.blockedUntil = null;
            existing.followupDate = null;
            existing.followupTime = null;
            existing.followupLockedBy = null;
            existing.followupName = null;
            skipped++;
          } else {
            existing.disposition = 'followup';
            existing.followupDate = followupDate;
            existing.followupTime = followupTime;
            existing.followupLockedBy = agentId || existing.followupLockedBy;
            existing.followupName = followupName || existing.followupName || '';
            existing.followupCount++;
            added++;
          }
        } else {
          skipped++;
        }
        return;
      }

      existingPhones.add(phone);
      const newEntry = {
        id: uuidv4(),
        phone,
        name,
        file: null,
        assignedTo: null,
        dialedBy: null,
        dialedAt: null,
        disposition: 'followup',
        followupDate,
        followupTime,
        followupLockedBy: agentId || null,
        followupName: followupName,
        followupCount: 1
      };
      appState.numbers.push(newEntry);
      added++;
    });

    saveState(appState);
    fs.unlinkSync(req.file.path);
    broadcastAdminStats();
    res.json({ success: true, added, skipped });
  } catch (e) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/download-followup-sample - Download sample Excel for followup upload
app.get('/api/admin/download-followup-sample', (req, res) => {
  const sampleData = [
    ['Phone', 'Name', 'FollowupDate (YYYY-MM-DD)', 'FollowupTime (HH:MM)', 'AgentId (emp_XXX)', 'FollowupName'],
    ['9876543210', 'John Doe', '2025-01-20', '10:30', 'emp_101', 'Loan discussion'],
    ['9876543211', 'Jane Smith', '2025-01-21', '14:00', 'emp_102', 'Document collection']
  ];
  const ws = XLSX.utils.aoa_to_sheet(sampleData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Followups');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=followup-sample.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ─── Admin Timer Control (fix broadcast to all) ───────────────────────────────
app.post('/api/admin/agent/break/end', (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const result = endBreak(agentId);
  // Broadcast to ALL connected clients so agent sees the update
  io.emit('timer-update', { agentId, type: 'break', action: 'end', ...result });
  broadcastAdminStats();
  res.json(result);
});

app.post('/api/admin/agent/washroom/end', (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const result = endWashroom(agentId);
  // Broadcast to ALL connected clients so agent sees the update
  io.emit('timer-update', { agentId, type: 'washroom', action: 'end', ...result });
  broadcastAdminStats();
  res.json(result);
});

app.post('/api/admin/agent/meeting/end', (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const result = endMeeting(agentId);
  // Broadcast to ALL connected clients so agent sees the update
  io.emit('timer-update', { agentId, type: 'meeting', action: 'end', ...result });
  broadcastAdminStats();
  res.json(result);
});

// ─── Page Routes ──────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.get('/agent', (req, res) => res.sendFile(path.join(__dirname, 'public/agent/index.html')));
app.get('/tl', (req, res) => res.sendFile(path.join(__dirname, 'public/tl/index.html')));

// ─── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  Ruralift CRM running on http://0.0.0.0:${PORT}`);
  console.log(`   Admin Panel : http://YOUR-LAN-IP:${PORT}/admin`);
  console.log(`   Agent Panel : http://YOUR-LAN-IP:${PORT}/agent`);
  console.log(`   TL Panel    : http://YOUR-LAN-IP:${PORT}/tl\n`);
});
