let processes = [];
let saveState = null;
let currentLogs = { out: '', error: '' };
let currentLogTab = 'out';
let refreshTimer = null;

const { el, api, escapeHtml, formatBytes, formatDate, formatUptime, has, showToast, loadSession, bindShell } = PM2UI;

function renderNamespaceFilter() {
  const select = el('namespace-filter');
  const current = select.value;
  const namespaces = [...new Set(processes.map((p) => p.namespace || 'default'))].sort();
  select.innerHTML = '<option value="all">Todos os namespaces</option>' + namespaces.map((ns) => `<option value="${escapeHtml(ns)}">${escapeHtml(ns)}</option>`).join('');
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function filteredProcesses() {
  const q = el('search').value.trim().toLowerCase();
  const status = el('status-filter').value;
  const namespace = el('namespace-filter').value;
  return processes.filter((p) => {
    const search = [p.name, p.namespace, p.cwd, p.script].some((value) => String(value || '').toLowerCase().includes(q));
    return (!q || search) && (status === 'all' || p.status === status) && (namespace === 'all' || p.namespace === namespace);
  });
}

function renderStats() {
  el('stat-total').textContent = processes.length;
  el('stat-online').textContent = processes.filter((p) => p.status === 'online').length;
  el('stat-stopped').textContent = processes.filter((p) => p.status !== 'online').length;
  el('stat-memory').textContent = formatBytes(processes.reduce((sum, p) => sum + Number(p.memory || 0), 0));
}

function actionButtons(p) {
  const logs = `<button class="action" data-action="logs" data-id="${p.pm_id}" data-name="${escapeHtml(p.name)}">Logs</button>`;
  if (p.protected) return `${logs}<span class="protected-label">Protegido</span>`;
  if (!has('operate')) return logs;
  const lifecycle = p.status === 'online'
    ? `<button class="action" data-action="restart" data-id="${p.pm_id}" data-name="${escapeHtml(p.name)}">Restart</button><button class="action" data-action="stop" data-id="${p.pm_id}" data-name="${escapeHtml(p.name)}">Stop</button>`
    : `<button class="action" data-action="start" data-id="${p.pm_id}" data-name="${escapeHtml(p.name)}">Start</button>`;
  const remove = has('delete') ? `<button class="action danger" data-action="delete" data-id="${p.pm_id}" data-name="${escapeHtml(p.name)}">Delete</button>` : '';
  return logs + lifecycle + remove;
}

function renderProcesses() {
  renderStats();
  const list = filteredProcesses();
  el('empty-state').classList.toggle('hidden', list.length > 0);
  el('process-list').innerHTML = list.map((p) => `<tr><td><div class="project-name">${escapeHtml(p.name)} ${p.protected ? '<span class="shield">●</span>' : ''}</div><div class="project-meta">#${p.pm_id} · ${escapeHtml(p.namespace)} · ${escapeHtml(p.cwd || p.script || '')}</div></td><td class="table-status"><span class="badge ${escapeHtml(p.status)}">${escapeHtml(p.status)}</span></td><td>${Number(p.cpu || 0).toFixed(1)}%</td><td>${formatBytes(p.memory)}</td><td>${p.restarts}</td><td>${formatUptime(p.uptime)}</td><td class="process-actions"><div class="actions">${actionButtons(p)}</div></td></tr>`).join('');
}

function renderSaveState() {
  if (!saveState) return;
  el('last-save').textContent = saveState.lastSavedAt ? `Último PM2 Save: ${formatDate(saveState.lastSavedAt)}` : 'Nenhum PM2 Save detectado';
  el('save-detail').textContent = saveState.hasDump ? `${saveState.savedProcessCount ?? '?'} processos no dump · ${formatBytes(saveState.dumpSize)}` : 'O dump.pm2 ainda não existe.';
  el('backup-count').textContent = `${saveState.backupCount} backup${saveState.backupCount === 1 ? '' : 's'}`;
  el('save-alert').classList.toggle('hidden', !saveState.dirtySince || !has('save'));
}

async function loadAll(silent = false) {
  try {
    [processes, saveState] = await Promise.all([api('/api/processes'), api('/api/pm2/state')]);
    renderNamespaceFilter();
    renderProcesses();
    renderSaveState();
    el('server-status').textContent = 'PM2 conectado';
    document.querySelector('.dot').style.background = 'var(--green)';
    if (!silent) showToast('Processos atualizados');
  } catch (error) {
    el('server-status').textContent = 'Falha na conexão';
    document.querySelector('.dot').style.background = 'var(--red)';
    if (!silent) showToast(error.message, 'error');
  }
}

async function runAction(id, action, name) {
  if (action === 'delete' && !confirm(`Remover "${name}" do PM2?\n\nUm backup do dump atual será criado antes da exclusão.`)) return;
  try {
    showToast(`${action}: ${name}...`);
    await api(`/api/processes/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    await loadAll(true);
    showToast(`${name}: ${action} concluído`);
  } catch (error) { showToast(error.message, 'error'); }
}

async function openLogs(id, name) {
  el('modal').classList.remove('hidden');
  el('modal-title').textContent = `Logs · ${name}`;
  el('modal-subtitle').textContent = `Processo #${id}`;
  el('log-content').textContent = 'Carregando...';
  try {
    currentLogs = await api(`/api/processes/${encodeURIComponent(id)}/logs?lines=200`);
    currentLogTab = 'out';
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === 'out'));
    renderLogs();
  } catch (error) { el('log-content').textContent = error.message; }
}
function renderLogs() { el('log-content').textContent = currentLogs[currentLogTab] || 'Sem logs.'; }

async function savePM2() {
  try {
    el('save-btn').disabled = true;
    const result = await api('/api/pm2/save', { method: 'POST' });
    await loadAll(true);
    showToast(result.backup ? 'PM2 Save concluído e dump anterior preservado.' : 'PM2 Save concluído.');
  } catch (error) { showToast(error.message, 'error'); }
  finally { el('save-btn').disabled = false; }
}

el('process-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action, id, name } = button.dataset;
  if (action === 'logs') openLogs(id, name); else runAction(id, action, name);
});
el('refresh-btn').addEventListener('click', () => loadAll());
el('save-btn').addEventListener('click', savePM2);
el('save-alert-btn').addEventListener('click', savePM2);
el('search').addEventListener('input', renderProcesses);
el('status-filter').addEventListener('change', renderProcesses);
el('namespace-filter').addEventListener('change', renderProcesses);
el('modal-close').addEventListener('click', () => el('modal').classList.add('hidden'));
el('modal').addEventListener('click', (event) => { if (event.target.id === 'modal') el('modal').classList.add('hidden'); });
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => { currentLogTab = tab.dataset.tab; document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab)); renderLogs(); }));

(async () => { bindShell(); if (!await loadSession()) return; await loadAll(true); refreshTimer = setInterval(() => loadAll(true), 5000); })();
window.addEventListener('beforeunload', () => { if (refreshTimer) clearInterval(refreshTimer); });