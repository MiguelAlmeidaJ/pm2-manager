const express = require('express');
const pm2 = require('pm2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 4333);
const HOST = process.env.HOST || '127.0.0.1';
const SELF_NAME = process.env.PM2_MANAGER_PROCESS_NAME || 'pm2-manager';
const PM2_HOME = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
const DUMP_PATH = path.join(PM2_HOME, 'dump.pm2');
const BACKUP_DIR = process.env.PM2_MANAGER_BACKUP_DIR || path.join(PM2_HOME, 'manager-backups');
const BACKUP_KEEP = Math.max(5, Number(process.env.PM2_MANAGER_BACKUP_KEEP || 30));
const AUTH_FILE = process.env.PM2_MANAGER_AUTH_FILE || path.join(PM2_HOME, 'pm2-manager-auth.json');
const SESSION_COOKIE = 'pm2_manager_session';
const SESSION_HOURS = Math.min(24, Math.max(1, Number(process.env.PM2_MANAGER_SESSION_HOURS || 8)));
const SESSION_TTL_MS = SESSION_HOURS * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

let dirtySince = null;
let authConfig = null;
const loginFailures = new Map();

app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});

function connectPM2() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => (err ? reject(err) : resolve()));
  });
}

function listPM2() {
  return new Promise((resolve, reject) => {
    pm2.list((err, list) => (err ? reject(err) : resolve(list)));
  });
}

function describePM2(id) {
  return new Promise((resolve, reject) => {
    pm2.describe(id, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function pm2Action(action, id) {
  return new Promise((resolve, reject) => {
    const fn = pm2[action];
    if (typeof fn !== 'function') return reject(new Error('Ação inválida'));
    fn.call(pm2, id, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function pm2Dump() {
  return new Promise((resolve, reject) => {
    pm2.dump((err, result) => (err ? reject(err) : resolve(result)));
  });
}

function normalizeProcess(proc) {
  const env = proc.pm2_env || {};
  const monit = proc.monit || {};
  const protectedProcess = proc.name === SELF_NAME;

  return {
    pm_id: proc.pm_id,
    name: proc.name,
    status: env.status || 'unknown',
    namespace: env.namespace || 'default',
    mode: env.exec_mode || '',
    pid: proc.pid || null,
    cpu: monit.cpu || 0,
    memory: monit.memory || 0,
    restarts: env.restart_time || 0,
    uptime: env.pm_uptime || null,
    createdAt: env.created_at || null,
    cwd: env.pm_cwd || '',
    script: env.pm_exec_path || '',
    version: env.version || '',
    nodeVersion: env.node_version || '',
    protected: protectedProcess,
  };
}

function readLastLines(filePath, maxLines = 150) {
  if (!filePath || !fs.existsSync(filePath)) return '';

  const stat = fs.statSync(filePath);
  const maxBytes = 256 * 1024;
  const start = Math.max(0, stat.size - maxBytes);
  const size = stat.size - start;
  const fd = fs.openSync(filePath, 'r');

  try {
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, start);

    return buffer
      .toString('utf8')
      .split(/\r?\n/)
      .slice(-maxLines)
      .join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitizeLabel(label = 'manual') {
  return String(label).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30) || 'manual';
}

function readDump(filePath = DUMP_PATH) {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('O dump do PM2 não possui o formato esperado.');
  return parsed;
}

function listBackups() {
  ensureBackupDir();

  return fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^dump-\d{8}-\d{6}-[a-z0-9-]+\.pm2$/.test(name))
    .map((name) => {
      const filePath = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(filePath);
      let processCount = null;

      try {
        processCount = readDump(filePath).length;
      } catch (_) {
        processCount = null;
      }

      return {
        name,
        size: stat.size,
        createdAt: stat.mtimeMs,
        processCount,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function pruneBackups() {
  const backups = listBackups();
  for (const backup of backups.slice(BACKUP_KEEP)) {
    fs.unlinkSync(path.join(BACKUP_DIR, backup.name));
  }
}

function backupCurrentDump(label = 'manual') {
  if (!fs.existsSync(DUMP_PATH)) return null;

  ensureBackupDir();
  const filename = `dump-${timestamp()}-${sanitizeLabel(label)}.pm2`;
  const destination = path.join(BACKUP_DIR, filename);
  fs.copyFileSync(DUMP_PATH, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  pruneBackups();

  const stat = fs.statSync(destination);
  return {
    name: filename,
    size: stat.size,
    createdAt: stat.mtimeMs,
    processCount: readDump(destination).length,
  };
}

function resolveBackup(filename) {
  const safe = path.basename(String(filename || ''));
  if (safe !== filename || !/^dump-\d{8}-\d{6}-[a-z0-9-]+\.pm2$/.test(safe)) {
    throw new Error('Backup inválido.');
  }

  const filePath = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(filePath)) throw new Error('Backup não encontrado.');
  return filePath;
}

function getSaveState() {
  const hasDump = fs.existsSync(DUMP_PATH);
  let lastSavedAt = null;
  let dumpSize = 0;
  let savedProcessCount = 0;

  if (hasDump) {
    const stat = fs.statSync(DUMP_PATH);
    lastSavedAt = stat.mtimeMs;
    dumpSize = stat.size;

    try {
      savedProcessCount = readDump().length;
    } catch (_) {
      savedProcessCount = null;
    }
  }

  return {
    hasDump,
    lastSavedAt,
    dumpSize,
    savedProcessCount,
    dirtySince,
    backupCount: listBackups().length,
    backupKeep: BACKUP_KEEP,
  };
}

function loadAuthConfig() {
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error(
      `Autenticação não configurada. Execute "npm run auth:setup" com o mesmo usuário do PM2. Arquivo esperado: ${AUTH_FILE}`
    );
  }

  if (process.platform !== 'win32') {
    const mode = fs.statSync(AUTH_FILE).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(`Permissões inseguras em ${AUTH_FILE}. Use: chmod 600 "${AUTH_FILE}"`);
    }
  }

  const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));

  if (!parsed.username || typeof parsed.username !== 'string') {
    throw new Error('Configuração de autenticação inválida: username ausente.');
  }

  if (!parsed.passwordHash || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i.test(parsed.passwordHash)) {
    throw new Error('Configuração de autenticação inválida: passwordHash inválido.');
  }

  if (!parsed.sessionSecret || !/^[a-f0-9]{128}$/i.test(parsed.sessionSecret)) {
    throw new Error('Configuração de autenticação inválida: sessionSecret inválido.');
  }

  return parsed;
}

function safeEqualString(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function verifyPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    const [, saltHex, expectedHex] = storedHash.split('$');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(expectedHex, 'hex');

    crypto.scrypt(String(password || ''), salt, expected.length, (err, derived) => {
      if (err) return reject(err);
      resolve(crypto.timingSafeEqual(derived, expected));
    });
  });
}

function parseCookies(req) {
  const result = {};
  const header = req.headers.cookie || '';

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;

    try {
      result[key] = decodeURIComponent(value);
    } catch (_) {
      result[key] = value;
    }
  }

  return result;
}

function signSession(username) {
  const payload = {
    u: username,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    csrf: crypto.randomBytes(24).toString('base64url'),
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', Buffer.from(authConfig.sessionSecret, 'hex'))
    .update(encoded)
    .digest('base64url');

  return { token: `${encoded}.${signature}`, payload };
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;

  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return null;

  const expected = crypto
    .createHmac('sha256', Buffer.from(authConfig.sessionSecret, 'hex'))
    .update(encoded)
    .digest('base64url');

  if (!safeEqualString(signature, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || payload.u !== authConfig.username) return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
    if (!payload.csrf || typeof payload.csrf !== 'string') return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function getSession(req) {
  return verifySessionToken(parseCookies(req)[SESSION_COOKIE]);
}

function isSecureRequest(req) {
  return Boolean(req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

function setSessionCookie(req, res, token) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];

  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];

  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function requirePageAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  req.auth = session;
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function requireApiAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Sessão expirada ou não autenticada.' });
  req.auth = session;
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function requireCsrfForUnsafe(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const token = req.get('x-csrf-token') || '';
  if (!safeEqualString(token, req.auth.csrf)) {
    return res.status(403).json({ error: 'Token de segurança inválido. Atualize a página e tente novamente.' });
  }

  next();
}

function getClientKey(req) {
  return String(req.ip || req.socket.remoteAddress || 'unknown');
}

function getLoginBlock(req) {
  const key = getClientKey(req);
  const current = loginFailures.get(key);
  if (!current) return null;

  if (Date.now() - current.firstFailure >= LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return null;
  }

  if (current.count < LOGIN_MAX_FAILURES) return null;
  return { retryAfterMs: LOGIN_WINDOW_MS - (Date.now() - current.firstFailure) };
}

function registerLoginFailure(req) {
  const key = getClientKey(req);
  const current = loginFailures.get(key);

  if (!current || Date.now() - current.firstFailure >= LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstFailure: Date.now() });
    return;
  }

  current.count += 1;
}

function clearLoginFailures(req) {
  loginFailures.delete(getClientKey(req));
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'pm2-manager' });
});

app.get('/api/auth/status', (req, res) => {
  const session = getSession(req);
  res.setHeader('Cache-Control', 'no-store');

  res.json({
    authenticated: Boolean(session),
    user: session?.u || null,
    csrfToken: session?.csrf || null,
    expiresAt: session?.exp || null,
  });
});

app.post('/api/auth/login', async (req, res) => {
  const block = getLoginBlock(req);

  if (block) {
    const retryAfter = Math.max(1, Math.ceil(block.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: `Muitas tentativas de login. Tente novamente em ${Math.ceil(retryAfter / 60)} minuto(s).`,
    });
  }

  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const [userMatches, passwordMatches] = await Promise.all([
      Promise.resolve(safeEqualString(username, authConfig.username)),
      verifyPassword(password, authConfig.passwordHash),
    ]);

    if (!userMatches || !passwordMatches) {
      registerLoginFailure(req);
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }

    clearLoginFailures(req);
    const session = signSession(authConfig.username);
    setSessionCookie(req, res, session.token);

    return res.json({
      ok: true,
      user: authConfig.username,
      csrfToken: session.payload.csrf,
      expiresAt: session.payload.exp,
    });
  } catch (_) {
    return res.status(500).json({ error: 'Não foi possível concluir o login.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/login', (req, res) => {
  if (getSession(req)) return res.redirect(302, '/');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get(['/', '/index.html'], requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/api', requireApiAuth, requireCsrfForUnsafe);

app.get('/api/processes', async (req, res) => {
  try {
    const list = await listPM2();
    res.json(list.map(normalizeProcess));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/processes/:id', async (req, res) => {
  try {
    const result = await describePM2(req.params.id);
    if (!result?.length) return res.status(404).json({ error: 'Processo não encontrado' });

    const proc = result[0];
    const env = proc.pm2_env || {};

    res.json({
      ...normalizeProcess(proc),
      outLog: env.pm_out_log_path || '',
      errorLog: env.pm_err_log_path || '',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/processes/:id/:action', async (req, res) => {
  const allowed = new Set(['start', 'stop', 'restart', 'delete']);
  const { id, action } = req.params;

  if (!allowed.has(action)) return res.status(400).json({ error: 'Ação inválida' });

  try {
    const result = await describePM2(id);
    if (!result?.length) return res.status(404).json({ error: 'Processo não encontrado' });

    const processInfo = result[0];
    if (processInfo.name === SELF_NAME) {
      return res.status(403).json({
        error: 'O PM2 Manager é protegido. Gerencie este processo diretamente pelo terminal.',
      });
    }

    let safetyBackup = null;
    if (action === 'delete') safetyBackup = backupCurrentDump('before-delete');

    await pm2Action(action, id);
    dirtySince = dirtySince || Date.now();
    res.json({ ok: true, action, id, safetyBackup });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/processes/:id/logs', async (req, res) => {
  const lines = Math.min(Math.max(Number(req.query.lines) || 150, 10), 500);

  try {
    const result = await describePM2(req.params.id);
    if (!result?.length) return res.status(404).json({ error: 'Processo não encontrado' });

    const env = result[0].pm2_env || {};
    res.json({
      out: readLastLines(env.pm_out_log_path, lines),
      error: readLastLines(env.pm_err_log_path, lines),
      outPath: env.pm_out_log_path || '',
      errorPath: env.pm_err_log_path || '',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/pm2/state', (req, res) => {
  try {
    res.json(getSaveState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pm2/save', async (req, res) => {
  try {
    const backup = backupCurrentDump('before-save');
    await pm2Dump();
    dirtySince = null;
    res.json({ ok: true, backup, state: getSaveState() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/backups', (req, res) => {
  try {
    res.json(listBackups());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/backups/create', (req, res) => {
  try {
    const backup = backupCurrentDump('manual');
    if (!backup) {
      return res.status(409).json({ error: 'Ainda não existe dump.pm2. Execute PM2 Save primeiro.' });
    }
    res.json({ ok: true, backup });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/backups/:filename/download', (req, res) => {
  try {
    const filePath = resolveBackup(req.params.filename);
    res.download(filePath, path.basename(filePath));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post('/api/backups/:filename/prepare-restore', (req, res) => {
  try {
    if (req.body?.confirm !== 'RESTAURAR') {
      return res.status(400).json({ error: 'Confirmação de restauração inválida.' });
    }

    const source = resolveBackup(req.params.filename);
    const apps = readDump(source);
    const emergencyBackup = backupCurrentDump('before-restore');

    fs.copyFileSync(source, DUMP_PATH);
    fs.chmodSync(DUMP_PATH, 0o600);
    dirtySince = Date.now();

    res.json({
      ok: true,
      prepared: true,
      processCount: apps.length,
      emergencyBackup,
      message: 'Backup preparado em dump.pm2. Para uma restauração completa, execute no servidor: pm2 kill && pm2 resurrect',
      recoveryCommand: 'pm2 kill && pm2 resurrect',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

Promise.resolve()
  .then(() => {
    authConfig = loadAuthConfig();
    console.log(`Autenticação: ${AUTH_FILE}`);
    return connectPM2();
  })
  .then(() => {
    ensureBackupDir();
    app.listen(PORT, HOST, () => {
      console.log(`PM2 Manager: http://${HOST}:${PORT}`);
      console.log(`PM2 Home: ${PM2_HOME}`);
      console.log(`Backups: ${BACKUP_DIR}`);
      console.log(`Sessão: ${SESSION_HOURS}h`);
    });
  })
  .catch((error) => {
    console.error('Falha ao iniciar o PM2 Manager:', error.message);
    process.exit(1);
  });

function shutdown() {
  pm2.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
