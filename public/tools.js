(() => {
  const { el, api, escapeHtml, formatBytes, formatDate, showToast, loadSession, bindShell, state } = PM2UI;
  let toolStatus = null;
  let projects = [];
  let scanResults = [];
  let hasScanned = false;

  function normalizeBrowserPath(value = '') {
    return String(value).trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  }

  function pathDepth(value = '') {
    return normalizeBrowserPath(value).split('/').filter(Boolean).length;
  }

  function ecosystemMatchesProject(ecosystem, project) {
    const eco = normalizeBrowserPath(ecosystem.directory);
    const proj = normalizeBrowserPath(project.path);
    if (!eco || !proj) return false;
    if (eco === proj) return true;
    if (proj.startsWith(`${eco}/`) && pathDepth(proj) - pathDepth(eco) <= 2) return true;
    return false;
  }

  function projectEcosystems(project) {
    return scanResults.filter((item) => ecosystemMatchesProject(item, project));
  }

  function projectForEcosystem(item) {
    const exact = projects.find((project) => normalizeBrowserPath(project.path) === normalizeBrowserPath(item.directory));
    if (exact) return exact;
    return projects.find((project) => ecosystemMatchesProject(item, project)) || null;
  }

  function quoteArg(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^[a-zA-Z0-9_./:@+\\-]+$/.test(text)) return text;
    return `'${text.replaceAll("'", `'\\''`)}'`;
  }

  function activateTab(name, updateHash = true) {
    const target = ['projects', 'ecosystems', 'generator', 'terminal'].includes(name) ? name : 'projects';
    document.querySelectorAll('[data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === target));
    document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === target));
    if (updateHash) history.replaceState(null, '', `#${target}`);
  }

  function bindTabs() {
    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => activateTab(button.dataset.tab));
    });
    const initial = window.location.hash.replace('#', '');
    activateTab(initial || 'projects', false);
  }

  async function loadStatus() {
    toolStatus = await api('/api/tools/status');
    el('terminal-mode').textContent = `Modo seguro · ${toolStatus.platform === 'win32' ? 'Windows' : toolStatus.platform}`;
    el('scan-limits').textContent = `prof. ${toolStatus.scanMaxDepth} · até ${toolStatus.scanMaxResults} resultados · ${(toolStatus.scanTimeoutMs / 1000).toFixed(0)}s`;
    el('root-count').textContent = `${toolStatus.roots.length} raiz${toolStatus.roots.length === 1 ? '' : 'es'}`;
    el('root-list').innerHTML = toolStatus.roots.map((root) => `<span class="root-chip">${escapeHtml(root)}</span>`).join('');
    if (!el('terminal-cwd').value && toolStatus.roots[0]) el('terminal-cwd').value = toolStatus.roots[0];
    renderQuickCommands();
    el('server-status').textContent = 'Ferramentas prontas';
    document.querySelector('.dot').style.background = 'var(--green)';
  }

  async function loadProjects() {
    projects = await api('/api/tools/projects');
    renderProjects();
  }

  function processChips(project) {
    return project.processes.map((process) => {
      const statusClass = process.status === 'online' ? 'linked' : 'orphan';
      return `<span class="process-chip ${statusClass}" title="PM2 #${escapeHtml(process.pm_id)} · ${escapeHtml(process.status)}">#${escapeHtml(process.pm_id)} ${escapeHtml(process.name)}</span>`;
    }).join('');
  }

  function renderProjects() {
    const tbody = el('project-list');
    const empty = el('project-empty');
    empty.classList.toggle('hidden', projects.length > 0);
    if (!projects.length) {
      tbody.innerHTML = '';
      return;
    }

    tbody.innerHTML = projects.map((project, index) => {
      const ecosystems = projectEcosystems(project);
      let ecosystemHtml = '<span class="muted-inline">Faça uma busca na aba Ecosystems</span>';
      if (hasScanned) {
        ecosystemHtml = ecosystems.length
          ? ecosystems.map((item) => `<div class="ecosystem-link"><span class="finder-status linked">${escapeHtml(item.name)}</span><small>${escapeHtml(item.path)}</small></div>`).join('')
          : '<span class="finder-status orphan">Nenhum ecosystem relacionado</span>';
      }

      const health = project.onlineCount === project.processCount
        ? `<span class="finder-status linked">${project.onlineCount}/${project.processCount} online</span>`
        : `<span class="finder-status orphan">${project.onlineCount}/${project.processCount} online</span>`;

      return `<tr>
        <td><div class="path-main">${escapeHtml(project.name)}</div><div class="path-sub">${escapeHtml(project.path)}</div></td>
        <td><div class="process-chip-list">${processChips(project)}</div></td>
        <td>${health}</td>
        <td>${ecosystemHtml}</td>
        <td><div class="actions"><button class="action" type="button" data-project-terminal="${index}">Terminal aqui</button>${ecosystems[0] ? `<button class="action" type="button" data-project-generator="${index}">Gerar start</button>` : ''}</div></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-project-terminal]').forEach((button) => button.addEventListener('click', () => {
      const project = projects[Number(button.dataset.projectTerminal)];
      el('terminal-cwd').value = project.path;
      el('terminal-command').value = 'pm2 list';
      activateTab('terminal');
      el('terminal-command').focus();
    }));

    tbody.querySelectorAll('[data-project-generator]').forEach((button) => button.addEventListener('click', () => {
      const project = projects[Number(button.dataset.projectGenerator)];
      const ecosystem = projectEcosystems(project)[0];
      if (!ecosystem) return;
      el('generator-action').value = 'start-ecosystem';
      el('generator-target').value = ecosystem.path;
      generateCommand();
      activateTab('generator');
    }));
  }

  function renderQuickCommands() {
    const commands = toolStatus?.allowedCommands || [];
    el('quick-commands').innerHTML = commands.map((command) => `<button class="quick-command" type="button" data-command="${escapeHtml(command)}">${escapeHtml(command)}</button>`).join('');
    el('quick-commands').querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => {
        const firstProcess = projects[0]?.processes?.[0];
        const command = button.dataset.command
          .replace('<processo>', firstProcess?.name || 'processo')
          .replace('<id>', String(firstProcess?.pm_id ?? '0'));
        el('terminal-command').value = command;
        el('terminal-command').focus();
      });
    });
  }

  function renderFinderSummary(scan) {
    const parts = [
      `<span class="finder-status">${scan.results.length} encontrado${scan.results.length === 1 ? '' : 's'}</span>`,
      `<span class="finder-status">${scan.visited} itens visitados</span>`,
    ];
    if (scan.denied) parts.push(`<span class="finder-status">${scan.denied} acessos ignorados</span>`);
    if (scan.truncated) parts.push('<span class="finder-status orphan">Busca limitada por tempo/quantidade</span>');
    el('finder-summary').innerHTML = parts.join('');
    el('finder-summary').classList.remove('hidden');
  }

  function renderEcosystems() {
    const tbody = el('ecosystem-list');
    const empty = el('ecosystem-empty');
    empty.classList.toggle('hidden', scanResults.length > 0);
    if (!scanResults.length) {
      empty.textContent = 'Nenhum ecosystem encontrado nas raízes configuradas.';
      tbody.innerHTML = '';
      renderProjects();
      return;
    }

    tbody.innerHTML = scanResults.map((item, index) => {
      const project = projectForEcosystem(item);
      const relatedProcesses = project?.processes || [];
      const projectHtml = project
        ? `<div class="path-main">${escapeHtml(project.name)}</div><div class="path-sub">${escapeHtml(project.path)}</div>`
        : '<span class="finder-status orphan">Projeto não identificado no PM2</span>';
      const relatedHtml = relatedProcesses.length
        ? `<div class="process-chip-list">${processChips(project)}</div>`
        : '<span class="muted-inline">Nenhum processo relacionado</span>';

      return `<tr>
        <td><div class="path-main">${escapeHtml(item.name)}</div><div class="path-sub">${escapeHtml(item.path)}</div><div class="path-sub">${formatBytes(item.size)}</div></td>
        <td>${projectHtml}</td>
        <td>${relatedHtml}</td>
        <td>${formatDate(item.modifiedAt)}</td>
        <td><div class="actions">
          <button class="action" type="button" data-copy-index="${index}">Copiar caminho</button>
          <button class="action" type="button" data-generate-index="${index}">Gerar start</button>
          <button class="action" type="button" data-cwd-index="${index}">Terminal aqui</button>
        </div></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-copy-index]').forEach((button) => button.addEventListener('click', () => copyText(scanResults[Number(button.dataset.copyIndex)].path)));
    tbody.querySelectorAll('[data-generate-index]').forEach((button) => button.addEventListener('click', () => {
      const item = scanResults[Number(button.dataset.generateIndex)];
      el('generator-action').value = 'start-ecosystem';
      el('generator-target').value = item.path;
      generateCommand();
      activateTab('generator');
    }));
    tbody.querySelectorAll('[data-cwd-index]').forEach((button) => button.addEventListener('click', () => {
      const item = scanResults[Number(button.dataset.cwdIndex)];
      el('terminal-cwd').value = item.directory;
      el('terminal-command').value = 'pm2 list';
      activateTab('terminal');
      el('terminal-command').focus();
    }));

    renderProjects();
  }

  async function scanEcosystems() {
    const button = el('scan-btn');
    button.disabled = true;
    button.textContent = 'Procurando...';
    el('ecosystem-empty').classList.remove('hidden');
    el('ecosystem-empty').textContent = 'Varrendo o servidor...';
    try {
      await loadProjects();
      const scan = await api('/api/tools/ecosystems/scan', { method: 'POST', body: '{}' });
      scanResults = scan.results || [];
      hasScanned = true;
      renderFinderSummary(scan);
      renderEcosystems();
      showToast(`${scanResults.length} ecosystem(s) encontrado(s).`);
    } catch (error) {
      showToast(error.message, 'error');
      el('ecosystem-empty').textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = 'Procurar ecosystems';
    }
  }

  function generateCommand() {
    const action = el('generator-action').value;
    const target = el('generator-target').value.trim();
    const env = el('generator-env').value.trim();
    let command = '';

    if (action === 'save') command = 'pm2 save';
    else if (action === 'restart-env') command = `pm2 restart ${quoteArg(target || '<processo>')} --update-env`;
    else if (action === 'restart') command = `pm2 restart ${quoteArg(target || '<processo>')}`;
    else if (action === 'show') command = `pm2 show ${quoteArg(target || '<processo>')}`;
    else if (action === 'logs') command = `pm2 logs ${quoteArg(target || '<processo>')} --lines 100 --nostream`;
    else if (action === 'start-ecosystem') command = `pm2 start ${quoteArg(target || 'C:\\caminho\\ecosystem.config.js')}${env ? ` --env ${quoteArg(env)}` : ''}`;

    el('generated-command').textContent = command;
    return command;
  }

  function appendTerminalLine(text, className = '') {
    const line = document.createElement('div');
    if (className) line.className = className;
    line.textContent = text;
    el('terminal-screen').appendChild(line);
    el('terminal-screen').scrollTop = el('terminal-screen').scrollHeight;
  }

  async function runTerminal() {
    const command = el('terminal-command').value.trim();
    const cwd = el('terminal-cwd').value.trim();
    if (!command) return;

    const button = el('terminal-run-btn');
    button.disabled = true;
    appendTerminalLine(`$ ${command}`, 'prompt');

    try {
      const result = await api('/api/tools/terminal/run', {
        method: 'POST',
        body: JSON.stringify({ command, cwd }),
      });
      if (result.stdout) appendTerminalLine(result.stdout.replace(/\n$/, ''));
      if (result.stderr) appendTerminalLine(result.stderr.replace(/\n$/, ''), 'stderr');
      appendTerminalLine(`[exit ${result.exitCode}] ${result.durationMs}ms · ${result.cwd}`, result.exitCode === 0 ? 'meta' : 'stderr');
    } catch (error) {
      appendTerminalLine(error.message, 'stderr');
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
      el('terminal-command').focus();
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copiado para a área de transferência.');
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      showToast('Copiado.');
    }
  }

  async function initialize() {
    bindShell();
    bindTabs();
    const authenticated = await loadSession();
    if (!authenticated) return;
    if (state.role !== 'admin') {
      document.body.innerHTML = '<main class="access-denied"><h1>Acesso restrito</h1><p>Somente administradores podem acessar Ferramentas.</p><a href="/">Voltar para Processos</a></main>';
      return;
    }

    try {
      await Promise.all([loadStatus(), loadProjects()]);
      renderQuickCommands();
      generateCommand();
    } catch (error) {
      el('server-status').textContent = 'Falha nas ferramentas';
      document.querySelector('.dot').style.background = 'var(--red)';
      showToast(error.message, 'error');
    }
  }

  el('refresh-status-btn').addEventListener('click', async () => {
    try { await Promise.all([loadStatus(), loadProjects()]); } catch (error) { showToast(error.message, 'error'); }
  });
  el('projects-refresh-btn').addEventListener('click', () => loadProjects().catch((error) => showToast(error.message, 'error')));
  el('scan-btn').addEventListener('click', scanEcosystems);
  el('generate-btn').addEventListener('click', generateCommand);
  el('generator-action').addEventListener('change', generateCommand);
  el('generator-target').addEventListener('input', generateCommand);
  el('generator-env').addEventListener('input', generateCommand);
  el('copy-generated-btn').addEventListener('click', () => copyText(generateCommand()));
  el('send-generated-btn').addEventListener('click', () => {
    el('terminal-command').value = generateCommand();
    activateTab('terminal');
    el('terminal-command').focus();
  });
  el('terminal-run-btn').addEventListener('click', runTerminal);
  el('terminal-command').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runTerminal(); }
  });

  initialize();
})();
