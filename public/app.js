let processes = [];
let saveState = null;
let overviewHistory = null;
let historyByKey = new Map();
let currentLogs = { out: '', error: '' };
let currentLogTab = 'out';
let refreshTimer = null;

const { el, api, escapeHtml, formatBytes, formatDate, formatUptime, has, showToast, loadSession, bindShell } = PM2UI;

function processKey(name, namespace) {
  return `${namespace || 'default'}\u0000${name || ''}`;
}

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
    ? `<button class="action" data-action="restart" data-id="${p.pm_id}" data-name="${escapeHtml(p.name)}">Restart</button><button class="action warning" data-action="stop" data-id="${p.pm_id}" data-name="${escapeHtml(p.name)}">Stop</button>`
    : `<button class="action" data-action="start" data-id="${p.pm_id}" data-name="${escapeHtml(p.name)}">Start</button>`;
  const remove = has('delete') ? `<button class="action danger" data-action="delete" data-id="${p.pm_id}" data-name="${escapeHtml(p.name)}">Delete</button>` : '';
  return logs + lifecycle + remove;
}

function statusClass(status) {
  const normalized = String(status || 'unknown').toLowerCase();
  if (['online', 'stopped', 'errored', 'launching', 'stopping'].includes(normalized)) return normalized;
  return 'unknown';
}

function renderTimeline(p) {
  const history = historyByKey.get(processKey(p.name, p.namespace));
  const points = (history?.timeline || []).slice(-36);
  const missing = Math.max(0, 36 - points.length);
  const placeholders = Array.from({ length: missing }, () => '<span class="timeline-cell empty" title="Sem amostra histórica"></span>').join('');
  const cells = points.map((point) => {
    const status = statusClass(point.status);
    const title = `${formatDate(point.at)} · ${point.status || 'unknown'}`;
    return `<span class="timeline-cell ${status}" title="${escapeHtml(title)}"></span>`;
  }).join('');
  return placeholders + cells;
}

function restartWindows(p) {
  return historyByKey.get(processKey(p.name, p.namespace))?.restarts || { hour: 0, day: 0, week: 0 };
}

function renderProcessCard(p) {
  const restarts = restartWindows(p);
  const status = statusClass(p.status);
  const metaPath = p.cwd || p.script || 'Caminho não informado';
  return `<article class="process-card" data-status="${status}">
    <div class="process-card-header">
      <div class="process-heading">
        <span class="process-mark ${status}" aria-hidden="true"></span>
        <div><div class="process-title-line"><strong>${escapeHtml(p.name)}</strong>${p.protected ? '<span class="shield">●</span>' : ''}<span class="badge ${status}">${escapeHtml(p.status)}</span></div><div class="project-meta">#${p.pm_id} · ${escapeHtml(p.namespace || 'default')} · ${escapeHtml(metaPath)}</div></div>
      </div>
      <span class="process-updated">PID ${p.pid || '-'}</span>
    </div>
    <div class="process-card-body">
      <div class="process-timeline-block">
        <div class="metric-label">Disponibilidade</div>
        <div class="timeline-grid">${renderTimeline(p)}</div>
        <div class="timeline-legend"><span><i class="legend-dot online"></i>online</span><span><i class="legend-dot stopped"></i>parado</span><span><i class="legend-dot errored"></i>erro</span></div>
      </div>
      <div class="restart-block">
        <div class="metric-label">Reinícios observados</div>
        <div class="restart-grid"><div><span>-1 hora</span><strong>${restarts.hour}</strong></div><div><span>-24 horas</span><strong>${restarts.day}</strong></div><div><span>-7 dias</span><strong>${restarts.week}</strong></div></div>
      </div>
      <div class="key-metrics">
        <div><span>CPU</span><strong>${Number(p.cpu || 0).toFixed(1)}%</strong></div>
        <div><span>RAM</span><strong>${formatBytes(p.memory)}</strong></div>
        <div><span>Uptime</span><strong>${formatUptime(p.uptime)}</strong></div>
        <div><span>Restarts</span><strong>${Number(p.restarts || 0)}</strong></div>
      </div>
    </div>
    <div class="process-card-footer"><span>${escapeHtml(p.mode || 'PM2')} ${p.version ? `· v${escapeHtml(p.version)}` : ''}${p.nodeVersion ? ` · Node ${escapeHtml(p.nodeVersion)}` : ''}</span><div class="actions">${actionButtons(p)}</div></div>
  </article>`;
}

function renderProcesses() {
  renderStats();
  const list = filteredProcesses();
  el('empty-state').classList.toggle('hidden', list.length > 0);
  el('process-list').innerHTML = list.map(renderProcessCard).join('');
}

function renderHistoryStatus() {
  const target = el('history-status');
  if (!overviewHistory?.sampledAt) {
    target.textContent = 'Histórico começará após a primeira coleta';
    return;
  }
  const earliest = overviewHistory.processes?.reduce((min, item) => Math.min(min, Number(item.firstSeen || Infinity)), Infinity);
  target.textContent = Number.isFinite(earliest)
    ? `Histórico desde ${formatDate(earliest)}`
    : `Histórico atualizado ${formatDate(overviewHistory.sampledAt)}`;
}

function indexHistory() {
  historyByKey = new Map((overviewHistory?.processes || []).map((item) => [processKey(item.name, item.namespace), item]));
  renderHistoryStatus();
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
    const historyPromise = api('/api/overview/history').catch(() => null);
    [processes, saveState, overviewHistory] = await Promise.all([api('/api/processes'), api('/api/pm2/state'), historyPromise]);
    indexHistory();
    renderNamespaceFilter();
    renderProcesses();
    renderSaveState();
    el('server-status').textContent = 'PM2 conectado';
    el('last-update').textContent = `Atualizado ${new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' }).format(new Date())}`;
    const dot = document.querySelector('.dot');
    if (dot) dot.className = 'dot connected';
    if (!silent) showToast('Processos atualizados');
  } catch (error) {
    el('server-status').textContent = 'Falha na conexão';
    el('last-update').textContent = 'Falha ao atualizar';
    const dot = document.querySelector('.dot');
    if (dot) dot.className = 'dot disconnected';
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
