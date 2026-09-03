(() => {
  const state = { user: null, role: null, permissions: new Set(), csrfToken: null, expiresAt: null };
  const el = (id) => document.getElementById(id);

  function escapeHtml(value = '') {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }
  function formatBytes(bytes = 0) {
    if (!bytes) return '0 MB';
    const mb = Number(bytes) / 1024 / 1024;
    return mb < 1024 ? `${mb.toFixed(mb < 100 ? 1 : 0)} MB` : `${(mb / 1024).toFixed(2)} GB`;
  }
  function formatDate(timestamp) {
    if (!timestamp) return '-';
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(timestamp));
  }
  function formatUptime(timestamp) {
    if (!timestamp) return '-';
    const diff = Math.max(0, Date.now() - Number(timestamp));
    const seconds = Math.floor(diff / 1000), days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600), minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }
  function roleLabel(role) { return ({ admin: 'Administrador', operator: 'Operador', viewer: 'Consulta' })[role] || role || '-'; }
  function has(permission) { return state.permissions.has(permission); }
  function redirectToLogin() {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(`/login?next=${encodeURIComponent(next)}`);
  }
  function showToast(message, kind = 'default') {
    const toast = el('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.classList.remove('hidden');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3200);
  }
  async function api(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, headers });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json().catch(() => ({})) : null;
    if (response.status === 401) { redirectToLogin(); throw new Error('Sessão expirada.'); }
    if (!response.ok) throw new Error(data?.error || `Erro HTTP ${response.status}`);
    return data;
  }
  async function loadSession(requiredPermission = null) {
    const response = await fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!data.authenticated) { redirectToLogin(); return false; }
    state.user = data.user;
    state.role = data.role;
    state.permissions = new Set(data.permissions || []);
    state.csrfToken = data.csrfToken;
    state.expiresAt = data.expiresAt;
    document.querySelectorAll('[data-current-user]').forEach((node) => { node.textContent = data.user || 'Usuário'; });
    document.querySelectorAll('[data-current-role]').forEach((node) => { node.textContent = roleLabel(data.role); });
    document.querySelectorAll('[data-permission]').forEach((node) => node.classList.toggle('hidden', !has(node.dataset.permission)));
    if (requiredPermission && !has(requiredPermission)) { window.location.replace('/'); return false; }
    return true;
  }
  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: state.csrfToken ? { 'X-CSRF-Token': state.csrfToken } : {} });
    } finally { window.location.replace('/login'); }
  }
  function bindShell() { document.querySelectorAll('[data-logout]').forEach((button) => button.addEventListener('click', logout)); }
  window.PM2UI = { state, el, api, escapeHtml, formatBytes, formatDate, formatUptime, roleLabel, has, showToast, loadSession, bindShell, logout };
})();