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
const TIMELINE_INTERVAL_MS = Math.min(10 * 60 * 1000, Math.max(15 * 1000, Number(process.env.PM2_MANAGER_HISTORY_TIMELINE_MS || 60 * 1000)));
const LIVE_INTERVAL_MS = Math.min(15 * 1000, Math.max(2 * 1000, Number(process.env.PM2_MANAGER_LIVE_INTERVAL_MS || 3000)));
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TIMELINE_POINTS = Math.min(288, Math.max(48, Number(process.env.PM2_MANAGER_HISTORY_POINTS || 120)));
const EVENT_KEEP = Math.min(1000, Math.max(100, Number(process.env.PM2_MANAGER_EVENT_KEEP || 300)));

let state = loadState();
let collecting = false;
let collectionTimer = null;
let liveTimer = null;
let liveBroadcasting = false;
let lastCollectedAt = Number(state.updatedAt || 0);
let authCache = { mtimeMs: 0, value: null };
let previousCpuSample = null;
const liveClients = new Set();

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
  return { version: 2, updatedAt: null, processes: {}, events: [] };
}

function loadState() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!parsed || ![1, 2].includes(Number(parsed.version)) || typeof parsed.processes !== 'object') return defaultState();
    return {
      version: 2,
      updatedAt: parsed.updatedAt || null,
      processes: parsed.processes || {},
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
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

function normalizeProcess(proc) {
  const env = proc.pm2_env || {};
  const monit = proc.monit || {};
  return {
    pm_id: proc.pm_id,
    name: proc.name,
    status: env.status || 'unknown',
    namespace: env.namespace || 'default',
    mode: env.exec_mode || '',
    pid: proc.pid || null,
    cpu: Number(monit.cpu || 0),
    memory: Number(monit.memory || 0),
    restarts: Number(env.restart_time || 0),
    uptime: env.pm_uptime || null,
    createdAt: env.created_at || null,
    cwd: env.pm_cwd || '',
    script: env.pm_exec_path || '',
    version: env.version || '',
    nodeVersion: env.node_version || '',
    protected: proc.name === (process.env.PM2_MANAGER_PROCESS_NAME || 'pm2-manager'),
  };
}

function addEvent(event) {
  state.events.push({ id: crypto.randomUUID(), at: Date.now(), ...event });
  const cutoff = Date.now() - RETENTION_MS;
  state.events = state.events.filter((item) => Number(item.at || 0) >= cutoff).slice(-EVENT_KEEP);
}

function trimEntry(entry, now) {
  entry.timeline = Array.isArray(entry.timeline) ? entry.timeline.slice(-TIMELINE_POINTS) : [];
  entry.restartEvents = Array.isArray(entry.restartEvents)
    ? entry.restartEvents.filter((event) => Number(event.at) >= now - RETENTION_MS)
    : [];
}

async function collectSnapshot(existingList = null, force = false) {
  if (collecting || (!force && Date.now() - lastCollectedAt < SAMPLE_INTERVAL_MS)) return;
  collecting = true;

  try {
    const list = existingList || await listPm2();
    const now = Date.now();
    const seen = new Set();

    for (const proc of list) {
      const env = proc.pm2_env || {};
      const monit = proc.monit || {};
      const name = String(proc.name || `process-${proc.pm_id}`);
      const namespace = String(env.namespace || 'default');
      const key = processKey(name, namespace);
      const status = String(env.status || 'unknown').toLowerCase();
      const restarts = Math.max(0, Number(env.restart_time || 0));
      const cpu = Math.max(0, Number(monit.cpu || 0));
      const memory = Math.max(0, Number(monit.memory || 0));
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

      const previousStatus = entry.lastStatus;
      const previousRestartCount = Number(entry.lastRestartCount);
      const restartDelta = Number.isFinite(previousRestartCount) && restarts > previousRestartCount
        ? restarts - previousRestartCount
        : 0;

      if (restartDelta > 0) {
        entry.restartEvents.push({ at: now, count: restartDelta });
        addEvent({ type: 'restart', name, namespace, count: restartDelta, status });
      }

      if (previousStatus && previousStatus !== status) {
        addEvent({ type: 'status', name, namespace, from: previousStatus, to: status, status });
      }

      entry.lastRestartCount = restarts;
      const lastPoint = entry.timeline[entry.timeline.length - 1];
      const statusChanged = previousStatus !== status;
      if (!lastPoint || statusChanged || restartDelta > 0 || now - Number(lastPoint.at || 0) >= TIMELINE_INTERVAL_MS) {
        entry.timeline.push({ at: now, status, cpu, memory, restarts });
      } else {
        lastPoint.cpu = cpu;
        lastPoint.memory = memory;
        lastPoint.restarts = restarts;
      }

      entry.lastStatus = status;
      trimEntry(entry, now);
    }

    for (const [key, entry] of Object.entries(state.processes)) {
      trimEntry(entry, now);
      if (!seen.has(key) && Number(entry.lastSeen || 0) < now - RETENTION_MS) delete state.processes[key];
    }

    state.version = 2;
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
  return (entry?.restartEvents || []).reduce((total, event) => {
    if (Number(event.at) < since) return total;
    return total + Math.max(0, Number(event.count || 0));
  }, 0);
}

function restartWindows(entry, now = Date.now()) {
  return {
    hour: countRestarts(entry, now - 60 * 60 * 1000),
    day: countRestarts(entry, now - 24 * 60 * 60 * 1000),
    week: countRestarts(entry, now - RETENTION_MS),
  };
}

function healthFor(proc, entry) {
  const reasons = [];
  const status = String(proc.status || 'unknown').toLowerCase();
  const recent = entry?.restarts && typeof entry.restarts === 'object' ? entry.restarts : restartWindows(entry);
  let score = 100;

  if (status === 'errored') {
    score -= 90;
    reasons.push('processo em erro');
  } else if (status !== 'online') {
    score -= 70;
    reasons.push(`status ${status}`);
  }

  if (recent.hour >= 3) {
    score -= 45;
    reasons.push(`${recent.hour} reinícios na última hora`);
  } else if (recent.hour > 0) {
    score -= 18;
    reasons.push(`${recent.hour} reinício(s) na última hora`);
  }

  if (recent.day >= 8) {
    score -= 30;
    reasons.push(`${recent.day} reinícios em 24h`);
  } else if (recent.day >= 3) {
    score -= 15;
    reasons.push(`${recent.day} reinícios em 24h`);
  }

  if (Number(proc.cpu || 0) >= 95) {
    score -= 25;
    reasons.push('CPU muito alta');
  } else if (Number(proc.cpu || 0) >= 80) {
    score -= 12;
    reasons.push('CPU alta');
  }

  const uptimeMs = proc.uptime ? Date.now() - Number(proc.uptime) : null;
  if (status === 'online' && recent.hour > 0 && uptimeMs !== null && uptimeMs < 5 * 60 * 1000) {
    score -= 10;
    reasons.push('uptime recente após reinício');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let level = 'healthy';
  if (status === 'errored' || score < 40) level = 'critical';
  else if (score < 65) level = 'unstable';
  else if (score < 85) level = 'attention';

  return { score, level, reasons: reasons.slice(0, 3), restarts: recent };
}

function responsePayload() {
  const now = Date.now();
  return {
    sampledAt: state.updatedAt,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    timelineIntervalMs: TIMELINE_INTERVAL_MS,
    retentionMs: RETENTION_MS,
    events: [...state.events].reverse().slice(0, 100),
    processes: Object.values(state.processes).map((entry) => ({
      name: entry.name,
      namespace: entry.namespace,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      timeline: (entry.timeline || []).slice(-TIMELINE_POINTS),
      restarts: restartWindows(entry, now),
    })),
  };
}

function cpuCounters() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times || {})) total += Number(value || 0);
    idle += Number(cpu.times?.idle || 0);
  }
  return { idle, total };
}

function cpuPercent() {
  const current = cpuCounters();
  if (!previousCpuSample) {
    previousCpuSample = current;
    return 0;
  }
  const totalDelta = current.total - previousCpuSample.total;
  const idleDelta = current.idle - previousCpuSample.idle;
  previousCpuSample = current;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Number(((1 - idleDelta / totalDelta) * 100).toFixed(1))));
}

async function diskMetrics() {
  const root = path.parse(process.cwd()).root || '/';
  if (typeof fs.promises.statfs !== 'function') return { path: root, total: null, free: null, used: null, percent: null };
  try {
    const info = await fs.promises.statfs(root);
    const blockSize = Number(info.bsize || info.frsize || 0);
    const total = Number(info.blocks || 0) * blockSize;
    const free = Number(info.bavail ?? info.bfree ?? 0) * blockSize;
    const used = Math.max(0, total - free);
    const percent = total > 0 ? Number(((used / total) * 100).toFixed(1)) : null;
    return { path: root, total, free, used, percent };
  } catch (_) {
    return { path: root, total: null, free: null, used: null, percent: null };
  }
}

function pm2Version() {
  try { return require('pm2/package.json').version || ''; } catch (_) { return ''; }
}

async function serverMetrics() {
  const totalMemory = Number(os.totalmem() || 0);
  const freeMemory = Number(os.freemem() || 0);
  const usedMemory = Math.max(0, totalMemory - freeMemory);
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    nodeVersion: process.version,
    pm2Version: pm2Version(),
    uptime: os.uptime(),
    loadavg: os.loadavg(),
    cpuCount: os.cpus().length,
    cpuPercent: cpuPercent(),
    totalMemory,
    freeMemory,
    usedMemory,
    memoryPercent: totalMemory > 0 ? Number(((usedMemory / totalMemory) * 100).toFixed(1)) : 0,
    disk: await diskMetrics(),
  };
}

async function buildSnapshot() {
  const list = await listPm2();
  await collectSnapshot(list);
  const history = responsePayload();
  const historyMap = new Map(history.processes.map((item) => [processKey(item.name, item.namespace), item]));
  const processes = list.map(normalizeProcess).map((proc) => ({
    ...proc,
    health: healthFor(proc, historyMap.get(processKey(proc.name, proc.namespace))),
  }));
  return {
    at: Date.now(),
    processes,
    history,
    server: await serverMetrics(),
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

  router.get('/snapshot', async (req, res) => {
    try {
      res.json(await buildSnapshot());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/server', async (req, res) => {
    try {
      res.json(await serverMetrics());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/stream', async (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 5000\n\n');
    liveClients.add(res);

    const remainingSessionMs = Math.max(1000, Number(req.auth.exp || 0) - Date.now());
    const expiryTimer = setTimeout(() => {
      try { res.write(`event: auth_expired\ndata: ${JSON.stringify({ expired: true })}\n\n`); } catch (_) { /* conexão encerrada */ }
      liveClients.delete(res);
      res.end();
    }, remainingSessionMs);
    expiryTimer.unref?.();

    try {
      const snapshot = await buildSnapshot();
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    } catch (error) {
      res.write(`event: warning\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    }

    req.on('close', () => {
      clearTimeout(expiryTimer);
      liveClients.delete(res);
    });
  });

  app.use('/api/overview', router);
}

async function broadcastLive() {
  if (liveBroadcasting || liveClients.size === 0) return;
  liveBroadcasting = true;
  try {
    const snapshot = await buildSnapshot();
    const message = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of [...liveClients]) {
      try { client.write(message); } catch (_) { liveClients.delete(client); }
    }
  } catch (error) {
    const message = `event: warning\ndata: ${JSON.stringify({ error: error.message })}\n\n`;
    for (const client of [...liveClients]) {
      try { client.write(message); } catch (_) { liveClients.delete(client); }
    }
  } finally {
    liveBroadcasting = false;
  }
}

function startCollector() {
  if (!collectionTimer) {
    setTimeout(() => collectSnapshot(), 10000).unref?.();
    collectionTimer = setInterval(() => collectSnapshot(), SAMPLE_INTERVAL_MS);
    collectionTimer.unref?.();
  }
  if (!liveTimer) {
    liveTimer = setInterval(() => broadcastLive(), LIVE_INTERVAL_MS);
    liveTimer.unref?.();
  }
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
