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
const os = require('os');
const zlib = require('zlib');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Map agentId -> socket.id so we can force-disconnect a specific agent server-side
const agentSocketMap = new Map();

const PORT = 3000;

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

// ─── Persistent Data Location ─────────────────────────────────────────────────
// CRITICAL: data/ and uploads/ live OUTSIDE the project folder by default.
// Reason: re-cloning, re-downloading, or extracting a fresh copy of this repo to
// "update" the app replaces the whole project folder. Anything stored inside it
// (old default: data/state.json, uploads/) gets wiped along with the old code.
// Storing it under the OS user's home folder means updating the code never touches it.
// Override with the AUTOLEAD_DATA_DIR environment variable (e.g. to point at a
// mounted persistent volume on a cloud host) if you don't want the home-folder default.
let DATA_ROOT = process.env.AUTOLEAD_DATA_DIR || path.join(os.homedir(), '.autolead-crm');
try {
  ensureDir(DATA_ROOT);
} catch (e) {
  console.error('\u26A0\uFE0F  Could not use external data folder "' + DATA_ROOT + '" (' + e.message + '). ' +
    'Falling back to storing data inside the project folder — your data WILL be lost next time you ' +
    'update by re-cloning/re-downloading this project. Set AUTOLEAD_DATA_DIR to a writable folder to fix this.');
  DATA_ROOT = __dirname;
}

// ─── Container/PaaS persistence sanity check ──────────────────────────────────
// "Outside the project folder" only survives an UPDATE if the home folder itself
// survives between deploys. On a real machine (LAN PC, VPS) it does. On a
// container host (Railway, Render, Heroku, Fly, etc.) it does NOT — every
// deploy/restart can hand the container a brand-new, empty filesystem,
// home folder included. AUTOLEAD_DATA_DIR must then point at a real
// persistent volume mount, or every redeploy wipes the data again.
const looksLikeContainerHost = !!(
  process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID ||
  process.env.RAILWAY_ENVIRONMENT_ID || process.env.RENDER ||
  process.env.DYNO /* Heroku */ || process.env.FLY_APP_NAME
);
if (looksLikeContainerHost && !process.env.AUTOLEAD_DATA_DIR) {
  console.error(
    '\n\uD83D\uDEA8 DATA LOSS RISK: this looks like a container host (Railway/Render/Heroku/Fly), ' +
    'and AUTOLEAD_DATA_DIR is NOT set.\n' +
    '   Right now data is sitting at "' + DATA_ROOT + '" inside the container\'s own filesystem — ' +
    'that is NOT a persistent volume and WILL be wiped on the next deploy or restart.\n' +
    '   Fix: attach a persistent Volume to this service, mount it at e.g. /data, then set the ' +
    'environment variable AUTOLEAD_DATA_DIR=/data and redeploy. See README.md → "Deploying on Railway".\n'
  );
}

const DATA_FILE         = path.join(DATA_ROOT, 'data', 'state.json');
const UPLOADS_DIR        = path.join(DATA_ROOT, 'uploads');
const LEAD_DOCS_DIR      = path.join(UPLOADS_DIR, 'lead_docs');
const AGENT_PHOTOS_DIR   = path.join(UPLOADS_DIR, 'agent_photos');
const SCRIPTS_DIR        = path.join(UPLOADS_DIR, 'scripts');
const BACKUPS_DIR        = path.join(DATA_ROOT, 'backups');
// Original numbers-sheet uploads (.xlsx/.csv etc.) are kept here forever, exactly
// as uploaded — they used to be parsed then deleted; now they're retained so the
// admin can always pull back the exact original file later.
const NUMBER_SHEETS_DIR  = path.join(UPLOADS_DIR, 'number_sheets');

// Exploded (per-document) files for the shareable lead pages live here. Each lead
// gets its own sub-folder keyed by an unguessable share token.
const SHARES_DIR         = path.join(LEAD_DOCS_DIR, 'shares');

// Ensure directories exist
[path.dirname(DATA_FILE), UPLOADS_DIR, LEAD_DOCS_DIR, SHARES_DIR, AGENT_PHOTOS_DIR, SCRIPTS_DIR, BACKUPS_DIR, NUMBER_SHEETS_DIR].forEach(ensureDir);

// ─── Minimal, dependency-free ZIP reader ──────────────────────────────────────
// The network is locked down (no npm installs), so we parse ZIP archives with
// only Node's built-in zlib. We read the Central Directory (authoritative sizes)
// then inflate each entry. Handles the STORED (0) and DEFLATE (8) methods that
// JSZip — the library the loan forms use client-side — produces. Good enough for
// our own archives and for migrating the historical ones.
function readZipEntries(buf) {
  const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50, LOC_SIG = 0x04034b50;
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no End Of Central Directory record)');
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method    = buf.readUInt16LE(p + 10);
    const compSize  = buf.readUInt32LE(p + 20);
    const uncompSize= buf.readUInt32LE(p + 24);
    const nameLen   = buf.readUInt16LE(p + 28);
    const extraLen  = buf.readUInt16LE(p + 30);
    const commentLen= buf.readUInt16LE(p + 32);
    const localOff  = buf.readUInt32LE(p + 42);
    const name      = buf.toString('utf8', p + 46, p + 46 + nameLen);
    let data = null;
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === LOC_SIG) {
      const lNameLen  = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.slice(dataStart, dataStart + compSize);
      try {
        if (method === 0) data = comp;                       // stored
        else if (method === 8) data = zlib.inflateRawSync(comp); // deflate
      } catch (e) { data = null; }
    }
    if (!name.endsWith('/')) entries.push({ name, data, size: uncompSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function sanitizeFileName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'file';
}

// Turn a lead's uploaded ZIP into a shareable page: pull out Applicant_Info.txt as
// readable text and each Documents/* file as an individually downloadable file.
// Idempotent unless {force:true}.
//
// {merge:true} preserves documents already on file and only adds/replaces the ones
// present in the new ZIP (matched by label). This is what makes "edit an existing
// submission and add the missing document" work without wiping the earlier files —
// the re-submitted form only contains whatever the agent re-selected.
//
// Falls back to exposing the raw ZIP as a single download if the archive can't be
// parsed, so no data is ever lost.
function explodeZipForLead(num, opts) {
  opts = opts || {};
  if (!num) return false;
  if (num.shareToken && !opts.force) return true;
  if (!num.docZipPath || !fs.existsSync(num.docZipPath)) return false;

  const token = num.shareToken || uuidv4();
  const destDir = path.join(SHARES_DIR, token);

  const existing = (opts.merge && Array.isArray(num.shareDocs))
    ? num.shareDocs.filter(d => d && d.path && fs.existsSync(d.path))
    : [];

  if (!opts.merge) {
    // Fresh build — start from an empty folder.
    try { if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
  }
  ensureDir(destDir);

  let entries = null;
  try { entries = readZipEntries(fs.readFileSync(num.docZipPath)); }
  catch (e) { entries = null; }

  // Parse the archive into { label, filename, data } records (skip the info text).
  let infoText = '';
  const parsed = [];
  if (entries) {
    for (const e of entries) {
      if (!e.data) continue;
      const base = e.name.split('/').pop();
      if (base === 'Applicant_Info.txt') { infoText = e.data.toString('utf8'); continue; }
      const safe = sanitizeFileName(base);
      const label = safe.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || safe;
      parsed.push({ label, filename: safe, data: e.data });
    }
  }

  // Start the document map from what's already on file (merge) or empty (fresh).
  const byKey = new Map();
  let maxId = -1;
  for (const d of existing) {
    byKey.set((d.label || d.filename || '').toLowerCase(), d);
    const n = parseInt(d.id, 10); if (!isNaN(n)) maxId = Math.max(maxId, n);
  }
  // Overlay the newly uploaded documents (replace same-label, add new ones).
  for (const nd of parsed) {
    const key = nd.label.toLowerCase();
    const prev = byKey.get(key);
    if (prev && prev.path) { try { fs.unlinkSync(prev.path); } catch {} }
    const id = prev ? prev.id : String(++maxId);
    const outPath = path.join(destDir, id + '__' + nd.filename);
    try { fs.writeFileSync(outPath, nd.data); } catch { continue; }
    byKey.set(key, { id, label: nd.label, filename: nd.filename, path: outPath, size: nd.data.length });
  }

  let docs = Array.from(byKey.values());

  // Fallback — couldn't parse the archive and we have nothing else: keep the ZIP itself.
  if (docs.length === 0 && !infoText) {
    const safe = sanitizeFileName(num.docZipName || 'documents.zip');
    const outPath = path.join(destDir, '0__' + safe);
    try {
      fs.copyFileSync(num.docZipPath, outPath);
      docs = [{ id: '0', label: 'All Documents (ZIP)', filename: safe, path: outPath, size: fs.statSync(outPath).size }];
    } catch {}
  }

  num.shareToken = token;
  num.shareInfoText = (opts.keepInfo && num.shareInfoText)
    ? num.shareInfoText
    : (infoText || num.shareInfoText || '');
  num.shareDocs = docs;
  num.shareUpdatedAt = new Date().toISOString();
  return true;
}

// Parse a stored Applicant_Info.txt block into structured, editable rows so an
// older lead (which only has this text, not the newer structured field data) can
// still be re-opened in an editor with every detail prefilled. Divider lines are
// dropped; label-less lines become section headings; "label : value" lines become
// editable fields.
function parseInfoFields(text) {
  const rows = [];
  (text || '').split('\n').forEach(line => {
    const t = line.trim();
    if (!t) return;
    if (/^[=\-_*]{3,}$/.test(t)) return; // divider line
    const idx = line.indexOf(':');
    if (idx === -1) { rows.push({ heading: true, label: t }); return; }
    const label = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!label) return;
    rows.push({ heading: false, label, value: (value === '\u2014' || value === 'None') ? '' : value });
  });
  return rows;
}

function copyRecursiveSync(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    // Merge: recurse into every item so pre-created (but empty) destination
    // subfolders like uploads/agent_photos don't cause their contents to be skipped.
    for (const item of fs.readdirSync(src)) copyRecursiveSync(path.join(src, item), path.join(dest, item));
  } else if (!fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
  }
}

// ─── One-time migration from the OLD in-project data/uploads folders ──────────
// Older runs of this app (or your very first run on this machine) may have data
// sitting inside the project folder. Pull it into the new external location once,
// so you don't lose anything on this transition. Safe to run on every boot —
// it only ever copies files that aren't already present at the destination.
if (DATA_ROOT !== __dirname) {
  try {
    const legacyDataFile = path.join(__dirname, 'data', 'state.json');
    if (!fs.existsSync(DATA_FILE) && fs.existsSync(legacyDataFile)) {
      fs.copyFileSync(legacyDataFile, DATA_FILE);
      console.log('\uD83D\uDCE6 Migrated existing state.json -> ' + DATA_FILE);
    }
  } catch (e) { console.error('Legacy state.json migration skipped:', e.message); }

  try {
    const legacyUploads = path.join(__dirname, 'uploads');
    if (fs.existsSync(legacyUploads)) {
      for (const item of fs.readdirSync(legacyUploads)) {
        if (item === '.gitkeep') continue;
        copyRecursiveSync(path.join(legacyUploads, item), path.join(UPLOADS_DIR, item));
      }
      console.log('\uD83D\uDCE6 Checked uploads/ for anything to migrate -> ' + UPLOADS_DIR);
    }
  } catch (e) { console.error('Legacy uploads migration skipped:', e.message); }
}

console.log('\uD83D\uDCBE Data storage location: ' + DATA_ROOT);
console.log('   (Outside the project folder — updating/re-cloning the code will never touch this.)');

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
    recordings: [],
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

// Extra safety net on top of the external storage location: keep one dated
// snapshot of state.json per day (last 14 days) in BACKUPS_DIR. Cheap insurance
// against an accidental Clear All / Hard Reset, a corrupted write, or anything else.
function backupStateFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const todaysBackup = path.join(BACKUPS_DIR, 'state-' + getTodayStr() + '.json');
    if (!fs.existsSync(todaysBackup)) {
      fs.copyFileSync(DATA_FILE, todaysBackup);
    }
    const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
    fs.readdirSync(BACKUPS_DIR).forEach(f => {
      const full = path.join(BACKUPS_DIR, f);
      try { if (fs.statSync(full).mtimeMs < cutoffMs) fs.unlinkSync(full); } catch {}
    });
  } catch (e) { console.error('State backup skipped:', e.message); }
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
    backupStateFile(); // snapshot yesterday's final state before today's reset mutates it
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
    // Trim dialedLog: remove entries older than 90 days to prevent unbounded growth
    const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    if (state.dialedLog && state.dialedLog.length > 0) {
      state.dialedLog = state.dialedLog.filter(entry => entry.timestamp && entry.timestamp >= cutoffDate);
    }
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
if (!appState.dndNumbers) {
  appState.dndNumbers = [];
}
// Migration: older state.json files predate the call-recording feature.
if (!appState.recordings) {
  appState.recordings = [];
}
appState = checkDailyReset(appState);

// Purge orphaned agent runtime records — a removed user (deleted EID) can otherwise
// linger in appState.agents and show up as a ghost row in admin stats and rankings
// even though admin removed them. Every legitimate agent is created only after its
// EID is validated against allowedEids, so any agent whose EID is no longer in the
// registry is stale and safe to drop. Guard against an empty registry to avoid
// wiping everything if allowedEids failed to load for some reason.
if (Object.keys(appState.allowedEids).length > 0) {
  for (const id of Object.keys(appState.agents)) {
    const m = id.match(/^emp_(.+)$/);
    const eid = m ? m[1] : null;
    if (!eid || !appState.allowedEids[eid]) {
      delete appState.agents[id];
    }
  }
}

for (const id in appState.agents) {
  const a = appState.agents[id];
  if (a.active && !a.onBreak) {
    a.needsAutoResume = true;
  }
  a.active = false;
}

// ─── Migrate legacy lead ZIPs to the new shareable-page format ────────────────
// Older leads stored only a downloadable ZIP. Explode each one into an
// individual-document share page (once) so the new UI and shared banker links
// work with historical data. Safe/idempotent: only touches leads that have a
// ZIP but no share token yet.
try {
  let migrated = 0;
  for (const num of appState.numbers) {
    if (num.docZipPath && !num.shareToken) {
      try { if (explodeZipForLead(num)) migrated++; } catch (e) { /* skip this one */ }
    }
  }
  if (migrated) console.log('\uD83D\uDD17 Migrated ' + migrated + ' legacy lead ZIP(s) to shareable pages');
} catch (e) { console.error('Lead ZIP migration skipped:', e.message); }

saveState(appState);
backupStateFile(); // guarantee at least one snapshot exists per boot, even same-day restarts

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
  const today = getTodayStr();
  // Collect all DND phones to exclude
  const dndPhones = new Set((appState.dndNumbers || []).map(d => d.phone));
  const undialed = appState.numbers.find(n => {
    if (n.dialedBy || n.assignedTo) return false;
    if (n.disposition === 'discard') return false;
    if (n.disposition === 'not_interested') return false;
    if (n.disposition === 'dnd') return false;
    if (n.permanent) return false;
    // Skip if phone is in DND list
    if (dndPhones.has(n.phone)) return false;
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
const VALID_DISPOSITIONS = ['dead', 'not_received', 'not_interested', 'followup', 'switch_off', 'interested', 'discard', 'dnd'];
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
    case 'dnd':
      // DND - Do Not Disturb - permanent, never dial again
      num.disposition = 'dnd';
      num.permanent = true;
      num.retryAfter = null;
      num.blockedUntil = null;
      num.dialedBy = agentId;
      num.dialedAt = now;
      num.assignedTo = null;
      // Also add to DND list
      if (!appState.dndNumbers) appState.dndNumbers = [];
      if (!appState.dndNumbers.find(d => d.phone === num.phone)) {
        appState.dndNumbers.push({ phone: num.phone, addedAt: now, addedBy: agentId });
      }
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
    const { sheetPath, ...publicFields } = f;
    const fileNums = appState.numbers.filter(n => n.file === f.id);
    return {
      ...publicFields,
      total: fileNums.length,
      dialed: fileNums.filter(n => n.dialedBy).length,
      remaining: fileNums.filter(n => !n.dialedBy).length,
      hasOriginal: !!(sheetPath && fs.existsSync(sheetPath))
    };
  });

  return {
    total, dialed, assigned, remaining, agentStats, fileStats,
    today: getTodayStr(),
    interestedCount: appState.numbers.filter(n => n.disposition === 'interested').length,
    followupCount: appState.numbers.filter(n => n.disposition === 'followup').length,
    discardCount: appState.numbers.filter(n => n.disposition === 'discard').length,
    notInterestedCount: appState.numbers.filter(n => n.disposition === 'not_interested').length,
    dndCount: (appState.dndNumbers || []).length,
    comingBackTomorrow: appState.numbers.filter(n => (n.disposition === 'not_received' || n.disposition === 'switch_off' || n.disposition === 'dead') && n.retryAfter && !n.permanent && (n.retryCount || 0) < 2 && getTodayStr() < n.retryAfter).length,
    overdueInterestedCount: appState.numbers.filter(n => n.disposition === 'interested' && !n.documentationComplete && (Date.now() - new Date(n.interestedAt).getTime()) >= DOC_DEADLINE_MS).length
  };
}

// ─── Express Setup ─────────────────────────────────────────────────────────────
app.use(express.json());

// ─── CORS — allow other CRMs to call the cross-sync endpoints ─────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Multer for number file uploads — keep the ORIGINAL file permanently (no longer
// deleted after parsing) so the admin can retrieve the exact sheet they uploaded.
const numberSheetStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, NUMBER_SHEETS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.xlsx';
    cb(null, uuidv4() + ext);
  }
});
const numberUpload = multer({ storage: numberSheetStorage });

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
    appState.uploadedFiles.push({ id: fileId, name: req.file.originalname, uploadedAt: new Date().toISOString(), total: phones.length, sheetPath: req.file.path });
    saveState(appState);
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
    num.documentationCompletedAt = num.documentationCompletedAt || new Date().toISOString();
    num.adminStatus = num.adminStatus || 'In Process';

    // Store the structured form field values so the form can be re-opened and
    // edited later (prefilled), and record which loan form was used. We only
    // persist the values when the agent actually entered something — this way
    // "just add one missing document" to an older lead never blanks out the
    // details that were already saved.
    //
    // FIX: The old check `Object.values(parsed).some(v => v.trim() !== '')` was
    // too weak — default dropdown values (e.g. "Married") make it pass even when
    // ALL meaningful fields (name, phone, DOB, amount, etc.) are empty. This
    // caused data loss when a form's prefill failed silently and the agent hit
    // save. The new check requires at least one KEY IDENTITY FIELD (name, mobile,
    // DOB, company, income, address, etc.) to be non-empty. This applies to all
    // loan categories: PL, BL, and LAP (Salaried + Business).
    let hasRealData = false;
    try {
      if (req.body.formData) {
        const parsed = JSON.parse(req.body.formData);

        // SAFETY: If the client signals that prefill failed (data couldn't be
        // loaded before save), treat this as "no real data" regardless of what
        // the fields contain. This is a last-resort safeguard — the client
        // already disables the button, but if it's bypassed we still protect.
        const prefillStatus = parsed['__prefillStatus'];
        if (prefillStatus === 'failed' && num.form) {
          // Prefill failed and we have existing data — refuse to overwrite.
          // Still allow the ZIP upload (documents) to go through.
          hasRealData = false;
        } else {
          // Key identity fields that a real submission must have at least one of.
          // These are the core fields across ALL five loan form types.
          const KEY_FIELDS = [
            'f_name', 'f_mobile', 'f_dob', 'f_father', 'f_mother',
            'f_addr', 'f_pin', 'f_addr_aadh', 'f_pin_aadh',
            'f_company', 'f_income', 'f_lamount', 'f_cibil',
            'f_biz_name', 'f_biz_addr', 'f_net_income',
            'f_email', 'f_alt_mobile', 'f_exp',
            'f_ref1name', 'f_ref1mob', 'f_ref2name', 'f_ref2mob',
            'f_prop_addr', 'f_prop_value', 'f_owner1_name'
          ];

          hasRealData = KEY_FIELDS.some(k => {
            const v = parsed[k];
            return typeof v === 'string' && v.trim() !== '';
          });

          if (hasRealData) {
            // New submission has real meaningful data → safe to store.
            // Remove internal tracking keys before persisting.
            delete parsed['__prefillStatus'];
            num.form = {
              type: req.body.formType || (num.form && num.form.type) || num.loanType || '',
              data: parsed,
              updatedAt: new Date().toISOString()
            };
          } else if (!num.form) {
            // No existing data at all — store whatever we got (first submission,
            // even if partially empty, is better than nothing).
            delete parsed['__prefillStatus'];
            num.form = {
              type: req.body.formType || num.loanType || '',
              data: parsed,
              updatedAt: new Date().toISOString()
            };
          }
          // else: new data is empty/trivial AND we already have saved data → keep existing
        }
      }
    } catch (e) { /* ignore malformed formData */ }

    // Explode the ZIP into an individual-document shareable page (replaces the old
    // "download a ZIP" flow). force:true so re-submissions refresh the page; merge
    // when the lead already has documents so an edit that only re-uploads one file
    // keeps the previously uploaded documents. keepInfo preserves the saved text
    // info when this submission carried no real field data (add-a-doc-only edits).
    try {
      explodeZipForLead(num, {
        force: true,
        merge: !!(num.shareDocs && num.shareDocs.length),
        keepInfo: !hasRealData
      });
    } catch (e) { console.error('explode failed:', e.message); }

    // The legacy-lead editor sends the edited applicant info as plain text (it has
    // no structured form fields). When present, it is authoritative for the page.
    // FIX: Only overwrite existing infoText if the new text actually has meaningful
    // content — not just section headers and empty field lines (e.g. "Full name : ").
    // This prevents a failed-prefill edit from blanking out good stored info.
    if (typeof req.body.infoText === 'string' && req.body.infoText.trim()) {
      const newText = req.body.infoText.trim();
      // Check if the info text has real content: at least one "Label : Value" line
      // where Value is something other than empty/dash/N/A.
      const lines = newText.split('\n');
      const hasRealContent = lines.some(line => {
        const m = line.match(/:\s+(.+)$/);
        if (!m) return false;
        const val = m[1].trim();
        return val && val !== '\u2014' && val !== '-' && val !== 'N/A' && val !== 'None' && val.length > 1;
      });
      if (hasRealContent || !num.shareInfoText) {
        num.shareInfoText = newText;
      }
      // else: new text has no real values but we already have saved info → keep existing
    }

    saveState(appState);
    broadcastAdminStats();
    res.json({ success: true, docZipName: num.docZipName, documentationCompletedAt: num.documentationCompletedAt, shareToken: num.shareToken || null });
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

// ─── Lead form prefill — lets a loan form re-open a saved submission ──────────
// Returns the previously saved field values (so the form can prefill and show an
// "Update" button) plus the list of documents already on file.

/**
 * Reconstruct a form field snapshot from the plain-text Applicant_Info.txt that
 * was embedded in every uploaded ZIP. Older leads were submitted before the JSON
 * snapshot (num.form.data) feature existed, so this is our only source of truth
 * for pre-filling the form when editing those leads.
 *
 * The text format is:   "Label          : Value\n"
 * We parse each such line and map the known labels to their HTML input IDs.
 * Date values stored as dd/mm/yyyy are converted to yyyy-mm-dd for <input type="date">.
 */
function reconstructFormDataFromInfoText(shareInfoText) {
  if (!shareInfoText || typeof shareInfoText !== 'string') return null;

  // Parse every "Label (2+ spaces) : Value" line into a plain object.
  const parsed = {};
  for (const line of shareInfoText.split('\n')) {
    const m = line.match(/^([A-Za-z][^:]{1,35}?)\s{2,}:\s(.+)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (val && val !== '—' && val !== '-') parsed[key] = val;
  }
  if (Object.keys(parsed).length === 0) return null;

  // Label-in-infoText → HTML field id. Covers PL_Salaried, PL_Business,
  // LAP_Salaried, LAP_Business, and BL_Business (fields overlap heavily).
  const LABEL_TO_FIELD = {
    'Full name':           'f_name',
    'Customer Name':       'f_name',
    'Date of birth':       { field: 'f_dob',        date: true },
    "Father's name":       'f_father',
    "Mother's name":       'f_mother',
    'Age':                 'f_age',
    'Marital status':      'f_marital',
    'Marital Status':      'f_marital',
    'Education':           'f_edu',
    'Mobile':              'f_mobile',
    'Contact No':          'f_mobile',
    'Alternate mobile':    'f_alt_mobile',
    'Alternate no.':       'f_alt_mobile',
    'Alternate No':        'f_alt_mobile',
    'Personal email':      'f_email',
    'Email':               'f_email',
    'Spouse':              'f_spouse',
    'Spouse name':         'f_spouse',
    'Spouse DOB':          { field: 'f_spouse_dob', date: true },
    // Address
    'Current address':     'f_addr',
    'Residence address':   'f_addr',
    'Landmark':            'f_addr_landmark',
    'Res. landmark':       'f_addr_landmark',
    'Current PIN':         'f_pin',
    'Residence PIN':       'f_pin',
    'PIN code':            'f_pin',
    'Rented/Owned':        'f_residence_type',
    'Rented / Owned':      'f_residence_type',
    'Res. addr. proof':    'f_addr_proof',
    'Aadhaar address':     'f_addr_aadh',
    'Aadhaar PIN':         'f_pin_aadh',
    // Permanent address (BL)
    'Permanent Address':   'f_perm_addr',
    'Permanent PIN Code':  'f_perm_pin',
    'Permanent Address Landmark': 'f_perm_landmark',
    // CIBIL
    'CIBIL score':         'f_cibil',
    'CIBIL Score':         'f_cibil',
    // Employment / business
    'Salary type':         '__salaryType',   // special: client calls setSalaryType()
    'Job type':            'f_job',
    'Designation':         'f_designation',
    'Business type':       'f_biz_type',
    'Business Type':       'f_biz_type',
    'Business name':       'f_biz_name',
    'Business Name':       'f_biz_name',
    'Company':             'f_company',
    'Company name':        'f_company',
    'Employed since':      'f_emp_since',
    'Office address':      'f_office_addr',
    'Business address':    'f_biz_addr',
    'Business Address':    'f_biz_addr',
    'Business Contact No': 'f_biz_mobile',
    'Business contact':    'f_biz_mobile',
    'Biz. landmark':       'f_biz_landmark',
    'Business landmark':   'f_biz_landmark',
    'Biz. PIN code':       'f_biz_pin',
    'Business PIN code':   'f_biz_pin',
    'Res. to biz. dist.':  'f_biz_distance',
    'Residence to Business Distance': 'f_distance',
    'Work email':          'f_work_email',
    'Experience':          'f_exp',
    'Total biz. exp.':     'f_biz_exp',
    'Total Business Experience': 'f_biz_exp',
    'Monthly income':      'f_income',
    'Monthly net income':  'f_net_income',
    'Net Monthly Income':  'f_net_income',
    'GSTIN':               'f_gstin',
    // Loan details
    'Required amount':     'f_lamount',
    'Loan amount':         'f_lamount',
    'Loan Facilitator':    'f_lender',
    'Agent name':          'f_bank',
    'Agent Name':          'f_agent',
    'Calling date':        { field: 'f_cdate', date: true },
    'Case type':           'f_case',
    'Loan purpose':        'f_loan_purpose',
    'Loan Purpose':        'f_loan_purpose',
    // LAP specific
    'Property address':    'f_prop_addr',
    'Property Address':    'f_prop_addr',
    'Property area':       'f_prop_area',
    'Property Area':       'f_prop_area',
    'Property value':      'f_prop_value',
    'Property Value':      'f_prop_value',
    'Owner type':          'f_owner_type',
    'Owner Type':          'f_owner_type',
    'Owner 1 name':        'f_owner1_name',
    'Owner 2 name':        'f_owner2_name',
  };

  // Convert Indian locale date (dd/mm/yyyy or d/m/yyyy) → HTML date (yyyy-mm-dd).
  function toHtmlDate(val) {
    const m = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return val;
    return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  }

  const snapshot = {};

  for (const [label, target] of Object.entries(LABEL_TO_FIELD)) {
    const val = parsed[label];
    if (val === undefined || val === '') continue;
    const fieldId   = typeof target === 'string' ? target : target.field;
    const needsDate = typeof target === 'object' && target.date;
    snapshot[fieldId] = needsDate ? toHtmlDate(val) : val;
  }

  // Reference 1 & 2 are stored as "Name  |  Mobile" on one line.
  const ref1 = parsed['Reference 1'];
  if (ref1) {
    const parts = ref1.split(/\s*\|\s*/);
    if (parts[0] && parts[0] !== '—') snapshot['f_ref1name'] = parts[0].trim();
    if (parts[1] && parts[1] !== '—') snapshot['f_ref1mob']  = parts[1].trim();
  }
  const ref2 = parsed['Reference 2'];
  if (ref2) {
    const parts = ref2.split(/\s*\|\s*/);
    if (parts[0] && parts[0] !== '—') snapshot['f_ref2name'] = parts[0].trim();
    if (parts[1] && parts[1] !== '—') snapshot['f_ref2mob']  = parts[1].trim();
  }

  // Notes section may be multi-line; capture everything between the NOTES header
  // and the next section divider.
  const notesM = shareInfoText.match(/\bNOTES\b\n-{10,}\n([\s\S]*?)(?:\n-{10,}|\n={10,}|$)/);
  if (notesM) {
    const notes = notesM[1].trim();
    if (notes && notes !== 'None') snapshot['f_notes'] = notes;
  }

  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

app.get('/api/lead-form/:numberId', (req, res) => {
  const num = appState.numbers.find(n => n.id === req.params.numberId);
  if (!num) return res.json({ exists: false });

  // Check whether the stored JSON snapshot has any real field data.
  let formData = (num.form && num.form.data) ? num.form.data : null;
  const hasRealStoredData = formData &&
    Object.values(formData).some(v => (typeof v === 'string' ? v.trim() !== '' : !!v));

  // ── Older leads: no JSON snapshot (or empty one) but Applicant_Info.txt ──
  // Parse the human-readable text to reconstruct the field values so the form
  // opens pre-filled instead of blank. reconstructFormDataFromInfoText() maps
  // known label strings to their HTML field IDs and handles date conversion.
  // parseInfoFields() also runs and its output is sent as infoFields so the
  // client-side fuzzy label matcher can fill in any gaps we didn't cover.
  if (!hasRealStoredData && num.shareInfoText) {
    const reconstructed = reconstructFormDataFromInfoText(num.shareInfoText);
    if (reconstructed) formData = reconstructed;
  }

  // Final fallback: at minimum inject the lead name + phone so the first two
  // fields aren't blank even on very old leads that have neither JSON nor text.
  if (!formData) formData = {};
  if (!formData['f_name']   && (num.leadName || num.name)) formData['f_name']   = num.leadName || num.name;
  if (!formData['f_mobile'] && num.phone)                  formData['f_mobile'] = num.phone;

  res.json({
    exists: !!(num.form || num.shareToken || num.docZipPath),
    formType: num.form ? num.form.type : (num.loanType || ''),
    data: Object.keys(formData).length > 0 ? formData : null,
    // infoFields lets the client fuzzy-match any labels our explicit map missed
    infoFields: parseInfoFields(num.shareInfoText || ''),
    docs: (num.shareDocs || []).map(d => ({ id: d.id, label: d.label, filename: d.filename })),
    shareToken: num.shareToken || null,
    leadName: num.leadName || num.name || '',
    loanType: num.loanType || '',
    phone: num.phone
  });
});

// ─── Switch form type (agent-facing) ──────────────────────────────────────────
// Lets an agent change the loan type of their lead (e.g. PL_Salaried → LAP_Business)
app.post('/api/agent/switch-form-type/:numberId', (req, res) => {
  const { numberId } = req.params;
  const { agentId, loanType } = req.body;
  if (!agentId || !numberId || !loanType) {
    return res.status(400).json({ error: 'agentId, numberId, and loanType are required' });
  }
  if (!VALID_LOAN_TYPES.includes(loanType)) {
    return res.status(400).json({ error: 'Invalid loan type. Must be one of: ' + VALID_LOAN_TYPES.join(', ') });
  }
  const num = appState.numbers.find(n => n.id === numberId);
  if (!num) return res.status(404).json({ error: 'Lead not found' });
  if (num.disposition !== 'interested') return res.status(400).json({ error: 'Lead is not marked as interested' });
  if (num.interestedBy !== agentId) return res.status(403).json({ error: 'This lead is not assigned to you' });
  num.loanType = loanType;
  if (num.form) num.form.type = loanType;
  saveState(appState);
  res.json({ success: true, loanType });
});

// ─── Public shareable lead page (replaces the ZIP download) ───────────────────
// Unique, unguessable URL per lead. Shows all the applicant text info and lets a
// banker download individual documents. No auth by design — the token is the key.
function fileIconFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['jpg','jpeg','png','gif','webp','bmp'].includes(ext)) return '\uD83D\uDDBC\uFE0F';
  if (ext === 'pdf') return '\uD83D\uDCC4';
  if (['zip','rar','7z'].includes(ext)) return '\uD83D\uDDDC\uFE0F';
  if (['doc','docx'].includes(ext)) return '\uD83D\uDCDD';
  if (['xls','xlsx','csv'].includes(ext)) return '\uD83D\uDCCA';
  return '\uD83D\uDCCE';
}
function humanSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

app.get('/share/:token', (req, res) => {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = appState.numbers.find(n => n.shareToken === req.params.token);
  if (!num) {
    return res.status(404).send('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title></head><body style="font-family:system-ui,sans-serif;background:linear-gradient(135deg,#1e1b4b,#312e81);color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center;padding:24px"><div><div style="font-size:56px">\uD83D\uDD0D</div><h1 style="font-weight:700;color:#c4b5fd">Link not found</h1><p style="color:#a78bfa">This document link is invalid or has been removed.</p></div></body></html>');
  }
  const token = num.shareToken;
  const docs = num.shareDocs || [];
  const name = num.leadName || num.name || 'Applicant';
  const loanType = (num.form && num.form.type) || num.loanType || '';
  const completedAt = num.documentationCompletedAt ? new Date(num.documentationCompletedAt).toLocaleString('en-IN') : '';

  const docCards = docs.length ? docs.map(d => `
      <div class="doc">
        <div class="doc-ic">${fileIconFor(d.filename)}</div>
        <div class="doc-meta">
          <div class="doc-name">${esc(d.label)}</div>
          <div class="doc-sub">${esc(d.filename)} \u00b7 ${humanSize(d.size)}</div>
        </div>
        <div class="doc-actions">
          <a class="btn ghost" href="/share/${esc(token)}/doc/${esc(d.id)}" target="_blank" rel="noopener">View</a>
          <a class="btn solid" href="/share/${esc(token)}/doc/${esc(d.id)}?dl=1">Download</a>
        </div>
      </div>`).join('') : '<p class="empty">No documents were attached to this lead.</p>';

  const infoBlock = num.shareInfoText
    ? `<pre class="info">${esc(num.shareInfoText)}</pre>`
    : '<p class="empty">No additional information was recorded.</p>';

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(name)} — Loan Documents</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:linear-gradient(135deg,#f5f3ff,#ede9fe 40%,#faf5ff 80%,#fdf4ff);color:#0f172a;min-height:100vh;padding:24px 14px 60px}
  .wrap{max-width:760px;margin:0 auto}
  .card{background:#fff;border:1px solid rgba(88,28,135,.06);border-radius:16px;box-shadow:0 8px 30px rgba(124,58,237,.08);padding:22px 24px;margin-bottom:18px}
  .head{background:linear-gradient(135deg,#4c1d95,#6d28d9 50%,#7c3aed 100%);color:#fff;border:none;padding:24px 24px 20px}
  .head h1{font-size:24px;font-weight:700;letter-spacing:-.3px}
  .head .logo-bar{display:flex;align-items:center;gap:14px;margin-bottom:14px}
  .head .logo-bar img{height:44px;width:auto;border-radius:10px;background:#fff;padding:4px 8px;box-shadow:0 2px 10px rgba(0,0,0,.15)}
  .head .logo-bar .brand{font-size:13px;font-weight:600;color:#ddd6fe;letter-spacing:.3px}
  .pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
  .pill{background:rgba(255,255,255,.15);color:#ede9fe;font-size:12px;font-weight:600;border-radius:20px;padding:5px 12px;backdrop-filter:blur(4px)}
  h2{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#7c3aed;margin-bottom:14px;padding-bottom:8px;border-bottom:1.5px solid #ede9fe}
  .info{white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;font-family:'SFMono-Regular',ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12px;line-height:1.7;color:#1e293b;background:#faf5ff;border:1px solid #ede9fe;border-radius:12px;padding:18px;overflow-x:auto;max-width:100%}
  .doc{display:flex;align-items:center;gap:14px;padding:13px 14px;border:1px solid #e9d5ff;border-radius:12px;margin-bottom:10px;transition:box-shadow .15s,border-color .15s}
  .doc:hover{border-color:#c084fc;box-shadow:0 2px 12px rgba(124,58,237,.1)}
  .doc-ic{font-size:26px;flex-shrink:0}
  .doc-meta{flex:1;min-width:0}
  .doc-name{font-weight:600;font-size:14px;color:#0f172a;text-transform:capitalize}
  .doc-sub{font-size:12px;color:#64748b;margin-top:2px;word-break:break-all}
  .doc-actions{display:flex;gap:8px;flex-shrink:0}
  .btn{font-size:12.5px;font-weight:600;padding:8px 14px;border-radius:8px;text-decoration:none;cursor:pointer;white-space:nowrap;transition:all .15s}
  .btn.solid{background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;box-shadow:0 2px 6px rgba(124,58,237,.25)}
  .btn.solid:hover{box-shadow:0 4px 12px rgba(124,58,237,.35);transform:translateY(-1px)}
  .btn.ghost{background:#f5f3ff;color:#7c3aed;border:1px solid #ddd6fe}
  .btn.ghost:hover{background:#ede9fe;border-color:#c084fc}
  .empty{color:#64748b;font-size:14px;padding:8px 0}
  .foot{text-align:center;color:#a78bfa;font-size:12px;margin-top:12px;display:flex;align-items:center;justify-content:center;gap:8px}
  .foot img{height:22px;width:auto;opacity:.7;border-radius:4px}

  /* ── Tablet (max-width: 768px) ── */
  @media(max-width:768px){
    body{padding:18px 12px 50px}
    .card{padding:18px 18px;border-radius:14px}
    .head{padding:20px 18px 16px}
    .head h1{font-size:21px}
    .info{font-size:11.5px;padding:14px;line-height:1.65}
    .doc{gap:10px;padding:11px 12px}
    .doc-name{font-size:13px}
    .doc-sub{font-size:11px}
  }

  /* ── Phone (max-width: 520px) ── */
  @media(max-width:520px){
    body{padding:12px 8px 40px}
    .wrap{max-width:100%}
    .card{padding:14px 13px;border-radius:12px;margin-bottom:12px}
    .head{padding:16px 14px 14px;border-radius:12px}
    .head h1{font-size:18px}
    .head .logo-bar{gap:10px;margin-bottom:10px}
    .head .logo-bar img{height:36px;padding:3px 6px}
    .head .logo-bar .brand{font-size:11.5px}
    .pills{gap:6px;margin-top:10px}
    .pill{font-size:11px;padding:4px 9px}
    h2{font-size:12px;margin-bottom:10px}
    .info{font-size:10.5px;padding:12px 10px;line-height:1.6;border-radius:9px;white-space:pre-wrap;word-break:break-word}
    .doc{flex-wrap:wrap;gap:8px;padding:10px 11px}
    .doc-ic{font-size:22px}
    .doc-meta{min-width:calc(100% - 40px)}
    .doc-name{font-size:13px}
    .doc-sub{font-size:10.5px}
    .doc-actions{width:100%;margin-top:4px}
    .btn{flex:1;text-align:center;padding:9px 10px;font-size:12px}
    .foot{font-size:11px;gap:6px}
    .foot img{height:18px}
  }
</style>
</head><body>
<div class="wrap">
  <div class="card head">
    <div class="logo-bar">
      <img src="/logo.png" alt="Ruralift">
      <span class="brand">Ruralift CRM</span>
    </div>
    <h1>${esc(name)}</h1>
    <div class="pills">
      ${loanType ? `<span class="pill">${esc(loanType)}</span>` : ''}
      ${num.phone ? `<span class="pill">\uD83D\uDCDE ${esc(num.phone)}</span>` : ''}
      <span class="pill">${docs.length} document${docs.length === 1 ? '' : 's'}</span>
      ${completedAt ? `<span class="pill">${esc(completedAt)}</span>` : ''}
    </div>
  </div>
  <div class="card">
    <h2>Documents</h2>
    ${docCards}
  </div>
  <div class="card">
    <h2>Applicant Information</h2>
    ${infoBlock}
  </div>
  <p class="foot"><img src="/logo.png" alt="Ruralift"> Secure document link \u00b7 Ruralift CRM</p>
</div>
</body></html>`;
  res.send(html);
});

// Download / view an individual document from a shareable lead page.
app.get('/share/:token/doc/:docId', (req, res) => {
  const num = appState.numbers.find(n => n.shareToken === req.params.token);
  if (!num) return res.status(404).send('Not found');
  const doc = (num.shareDocs || []).find(d => d.id === req.params.docId);
  if (!doc || !doc.path || !fs.existsSync(doc.path)) return res.status(404).send('Document not found');
  if (req.query.dl) return res.download(doc.path, doc.filename);
  res.sendFile(doc.path, (err) => { if (err && !res.headersSent) res.status(404).send('Document not found'); });
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
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const followups = appState.numbers.filter(n => n.disposition === 'followup').map(n => {
    const agent = appState.agents[n.followupLockedBy];
    let overdue = false;
    if (n.followupDate) {
      const fDateStr = n.followupDate + 'T' + (n.followupTime || '23:59') + ':00';
      const fDate = new Date(fDateStr);
      overdue = istNow > fDate;
    }
    return {
      id: n.id, phone: n.phone, name: n.name || '',
      followupLockedBy: agent ? agent.name : n.followupLockedBy,
      followupLockedByAgentId: n.followupLockedBy,
      followupDate: n.followupDate,
      followupTime: n.followupTime,
      followupName: n.followupName || '',
      followupCount: n.followupCount || 0,
      overdue
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
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const followups = appState.numbers.filter(n => n.disposition === 'followup' && n.followupLockedBy === agentId).map(n => {
    let overdue = false;
    if (n.followupDate) {
      const fDateStr = n.followupDate + 'T' + (n.followupTime || '23:59') + ':00';
      const fDate = new Date(fDateStr);
      overdue = istNow > fDate;
    }
    return {
      id: n.id, phone: n.phone, name: n.name || '',
      followupDate: n.followupDate,
      followupTime: n.followupTime,
      followupName: n.followupName || '',
      followupCount: n.followupCount || 0,
      overdue
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
    // Feature 4: If existing number was marked as not_interested, switch_off, dead (CNC), or discard
    // allow overriding to interested
    const overridableDispositions = ['not_interested', 'switch_off', 'dead', 'discard', 'not_received'];
    if (overridableDispositions.includes(existingNumber.disposition) || existingNumber.permanent) {
      // Override: convert to interested
      const now = new Date().toISOString();
      existingNumber.disposition = 'interested';
      existingNumber.permanent = false;
      existingNumber.retryAfter = null;
      existingNumber.blockedUntil = null;
      existingNumber.interestedBy = agentId;
      existingNumber.interestedAt = now;
      existingNumber.leadName = leadName || '';
      existingNumber.name = leadName || existingNumber.name || '';
      existingNumber.loanType = loanType || '';
      existingNumber.remarks = remarks || '';
      existingNumber.loanAmount = loanAmount || '';
      existingNumber.employmentType = employmentType || '';
      existingNumber.city = city || '';
      existingNumber.documentationComplete = false;
      existingNumber.documentationCompletedAt = null;
      existingNumber.docZipPath = null;
      existingNumber.docZipName = null;
      existingNumber.dialedBy = agentId;
      existingNumber.dialedAt = now;
      existingNumber.assignedTo = null;
      appState.dialedLog.push({
        phone, agentId,
        agentName: appState.agents[agentId] ? appState.agents[agentId].name : agentId,
        timestamp: now,
        disposition: 'interested'
      });
      saveState(appState);
      broadcastAdminStats();
      return res.json({ success: true, entry: existingNumber });
    }
    // If it's already interested or followup, don't allow duplicate
    return res.status(409).json({ error: 'This phone number already exists in the system as ' + (existingNumber.disposition || 'active') });
  }
  // Check DND list
  if (appState.dndNumbers && appState.dndNumbers.find(d => d.phone === phone)) {
    return res.status(409).json({ error: 'This number is in the DND list and cannot be added' });
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

// ─── Feature 2,3,4: Remove interested/completed leads COMPLETELY from system ──
app.post('/api/agent/remove-interested', (req, res) => {
  const { agentId, numberId } = req.body;
  if (!agentId || !numberId) {
    return res.status(400).json({ error: 'agentId and numberId are required' });
  }
  const idx = appState.numbers.findIndex(n => n.id === numberId);
  if (idx === -1) return res.status(404).json({ error: 'Number not found' });
  const num = appState.numbers[idx];
  if (num.disposition !== 'interested') return res.status(400).json({ error: 'Number is not marked as interested' });
  if (num.interestedBy !== agentId) return res.status(403).json({ error: 'This lead is not assigned to you' });
  // Completely remove from system
  appState.numbers.splice(idx, 1);
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true });
});

app.post('/api/admin/remove-interested', (req, res) => {
  const { numberId } = req.body;
  if (!numberId) {
    return res.status(400).json({ error: 'numberId is required' });
  }
  const idx = appState.numbers.findIndex(n => n.id === numberId);
  if (idx === -1) return res.status(404).json({ error: 'Number not found' });
  // Completely remove from system (works for interested AND documentation completed)
  appState.numbers.splice(idx, 1);
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
      docZipName: n.docZipName || null,
      shareToken: n.shareToken || null,
      docCount: (n.shareDocs || []).length,
      formType: (n.form && n.form.type) || n.loanType || '',
      editorKind: ((n.form && n.form.data) || VALID_LOAN_TYPES.includes((n.form && n.form.type) || n.loanType || '')) ? 'form' : 'legacy'
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
    docZipName: n.docZipName || null,
    shareToken: n.shareToken || null,
    docCount: (n.shareDocs || []).length,
    formType: (n.form && n.form.type) || n.loanType || '',
    editorKind: ((n.form && n.form.data) || VALID_LOAN_TYPES.includes((n.form && n.form.type) || n.loanType || '')) ? 'form' : 'legacy'
  }));
  res.json(completed);
});

app.delete('/api/admin/file/:fileId', (req, res) => {
  const fid = req.params.fileId;
  // SAFE DELETE: never remove interested leads when deleting a file batch —
  // they are real business data (pending docs or docs already uploaded).
  // Only wipe undisposed / non-converting numbers from that batch.
  const fileInfo = appState.uploadedFiles.find(f => f.id === fid);
  if (fileInfo && fileInfo.sheetPath) {
    try { fs.unlinkSync(fileInfo.sheetPath); } catch {}
  }
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
  (appState.uploadedFiles || []).forEach(f => {
    if (f.sheetPath) { try { fs.unlinkSync(f.sheetPath); } catch {} }
  });
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
  (appState.uploadedFiles || []).forEach(f => {
    if (f.sheetPath) { try { fs.unlinkSync(f.sheetPath); } catch {} }
  });
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
  let { name, employeeId } = req.body;
  if (!employeeId || !/^\d+$/.test(employeeId)) return res.status(400).json({ error: 'Valid numeric Employee ID required' });

  if (!appState.allowedEids[employeeId]) {
    return res.status(403).json({ error: 'Employee ID not recognised. Please contact your admin.' });
  }
  // Auto-fill name from allowedEids if not provided
  if (!name || !name.trim()) { name = getEidName(appState.allowedEids[employeeId]); }
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
    role: getEidRole(appState.allowedEids[employeeId]),
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
    totalTlModeMs: agent.totalTlModeMs || 0,
    lateLogin: (agent.firstLoginToday && agent.firstLoginToday > '10:00') || false
  });
});

// Break / washroom / meeting endpoints
app.post('/api/agent/break/start',    (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(startBreak(agentId)); });
app.post('/api/agent/break/end',      (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(endBreak(agentId)); });
app.post('/api/agent/washroom/start', (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(startWashroom(agentId)); });
app.post('/api/agent/washroom/end',   (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(endWashroom(agentId)); });
app.post('/api/agent/meeting/start',  (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(startMeeting(agentId)); });
app.post('/api/agent/meeting/end',    (req, res) => { const { agentId } = req.body; if (!agentId) return res.status(400).json({ error: 'agentId required' }); res.json(endMeeting(agentId)); });

// ─── Cross-CRM Timer Sync Endpoints ──────────────────────────────────────────
// GET  /api/config/crm-urls  — returns peer CRM URLs from env vars (for frontend)
// Set env vars: PEER_CRM_1=https://swiggy-crm.up.railway.app
//               PEER_CRM_2=https://kingfisher-crm.up.railway.app
app.get('/api/config/crm-urls', (req, res) => {
  const peers = [process.env.PEER_CRM_1, process.env.PEER_CRM_2]
    .filter(Boolean)
    .map(u => u.replace(/\/$/, ''));
  res.json({ peers });
});

// GET  /api/sync/timer-state/:empId  — read current timer state for an employee
app.get('/api/sync/timer-state/:empId', (req, res) => {
  const agentId = 'emp_' + req.params.empId;
  const agent = appState.agents[agentId];
  if (!agent) return res.json({ found: false });
  res.json({
    found: true,
    onBreak:          agent.onBreak         || false,
    breakStartedAt:   agent.breakStartedAt  || null,
    totalBreakMs:     agent.totalBreakMs    || 0,
    breakAllowedMs:   BREAK_DURATION_MS,
    onWashroom:        agent.onWashroom       || false,
    washroomStartedAt: agent.washroomStartedAt || null,
    totalWashroomMs:   agent.totalWashroomMs   || 0,
    onMeeting:         agent.onMeeting         || false,
    meetingStartedAt:  agent.meetingStartedAt  || null,
    totalMeetingMs:    agent.totalMeetingMs    || 0
  });
});

// POST /api/sync/timer-action  — trigger a timer start/end by empId (called by other CRMs)
app.post('/api/sync/timer-action', (req, res) => {
  const { empId, type, action } = req.body;
  if (!empId || !type || !action) return res.status(400).json({ error: 'empId, type, action required' });
  const agentId = 'emp_' + empId;
  if (!appState.agents[agentId]) return res.json({ found: false });
  let result;
  if      (type === 'break'    && action === 'start') result = startBreak(agentId);
  else if (type === 'break'    && action === 'end')   result = endBreak(agentId);
  else if (type === 'washroom' && action === 'start') result = startWashroom(agentId);
  else if (type === 'washroom' && action === 'end')   result = endWashroom(agentId);
  else if (type === 'meeting'  && action === 'start') result = startMeeting(agentId);
  else if (type === 'meeting'  && action === 'end')   result = endMeeting(agentId);
  else return res.status(400).json({ error: 'Invalid type/action' });
  // Broadcast to all sockets on this server so the agent tab here also updates
  io.emit('timer-update', { agentId, type, action, ...result });
  broadcastAdminStats();
  res.json({ found: true, ...result });
});

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
      agentSocketMap.delete(socketAgentId);
      const agent = appState.agents[socketAgentId];
      if (agent) { agent.active = false; saveState(appState); }
      broadcastAdminStats();
    }
  });

  socket.on('agent-start', ({ agentId }) => {
    socketAgentId = agentId;
    agentSocketMap.set(agentId, socket.id);
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
    dead: 0, not_received: 0, not_interested: 0, followup: 0, switch_off: 0, interested: 0, discard: 0, dnd: 0
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

// Helper: resolve who added a DND number to a display name + role (agent / tl / admin)
// so admin.html and tl.html (TL mode) can show a note like "Added by Rohan (TL)".
function resolveDndAddedBy(rawId) {
  if (!rawId || rawId === 'admin') {
    return { id: 'admin', name: 'Admin', role: 'admin' };
  }
  const agent = appState.agents && appState.agents[rawId];
  if (agent) {
    const eid = agent.employeeId;
    const role = (eid && appState.allowedEids[eid]) ? getEidRole(appState.allowedEids[eid]) : 'agent';
    return { id: rawId, name: agent.name || rawId, role: role };
  }
  return { id: rawId, name: rawId, role: 'agent' };
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

  const agentId = 'emp_' + eid;

  // Remove from allowedEids
  delete appState.allowedEids[eid];

  // Remove agent runtime record
  delete appState.agents[agentId];

  // Clean up number references for the removed agent
  if (appState.numbers && Array.isArray(appState.numbers)) {
    appState.numbers.forEach(n => {
      // Release assigned numbers back to the pool
      if (n.assignedTo === agentId) {
        n.assignedTo = null;
      }
      // Release followup locks so others can manage them
      if (n.followupLockedBy === agentId) {
        n.followupLockedBy = null;
      }
      // Clear interested lead ownership so admin can reassign
      if (n.interestedBy === agentId) {
        n.interestedBy = null;
      }
    });
  }

  saveState(appState);

  // Force disconnect the agent's socket server-side if connected
  const agentSocketId = agentSocketMap.get(agentId);
  if (agentSocketId) {
    const agentSocket = io.sockets.sockets.get(agentSocketId);
    if (agentSocket) {
      agentSocket.emit('force-stop-agent', { agentId });
      agentSocket.disconnect(true);
    }
    agentSocketMap.delete(agentId);
  } else {
    // Fallback broadcast in case the map entry is stale or missing
    io.emit('force-stop-agent', { agentId });
  }

  // Broadcast updated stats so admin panel reflects the removal immediately
  broadcastAdminStats();

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
  let { employeeId, name } = req.body;
  if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
  const eidData = appState.allowedEids[employeeId];
  if (!eidData) return res.status(403).json({ error: 'Employee ID not recognised. Please contact your admin.' });
  if (!name || !name.trim()) { name = getEidName(eidData); }
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
  const agent = appState.agents[agentId];
  const lateLogin = (agent.firstLoginToday && agent.firstLoginToday > '10:00') || false;
  res.json({ success: true, agentId, name, employeeId, role, lateLogin });
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

  // Only keep agents that are still in the allowed-EID registry. `allowedEids`
  // is the authoritative list of current employees, so any agent whose EID is no
  // longer present has been removed by admin and must NOT appear in the rankings.
  // Note: we intentionally do NOT trust `appState.agents` here — a removed user's
  // runtime record can linger there and would otherwise show up as a ghost row.
  // The `.+` capture (instead of `\d+`) also covers non-numeric employee IDs.
  for (const aid of Object.keys(agentScores)) {
    const eidMatch = aid.match(/^emp_(.+)$/);
    const eidVal = eidMatch ? eidMatch[1] : null;
    if (!eidVal || !appState.allowedEids[eidVal]) {
      delete agentScores[aid];
    }
  }

  // New formula: MAX(0, MIN(100, (((100*Interested) + (25*FollowUp) - (10*NotInterested) - (15*NotEligible/discard) - (2*CNC) - (2*SwitchOff)) / (TotalCalls*100)) * 100))
  const rankings = Object.values(agentScores).map(a => {
    let score = 0;
    if (a.totalCalls > 0) {
      const rawScore = ((100 * a.interested) + (25 * a.followups) - (10 * a.notInterested) - (15 * a.discard) - (2 * a.dead) - (2 * a.switchOff)) / (a.totalCalls * 100) * 100;
      score = Math.max(0, Math.min(100, rawScore));
    }
    score = Math.round(score * 100) / 100;
    // Get profile photo
    const eidMatch = a.agentId.match(/^emp_(.+)$/);
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

  const formulaDescription = 'Score (0-100) = ((100 x Interested) + (25 x FollowUp) - (10 x NotInterested) - (15 x Not-Eligible) - (2 x CNC) - (2 x SwitchOff)) / (TotalCalls x 100) x 100. Higher interested and followup calls improve your score. Not Interested, Not-Eligible, CNC and SwitchOff reduce it.';

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
  // Force a full page reload on the agent's browser so dialing resumes immediately
  io.emit('force-page-reload', { agentId, reason: 'break-removed-by-admin' });
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

// ─── DND (Do Not Disturb) Management ──────────────────────────────────────────
app.get('/api/admin/dnd', (req, res) => {
  const list = (appState.dndNumbers || []).map(d => {
    const info = resolveDndAddedBy(d.addedBy);
    return Object.assign({}, d, { addedByName: info.name, addedByRole: info.role });
  });
  res.json({ dndNumbers: list });
});

app.post('/api/admin/dnd', (req, res) => {
  const { phone, addedBy } = req.body;
  if (!phone || !/^\d{7,15}$/.test(phone.replace(/\s+/g,''))) {
    return res.status(400).json({ error: 'Valid phone number required' });
  }
  const cleanPhone = phone.replace(/\s+/g,'');
  if (!appState.dndNumbers) appState.dndNumbers = [];
  if (appState.dndNumbers.find(d => d.phone === cleanPhone)) {
    return res.status(409).json({ error: 'Number already in DND list' });
  }
  // Respect who actually submitted this (agent / TL / admin); default to 'admin' only when nobody is identified.
  const info = resolveDndAddedBy(addedBy);
  appState.dndNumbers.push({ phone: cleanPhone, addedAt: new Date().toISOString(), addedBy: info.id });
  // Also mark any existing number with this phone as dnd
  const existing = appState.numbers.find(n => n.phone === cleanPhone);
  if (existing && existing.disposition !== 'interested') {
    existing.disposition = 'dnd';
    existing.permanent = true;
    existing.assignedTo = null;
  }
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true, phone: cleanPhone, addedByName: info.name, addedByRole: info.role });
});

app.delete('/api/admin/dnd/:phone', (req, res) => {
  const phone = req.params.phone;
  if (!appState.dndNumbers) appState.dndNumbers = [];
  const idx = appState.dndNumbers.findIndex(d => d.phone === phone);
  if (idx === -1) return res.status(404).json({ error: 'Number not in DND list' });
  appState.dndNumbers.splice(idx, 1);
  saveState(appState);
  res.json({ success: true });
});

// ─── Script Upload & Management (Feature 5) ──────────────────────────────────
const scriptUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, SCRIPTS_DIR),
    filename: (req, file, cb) => cb(null, 'call_script.txt')
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/plain' || file.originalname.toLowerCase().endsWith('.txt')) {
      cb(null, true);
    } else {
      cb(new Error('Only TXT files are allowed'));
    }
  }
});

app.post('/api/admin/upload-script', scriptUpload.single('script'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No TXT file uploaded' });
    res.json({ success: true, filename: req.file.originalname });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/script', (req, res) => {
  const scriptPath = path.join(SCRIPTS_DIR, 'call_script.txt');
  if (!fs.existsSync(scriptPath)) {
    return res.json({ script: null });
  }
  try {
    const content = fs.readFileSync(scriptPath, 'utf8');
    res.json({ script: content });
  } catch (e) {
    res.json({ script: null });
  }
});

// ─── Disposition Stats Copy (Feature 6) ───────────────────────────────────────
app.get('/api/stats/daily-numbers', (req, res) => {
  // Returns numbers dialed today between 10:00 AM and 5:43 PM IST, grouped by disposition
  const now = new Date();
  const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const istTodayStr = istNow.toISOString().slice(0, 10);
  
  // Today start at 10:00 AM IST and end at 5:43 PM IST
  const startIST = new Date(istTodayStr + 'T10:00:00.000+05:30');
  const endIST = new Date(istTodayStr + 'T17:43:00.000+05:30');
  
  // Filter dialed log for today between 10:00 AM and 5:43 PM
  const filteredLogs = appState.dialedLog.filter(entry => {
    if (!entry.timestamp) return false;
    const entryDate = new Date(entry.timestamp);
    return entryDate >= startIST && entryDate <= endIST;
  });
  
  // Group by disposition
  const groups = {};
  filteredLogs.forEach(entry => {
    const dispo = entry.disposition || 'unknown';
    if (!groups[dispo]) groups[dispo] = [];
    // Only add phone if not already in this disposition group
    if (!groups[dispo].includes(entry.phone)) {
      groups[dispo].push(entry.phone);
    }
  });
  
  // If no data, provide dummy data for testing
  const hasSomeData = Object.keys(groups).length > 0;
  if (!hasSomeData) {
    groups.dead = ['9876543210', '9876543211'];
    groups.not_received = ['9876543212', '9876543213'];
    groups.not_interested = ['9876543214'];
    groups.followup = ['9876543215'];
    groups.switch_off = ['9876543216'];
    groups.interested = ['9876543217'];
    groups._isDummy = true;
  }
  
  res.json({ 
    date: istTodayStr, 
    timeRange: '10:00 AM - 5:43 PM',
    groups,
    isDummy: !hasSomeData
  });
});

// ─── Admin: Download uploaded numbers sheet back as Excel ──────────────────────
app.get('/api/admin/download-numbers/:fileId', (req, res) => {
  const fid = req.params.fileId;
  const fileInfo = appState.uploadedFiles.find(f => f.id === fid);
  if (!fileInfo) return res.status(404).json({ error: 'File not found' });
  const fileNumbers = appState.numbers.filter(n => n.file === fid);
  if (fileNumbers.length === 0) return res.status(404).json({ error: 'No numbers found for this file' });
  const rows = [['Phone', 'Name', 'Disposition', 'Dialed By', 'Dialed At']];
  fileNumbers.forEach(n => {
    const agentName = n.dialedBy && appState.agents[n.dialedBy] ? appState.agents[n.dialedBy].name : (n.dialedBy || '');
    rows.push([n.phone || '', n.name || '', n.disposition || 'Pending', agentName, n.dialedAt || '']);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Numbers');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const downloadName = (fileInfo.name || 'numbers').replace(/\.[^.]+$/, '') + '_export.xlsx';
  res.setHeader('Content-Disposition', 'attachment; filename=' + encodeURIComponent(downloadName));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ─── Admin: Download the ORIGINAL uploaded sheet exactly as it was uploaded ────
// (Distinct from /download-numbers above, which regenerates a status export —
// this returns the literal file the admin uploaded, untouched.)
app.get('/api/admin/original-file/:fileId', (req, res) => {
  const fid = req.params.fileId;
  const fileInfo = appState.uploadedFiles.find(f => f.id === fid);
  if (!fileInfo || !fileInfo.sheetPath || !fs.existsSync(fileInfo.sheetPath)) {
    return res.status(404).json({ error: 'Original file is not available for this upload (uploaded before this feature, or already removed).' });
  }
  res.download(fileInfo.sheetPath, fileInfo.name);
});

// ─── Manual Lead Addition (Agent / TL-Agent) ──────────────────────────────────
app.post('/api/agent/add-manual-number', (req, res) => {
  const { agentId, phone, name } = req.body;
  const clean = String(phone || '').trim().replace(/\s+/g, '');
  if (!/^\d{10}$/.test(clean)) return res.status(400).json({ error: 'Valid 10-digit phone required' });
  if (appState.numbers.find(n => n.phone === clean)) return res.status(400).json({ error: 'Number already exists in system' });
  let manualFile = appState.uploadedFiles.find(f => f.id === 'manual');
  if (!manualFile) {
    manualFile = { id: 'manual', name: 'Manual Entries', uploadedAt: new Date().toISOString(), total: 0, hasOriginal: false };
    appState.uploadedFiles.push(manualFile);
  }
  const newNum = { id: uuidv4(), phone: clean, name: String(name || '').trim(), file: 'manual', assignedTo: null, dialedBy: null, dialedAt: null };
  appState.numbers.push(newNum);
  manualFile.total = appState.numbers.filter(n => n.file === 'manual').length;
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true, numberId: newNum.id });
});

// Remove a number from pool — blocked if lead is interested (real business data)
app.delete('/api/agent/number/:numberId', (req, res) => {
  const num = appState.numbers.find(n => n.id === req.params.numberId);
  if (!num) return res.status(404).json({ error: 'Number not found' });
  if (num.disposition === 'interested') return res.status(400).json({ error: 'Cannot remove an interested lead' });
  appState.numbers = appState.numbers.filter(n => n.id !== req.params.numberId);
  const manualFile = appState.uploadedFiles.find(f => f.id === 'manual');
  if (manualFile) manualFile.total = appState.numbers.filter(n => n.file === 'manual').length;
  saveState(appState);
  broadcastAdminStats();
  res.json({ success: true });
});

// ─── Call Recording Uploads ─────────────────────────────────────────────────────
// Configure multer for recording uploads
const recordingStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(DATA_ROOT, 'uploads', 'recordings');
    ensureDir(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${timestamp}_${sanitizedName}`);
  }
});

const uploadRecording = multer({
  storage: recordingStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav',
      'audio/ogg', 'audio/webm', 'audio/aac', 'audio/m4a', 'audio/x-m4a',
      'audio/flac', 'audio/x-flac', 'audio/amr', 'audio/3gpp', 'audio/3gpp2',
      'audio/mp4', 'audio/opus', 'audio/x-ms-wma', 'audio/aiff', 'audio/x-aiff',
      'audio/basic', 'audio/x-caf', 'application/octet-stream'
    ];
    if (allowedMimes.includes(file.mimetype) || file.originalname.match(/\.(mp3|wav|ogg|webm|aac|m4a|flac|amr|3gp|opus|wma|aiff|caf|pcm)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only audio files are allowed.'));
    }
  }
});

// Auto-delete recordings older than 7 days
async function cleanupOldRecordings() {
  try {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const recordingsDir = path.join(DATA_ROOT, 'uploads', 'recordings');
    if (!fs.existsSync(recordingsDir)) return;
    const oldRecordings = (appState.recordings || []).filter(rec => rec.uploadDate < sevenDaysAgo);
    for (const recording of oldRecordings) {
      try {
        const filePath = path.join(recordingsDir, recording.filename);
        if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); console.log(`Deleted old recording: ${recording.filename}`); }
      } catch (error) { console.error(`Error deleting file ${recording.filename}:`, error); }
    }
    appState.recordings = (appState.recordings || []).filter(rec => rec.uploadDate >= sevenDaysAgo);
    saveState(appState);
    if (oldRecordings.length > 0) console.log(`Cleanup complete: Removed ${oldRecordings.length} old recordings`);
  } catch (error) { console.error('Error during cleanup:', error); }
}

// Run cleanup every hour and on startup
setInterval(cleanupOldRecordings, 60 * 60 * 1000);
setTimeout(cleanupOldRecordings, 10000);

// Serve uploaded recordings
app.use('/uploads/recordings', express.static(path.join(DATA_ROOT, 'uploads', 'recordings')));

// Recording upload endpoint
app.post('/api/recordings/upload', uploadRecording.array('recordings', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const { agentName, agentEmail, leadPhone, leadName } = req.body;
    const uploadedRecordings = req.files.map(file => ({
      id: Date.now() + Math.random().toString(36).substr(2, 9),
      filename: file.filename,
      originalName: file.originalname,
      agentName: agentName || 'Unknown',
      agentEmail: agentEmail || '',
      leadPhone: leadPhone || '',
      leadName: leadName || '',
      uploadDate: Date.now(),
      fileSize: file.size,
      important: false,
      path: file.path
    }));
    if (!appState.recordings) appState.recordings = [];
    appState.recordings.push(...uploadedRecordings);
    saveState(appState);
    res.json({ success: true, recordings: uploadedRecordings, message: `${uploadedRecordings.length} recording(s) uploaded successfully` });
  } catch (error) { console.error('Upload error:', error); res.status(500).json({ error: 'Failed to upload recordings' }); }
});

// Get recordings with filters
app.get('/api/recordings', (req, res) => {
  const { agent, date, important } = req.query;
  let filteredRecordings = [...(appState.recordings || [])];
  if (agent && agent !== 'all') {
    filteredRecordings = filteredRecordings.filter(rec =>
      (rec.agentName || '').toLowerCase().includes(agent.toLowerCase()) ||
      (rec.agentEmail || '').toLowerCase().includes(agent.toLowerCase())
    );
  }
  if (date) {
    const targetDate = new Date(date).setHours(0, 0, 0, 0);
    filteredRecordings = filteredRecordings.filter(rec => {
      const recMs = typeof rec.uploadDate === 'number' ? rec.uploadDate : Date.parse(rec.uploadDate);
      return new Date(recMs).setHours(0,0,0,0) === targetDate;
    });
  }
  if (important === 'true') filteredRecordings = filteredRecordings.filter(rec => rec.important);
  filteredRecordings.sort((a, b) => {
    const tsA = typeof a.uploadDate === 'number' ? a.uploadDate : Date.parse(a.uploadDate || 0);
    const tsB = typeof b.uploadDate === 'number' ? b.uploadDate : Date.parse(b.uploadDate || 0);
    return tsB - tsA;
  });
  const allRecordings = appState.recordings || [];
  const todayMs = new Date().setHours(0,0,0,0);
  const todayCount = allRecordings.filter(rec => {
    const ts = typeof rec.uploadDate === 'number' ? rec.uploadDate : Date.parse(rec.uploadDate || 0);
    return ts >= todayMs;
  }).length;
  res.json({
    recordings: filteredRecordings,
    stats: { total: allRecordings.length, today: todayCount, important: allRecordings.filter(r => r.important).length }
  });
});

// Toggle important flag
app.patch('/api/recordings/:id/important', (req, res) => {
  const { id } = req.params;
  const { important } = req.body;
  if (!appState.recordings) return res.status(404).json({ error: 'Recording not found' });
  const recording = appState.recordings.find(rec => rec.id === id);
  if (!recording) return res.status(404).json({ error: 'Recording not found' });
  recording.important = important !== undefined ? important : !recording.important;
  saveState(appState);
  res.json({ success: true, recording, important: recording.important });
});

// Delete a recording
app.delete('/api/recordings/:id', (req, res) => {
  const { id } = req.params;
  if (!appState.recordings) return res.status(404).json({ error: 'Recording not found' });
  const idx = appState.recordings.findIndex(rec => rec.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Recording not found' });
  const recording = appState.recordings[idx];
  const filePath = path.join(DATA_ROOT, 'uploads', 'recordings', recording.filename);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  appState.recordings.splice(idx, 1);
  saveState(appState);
  res.json({ success: true });
});

// Download a specific recording by ID
app.get('/api/recordings/:id/download', (req, res) => {
  const { id } = req.params;
  if (!appState.recordings) return res.status(404).json({ error: 'Recording not found' });
  const recording = appState.recordings.find(rec => rec.id == id);
  if (!recording) return res.status(404).json({ error: 'Recording not found' });
  const filePath = path.join(DATA_ROOT, 'uploads', 'recordings', recording.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Recording file not found on disk' });
  res.setHeader('Content-Disposition', 'attachment; filename="' + (recording.originalName || recording.filename).replace(/"/g, '') + '"');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(filePath);
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


