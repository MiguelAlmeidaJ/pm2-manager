(() => {
  const { el, api, escapeHtml, formatBytes, formatDate, showToast, loadSession, bindShell, state } = PM2UI;
  let toolStatus = null;
  let processes = [];
  let scanResults = [];

  function quoteArg(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^[a-zA-Z0-9_./:@+-]+$/.test(text)) return text;
    return `'${text.replaceAll("'", `'\\''`)}'`;
  }

  function pathRelatedToProcess(directory, process) {
    const dir = String(directory || '').replace(/\/+$/, '');
    const cwd = String(process.cwd || '').replace(/\/+$/, '');
    const script = String(process.script || '');
    if (!dir) return false;
    return cwd === dir || cwd.startsWith(`${dir}/`) || script === dir || script.startsWith(`${dir}/`);
  }

  function relatedProcesses(item) {
    return processes.filter((process) => pathRelatedToProcess(item.directory, process));
  }

  async function loadStatus() {
    toolStatus = await api('/api/tools/status');
    el('terminal-mode').textContent = toolStatus.mode === 'safe' ? 'Modo seguro · admin' : toolStatus.mode;
    el('scan-limits').textContent = `prof. ${toolStatus.scanMaxDepth} · até ${toolStatus.scanMaxResults} resultados · ${(toolStatus.scanTimeoutMs / 1000).toFixed(0)}s`;
    el('root-count').textContent = `${toolStatus.roots.length} diretório${toolStatus.roots.length === 1 ? '' : 's'}`;
    el('root-list').innerHTML = toolStatus.roots.map((root) => `<span class="root-chip">${escapeHtml(root)}</span>`).join('');
    if (!el('terminal-cwd').value && toolStatus.roots[0]) el('terminal-cwd').value = toolStatus.roots[0];
    renderQuickCommands();
    el('server-status').textContent = 'Ferramentas prontas';
    document.querySelector('.dot').style.background = 'var(--green)';
  }

  async function loadProcesses() {
    try { processes = await api('/api/processes'); } catch (_) { processes = []; }
  }

  function renderQuickCommands() {
    const commands = toolStatus?.allowedCommands || [];
    el('quick-commands').innerHTML = commands.map((command) => `<button class="quick-command" type="button" data-command="${escapeHtml(command)}">${escapeHtml(command)}</button>`).join('');
    el('quick-commands').querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => {
        const command = button.dataset.command.replace('<processo>', processes[0]?.name || 'processo').replace('<id>', String(processes[0]?.pm_id ?? '0'));
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
      return;
    }

    tbody.innerHTML = scanResults.map((item, index) => {
      const related = relatedProcesses(item);
      const relation = related.length
        ? `<span class="finder-status linked">Em uso provável · ${related.map((p) => escapeHtml(p.name)).join(', ')}</span>`
        : '<span class="finder-status orphan">Sem processo relacionado</span>';

      return `<tr>
        <td><div class="path-main">${escapeHtml(item.name)}</div><div class="path-sub">${escapeHtml(item.path)}</div><div class="path-sub">${formatBytes(item.size)}</div></td>
        <td>${formatDate(item.modifiedAt)}</td>
        <td>${relation}</td>
        <td><div class="actions">
          <button class="action" type="button" data-copy-index="${index}">Copiar caminho</button>
          <button class="action" type="button" data-generate-index="${index}">Gerar start</button>
          <button class="action" type="button" data-cwd-index="${index}">Abrir diretório</button>
        </div></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-copy-index]').forEach((button) => button.addEventListener('click', () => copyText(scanResults[Number(button.dataset.copyIndex)].path)));
    tbody.querySelectorAll('[data-generate-index]').forEach((button) => button.addEventListener('click', () => {
      const item = scanResults[Number(button.dataset.generateIndex)];
      el('generator-action').value = 'start-ecosystem';
      el('generator-target').value = item.path;
      generateCommand();
      el('generator-target').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
    tbody.querySelectorAll('[data-cwd-index]').forEach((button) => button.addEventListener('click', () => {
      const item = scanResults[Number(button.dataset.cwdIndex)];
      el('terminal-cwd').value = item.directory;
      el('terminal-command').value = 'ls -la';
      el('terminal-command').scrollIntoView({ behavior: 'smooth', block: 'center' });
      el('terminal-command').focus();
    }));
  }

  async function scanEcosystems() {
    const button = el('scan-btn');
    button.disabled = true;
    button.textContent = 'Procurando...';
    el('ecosystem-empty').classList.remove('hidden');
    el('ecosystem-empty').textContent = 'Varrendo diretórios...';
    try {
      await loadProcesses();
      const scan = await api('/api/tools/ecosystems/scan', { method: 'POST', body: '{}' });
      scanResults = scan.results || [];
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
    else if (action === 'start-ecosystem') command = `pm2 start ${quoteArg(target || '/caminho/ecosystem.config.js')}${env ? ` --env ${quoteArg(env)}` : ''}`;

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
      appendTerminalLine(`[exit ${result.exitCode}] ${result.durationMs}ms · ${result.cwd}`, 'meta');
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
    const authenticated = await loadSession();
    if (!authenticated) return;
    if (state.role !== 'admin') {
      window.location.replace('/');
      return;
    }

    try {
      await Promise.all([loadStatus(), loadProcesses()]);
      renderQuickCommands();
      generateCommand();
    } catch (error) {
      el('server-status').textContent = 'Falha nas ferramentas';
      document.querySelector('.dot').style.background = 'var(--red)';
      showToast(error.message, 'error');
    }
  }

  el('refresh-status-btn').addEventListener('click', () => loadStatus().catch((error) => showToast(error.message, 'error')));
  el('scan-btn').addEventListener('click', scanEcosystems);
  el('generate-btn').addEventListener('click', generateCommand);
  el('generator-action').addEventListener('change', generateCommand);
  el('generator-target').addEventListener('input', generateCommand);
  el('generator-env').addEventListener('input', generateCommand);
  el('copy-generated-btn').addEventListener('click', () => copyText(generateCommand()));
  el('send-generated-btn').addEventListener('click', () => {
    el('terminal-command').value = generateCommand();
    el('terminal-command').scrollIntoView({ behavior: 'smooth', block: 'center' });
    el('terminal-command').focus();
  });
  el('terminal-run-btn').addEventListener('click', runTerminal);
  el('terminal-command').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runTerminal(); }
  });

  initialize();
})();
