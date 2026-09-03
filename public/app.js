let processes = [];
let backups = [];
let saveState = null;
let currentLogs = { out: '', error: '' };
let currentLogTab = 'out';
let authState = { user: null, csrfToken: null, expiresAt: null };
let refreshTimer = null;

const el = (id) => document.getElementById(id);

function formatBytes(bytes = 0) {
  if (!bytes) return '0 MB';
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 100 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatUptime(timestamp) {
  if (!timestamp) return '-';
  const diff = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diff / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDate(timestamp) {
  if (!timestamp) return '-';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(timestamp));
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeJs(value = '') {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function showToast(message) {
  const toast = el('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

function redirectToLogin() {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.replace(`/login?next=${encodeURIComponent(next)}`);
}

async function api(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && authState.csrfToken) {
    headers['X-CSRF-Token'] = authState.csrfToken;
  }

  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers,
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : {};

  if (response.status === 401) {
    redirectToLogin();
    throw new Error('Sessão expirada.');
  }

  if (!response.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}

async function loadAuthState() {
  const response = await fetch('/api/auth/status', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));

  if (!data.authenticated) {
    redirectToLogin();
    return false;
  }

  authState = {
    user: data.user,
    csrfToken: data.csrfToken,
    expiresAt: data.expiresAt,
  };

  el('current-user').textContent = data.user || 'Usuário';
  return true;
}

async function loadAll(silent = false) {
  try {
    const [processData, stateData, backupData] = await Promise.all([
      api('/api/processes'),
      api('/api/pm2/state'),
      api('/api/backups'),
    ]);

    processes = processData;
    saveState = stateData;
    backups = backupData;

    renderNamespaceFilter();
    render();
    renderSaveState();
    renderBackups();

    el('server-status').textContent = 'PM2 conectado';
    document.querySelector('.dot').style.background = 'var(--green)';
    if (!silent) showToast('Painel atualizado');
  } catch (error) {
    el('server-status').textContent = 'Falha na conexão';
    document.querySelector('.dot').style.background = 'var(--red)';
    if (!silent) showToast(error.message);
  }
}

function renderNamespaceFilter() {
  const select = el('namespace-filter');
  const current = select.value;
  const namespaces = [...new Set(processes.map((p) => p.namespace || 'default'))].sort();

  select.innerHTML = '<option value="all">Todos os namespaces</option>' +
    namespaces.map((ns) => `<option value="${escapeHtml(ns)}">${escapeHtml(ns)}</option>`).join('');

  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function getFiltered() {
  const q = el('search').value.trim().toLowerCase();
  const status = el('status-filter').value;
  const namespace = el('namespace-filter').value;

  return processes.filter((p) => {
    const matchesQ = !q || [p.name, p.namespace, p.cwd, p.script]
      .some((v) => String(v || '').toLowerCase().includes(q));
    const matchesStatus = status === 'all' || p.status === status;
    const matchesNamespace = namespace === 'all' || p.namespace === namespace;
    return matchesQ && matchesStatus && matchesNamespace;
  });
}

function renderStats() {
  el('stat-total').textContent = processes.length;
  el('stat-online').textContent = processes.filter((p) => p.status === 'online').length;
  el('stat-stopped').textContent = processes.filter((p) => p.status !== 'online').length;

  const totalMemory = processes.reduce((sum, p) => sum + (p.memory || 0), 0);
  el('stat-memory').textContent = formatBytes(totalMemory);
}

function render() {
  renderStats();
  const list = getFiltered();
  const tbody = el('process-list');
  const empty = el('empty-state');

  empty.classList.toggle('hidden', list.length > 0);

  tbody.innerHTML = list.map((p) => {
    const safeName = safeJs(p.name);
    const protectedActions = p.protected
      ? '<span class="protected-label">Protegido</span>'
      : p.status === 'online'
        ? `<button class="action" onclick="runAction('${p.pm_id}', 'restart', '${safeName}')">Restart</button>
           <button class="action" onclick="runAction('${p.pm_id}', 'stop', '${safeName}')">Stop</button>
           <button class="action danger" onclick="runAction('${p.pm_id}', 'delete', '${safeName}')">Delete</button>`
        : `<button class="action" onclick="runAction('${p.pm_id}', 'start', '${safeName}')">Start</button>
           <button class="action danger" onclick="runAction('${p.pm_id}', 'delete', '${safeName}')">Delete</button>`;

    return `
      <tr>
        <td>
          <div class="project-name">${escapeHtml(p.name)} ${p.protected ? '<span class="shield">●</span>' : ''}</div>
          <div class="project-meta">#${p.pm_id} · ${escapeHtml(p.namespace)} · ${escapeHtml(p.cwd || p.script || '')}</div>
        </td>
        <td><span class="badge ${escapeHtml(p.status)}">${escapeHtml(p.status)}</span></td>
        <td>${Number(p.cpu || 0).toFixed(1)}%</td>
        <td>${formatBytes(p.memory)}</td>
        <td>${p.restarts}</td>
        <td>${formatUptime(p.uptime)}</td>
        <td>
          <div class="actions">
            <button class="action" onclick="openLogs('${p.pm_id}', '${safeName}')">Logs</button>
            ${protectedActions}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderSaveState() {
  if (!saveState) return;

  el('last-save').textContent = saveState.lastSavedAt
    ? `Último PM2 Save: ${formatDate(saveState.lastSavedAt)}`
    : 'Nenhum PM2 Save detectado';

  el('save-detail').textContent = saveState.hasDump
    ? `${saveState.savedProcessCount ?? '?'} processos no dump · ${formatBytes(saveState.dumpSize)}`
    : 'O dump.pm2 ainda não existe.';

  el('backup-count').textContent = `${saveState.backupCount} backup${saveState.backupCount === 1 ? '' : 's'}`;
  el('save-alert').classList.toggle('hidden', !saveState.dirtySince);
}

function renderBackups() {
  const tbody = el('backup-list');
  const empty = el('backup-empty');
  empty.classList.toggle('hidden', backups.length > 0);

  tbody.innerHTML = backups.map((backup) => {
    const name = escapeHtml(backup.name);
    const safeName = safeJs(backup.name);
    return `
      <tr>
        <td><div class="backup-name">${name}</div></td>
        <td>${formatDate(backup.createdAt)}</td>
        <td>${backup.processCount ?? '?'}</td>
        <td>${formatBytes(backup.size)}</td>
        <td>
          <div class="actions">
            <button class="action" onclick="downloadBackup('${safeName}')">Baixar</button>
            <button class="action warning" onclick="prepareRestore('${safeName}')">Preparar restore</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function runAction(id, action, name) {
  if (action === 'delete') {
    const confirmed = confirm(`Remover "${name}" do PM2?\n\nUm backup de segurança do dump atual será criado antes da exclusão.`);
    if (!confirmed) return;
  }

  try {
    showToast(`${action}: ${name}...`);
    const result = await api(`/api/processes/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    await loadAll(true);

    if (result.safetyBackup) {
      showToast(`${name} removido. Backup de segurança criado.`);
    } else {
      showToast(`${name}: ${action} concluído`);
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function savePM2() {
  const button = el('save-btn');
  button.disabled = true;
  button.textContent = 'Salvando...';

  try {
    const result = await api('/api/pm2/save', { method: 'POST' });
    await loadAll(true);

    if (result.backup) {
      showToast('PM2 Save concluído. O dump anterior foi preservado em backup.');
    } else {
      showToast('PM2 Save concluído.');
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'PM2 Save';
  }
}

async function createBackup() {
  try {
    const result = await api('/api/backups/create', { method: 'POST' });
    await loadAll(true);
    showToast(`Backup criado: ${result.backup.name}`);
  } catch (error) {
    showToast(error.message);
  }
}

function downloadBackup(filename) {
  window.location.href = `/api/backups/${encodeURIComponent(filename)}/download`;
}

async function prepareRestore(filename) {
  const confirmation = prompt(
    `Você está preparando o backup:\n${filename}\n\nIsso substituirá o dump.pm2 atual, mas NÃO reiniciará o daemon.\n\nDigite RESTAURAR para continuar:`
  );

  if (confirmation !== 'RESTAURAR') return;

  try {
    const result = await api(`/api/backups/${encodeURIComponent(filename)}/prepare-restore`, {
      method: 'POST',
      body: JSON.stringify({ confirm: 'RESTAURAR' }),
    });

    await loadAll(true);
    el('restore-command').textContent = result.recoveryCommand;
    el('restore-modal').classList.remove('hidden');
    showToast('Backup preparado. A restauração completa depende do comando exibido.');
  } catch (error) {
    showToast(error.message);
  }
}

async function openLogs(id, name) {
  el('modal').classList.remove('hidden');
  el('modal-title').textContent = `Logs · ${name}`;
  el('modal-subtitle').textContent = `Processo #${id}`;
  el('log-content').textContent = 'Carregando...';

  try {
    currentLogs = await api(`/api/processes/${encodeURIComponent(id)}/logs?lines=200`);
    currentLogTab = 'out';
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.tab === 'out');
    });
    renderLogs();
  } catch (error) {
    el('log-content').textContent = error.message;
  }
}

function renderLogs() {
  el('log-content').textContent = currentLogs[currentLogTab] || 'Sem logs.';
}

async function logout() {
  const button = el('logout-btn');
  button.disabled = true;

  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: authState.csrfToken ? { 'X-CSRF-Token': authState.csrfToken } : {},
    });
  } finally {
    window.location.replace('/login');
  }
}

async function initialize() {
  try {
    const authenticated = await loadAuthState();
    if (!authenticated) return;

    await loadAll(true);
    refreshTimer = setInterval(() => loadAll(true), 5000);
  } catch (_) {
    redirectToLogin();
  }
}

window.runAction = runAction;
window.openLogs = openLogs;
window.downloadBackup = downloadBackup;
window.prepareRestore = prepareRestore;

el('refresh-btn').addEventListener('click', () => loadAll());
el('save-btn').addEventListener('click', savePM2);
el('save-alert-btn').addEventListener('click', savePM2);
el('backup-btn').addEventListener('click', createBackup);
el('logout-btn').addEventListener('click', logout);
el('search').addEventListener('input', render);
el('status-filter').addEventListener('change', render);
el('namespace-filter').addEventListener('change', render);

el('modal-close').addEventListener('click', () => el('modal').classList.add('hidden'));
el('modal').addEventListener('click', (event) => {
  if (event.target.id === 'modal') el('modal').classList.add('hidden');
});

el('restore-close').addEventListener('click', () => el('restore-modal').classList.add('hidden'));
el('restore-modal').addEventListener('click', (event) => {
  if (event.target.id === 'restore-modal') el('restore-modal').classList.add('hidden');
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    currentLogTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderLogs();
  });
});

window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});

initialize();
