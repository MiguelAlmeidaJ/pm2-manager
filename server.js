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
const AUDIT_FILE = process.env.PM2_MANAGER_AUDIT_FILE || path.join(PM2_HOME, 'pm2-manager-audit.jsonl');
const AUDIT_MAX_BYTES = Math.max(1024 * 1024, Number(process.env.PM2_MANAGER_AUDIT_MAX_BYTES || 10 * 1024 * 1024));
const AUDIT_KEEP = Math.max(2, Number(process.env.PM2_MANAGER_AUDIT_KEEP || 5));
const SESSION_COOKIE = 'pm2_manager_session';
const SESSION_HOURS = Math.min(24, Math.max(1, Number(process.env.PM2_MANAGER_SESSION_HOURS || 8)));
const SESSION_TTL_MS = SESSION_HOURS * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const ROLES = new Set(['admin', 'operator', 'viewer']);
const ROLE_PERMISSIONS = {
  admin: new Set(['read', 'operate', 'save', 'backup', 'delete', 'restore', 'downloadBackup', 'audit', 'users']),
  operator: new Set(['read', 'operate', 'save', 'backup']),
  viewer: new Set(['read']),
};

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
    protected: proc.name === SELF_NAME,
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
    return buffer.toString('utf8').split(/\r?\n/).slice(-maxLines).join('\n');
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

      return { name, size: stat.size, createdAt: stat.mtimeMs, processCount };
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

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function validateUsername(username) {
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9._-]{3,64}$/i.test(normalized)) {
    throw new Error('Usuário inválido. Use 3 a 64 caracteres: letras, números, ponto, underline ou hífen.');
  }
  return normalized;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('A senha deve ter pelo menos 12 caracteres.');
  }
}

function validateRole(role) {
  const normalized = String(role || '').toLowerCase();
  if (!ROLES.has(normalized)) throw new Error('Perfil inválido.');
  return normalized;
}

function normalizeAuthConfig(parsed) {
  if (!parsed || !parsed.sessionSecret || !/^[a-f0-9]{128}$/i.test(parsed.sessionSecret)) {
    throw new Error('Configuração de autenticação inválida: sessionSecret inválido.');
  }

  let users;

  if (Array.isArray(parsed.users)) {
    users = parsed.users;
  } else if (parsed.username && parsed.passwordHash) {
    const now = parsed.updatedAt || new Date().toISOString();
    users = [{
      id: crypto.randomUUID(),
      username: normalizeUsername(parsed.username),
      passwordHash: parsed.passwordHash,
      role: 'admin',
      active: true,
      sessionVersion: 1,
      createdAt: now,
      updatedAt: now,
    }];
  } else {
    throw new Error('Configuração de autenticação inválida: nenhum usuário encontrado.');
  }

  const seen = new Set();
  const normalizedUsers = users.map((user) => {
    const username = validateUsername(user.username);
    const role = validateRole(user.role || 'viewer');

    if (seen.has(username)) throw new Error(`Usuário duplicado na configuração: ${username}`);
    seen.add(username);

    if (!user.passwordHash || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i.test(user.passwordHash)) {
      throw new Error(`Hash inválido para o usuário ${username}.`);
    }

    return {
      id: String(user.id || crypto.randomUUID()),
      username,
      passwordHash: user.passwordHash,
      role,
      active: user.active !== false,
      sessionVersion: Math.max(1, Number(user.sessionVersion || 1)),
      createdAt: user.createdAt || new Date().toISOString(),
      updatedAt: user.updatedAt || user.createdAt || new Date().toISOString(),
    };
  });

  if (!normalizedUsers.some((user) => user.active && user.role === 'admin')) {
    throw new Error('É necessário existir pelo menos um administrador ativo.');
  }

  return {
    version: 2,
    sessionSecret: parsed.sessionSecret,
    users: normalizedUsers,
    updatedAt: parsed.updatedAt || new Date().toISOString(),
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

  return normalizeAuthConfig(JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')));
}

function saveAuthConfig() {
  authConfig.updatedAt = new Date().toISOString();
  const temporary = `${AUTH_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(authConfig, null, 2)}\n`, { mode: 0o600, flag: 'w' });
  fs.renameSync(temporary, AUTH_FILE);
  if (process.platform !== 'win32') fs.chmodSync(AUTH_FILE, 0o600);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function findUserByUsername(username) {
  const normalized = normalizeUsername(username);
  return authConfig.users.find((user) => user.username === normalized) || null;
}

function findUserById(id) {
  return authConfig.users.find((user) => user.id === String(id)) || null;
}

function activeAdminCount(excludingId = null) {
  return authConfig.users.filter((user) => user.id !== excludingId && user.active && user.role === 'admin').length;
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

function signSession(user) {
  const payload = {
    uid: user.id,
    u: user.username,
    role: user.role,
    v: user.sessionVersion,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    csrf: crypto.randomBytes(24).toString('base64url'),
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', Buffer.from(authConfig.sessionSecret, 'hex')).update(encoded).digest('base64url');
  return { token: `${encoded}.${signature}`, payload };
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;

  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return null;

  const expected = crypto.createHmac('sha256', Buffer.from(authConfig.sessionSecret, 'hex')).update(encoded).digest('base64url');
  if (!safeEqualString(signature, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;

    const user = findUserById(payload.uid);
    if (!user || !user.active) return null;
    if (payload.u !== user.username || payload.role !== user.role || Number(payload.v) !== user.sessionVersion) return null;
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

function hasPermission(role, permission) {
  return Boolean(ROLE_PERMISSIONS[role]?.has(permission));
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

function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.auth?.role, permission)) {
      return res.status(403).json({ error: 'Seu perfil não possui permissão para esta ação.' });
    }
    next();
  };
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

function rotateAuditIfNeeded() {
  if (!fs.existsSync(AUDIT_FILE) || fs.statSync(AUDIT_FILE).size < AUDIT_MAX_BYTES) return;

  for (let index = AUDIT_KEEP - 1; index >= 1; index -= 1) {
    const source = index === 1 ? AUDIT_FILE : `${AUDIT_FILE}.${index - 1}`;
    const destination = `${AUDIT_FILE}.${index}`;
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    fs.renameSync(source, destination);
  }
}

function appendAudit(req, event, options = {}) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true, mode: 0o700 });
    rotateAuditIfNeeded();

    const record = {
      at: new Date().toISOString(),
      user: options.user ?? req?.auth?.u ?? null,
      userId: options.userId ?? req?.auth?.uid ?? null,
      role: options.role ?? req?.auth?.role ?? null,
      event,
      target: options.target ?? null,
      success: options.success !== false,
      ip: String(req?.ip || req?.socket?.remoteAddress || 'unknown').slice(0, 100),
      userAgent: String(req?.get?.('user-agent') || '').slice(0, 250),
      detail: options.detail ? String(options.detail).slice(0, 500) : null,
    };

    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(AUDIT_FILE, 0o600);
  } catch (error) {
    console.error('Falha ao gravar auditoria:', error.message);
  }
}

function readAudit(limit = 200) {
  if (!fs.existsSync(AUDIT_FILE)) return [];

  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const stat = fs.statSync(AUDIT_FILE);
  const maxBytes = Math.min(stat.size, 2 * 1024 * 1024);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(AUDIT_FILE, 'r');

  try {
    const buffer = Buffer.alloc(maxBytes);
    fs.readSync(fd, buffer, 0, maxBytes, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);

    return text.split(/\r?\n/)
      .filter(Boolean)
      .slice(-safeLimit)
      .reverse()
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
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
    role: session?.role || null,
    permissions: session ? [...(ROLE_PERMISSIONS[session.role] || [])] : [],
    csrfToken: session?.csrf || null,
    expiresAt: session?.exp || null,
  });
});

app.post('/api/auth/login', async (req, res) => {
  const attemptedUsername = normalizeUsername(req.body?.username);
  const block = getLoginBlock(req);

  if (block) {
    const retryAfter = Math.max(1, Math.ceil(block.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    appendAudit(req, 'auth.login_blocked', { user: attemptedUsername || null, success: false });
    return res.status(429).json({
      error: `Muitas tentativas de login. Tente novamente em ${Math.ceil(retryAfter / 60)} minuto(s).`,
    });
  }

  try {
    const password = String(req.body?.password || '');
    const user = findUserByUsername(attemptedUsername);
    const passwordMatches = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, hashPassword('invalid-password-placeholder'));

    if (!user || !user.active || !passwordMatches) {
      registerLoginFailure(req);
      appendAudit(req, 'auth.login_failed', {
        user: attemptedUsername || null,
        userId: user?.id || null,
        role: user?.role || null,
        success: false,
      });
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }

    clearLoginFailures(req);
    const session = signSession(user);
    setSessionCookie(req, res, session.token);
    appendAudit(req, 'auth.login_success', { user: user.username, userId: user.id, role: user.role });

    return res.json({
      ok: true,
      user: user.username,
      role: user.role,
      permissions: [...ROLE_PERMISSIONS[user.role]],
      csrfToken: session.payload.csrf,
      expiresAt: session.payload.exp,
    });
  } catch (_) {
    appendAudit(req, 'auth.login_error', { user: attemptedUsername || null, success: false });
    return res.status(500).json({ error: 'Não foi possível concluir o login.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const session = getSession(req);
  if (session) {
    const token = req.get('x-csrf-token') || '';
    if (!safeEqualString(token, session.csrf)) {
      return res.status(403).json({ error: 'Token de segurança inválido.' });
    }
    req.auth = session;
    appendAudit(req, 'auth.logout');
  }

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

app.get('/api/processes', requirePermission('read'), async (req, res) => {
  try {
    const list = await listPM2();
    res.json(list.map(normalizeProcess));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/processes/:id', requirePermission('read'), async (req, res) => {
  try {
    const result = await describePM2(req.params.id);
    if (!result?.length) return res.status(404).json({ error: 'Processo não encontrado' });

    const proc = result[0];
    const env = proc.pm2_env || {};
    res.json({ ...normalizeProcess(proc), outLog: env.pm_out_log_path || '', errorLog: env.pm_err_log_path || '' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/processes/:id/:action', async (req, res) => {
  const allowed = new Set(['start', 'stop', 'restart', 'delete']);
  const { id, action } = req.params;

  if (!allowed.has(action)) return res.status(400).json({ error: 'Ação inválida' });
  const permission = action === 'delete' ? 'delete' : 'operate';
  if (!hasPermission(req.auth.role, permission)) {
    return res.status(403).json({ error: 'Seu perfil não possui permissão para esta ação.' });
  }

  let target = `#${id}`;
  try {
    const result = await describePM2(id);
    if (!result?.length) return res.status(404).json({ error: 'Processo não encontrado' });

    const processInfo = result[0];
    target = `${processInfo.name} (#${id})`;
    if (processInfo.name === SELF_NAME) {
      return res.status(403).json({ error: 'O PM2 Manager é protegido. Gerencie este processo diretamente pelo terminal.' });
    }

    let safetyBackup = null;
    if (action === 'delete') safetyBackup = backupCurrentDump('before-delete');

    await pm2Action(action, id);
    dirtySince = dirtySince || Date.now();
    appendAudit(req, `process.${action}`, { target });
    res.json({ ok: true, action, id, safetyBackup });
  } catch (error) {
    appendAudit(req, `process.${action}`, { target, success: false, detail: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/processes/:id/logs', requirePermission('read'), async (req, res) => {
  const lines = Math.min(Math.max(Number(req.query.lines) || 150, 10), 500);
  let target = `#${req.params.id}`;

  try {
    const result = await describePM2(req.params.id);
    if (!result?.length) return res.status(404).json({ error: 'Processo não encontrado' });

    const env = result[0].pm2_env || {};
    target = `${result[0].name} (#${req.params.id})`;
    appendAudit(req, 'process.logs_viewed', { target });
    res.json({
      out: readLastLines(env.pm_out_log_path, lines),
      error: readLastLines(env.pm_err_log_path, lines),
      outPath: env.pm_out_log_path || '',
      errorPath: env.pm_err_log_path || '',
    });
  } catch (error) {
    appendAudit(req, 'process.logs_viewed', { target, success: false, detail: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/pm2/state', requirePermission('read'), (req, res) => {
  try {
    res.json(getSaveState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pm2/save', requirePermission('save'), async (req, res) => {
  try {
    const backup = backupCurrentDump('before-save');
    await pm2Dump();
    dirtySince = null;
    appendAudit(req, 'pm2.save', { target: DUMP_PATH });
    res.json({ ok: true, backup, state: getSaveState() });
  } catch (error) {
    appendAudit(req, 'pm2.save', { target: DUMP_PATH, success: false, detail: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/backups', requirePermission('read'), (req, res) => {
  try {
    res.json(listBackups());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/backups/create', requirePermission('backup'), (req, res) => {
  try {
    const backup = backupCurrentDump('manual');
    if (!backup) return res.status(409).json({ error: 'Ainda não existe dump.pm2. Execute PM2 Save primeiro.' });
    appendAudit(req, 'backup.create', { target: backup.name });
    res.json({ ok: true, backup });
  } catch (error) {
    appendAudit(req, 'backup.create', { success: false, detail: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/backups/:filename/download', requirePermission('downloadBackup'), (req, res) => {
  try {
    const filePath = resolveBackup(req.params.filename);
    appendAudit(req, 'backup.download', { target: req.params.filename });
    res.download(filePath, path.basename(filePath));
  } catch (error) {
    appendAudit(req, 'backup.download', { target: req.params.filename, success: false, detail: error.message });
    res.status(404).json({ error: error.message });
  }
});

app.post('/api/backups/:filename/prepare-restore', requirePermission('restore'), (req, res) => {
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
    appendAudit(req, 'backup.restore_prepared', { target: req.params.filename, detail: `${apps.length} processos` });

    res.json({
      ok: true,
      prepared: true,
      processCount: apps.length,
      emergencyBackup,
      message: 'Backup preparado em dump.pm2. Para uma restauração completa, execute no servidor: pm2 kill && pm2 resurrect',
      recoveryCommand: 'pm2 kill && pm2 resurrect',
    });
  } catch (error) {
    appendAudit(req, 'backup.restore_prepared', { target: req.params.filename, success: false, detail: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users', requirePermission('users'), (req, res) => {
  res.json(authConfig.users.map(publicUser).sort((a, b) => a.username.localeCompare(b.username)));
});

app.post('/api/users', requirePermission('users'), (req, res) => {
  try {
    const username = validateUsername(req.body?.username);
    const role = validateRole(req.body?.role || 'viewer');
    const password = String(req.body?.password || '');
    validatePassword(password);

    if (findUserByUsername(username)) return res.status(409).json({ error: 'Esse usuário já existe.' });

    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      username,
      passwordHash: hashPassword(password),
      role,
      active: true,
      sessionVersion: 1,
      createdAt: now,
      updatedAt: now,
    };

    authConfig.users.push(user);
    saveAuthConfig();
    appendAudit(req, 'user.create', { target: username, detail: `role=${role}` });
    res.status(201).json(publicUser(user));
  } catch (error) {
    appendAudit(req, 'user.create', { target: normalizeUsername(req.body?.username) || null, success: false, detail: error.message });
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/users/:id', requirePermission('users'), (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

  try {
    const changingSelf = user.id === req.auth.uid;
    const changes = [];

    if (req.body?.role !== undefined) {
      const newRole = validateRole(req.body.role);
      if (changingSelf && newRole !== user.role) throw new Error('Você não pode alterar o próprio perfil durante uma sessão ativa.');
      if (user.role === 'admin' && newRole !== 'admin' && activeAdminCount(user.id) < 1) {
        throw new Error('É necessário manter pelo menos um administrador ativo.');
      }
      if (newRole !== user.role) {
        user.role = newRole;
        changes.push(`role=${newRole}`);
      }
    }

    if (req.body?.active !== undefined) {
      const active = Boolean(req.body.active);
      if (changingSelf && !active) throw new Error('Você não pode desativar o próprio usuário durante uma sessão ativa.');
      if (user.role === 'admin' && !active && activeAdminCount(user.id) < 1) {
        throw new Error('É necessário manter pelo menos um administrador ativo.');
      }
      if (active !== user.active) {
        user.active = active;
        changes.push(`active=${active}`);
      }
    }

    if (req.body?.password !== undefined) {
      const password = String(req.body.password || '');
      validatePassword(password);
      user.passwordHash = hashPassword(password);
      changes.push('password=changed');
    }

    if (!changes.length) return res.json(publicUser(user));

    user.sessionVersion += 1;
    user.updatedAt = new Date().toISOString();
    saveAuthConfig();
    appendAudit(req, 'user.update', { target: user.username, detail: changes.join(', ') });
    res.json(publicUser(user));
  } catch (error) {
    appendAudit(req, 'user.update', { target: user.username, success: false, detail: error.message });
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/users/:id', requirePermission('users'), (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

  try {
    if (user.id === req.auth.uid) throw new Error('Você não pode excluir o próprio usuário durante uma sessão ativa.');
    if (user.role === 'admin' && activeAdminCount(user.id) < 1) {
      throw new Error('É necessário manter pelo menos um administrador ativo.');
    }

    authConfig.users = authConfig.users.filter((item) => item.id !== user.id);
    saveAuthConfig();
    appendAudit(req, 'user.delete', { target: user.username, detail: `role=${user.role}` });
    res.json({ ok: true });
  } catch (error) {
    appendAudit(req, 'user.delete', { target: user.username, success: false, detail: error.message });
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/audit', requirePermission('audit'), (req, res) => {
  try {
    res.json(readAudit(req.query.limit));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

Promise.resolve()
  .then(() => {
    authConfig = loadAuthConfig();
    console.log(`Autenticação: ${AUTH_FILE}`);
    console.log(`Usuários: ${authConfig.users.length}`);
    console.log(`Auditoria: ${AUDIT_FILE}`);
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
