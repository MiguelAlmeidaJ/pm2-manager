const express = require('express');
const pm2 = require('pm2');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3333;
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function connectPM2() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => err ? reject(err) : resolve());
  });
}

function listPM2() {
  return new Promise((resolve, reject) => {
    pm2.list((err, list) => err ? reject(err) : resolve(list));
  });
}

function pm2Action(action, id) {
  return new Promise((resolve, reject) => {
    const fn = pm2[action];
    if (typeof fn !== 'function') return reject(new Error('Ação inválida'));
    fn.call(pm2, id, (err, result) => err ? reject(err) : resolve(result));
  });
}

function describePM2(id) {
  return new Promise((resolve, reject) => {
    pm2.describe(id, (err, result) => err ? reject(err) : resolve(result));
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
  };
}

function readLastLines(filePath, maxLines = 150) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  const stat = fs.statSync(filePath);
  const maxBytes = 256 * 1024;
  const start = Math.max(0, stat.size - maxBytes);
  const size = stat.size - start;
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(size);
  fs.readSync(fd, buffer, 0, size, start);
  fs.closeSync(fd);

  return buffer
    .toString('utf8')
    .split(/\r?\n/)
    .slice(-maxLines)
    .join('\n');
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
    await pm2Action(action, id);
    res.json({ ok: true, action, id });
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

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'pm2-manager' });
});

connectPM2()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`PM2 Manager: http://${HOST}:${PORT}`);
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
