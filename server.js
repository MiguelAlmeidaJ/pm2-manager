const express = require('express');
const pm2 = require('pm2');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 4333);
const HOST = process.env.HOST || '127.0.0.1';
const SELF_NAME = process.env.PM2_MANAGER_PROCESS_NAME || 'pm2-manager';
const PM2_HOME = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
const DUMP_PATH = path.join(PM2_HOME, 'dump.pm2');
const BACKUP_DIR = process.env.PM2_MANAGER_BACKUP_DIR || path.join(PM2_HOME, 'manager-backups');
const BACKUP_KEEP = Math.max(5, Number(process.env.PM2_MANAGER_BACKUP_KEEP || 30));

let dirtySince = null;

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

  if (!allowed.has(action)) {
    return res.status(400).json({ error: 'Ação inválida' });
  }

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
    if (action === 'delete') {
      safetyBackup = backupCurrentDump('before-delete');
    }

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

    res.json({
      ok: true,
      backup,
      state: getSaveState(),
    });
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

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'pm2-manager', selfName: SELF_NAME });
});

connectPM2()
  .then(() => {
    ensureBackupDir();
    app.listen(PORT, HOST, () => {
      console.log(`PM2 Manager: http://${HOST}:${PORT}`);
      console.log(`PM2 Home: ${PM2_HOME}`);
      console.log(`Backups: ${BACKUP_DIR}`);
    });
  })
  .catch((error) => {
    console.error('Não foi possível conectar ao PM2:', error);
    process.exit(1);
  });

function shutdown() {
  pm2.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
