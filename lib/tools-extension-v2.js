const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pm2 = require('pm2');
const { execFile } = require('child_process');

const SESSION_COOKIE = 'pm2_manager_session';
const PM2_HOME = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
const AUTH_FILE = process.env.PM2_MANAGER_AUTH_FILE || path.join(PM2_HOME, 'pm2-manager-auth.json');
const AUDIT_FILE = process.env.PM2_MANAGER_AUDIT_FILE || path.join(PM2_HOME, 'pm2-manager-audit.jsonl');
const SCAN_MAX_DEPTH = Math.min(16, Math.max(1, Number(process.env.PM2_MANAGER_SCAN_MAX_DEPTH || 9)));
const SCAN_MAX_RESULTS = Math.min(3000, Math.max(20, Number(process.env.PM2_MANAGER_SCAN_MAX_RESULTS || 750)));
const SCAN_TIMEOUT_MS = Math.min(120000, Math.max(5000, Number(process.env.PM2_MANAGER_SCAN_TIMEOUT_MS || 30000)));
const TERMINAL_TIMEOUT_MS = Math.min(30000, Math.max(2000, Number(process.env.PM2_MANAGER_TERMINAL_TIMEOUT_MS || 8000)));
const TERMINAL_MAX_BUFFER = Math.min(1024 * 1024, Math.max(64 * 1024, Number(process.env.PM2_MANAGER_TERMINAL_MAX_BUFFER || 256 * 1024)));

const WINDOWS_SYSTEM_DRIVE = process.env.SystemDrive ? `${process.env.SystemDrive}\\` : path.parse(process.cwd()).root;
const DEFAULT_ROOTS = process.platform === 'win32'
  ? [WINDOWS_SYSTEM_DRIVE]
  : [os.homedir(), '/var/www', '/srv', '/opt'];

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.cache', '.npm', '.yarn', '.pnpm-store', 'vendor',
  'storage', 'logs', 'log', 'tmp', 'temp', '.next', 'dist', 'build', 'coverage',
  'windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin',
  'system volume information', 'recovery', 'perflogs', 'appdata',
]);

const ECOSYSTEM_PATTERN = /^ecosystem(?:\.[a-z0-9_-]+)?(?:\.config)?\.(?:js|cjs|mjs|json|ya?ml)$/i;
const commandRate = new Map();
let authCache = { mtimeMs: 0, value: null };

function existingRoots() {
  const configured = String(process.env.PM2_MANAGER_SCAN_ROOTS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const roots = configured.length ? configured : DEFAULT_ROOTS;
  const unique = [];

  for (const root of roots) {
    const expanded = root.replace(/^~(?=$|[\\/])/, os.homedir());
    const absolute = path.resolve(expanded);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (!unique.some((item) => item.key === key) && fs.existsSync(absolute)) {
      unique.push({ key, value: absolute });
    }
  }

  return unique.length ? unique.map((item) => item.value) : [os.homedir()];
}

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

  const expected = crypto
    .createHmac('sha256', Buffer.from(config.sessionSecret, 'hex'))
    .update(encoded)
    .digest('base64url');
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

function appendAudit(req, event, options = {}) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true, mode: 0o700 });
    const record = {
      at: new Date().toISOString(),
      user: req.auth?.u || null,
      userId: req.auth?.uid || null,
      role: req.auth?.role || null,
      event,
      target: options.target ?? null,
      success: options.success !== false,
      ip: String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 100),
      userAgent: String(req.get?.('user-agent') || '').slice(0, 250),
      detail: options.detail ? String(options.detail).slice(0, 500) : null,
    };
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(AUDIT_FILE, 0o600);
  } catch (error) {
    console.error('Falha ao gravar auditoria de ferramentas:', error.message);
  }
}

function requireAdmin(req, res, next) {
  const session = verifySession(req);
  if (!session) return res.status(401).json({ error: 'Sessão expirada ou não autenticada.' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem usar as ferramentas do servidor.' });
  req.auth = session;
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.get('x-csrf-token') || '';
  if (!safeEqual(token, req.auth?.csrf || '')) return res.status(403).json({ error: 'Token de segurança inválido.' });
  next();
}

function normalizedPath(value) {
  if (!value) return '';
  const absolute = path.resolve(String(value));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function pathsEqual(a, b) {
  return normalizedPath(a) === normalizedPath(b);
}

function pathIsInside(candidate, parent) {
  const child = normalizedPath(candidate);
  const root = normalizedPath(parent);
  return child === root || child.startsWith(`${root}${path.sep}`);
}

function isInsideRoot(candidate, roots = existingRoots()) {
  return roots.some((root) => pathIsInside(candidate, root));
}

function resolveAllowedPath(candidate, cwd = os.homedir()) {
  const absolute = path.resolve(cwd, candidate || '.');
  if (!isInsideRoot(absolute)) throw new Error('Caminho fora das raízes permitidas.');
  if (!fs.existsSync(absolute)) throw new Error('Caminho não encontrado.');
  return absolute;
}

function shouldIgnoreDirectory(name) {
  return IGNORED_DIRS.has(String(name || '').toLowerCase());
}

async function scanRoot(root, deadline, results, stats, depth = 0) {
  if (Date.now() > deadline || results.length >= SCAN_MAX_RESULTS || depth > SCAN_MAX_DEPTH) return;

  let directory;
  try {
    directory = await fs.promises.opendir(root);
  } catch (_) {
    stats.denied += 1;
    return;
  }

  for await (const entry of directory) {
    if (Date.now() > deadline || results.length >= SCAN_MAX_RESULTS) break;
    const fullPath = path.join(root, entry.name);
    stats.visited += 1;

    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!shouldIgnoreDirectory(entry.name)) await scanRoot(fullPath, deadline, results, stats, depth + 1);
      continue;
    }

    if (!entry.isFile() || !ECOSYSTEM_PATTERN.test(entry.name)) continue;

    try {
      const stat = await fs.promises.stat(fullPath);
      results.push({
        name: entry.name,
        path: fullPath,
        directory: path.dirname(fullPath),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    } catch (_) {
      stats.denied += 1;
    }
  }
}

async function scanEcosystems() {
  const roots = existingRoots();
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  const results = [];
  const stats = { visited: 0, denied: 0 };

  for (const root of roots) {
    if (Date.now() > deadline || results.length >= SCAN_MAX_RESULTS) break;
    await scanRoot(root, deadline, results, stats);
  }

  results.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  return {
    roots,
    results,
    visited: stats.visited,
    denied: stats.denied,
    truncated: results.length >= SCAN_MAX_RESULTS || Date.now() > deadline,
  };
}

function listPm2() {
  return new Promise((resolve, reject) => {
    pm2.list((error, list) => (error ? reject(error) : resolve(list || [])));
  });
}

function processProjectPath(proc) {
  const env = proc.pm2_env || {};
  if (env.pm_cwd) return path.resolve(env.pm_cwd);
  if (env.pm_exec_path) return path.dirname(path.resolve(env.pm_exec_path));
  return '';
}

async function listProjects() {
  const list = await listPm2();
  const groups = new Map();

  for (const proc of list) {
    const env = proc.pm2_env || {};
    const projectPath = processProjectPath(proc);
    if (!projectPath) continue;
    const key = normalizedPath(projectPath);
    if (!groups.has(key)) {
      groups.set(key, {
        path: projectPath,
        name: path.basename(projectPath) || projectPath,
        processCount: 0,
        onlineCount: 0,
        processes: [],
      });
    }

    const group = groups.get(key);
    const status = env.status || 'unknown';
    group.processCount += 1;
    if (status === 'online') group.onlineCount += 1;
    group.processes.push({
      pm_id: proc.pm_id,
      name: proc.name,
      status,
      namespace: env.namespace || 'default',
      cwd: env.pm_cwd || '',
      script: env.pm_exec_path || '',
    });
  }

  return [...groups.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((group) => ({ ...group, processes: group.processes.sort((a, b) => Number(a.pm_id) - Number(b.pm_id)) }));
}

function splitCommandLine(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Digite um comando.');
  if (/[\n\r;&|`<>]/.test(text) || text.includes('$(')) {
    throw new Error('Pipes, redirecionamentos, comandos encadeados e substituições de shell são bloqueados.');
  }

  const tokens = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (const char of text) {
    if (escaping) { current += char; escaping = false; continue; }
    if (char === '\\' && quote !== "'") { escaping = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += char;
  }

  if (quote) throw new Error('Aspas não fechadas.');
  if (escaping) current += '\\';
  if (current) tokens.push(current);
  if (!tokens.length) throw new Error('Digite um comando.');
  return tokens;
}

function validatePm2Args(args) {
  const sub = args[0] || 'list';
  const allowed = new Set(['list', 'status', 'jlist', 'prettylist', 'show', 'describe', 'info', 'env', 'logs']);
  if (!allowed.has(sub)) throw new Error('No terminal seguro, PM2 permite apenas comandos de consulta. Use o gerador para comandos operacionais.');

  if (sub === 'logs') {
    const next = [...args];
    if (!next.includes('--nostream')) next.push('--nostream');
    if (!next.includes('--lines')) next.push('--lines', '80');
    return next;
  }
  return args;
}

function validateGitArgs(args) {
  const sub = args[0];
  if (sub === 'status') return args;
  if (sub === 'branch' && args.length === 2 && args[1] === '--show-current') return args;
  if (sub === 'log') {
    const allowed = args.every((arg, index) => index === 0 || /^-n\d{1,2}$/.test(arg) || arg === '--oneline' || arg === '--decorate');
    if (allowed) return args;
  }
  throw new Error('Git está limitado a status, branch --show-current e log -nN --oneline.');
}

function validateLsArgs(args, cwd) {
  const allowedFlags = new Set(['-l', '-a', '-h', '-la', '-al', '-lh', '-hl', '-lah', '-lha', '-alh', '-ahl']);
  const checked = [];
  let paths = 0;
  for (const arg of args) {
    if (arg.startsWith('-')) {
      if (!allowedFlags.has(arg)) throw new Error(`Flag do ls não permitida: ${arg}`);
      checked.push(arg);
      continue;
    }
    paths += 1;
    if (paths > 2) throw new Error('Use no máximo dois caminhos no ls.');
    checked.push(resolveAllowedPath(arg, cwd));
  }
  return checked;
}

function pm2CliPath() {
  try {
    return require.resolve('pm2/bin/pm2');
  } catch (_) {
    throw new Error('CLI do PM2 não encontrado dentro da instalação do PM2 Manager. Execute npm install.');
  }
}

function buildExecutable(tokens, cwd) {
  const [command, ...args] = tokens;

  if (command === 'pwd') {
    if (args.length) throw new Error('pwd não aceita argumentos neste terminal.');
    return { file: 'pwd', args: [] };
  }
  if (command === 'whoami' || command === 'hostname' || command === 'uptime') {
    if (args.length) throw new Error(`${command} não aceita argumentos neste terminal.`);
    return { file: command, args: [] };
  }
  if (command === 'df') {
    if (args.length && !(args.length === 1 && args[0] === '-h')) throw new Error('Use apenas: df ou df -h');
    return { file: 'df', args };
  }
  if (command === 'ls') return { file: 'ls', args: validateLsArgs(args, cwd) };
  if (command === 'node') {
    if (args.length !== 1 || !['-v', '--version'].includes(args[0])) throw new Error('Node está limitado a node -v / --version.');
    return { file: process.execPath, args };
  }
  if (command === 'npm') {
    if (args.length !== 1 || !['-v', '--version'].includes(args[0])) throw new Error('NPM está limitado a npm -v / --version.');
    return { file: process.platform === 'win32' ? 'npm.cmd' : 'npm', args };
  }
  if (command === 'git') return { file: 'git', args: validateGitArgs(args) };
  if (command === 'pm2') return { file: process.execPath, args: [pm2CliPath(), ...validatePm2Args(args)] };

  throw new Error(`Comando "${command}" não está liberado no terminal seguro.`);
}

function rateLimitCommand(req) {
  const key = `${req.auth?.uid || 'unknown'}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
  const now = Date.now();
  const current = commandRate.get(key);
  if (!current || now - current.startedAt > 60000) {
    commandRate.set(key, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > 30) throw new Error('Limite de 30 comandos por minuto atingido.');
}

function runCommand(command, cwd) {
  const tokens = splitCommandLine(command);
  const resolvedCwd = resolveAllowedPath(cwd || os.homedir(), os.homedir());
  if (!fs.statSync(resolvedCwd).isDirectory()) throw new Error('O diretório de trabalho precisa ser uma pasta.');
  const executable = buildExecutable(tokens, resolvedCwd);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(executable.file, executable.args, {
      cwd: resolvedCwd,
      timeout: TERMINAL_TIMEOUT_MS,
      maxBuffer: TERMINAL_MAX_BUFFER,
      env: process.env,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        command,
        cwd: resolvedCwd,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        exitCode: error?.code === undefined ? 0 : error.code,
        timedOut: Boolean(error?.killed && error?.signal),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function installRoutes(app, express) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  router.use(express.json({ limit: '16kb' }));
  router.use(requireAdmin, requireCsrf);

  router.get('/status', (req, res) => {
    res.json({
      mode: 'safe',
      platform: process.platform,
      roots: existingRoots(),
      scanMaxDepth: SCAN_MAX_DEPTH,
      scanMaxResults: SCAN_MAX_RESULTS,
      scanTimeoutMs: SCAN_TIMEOUT_MS,
      terminalTimeoutMs: TERMINAL_TIMEOUT_MS,
      allowedCommands: ['pwd', 'ls', 'whoami', 'hostname', 'uptime', 'df -h', 'node -v', 'npm -v', 'git status', 'git branch --show-current', 'git log -n10 --oneline', 'pm2 list', 'pm2 status', 'pm2 show <processo>', 'pm2 env <id>', 'pm2 logs <processo> --nostream'],
    });
  });

  router.get('/projects', async (req, res) => {
    try {
      const projects = await listProjects();
      res.json(projects);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/ecosystems/scan', async (req, res) => {
    try {
      const scan = await scanEcosystems();
      appendAudit(req, 'tools.ecosystem_scan', { target: scan.roots.join(', '), detail: `${scan.results.length} encontrados; ${scan.visited} itens visitados` });
      res.json(scan);
    } catch (error) {
      appendAudit(req, 'tools.ecosystem_scan', { success: false, detail: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/terminal/run', async (req, res) => {
    const command = String(req.body?.command || '').trim();
    try {
      rateLimitCommand(req);
      const result = await runCommand(command, req.body?.cwd);
      appendAudit(req, 'tools.command', {
        target: command.slice(0, 250),
        success: result.exitCode === 0,
        detail: `cwd=${result.cwd}; exit=${result.exitCode}; ${result.durationMs}ms`,
      });
      res.json(result);
    } catch (error) {
      appendAudit(req, 'tools.command', { target: command.slice(0, 250), success: false, detail: error.message });
      res.status(400).json({ error: error.message });
    }
  });

  app.use('/api/tools', router);
}

function installExpressExtension() {
  const expressPath = require.resolve('express');
  const original = require(expressPath);

  function wrappedExpress(...args) {
    const app = original(...args);
    installRoutes(app, original);
    return app;
  }

  Object.assign(wrappedExpress, original);
  Object.setPrototypeOf(wrappedExpress, Object.getPrototypeOf(original));
  require.cache[expressPath].exports = wrappedExpress;
}

module.exports = { installExpressExtension };
