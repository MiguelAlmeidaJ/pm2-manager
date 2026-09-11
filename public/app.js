let processes = [];
let saveState = null;
let overviewHistory = null;
let serverState = null;
let historyByKey = new Map();
let currentLogs = { out: '', error: '', outPath: '', errorPath: '' };
let logsProcessId = null;
let selectedProcessId = null;
let selectedDetailTab = 'overview';
let liveSource = null;
let fallbackTimer = null;
let stateTimer = null;
let logTimer = null;
let logLive = false;
let favoriteOnly = false;
let paletteIndex = 0;

const { el, api, escapeHtml, formatBytes, formatDate, formatUptime, has, showToast, loadSession, bindShell } = PM2UI;
const HEALTH_LABELS = { healthy: 'Saudável', attention: 'Atenção', unstable: 'Instável', critical: 'Crítico' };
const HEALTH_RANK = { critical: 0, unstable: 1, attention: 2, healthy: 3 };
const FAVORITES_KEY = 'pm2-manager:favorites:v1';
const favorites = loadFavorites();

function loadFavorites() {
  try {
    const value = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    return new Set(Array.isArray(value) ? value : []);
  } catch (_) {
    return new Set();
  }
}

function saveFavorites() {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites])); } catch (_) { /* browser sem storage */ }
}

function processKey(name, namespace) {
  return `${namespace || 'default'}\u0000${name || ''}`;
}

function favoriteKey(p) {
  return processKey(p.name, p.namespace);
}

function isFavorite(p) {
  return favorites.has(favoriteKey(p));
}

function findProcess(id) {
  return processes.find((p) => String(p.pm_id) === String(id)) || null;
}

function formatDurationSeconds(value) {
  const seconds = Math.max(0, Number(value || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRelativeTime(timestamp) {
  const diff = Math.max(0, Date.now() - Number(timestamp || 0));
  if (diff < 60 * 1000) return 'agora';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} min`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

function statusClass(status) {
  const normalized = String(status || 'unknown').toLowerCase();
  if (['online', 'stopped', 'errored', 'launching', 'stopping'].includes(normalized)) return normalized;
  return 'unknown';
}

function restartWindows(p) {
  return historyByKey.get(processKey(p.name, p.namespace))?.restarts || p.health?.restarts || { hour: 0, day: 0, week: 0 };
}

function calculateHealth(p) {
  if (p.health?.level) return p.health;
  const recent = restartWindows(p);
  const reasons = [];
  const status = statusClass(p.status);
  let score = 100;

  if (status === 'errored') { score -= 90; reasons.push('processo em erro'); }
  else if (status !== 'online') { score -= 70; reasons.push(`status ${status}`); }
  if (recent.hour >= 3) { score -= 45; reasons.push(`${recent.hour} reinícios na última hora`); }
  else if (recent.hour > 0) { score -= 18; reasons.push(`${recent.hour} reinício(s) na última hora`); }
  if (recent.day >= 8) { score -= 30; reasons.push(`${recent.day} reinícios em 24h`); }
  else if (recent.day >= 3) { score -= 15; reasons.push(`${recent.day} reinícios em 24h`); }
  if (Number(p.cpu || 0) >= 95) { score -= 25; reasons.push('CPU muito alta'); }
  else if (Number(p.cpu || 0) >= 80) { score -= 12; reasons.push('CPU alta'); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let level = 'healthy';
  if (status === 'errored' || score < 40) level = 'critical';
  else if (score < 65) level = 'unstable';
  else if (score < 85) level = 'attention';
  return { score, level, reasons: reasons.slice(0, 3), restarts: recent };
}

function processHistory(p) {
  return historyByKey.get(processKey(p.name, p.namespace)) || null;
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
  const health = el('health-filter').value;
  const namespace = el('namespace-filter').value;
  return processes.filter((p) => {
    const search = [p.name, p.namespace, p.cwd, p.script].some((value) => String(value || '').toLowerCase().includes(q));
    const condition = calculateHealth(p).level;
    return (!q || search)
      && (status === 'all' || String(p.status).toLowerCase() === status)
      && (health === 'all' || condition === health)
      && (namespace === 'all' || p.namespace === namespace)
      && (!favoriteOnly || isFavorite(p));
  }).sort((a, b) => {
    const healthDiff = HEALTH_RANK[calculateHealth(a).level] - HEALTH_RANK[calculateHealth(b).level];
    if (healthDiff) return healthDiff;
    const favoriteDiff = Number(isFavorite(b)) - Number(isFavorite(a));
    if (favoriteDiff) return favoriteDiff;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function renderStats() {
  const health = processes.map(calculateHealth);
  el('stat-total').textContent = processes.length;
  el('stat-online').textContent = processes.filter((p) => p.status === 'online').length;
  el('stat-attention').textContent = health.filter((item) => ['attention', 'unstable'].includes(item.level)).length;
  el('stat-critical').textContent = health.filter((item) => item.level === 'critical').length;
  el('stat-memory').textContent = formatBytes(processes.reduce((sum, p) => sum + Number(p.memory || 0), 0));
}

function serverCondition() {
  if (!serverState) return { level: 'attention', label: 'Aguardando' };
  const cpu = Number(serverState.cpuPercent || 0);
  const ram = Number(serverState.memoryPercent || 0);
  const disk = Number(serverState.disk?.percent || 0);
  if (cpu >= 95 || ram >= 96 || disk >= 96) return { level: 'critical', label: 'Crítico' };
  if (cpu >= 82 || ram >= 88 || disk >= 88) return { level: 'attention', label: 'Atenção' };
  return { level: 'healthy', label: 'Saudável' };
}

function setProgress(id, value) {
  const target = el(id);
  if (!target) return;
  target.value = Math.max(0, Math.min(100, Number(value || 0)));
}

function renderServer() {
  const condition = serverCondition();
  el('server-health-icon').className = `server-health-icon ${condition.level}`;
  el('server-health-label').className = `health-chip ${condition.level}`;
  el('server-health-label').textContent = condition.label;

  if (!serverState) return;
  const cpu = Number(serverState.cpuPercent || 0);
  const ram = Number(serverState.memoryPercent || 0);
  const disk = serverState.disk?.percent;
  const platform = `${serverState.platform || 'server'} ${serverState.release || ''}`.trim();

  el('server-name').textContent = serverState.hostname || 'Servidor';
  el('server-meta').textContent = `${platform} · ${serverState.arch || '-'} · Node ${serverState.nodeVersion || '-'} · PM2 ${serverState.pm2Version || '-'} · ${serverState.cpuCount || 0} CPUs`;
  el('server-cpu').textContent = `${cpu.toFixed(1)}%`;
  el('server-cpu-detail').textContent = `Load ${Array.isArray(serverState.loadavg) ? serverState.loadavg.map((n) => Number(n).toFixed(2)).join(' · ') : '—'}`;
  setProgress('server-cpu-progress', cpu);

  el('server-ram').textContent = `${ram.toFixed(1)}%`;
  el('server-ram-detail').textContent = `${formatBytes(serverState.usedMemory)} / ${formatBytes(serverState.totalMemory)}`;
  setProgress('server-ram-progress', ram);

  el('server-disk').textContent = disk === null || disk === undefined ? '—' : `${Number(disk).toFixed(1)}%`;
  el('server-disk-detail').textContent = serverState.disk?.total ? `${formatBytes(serverState.disk.used)} / ${formatBytes(serverState.disk.total)}` : (serverState.disk?.path || 'Indisponível');
  setProgress('server-disk-progress', disk || 0);

  el('server-uptime').textContent = formatDurationSeconds(serverState.uptime);
  el('server-runtime-detail').textContent = `${serverState.nodeVersion || 'Node'} · ${serverState.pm2Version ? `PM2 ${serverState.pm2Version}` : 'PM2'}`;
}

function timelineCells(p, count = 36) {
  const history = processHistory(p);
  const points = (history?.timeline || []).slice(-count);
  const missing = Math.max(0, count - points.length);
  const placeholders = Array.from({ length: missing }, () => '<span class="timeline-cell empty" title="Sem amostra histórica"></span>').join('');
  const cells = points.map((point) => {
    const status = statusClass(point.status);
    const title = `${formatDate(point.at)} · ${point.status || 'unknown'}`;
    return `<span class="timeline-cell ${status}" title="${escapeHtml(title)}"></span>`;
  }).join('');
  return placeholders + cells;
}

function sparkline(p, metric = 'cpu') {
  const points = (processHistory(p)?.timeline || [])
    .map((point) => Number(point[metric]))
    .filter((value) => Number.isFinite(value));
  if (points.length < 2) return '<div class="sparkline-empty">coletando histórico</div>';

  const width = 100;
  const height = 40;
  const maxValue = metric === 'cpu' ? Math.max(100, ...points) : Math.max(1, ...points) * 1.12;
  const coords = points.map((value, index) => {
    const x = points.length === 1 ? 0 : (index / (points.length - 1)) * width;
    const y = height - Math.min(height, (value / maxValue) * (height - 3));
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const area = `M 0 ${height} L ${coords.join(' L ')} L ${width} ${height} Z`;
  const klass = metric === 'memory' ? 'sparkline ram' : 'sparkline';
  return `<svg class="${klass}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><line class="grid-line" x1="0" y1="20" x2="100" y2="20"></line><path class="area" d="${area}"></path><polyline class="line" points="${coords.join(' ')}"></polyline></svg>`;
}

function restartClass(value, severe = false) {
  if (severe ? value >= 3 : value >= 8) return 'danger';
  if (value > 0) return 'warn';
  return '';
}

function compactActions(p) {
  const open = `<button class="action open-detail" data-action="open" data-id="${p.pm_id}" type="button">Abrir</button>`;
  const logs = `<button class="action" data-action="logs" data-id="${p.pm_id}" type="button">Logs</button>`;
  if (p.protected || !has('operate')) return open + logs + (p.protected ? '<span class="protected-label">Protegido</span>' : '');
  const lifecycle = p.status === 'online'
    ? `<button class="action" data-action="restart" data-id="${p.pm_id}" type="button">Restart</button><button class="action warning" data-action="stop" data-id="${p.pm_id}" type="button">Stop</button>`
    : `<button class="action" data-action="start" data-id="${p.pm_id}" type="button">Start</button>`;
  return open + logs + lifecycle;
}

function fullActions(p) {
  if (p.protected) return '<span class="protected-label">Processo protegido</span>';
  if (!has('operate')) return '';
  const lifecycle = p.status === 'online'
    ? `<button class="action" data-action="restart" data-id="${p.pm_id}" type="button">Restart</button><button class="action warning" data-action="stop" data-id="${p.pm_id}" type="button">Stop</button>`
    : `<button class="action" data-action="start" data-id="${p.pm_id}" type="button">Start</button>`;
  const remove = has('delete') ? `<button class="action danger" data-action="delete" data-id="${p.pm_id}" type="button">Delete</button>` : '';
  return lifecycle + remove;
}

function renderProcessCard(p) {
  const recent = restartWindows(p);
  const status = statusClass(p.status);
  const health = calculateHealth(p);
  const metaPath = p.cwd || p.script || 'Caminho não informado';
  const favorite = isFavorite(p);
  return `<article class="process-card" data-status="${status}" data-health="${health.level}">
    <div class="process-card-header">
      <div class="process-heading"><span class="process-mark ${status}" aria-hidden="true"></span><div><div class="process-title-line"><button class="process-open" data-open-id="${p.pm_id}" type="button">${escapeHtml(p.name)}</button>${p.protected ? '<span class="shield">●</span>' : ''}<span class="badge ${status}">${escapeHtml(p.status)}</span><span class="health-chip ${health.level}">${HEALTH_LABELS[health.level]}</span></div><div class="project-meta">#${p.pm_id} · ${escapeHtml(p.namespace || 'default')} · ${escapeHtml(metaPath)}</div></div></div>
      <div class="process-header-actions"><span class="process-updated">PID ${p.pid || '-'}</span><button class="favorite-btn ${favorite ? 'active' : ''}" data-favorite-id="${p.pm_id}" type="button" title="${favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}">${favorite ? '★' : '☆'}</button></div>
    </div>
    <div class="process-card-body">
      <div class="process-timeline-block"><div class="metric-label">Disponibilidade</div><div class="timeline-grid">${timelineCells(p, 36)}</div><div class="timeline-legend"><span><i class="legend-dot online"></i>online</span><span><i class="legend-dot stopped"></i>parado</span><span><i class="legend-dot errored"></i>erro</span></div></div>
      <div class="trend-block"><div class="metric-label">Tendência</div><div class="trend-grid"><div class="trend-card"><div class="trend-card-header"><span>CPU</span><strong>${Number(p.cpu || 0).toFixed(1)}%</strong></div>${sparkline(p, 'cpu')}</div><div class="trend-card"><div class="trend-card-header"><span>RAM</span><strong>${formatBytes(p.memory)}</strong></div>${sparkline(p, 'memory')}</div></div></div>
      <div class="restart-block"><div class="metric-label">Reinícios observados</div><div class="restart-grid"><div><span>-1 hora</span><strong class="${restartClass(recent.hour, true)}">${recent.hour}</strong></div><div><span>-24 horas</span><strong class="${restartClass(recent.day)}">${recent.day}</strong></div><div><span>-7 dias</span><strong class="${restartClass(recent.week)}">${recent.week}</strong></div></div></div>
      <div class="key-metrics"><div><span>CPU</span><strong>${Number(p.cpu || 0).toFixed(1)}%</strong></div><div><span>RAM</span><strong>${formatBytes(p.memory)}</strong></div><div><span>Uptime</span><strong>${formatUptime(p.uptime)}</strong></div><div><span>Score</span><strong>${health.score}</strong></div></div>
    </div>
    <div class="process-card-footer"><span>${escapeHtml(p.mode || 'PM2')} ${p.version ? `· v${escapeHtml(p.version)}` : ''}${p.nodeVersion ? ` · Node ${escapeHtml(p.nodeVersion)}` : ''}</span><div class="actions">${compactActions(p)}</div></div>
  </article>`;
}

function renderProcesses() {
  renderStats();
  const list = filteredProcesses();
  el('visible-count').textContent = `${list.length} visíve${list.length === 1 ? 'l' : 'is'}`;
  el('empty-state').classList.toggle('hidden', list.length > 0);
  el('process-list').innerHTML = list.map(renderProcessCard).join('');
}

function renderHistoryStatus() {
  const target = el('history-status');
  if (!overviewHistory?.sampledAt) {
    target.textContent = 'Histórico iniciando...';
    return;
  }
  const earliest = overviewHistory.processes?.reduce((min, item) => Math.min(min, Number(item.firstSeen || Infinity)), Infinity);
  target.textContent = Number.isFinite(earliest) ? `Desde ${formatDate(earliest)}` : `Atualizado ${formatDate(overviewHistory.sampledAt)}`;
}

function indexHistory() {
  historyByKey = new Map((overviewHistory?.processes || []).map((item) => [processKey(item.name, item.namespace), item]));
  renderHistoryStatus();
}

function alertItems() {
  const items = [];
  if (serverState) {
    const checks = [
      ['CPU do servidor', Number(serverState.cpuPercent || 0), 82, 95],
      ['RAM do servidor', Number(serverState.memoryPercent || 0), 88, 96],
      ['Disco do servidor', Number(serverState.disk?.percent || 0), 88, 96],
    ];
    for (const [label, value, warning, critical] of checks) {
      if (value >= warning) items.push({ level: value >= critical ? 'critical' : 'attention', title: label, detail: `${value.toFixed(1)}% em uso`, score: Math.round(value) });
    }
  }
  for (const p of processes) {
    const health = calculateHealth(p);
    if (health.level === 'healthy') continue;
    items.push({ level: health.level, title: p.name, detail: health.reasons?.[0] || `Health Score ${health.score}`, score: health.score, id: p.pm_id });
  }
  return items.sort((a, b) => (HEALTH_RANK[a.level] ?? 9) - (HEALTH_RANK[b.level] ?? 9) || a.score - b.score).slice(0, 6);
}

function renderAlerts() {
  const items = alertItems();
  el('alert-count').textContent = `${items.length} alerta${items.length === 1 ? '' : 's'}`;
  if (!items.length) {
    el('alerts-list').innerHTML = '<div class="panel-empty">Tudo estável por aqui. Nenhuma prioridade operacional agora.</div>';
    return;
  }
  el('alerts-list').innerHTML = items.map((item) => {
    const tag = item.id !== undefined ? 'button' : 'div';
    const open = item.id !== undefined ? ` data-open-id="${item.id}" type="button"` : '';
    return `<${tag} class="alert-item ${item.level}"${open}><span class="alert-signal"></span><div class="alert-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div><span class="alert-score">${item.id !== undefined ? `score ${item.score}` : `${item.score}%`}</span></${tag}>`;
  }).join('');
}

function eventDescription(event) {
  if (event.type === 'restart') return `${event.count || 1} reinício(s) observado(s)`;
  if (event.type === 'status') return `${event.from || '?'} → ${event.to || '?'}`;
  return event.type || 'evento';
}

function eventClass(event) {
  if (event.type === 'restart') return 'restart';
  return `status-${statusClass(event.to || event.status)}`;
}

function eventProcessId(event) {
  return processes.find((p) => p.name === event.name && (p.namespace || 'default') === (event.namespace || 'default'))?.pm_id;
}

function activityItemHtml(event) {
  const id = eventProcessId(event);
  const tag = id !== undefined ? 'button' : 'div';
  const open = id !== undefined ? ` data-open-id="${id}" type="button"` : '';
  return `<${tag} class="activity-item ${eventClass(event)}"${open}><span class="activity-signal"></span><div class="activity-copy"><strong>${escapeHtml(event.name || 'Sistema')}</strong><span>${escapeHtml(eventDescription(event))}</span></div><span class="activity-time" title="${escapeHtml(formatDate(event.at))}">${formatRelativeTime(event.at)}</span></${tag}>`;
}

function renderActivity() {
  const events = (overviewHistory?.events || []).slice(0, 6);
  el('activity-list').innerHTML = events.length ? events.map(activityItemHtml).join('') : '<div class="panel-empty">Aguardando mudanças de status e reinícios.</div>';
}

function renderSaveState() {
  if (!saveState) return;
  el('last-save').textContent = saveState.lastSavedAt ? `Último PM2 Save: ${formatDate(saveState.lastSavedAt)}` : 'Nenhum PM2 Save detectado';
  el('save-detail').textContent = saveState.hasDump ? `${saveState.savedProcessCount ?? '?'} processos no dump · ${formatBytes(saveState.dumpSize)}` : 'O dump.pm2 ainda não existe.';
  el('backup-count').textContent = `${saveState.backupCount} backup${saveState.backupCount === 1 ? '' : 's'}`;
  el('save-alert').classList.toggle('hidden', !saveState.dirtySince || !has('save'));
}

function renderFavoriteFilter() {
  const button = el('favorite-filter');
  button.classList.toggle('active', favoriteOnly);
  button.textContent = favoriteOnly ? '★ Favoritos' : '☆ Favoritos';
}

function renderAll() {
  renderServer();
  renderProcesses();
  renderAlerts();
  renderActivity();
  renderFavoriteFilter();
  if (selectedProcessId !== null) renderDetail(findProcess(selectedProcessId));
  if (!el('palette').classList.contains('hidden')) renderPalette();
}

function applySnapshot(snapshot) {
  processes = Array.isArray(snapshot?.processes) ? snapshot.processes : [];
  overviewHistory = snapshot?.history || overviewHistory;
  serverState = snapshot?.server || serverState;
  indexHistory();
  renderNamespaceFilter();
  renderAll();
  el('last-update').textContent = `Atualizado ${new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' }).format(new Date(snapshot?.at || Date.now()))}`;
}

function setLiveStatus(mode, text) {
  const indicator = el('live-indicator');
  indicator.className = `live-indicator ${mode || ''}`.trim();
  indicator.lastChild.textContent = text;
  const dot = document.querySelector('.dot');
  if (dot) dot.className = `dot ${mode === 'connected' ? 'connected' : mode === 'disconnected' ? 'disconnected' : ''}`;
  el('server-status').textContent = text;
}

async function loadSnapshot(silent = false) {
  try {
    const snapshot = await api('/api/overview/snapshot');
    applySnapshot(snapshot);
    setLiveStatus('connected', liveSource ? 'Telemetria ao vivo' : 'PM2 conectado');
    if (!silent) showToast('Painel atualizado');
  } catch (error) {
    try {
      const [fallbackProcesses, history, server] = await Promise.all([
        api('/api/processes'),
        api('/api/overview/history').catch(() => null),
        api('/api/overview/server').catch(() => null),
      ]);
      applySnapshot({ at: Date.now(), processes: fallbackProcesses, history, server });
      setLiveStatus('', 'PM2 conectado');
      if (!silent) showToast('Painel atualizado');
    } catch (_) {
      setLiveStatus('disconnected', 'Falha na conexão');
      el('last-update').textContent = 'Falha ao atualizar';
      if (!silent) showToast(error.message, 'error');
    }
  }
}

async function loadSaveState(silent = true) {
  try {
    saveState = await api('/api/pm2/state');
    renderSaveState();
  } catch (error) {
    if (!silent) showToast(error.message, 'error');
  }
}

function ensureFallbackPolling() {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => loadSnapshot(true), 15000);
}

function clearFallbackPolling() {
  if (!fallbackTimer) return;
  clearInterval(fallbackTimer);
  fallbackTimer = null;
}

function connectLive() {
  if (!window.EventSource) {
    ensureFallbackPolling();
    return;
  }
  if (liveSource) liveSource.close();
  liveSource = new EventSource('/api/overview/stream');
  setLiveStatus('', 'Conectando ao vivo');
  liveSource.addEventListener('snapshot', (event) => {
    try { applySnapshot(JSON.parse(event.data)); } catch (_) { /* payload inválido é ignorado */ }
  });
  liveSource.addEventListener('warning', () => setLiveStatus('', 'Telemetria degradada'));
  liveSource.onopen = () => {
    clearFallbackPolling();
    setLiveStatus('connected', 'Telemetria ao vivo');
  };
  liveSource.onerror = () => {
    setLiveStatus('disconnected', 'Reconectando...');
    ensureFallbackPolling();
  };
}

async function runAction(id, action) {
  const p = findProcess(id);
  if (!p) return;
  if (action === 'delete' && !confirm(`Remover "${p.name}" do PM2?\n\nUm backup do dump atual será criado antes da exclusão.`)) return;
  try {
    showToast(`${action}: ${p.name}...`);
    await api(`/api/processes/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    await Promise.all([loadSnapshot(true), loadSaveState(true)]);
    showToast(`${p.name}: ${action} concluído`);
  } catch (error) { showToast(error.message, 'error'); }
}

function toggleFavorite(id) {
  const p = findProcess(id);
  if (!p) return;
  const key = favoriteKey(p);
  if (favorites.has(key)) favorites.delete(key); else favorites.add(key);
  saveFavorites();
  renderAll();
}

function detailEvents(p) {
  return (overviewHistory?.events || []).filter((event) => event.name === p.name && (event.namespace || 'default') === (p.namespace || 'default')).slice(0, 10);
}

function renderDetail(p) {
  if (!p) {
    closeDetail();
    return;
  }
  const health = calculateHealth(p);
  const status = statusClass(p.status);
  const recent = restartWindows(p);
  const mark = el('detail-status-mark');
  mark.className = `process-mark ${status}`;
  el('detail-title').textContent = p.name;
  el('detail-health').className = `health-chip ${health.level}`;
  el('detail-health').textContent = HEALTH_LABELS[health.level];
  el('detail-subtitle').textContent = `#${p.pm_id} · ${p.namespace || 'default'} · ${p.cwd || p.script || 'caminho não informado'}`;
  el('detail-summary').innerHTML = `<article><span>CPU</span><strong>${Number(p.cpu || 0).toFixed(1)}%</strong></article><article><span>RAM</span><strong>${formatBytes(p.memory)}</strong></article><article><span>Uptime</span><strong>${formatUptime(p.uptime)}</strong></article><article><span>Restarts</span><strong>${Number(p.restarts || 0)}</strong></article>`;
  el('detail-score').textContent = `${health.score}/100`;
  el('detail-reasons').innerHTML = health.reasons?.length
    ? health.reasons.map((reason) => `<span class="reason-pill">${escapeHtml(reason)}</span>`).join('')
    : '<span class="reason-pill ok">Nenhum sinal de instabilidade relevante</span>';

  const events = detailEvents(p);
  el('detail-events').innerHTML = events.length ? events.map(activityItemHtml).join('') : '<div class="panel-empty">Nenhum evento recente registrado para esta aplicação.</div>';
  el('detail-runtime').innerHTML = `<div><span>PID</span><strong>${p.pid || '-'}</strong></div><div><span>Namespace</span><strong>${escapeHtml(p.namespace || 'default')}</strong></div><div><span>Modo</span><strong>${escapeHtml(p.mode || '-')}</strong></div><div><span>Node</span><strong>${escapeHtml(p.nodeVersion || '-')}</strong></div><div><span>Versão</span><strong>${escapeHtml(p.version || '-')}</strong></div><div><span>Criado</span><strong>${p.createdAt ? escapeHtml(formatDate(p.createdAt)) : '-'}</strong></div><div><span>Script</span><strong title="${escapeHtml(p.script || '')}">${escapeHtml(p.script || '-')}</strong></div><div><span>Diretório</span><strong title="${escapeHtml(p.cwd || '')}">${escapeHtml(p.cwd || '-')}</strong></div>`;

  el('detail-cpu-current').textContent = `${Number(p.cpu || 0).toFixed(1)}%`;
  el('detail-ram-current').textContent = formatBytes(p.memory);
  el('detail-uptime-current').textContent = formatUptime(p.uptime);
  el('detail-cpu-chart').innerHTML = sparkline(p, 'cpu');
  el('detail-ram-chart').innerHTML = sparkline(p, 'memory');
  el('detail-timeline').innerHTML = `<div class="timeline-grid">${timelineCells(p, 48)}</div><div class="timeline-legend"><span><i class="legend-dot online"></i>online</span><span><i class="legend-dot stopped"></i>parado</span><span><i class="legend-dot errored"></i>erro</span><span>${recent.day} reinício(s) / 24h</span></div>`;
  el('detail-favorite').textContent = isFavorite(p) ? '★ Favorito' : '☆ Favoritar';
  el('detail-actions').innerHTML = fullActions(p);
}

function openDetail(id, tab = 'overview') {
  const p = findProcess(id);
  if (!p) return;
  selectedProcessId = p.pm_id;
  el('detail-overlay').classList.remove('hidden');
  el('detail-overlay').setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
  renderDetail(p);
  setDetailTab(tab);
}

function closeDetail() {
  selectedProcessId = null;
  el('detail-overlay').classList.add('hidden');
  el('detail-overlay').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
  stopLogLive();
}

function setDetailTab(tab) {
  selectedDetailTab = tab;
  document.querySelectorAll('[data-detail-tab]').forEach((button) => button.classList.toggle('active', button.dataset.detailTab === tab));
  document.querySelectorAll('.detail-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `detail-panel-${tab}`));
  if (tab === 'logs' && selectedProcessId !== null && String(logsProcessId) !== String(selectedProcessId)) loadLogs();
}

function logText() {
  const source = el('log-source').value;
  const query = el('log-search').value.trim().toLowerCase();
  const text = currentLogs[source] || '';
  if (!query) return text;
  return text.split(/\r?\n/).filter((line) => line.toLowerCase().includes(query)).join('\n');
}

function renderLogs() {
  const source = el('log-source').value;
  const text = logText();
  const lines = text ? text.split(/\r?\n/).length : 0;
  el('detail-log-content').textContent = text || 'Sem logs para este filtro.';
  el('log-path').textContent = source === 'error' ? (currentLogs.errorPath || 'error log') : (currentLogs.outPath || 'output log');
  el('log-count').textContent = `${lines} linha${lines === 1 ? '' : 's'}`;
}

async function loadLogs(silent = false) {
  if (selectedProcessId === null) return;
  try {
    const logs = await api(`/api/processes/${encodeURIComponent(selectedProcessId)}/logs?lines=500`);
    if (selectedProcessId === null) return;
    currentLogs = logs;
    logsProcessId = selectedProcessId;
    renderLogs();
    if (!silent) showToast('Logs atualizados');
  } catch (error) {
    el('detail-log-content').textContent = error.message;
  }
}

function stopLogLive() {
  logLive = false;
  if (logTimer) clearInterval(logTimer);
  logTimer = null;
  el('log-live').classList.remove('active');
  el('log-live').textContent = 'Live: off';
}

function toggleLogLive() {
  if (logLive) {
    stopLogLive();
    return;
  }
  logLive = true;
  el('log-live').classList.add('active');
  el('log-live').textContent = 'Live: on';
  loadLogs(true);
  logTimer = setInterval(() => loadLogs(true), 3000);
}

async function copyLogs() {
  try {
    await navigator.clipboard.writeText(logText());
    showToast('Logs copiados');
  } catch (_) {
    showToast('Não foi possível copiar os logs neste navegador.', 'error');
  }
}

function paletteMatches() {
  const q = el('palette-search').value.trim().toLowerCase();
  return processes.filter((p) => [p.name, p.namespace, p.cwd, p.script].some((value) => String(value || '').toLowerCase().includes(q)))
    .sort((a, b) => Number(isFavorite(b)) - Number(isFavorite(a)) || (HEALTH_RANK[calculateHealth(a).level] - HEALTH_RANK[calculateHealth(b).level]) || String(a.name).localeCompare(String(b.name)))
    .slice(0, 10);
}

function renderPalette() {
  const matches = paletteMatches();
  if (paletteIndex >= matches.length) paletteIndex = Math.max(0, matches.length - 1);
  el('palette-results').innerHTML = matches.length ? matches.map((p, index) => {
    const health = calculateHealth(p);
    return `<button class="palette-item ${index === paletteIndex ? 'active' : ''}" data-open-id="${p.pm_id}" type="button"><span class="process-mark ${statusClass(p.status)}"></span><div class="palette-copy"><strong>${isFavorite(p) ? '★ ' : ''}${escapeHtml(p.name)}</strong><span>#${p.pm_id} · ${escapeHtml(p.namespace || 'default')} · ${escapeHtml(p.status)}</span></div><span class="palette-health">${HEALTH_LABELS[health.level]} · ${health.score}</span></button>`;
  }).join('') : '<div class="panel-empty">Nenhuma aplicação encontrada.</div>';
}

function openPalette() {
  paletteIndex = 0;
  el('palette').classList.remove('hidden');
  el('palette').setAttribute('aria-hidden', 'false');
  el('palette-search').value = '';
  renderPalette();
  requestAnimationFrame(() => el('palette-search').focus());
}

function closePalette() {
  el('palette').classList.add('hidden');
  el('palette').setAttribute('aria-hidden', 'true');
}

async function savePM2() {
  try {
    el('save-btn').disabled = true;
    const result = await api('/api/pm2/save', { method: 'POST' });
    await Promise.all([loadSnapshot(true), loadSaveState(true)]);
    showToast(result.backup ? 'PM2 Save concluído e dump anterior preservado.' : 'PM2 Save concluído.');
  } catch (error) { showToast(error.message, 'error'); }
  finally { el('save-btn').disabled = false; }
}

function handleActionButton(button) {
  const { action, id } = button.dataset;
  if (action === 'open') openDetail(id);
  else if (action === 'logs') openDetail(id, 'logs');
  else runAction(id, action);
}

el('process-list').addEventListener('click', (event) => {
  const favorite = event.target.closest('[data-favorite-id]');
  if (favorite) { toggleFavorite(favorite.dataset.favoriteId); return; }
  const opener = event.target.closest('[data-open-id]');
  if (opener) { openDetail(opener.dataset.openId); return; }
  const button = event.target.closest('[data-action]');
  if (button) handleActionButton(button);
});

['alerts-list', 'activity-list'].forEach((id) => el(id).addEventListener('click', (event) => {
  const opener = event.target.closest('[data-open-id]');
  if (opener) openDetail(opener.dataset.openId);
}));

el('detail-events').addEventListener('click', (event) => {
  const opener = event.target.closest('[data-open-id]');
  if (opener) openDetail(opener.dataset.openId);
});

el('detail-actions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (button) handleActionButton(button);
});

el('refresh-btn').addEventListener('click', () => Promise.all([loadSnapshot(false), loadSaveState(true)]));
el('save-btn').addEventListener('click', savePM2);
el('save-alert-btn').addEventListener('click', savePM2);
el('search').addEventListener('input', renderProcesses);
el('status-filter').addEventListener('change', renderProcesses);
el('health-filter').addEventListener('change', renderProcesses);
el('namespace-filter').addEventListener('change', renderProcesses);
el('favorite-filter').addEventListener('click', () => { favoriteOnly = !favoriteOnly; renderFavoriteFilter(); renderProcesses(); });
el('detail-close').addEventListener('click', closeDetail);
el('detail-overlay').addEventListener('click', (event) => { if (event.target.id === 'detail-overlay') closeDetail(); });
document.querySelectorAll('[data-detail-tab]').forEach((button) => button.addEventListener('click', () => setDetailTab(button.dataset.detailTab)));
el('detail-favorite').addEventListener('click', () => { if (selectedProcessId !== null) toggleFavorite(selectedProcessId); });
el('log-source').addEventListener('change', renderLogs);
el('log-search').addEventListener('input', renderLogs);
el('log-refresh').addEventListener('click', () => loadLogs(false));
el('log-live').addEventListener('click', toggleLogLive);
el('log-copy').addEventListener('click', copyLogs);
el('palette-search').addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
el('palette-results').addEventListener('click', (event) => {
  const opener = event.target.closest('[data-open-id]');
  if (!opener) return;
  closePalette();
  openDetail(opener.dataset.openId);
});
el('palette').addEventListener('click', (event) => { if (event.target.id === 'palette') closePalette(); });

document.addEventListener('keydown', (event) => {
  const paletteOpen = !el('palette').classList.contains('hidden');
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (paletteOpen) closePalette(); else openPalette();
    return;
  }
  if (event.key === 'Escape') {
    if (paletteOpen) closePalette();
    else if (!el('detail-overlay').classList.contains('hidden')) closeDetail();
    return;
  }
  if (!paletteOpen) return;
  const matches = paletteMatches();
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    paletteIndex = Math.min(Math.max(0, matches.length - 1), paletteIndex + 1);
    renderPalette();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    paletteIndex = Math.max(0, paletteIndex - 1);
    renderPalette();
  } else if (event.key === 'Enter' && matches[paletteIndex]) {
    event.preventDefault();
    const p = matches[paletteIndex];
    closePalette();
    openDetail(p.pm_id);
  }
});

(async () => {
  bindShell();
  if (!await loadSession()) return;
  await Promise.all([loadSnapshot(true), loadSaveState(true)]);
  connectLive();
  stateTimer = setInterval(() => loadSaveState(true), 30000);
})();

window.addEventListener('beforeunload', () => {
  if (liveSource) liveSource.close();
  if (fallbackTimer) clearInterval(fallbackTimer);
  if (stateTimer) clearInterval(stateTimer);
  if (logTimer) clearInterval(logTimer);
});
