const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pm2 = require('pm2');

const SESSION_COOKIE = 'pm2_manager_session';
const PM2_HOME = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
const AUTH_FILE = process.env.PM2_MANAGER_AUTH_FILE || path.join(PM2_HOME, 'pm2-manager-auth.json');
const HISTORY_FILE = process.env.PM2_MANAGER_HISTORY_FILE || path.join(PM2_HOME, 'pm2-manager-overview-history.json');
const SAMPLE_INTERVAL_MS = Math.min(5 * 60 * 1000, Math.max(15 * 1000, Number(process.env.PM2_MANAGER_HISTORY_SAMPLE_MS || 60 * 1000)));
const TIMELINE_INTERVAL_MS = Math.min(30 * 60 * 1000, Math.max(60 * 1000, Number(process.env.PM2_MANAGER_HISTORY_TIMELINE_MS || 5 * 60 * 1000)));
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TIMELINE_POINTS = Math.min(96, Math.max(24, Number(process.env.PM2_MANAGER_HISTORY_POINTS || 48)));

let state = loadState();
let collecting = false;
let collectionTimer = null;
let lastCollectedAt = Number(state.updatedAt || 0);
let authCache = { mtimeMs: 0, value: null };

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!key) continue;
    try { cookies[key] = decodeURIComponent(raw); } catch (_) { cookies[key] = raw; }
  }
  return cookies;
}

function loadAuthConfig() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  const stat = fs.statSync(AUTH_FILE);
  if (authCache.value && authCache.mtimeMs === stat.mtimeMs) return authCache.value;
  const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  authCache = { mtimeMs: stat.mtimeMs, value: parsed };
  return parsed;
}

function verifySession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const [encoded, signature, extra] = String(token).split('.');
  if (!encoded || !signature || extra) return null;

  const config = loadAuthConfig();
  if (!config?.sessionSecret || !Array.isArray(config.users)) return null;
  const expected = crypto.createHmac('sha256', Buffer.from(config.sessionSecret, 'hex')).update(encoded).digest('base64url');
  if (!safeEqual(signature, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
    const user = config.users.find((item) => String(item.id) === String(payload.uid));
    if (!user || user.active === false) return null;
    if (payload.u !== user.username || payload.role !== user.role || Number(payload.v) !== Number(user.sessionVersion || 1)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function defaultState() {
  return { version: 1, updatedAt: null, processes: {} };
}

function loadState() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!parsed || parsed.version !== 1 || typeof parsed.processes !== 'object') return defaultState();
    return parsed;
  } catch (error) {
    console.error('Falha ao carregar histórico do overview:', error.message);
    return defaultState();
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true, mode: 0o700 });
    const temporary = `${HISTORY_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' });
    fs.renameSync(temporary, HISTORY_FILE);
    if (process.platform !== 'win32') fs.chmodSync(HISTORY_FILE, 0o600);
  } catch (error) {
    console.error('Falha ao salvar histórico do overview:', error.message);
  }
}

function processKey(name, namespace) {
  return `${String(namespace || 'default')}\u0000${String(name || '')}`;
}

function listPm2() {
  return new Promise((resolve, reject) => {
    pm2.list((error, list) => (error ? reject(error) : resolve(list || [])));
  });
}

function trimEntry(entry, now) {
  entry.timeline = Array.isArray(entry.timeline) ? entry.timeline.slice(-TIMELINE_POINTS) : [];
  entry.restartEvents = Array.isArray(entry.restartEvents)
    ? entry.restartEvents.filter((event) => Number(event.at) >= now - RETENTION_MS)
    : [];
}

async function collectSnapshot() {
  if (collecting || Date.now() - lastCollectedAt < SAMPLE_INTERVAL_MS) return;
  collecting = true;

  try {
    const list = await listPm2();
    const now = Date.now();
    const seen = new Set();

    for (const proc of list) {
      const env = proc.pm2_env || {};
      const name = String(proc.name || `process-${proc.pm_id}`);
      const namespace = String(env.namespace || 'default');
      const key = processKey(name, namespace);
      const status = String(env.status || 'unknown').toLowerCase();
      const restarts = Math.max(0, Number(env.restart_time || 0));
      seen.add(key);

      let entry = state.processes[key];
      if (!entry) {
        entry = state.processes[key] = {
          name,
          namespace,
          firstSeen: now,
          lastSeen: now,
          lastStatus: status,
          lastRestartCount: restarts,
          timeline: [],
          restartEvents: [],
        };
      }

      entry.name = name;
      entry.namespace = namespace;
      entry.lastSeen = now;

      const previousRestartCount = Number(entry.lastRestartCount);
      if (Number.isFinite(previousRestartCount) && restarts > previousRestartCount) {
        entry.restartEvents.push({ at: now, count: restarts - previousRestartCount });
      }
      entry.lastRestartCount = restarts;

      const lastPoint = entry.timeline[entry.timeline.length - 1];
      const statusChanged = entry.lastStatus !== status;
      if (!lastPoint || statusChanged || now - Number(lastPoint.at || 0) >= TIMELINE_INTERVAL_MS) {
        entry.timeline.push({ at: now, status });
      }
      entry.lastStatus = status;
      trimEntry(entry, now);
    }

    for (const [key, entry] of Object.entries(state.processes)) {
      trimEntry(entry, now);
      if (!seen.has(key) && Number(entry.lastSeen || 0) < now - RETENTION_MS) delete state.processes[key];
    }

    state.updatedAt = now;
    lastCollectedAt = now;
    saveState();
  } catch (error) {
    console.error('Falha ao coletar histórico do PM2:', error.message);
  } finally {
    collecting = false;
  }
}

function countRestarts(entry, since) {
  return (entry.restartEvents || []).reduce((total, event) => {
    if (Number(event.at) < since) return total;
    return total + Math.max(0, Number(event.count || 0));
  }, 0);
}

function responsePayload() {
  const now = Date.now();
  return {
    sampledAt: state.updatedAt,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    timelineIntervalMs: TIMELINE_INTERVAL_MS,
    retentionMs: RETENTION_MS,
    processes: Object.values(state.processes).map((entry) => ({
      name: entry.name,
      namespace: entry.namespace,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      timeline: (entry.timeline || []).slice(-TIMELINE_POINTS),
      restarts: {
        hour: countRestarts(entry, now - 60 * 60 * 1000),
        day: countRestarts(entry, now - 24 * 60 * 60 * 1000),
        week: countRestarts(entry, now - RETENTION_MS),
      },
    })),
  };
}

function installRoutes(app, express) {
  const router = express.Router();
  router.use((req, res, next) => {
    const session = verifySession(req);
    if (!session) return res.status(401).json({ error: 'Sessão expirada ou não autenticada.' });
    res.setHeader('Cache-Control', 'no-store');
    req.auth = session;
    next();
  });

  router.get('/history', async (req, res) => {
    await collectSnapshot();
    res.json(responsePayload());
  });

  app.use('/api/overview', router);
}

function startCollector() {
  if (collectionTimer) return;
  setTimeout(() => collectSnapshot(), 10000).unref?.();
  collectionTimer = setInterval(() => collectSnapshot(), SAMPLE_INTERVAL_MS);
  collectionTimer.unref?.();
}

function installOverviewExtension() {
  const expressPath = require.resolve('express');
  const original = require(expressPath);

  function wrappedExpress(...args) {
    const app = original(...args);
    installRoutes(app, original);
    startCollector();
    return app;
  }

  Object.assign(wrappedExpress, original);
  Object.setPrototypeOf(wrappedExpress, Object.getPrototypeOf(original));
  require.cache[expressPath].exports = wrappedExpress;
}

module.exports = { installOverviewExtension };
