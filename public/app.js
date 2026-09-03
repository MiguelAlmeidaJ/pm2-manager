let processes = [];
let currentLogs = { out: '', error: '' };
let currentLogTab = 'out';

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

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showToast(message) {
  const toast = el('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}

async function loadProcesses(silent = false) {
  try {
    processes = await api('/api/processes');
    renderNamespaceFilter();
    render();
    el('server-status').textContent = 'PM2 conectado';
    document.querySelector('.dot').style.background = 'var(--green)';
    if (!silent) showToast('Lista atualizada');
  } catch (error) {
    el('server-status').textContent = 'Falha na conexão';
    document.querySelector('.dot').style.background = 'var(--red)';
    if (!silent) showToast(error.message);
  }
}

function renderNamespaceFilter() {
  const select = el('namespace-filter');
  const current = select.value;
  const namespaces = [...new Set(processes.map(p => p.namespace || 'default'))].sort();

  select.innerHTML = '<option value="all">Todos os namespaces</option>' +
    namespaces.map(ns => `<option value="${escapeHtml(ns)}">${escapeHtml(ns)}</option>`).join('');

  if ([...select.options].some(o => o.value === current)) select.value = current;
}

function getFiltered() {
  const q = el('search').value.trim().toLowerCase();
  const status = el('status-filter').value;
  const namespace = el('namespace-filter').value;

  return processes.filter(p => {
    const matchesQ = !q || [p.name, p.namespace, p.cwd, p.script]
      .some(v => String(v || '').toLowerCase().includes(q));

    const matchesStatus = status === 'all' || p.status === status;
    const matchesNamespace = namespace === 'all' || p.namespace === namespace;

    return matchesQ && matchesStatus && matchesNamespace;
  });
}

function renderStats() {
  el('stat-total').textContent = processes.length;
  el('stat-online').textContent = processes.filter(p => p.status === 'online').length;
  el('stat-stopped').textContent = processes.filter(p => p.status !== 'online').length;

  const totalMemory = processes.reduce((sum, p) => sum + (p.memory || 0), 0);
  el('stat-memory').textContent = formatBytes(totalMemory);
}

function render() {
  renderStats();

  const list = getFiltered();
  const tbody = el('process-list');
  const empty = el('empty-state');

  empty.classList.toggle('hidden', list.length > 0);

  tbody.innerHTML = list.map(p => `
    <tr>
      <td>
        <div class="project-name">${escapeHtml(p.name)}</div>
        <div class="project-meta">#${p.pm_id} · ${escapeHtml(p.namespace)} · ${escapeHtml(p.cwd || p.script || '')}</div>
      </td>
      <td><span class="badge ${escapeHtml(p.status)}">${escapeHtml(p.status)}</span></td>
      <td>${Number(p.cpu || 0).toFixed(1)}%</td>
      <td>${formatBytes(p.memory)}</td>
      <td>${p.restarts}</td>
      <td>${formatUptime(p.uptime)}</td>
      <td>
        <div class="actions">
          <button class="action" onclick="openLogs('${p.pm_id}', '${escapeHtml(p.name)}')">Logs</button>
          ${p.status === 'online'
            ? `<button class="action" onclick="runAction('${p.pm_id}', 'restart', '${escapeHtml(p.name)}')">Restart</button>
               <button class="action" onclick="runAction('${p.pm_id}', 'stop', '${escapeHtml(p.name)}')">Stop</button>`
            : `<button class="action" onclick="runAction('${p.pm_id}', 'start', '${escapeHtml(p.name)}')">Start</button>`
          }
          <button class="action danger" onclick="runAction('${p.pm_id}', 'delete', '${escapeHtml(p.name)}')">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function runAction(id, action, name) {
  if (action === 'delete' && !confirm(`Remover "${name}" do PM2?`)) return;

  try {
    showToast(`${action}: ${name}...`);
    await api(`/api/processes/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    await loadProcesses(true);
    showToast(`${name}: ${action} concluído`);
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
    document.querySelectorAll('.tab').forEach(tab => {
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

window.runAction = runAction;
window.openLogs = openLogs;

el('refresh-btn').addEventListener('click', () => loadProcesses());
el('search').addEventListener('input', render);
el('status-filter').addEventListener('change', render);
el('namespace-filter').addEventListener('change', render);

el('modal-close').addEventListener('click', () => el('modal').classList.add('hidden'));
el('modal').addEventListener('click', (event) => {
  if (event.target.id === 'modal') el('modal').classList.add('hidden');
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    currentLogTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    renderLogs();
  });
});

loadProcesses(true);
setInterval(() => loadProcesses(true), 5000);
