const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const PM2_HOME = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
const AUTH_FILE = process.env.PM2_MANAGER_AUTH_FILE || path.join(PM2_HOME, 'pm2-manager-auth.json');
const ROLES = new Set(['admin', 'operator', 'viewer']);

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

function askHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error('Terminal interativo necessário para digitar a senha com segurança.'));
  }

  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let value = '';

    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };

    const onData = (char) => {
      if (char === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      }
      if (char === '\r' || char === '\n') return finish();
      if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1);
        return;
      }
      if (char >= ' ') value += char;
    };

    process.stdin.on('data', onData);
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function loadConfig() {
  if (!fs.existsSync(AUTH_FILE)) throw new Error(`Arquivo não encontrado: ${AUTH_FILE}. Execute npm run auth:setup primeiro.`);
  const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));

  if (Array.isArray(parsed.users)) return parsed;

  if (parsed.username && parsed.passwordHash && parsed.sessionSecret) {
    const now = parsed.updatedAt || new Date().toISOString();
    return {
      version: 2,
      sessionSecret: parsed.sessionSecret,
      users: [{
        id: crypto.randomUUID(),
        username: String(parsed.username).toLowerCase(),
        passwordHash: parsed.passwordHash,
        role: 'admin',
        active: true,
        sessionVersion: 1,
        createdAt: now,
        updatedAt: now,
      }],
      updatedAt: now,
    };
  }

  throw new Error('Formato de autenticação inválido.');
}

function saveConfig(config) {
  config.version = 2;
  config.updatedAt = new Date().toISOString();
  const tmp = `${AUTH_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE);
  if (process.platform !== 'win32') fs.chmodSync(AUTH_FILE, 0o600);
}

function validateUsername(username) {
  const normalized = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/i.test(normalized)) {
    throw new Error('Usuário inválido. Use 3 a 64 caracteres: letras, números, ponto, underline ou hífen.');
  }
  return normalized;
}

function getUser(config, username) {
  const normalized = validateUsername(username);
  const user = config.users.find((item) => item.username.toLowerCase() === normalized);
  if (!user) throw new Error(`Usuário não encontrado: ${normalized}`);
  return user;
}

function ensureActiveAdmin(config, ignoredId = null) {
  const count = config.users.filter((user) => user.id !== ignoredId && user.active !== false && user.role === 'admin').length;
  if (count < 1) throw new Error('É necessário manter pelo menos um administrador ativo.');
}

async function addUser(config) {
  const username = validateUsername(await ask('Novo usuário: '));
  if (config.users.some((user) => user.username.toLowerCase() === username)) throw new Error('Esse usuário já existe.');

  const role = (await ask('Perfil [viewer/operator/admin] (viewer): ') || 'viewer').toLowerCase();
  if (!ROLES.has(role)) throw new Error('Perfil inválido.');

  const password = await askHidden('Senha: ');
  const confirm = await askHidden('Confirme a senha: ');
  if (password !== confirm) throw new Error('As senhas não conferem.');
  if (password.length < 12) throw new Error('Use uma senha com pelo menos 12 caracteres.');

  const now = new Date().toISOString();
  config.users.push({
    id: crypto.randomUUID(), username, passwordHash: hashPassword(password), role,
    active: true, sessionVersion: 1, createdAt: now, updatedAt: now,
  });
  saveConfig(config);
  console.log(`Usuário ${username} criado como ${role}.`);
}

async function main() {
  const config = loadConfig();
  const command = String(process.argv[2] || 'list').toLowerCase();

  if (command === 'list') {
    console.table(config.users.map(({ username, role, active = true, createdAt }) => ({ username, role, active, createdAt })));
    return;
  }

  if (command === 'add') return addUser(config);

  const username = process.argv[3] || await ask('Usuário: ');
  const user = getUser(config, username);

  if (command === 'password') {
    const password = await askHidden('Nova senha: ');
    const confirm = await askHidden('Confirme a senha: ');
    if (password !== confirm) throw new Error('As senhas não conferem.');
    if (password.length < 12) throw new Error('Use uma senha com pelo menos 12 caracteres.');
    user.passwordHash = hashPassword(password);
    user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    user.updatedAt = new Date().toISOString();
    saveConfig(config);
    console.log(`Senha de ${user.username} alterada.`);
    return;
  }

  if (command === 'role') {
    const role = String(process.argv[4] || await ask('Novo perfil [viewer/operator/admin]: ')).toLowerCase();
    if (!ROLES.has(role)) throw new Error('Perfil inválido.');
    if (user.role === 'admin' && role !== 'admin') ensureActiveAdmin(config, user.id);
    user.role = role;
    user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    user.updatedAt = new Date().toISOString();
    saveConfig(config);
    console.log(`${user.username} agora é ${role}.`);
    return;
  }

  if (command === 'enable' || command === 'disable') {
    const active = command === 'enable';
    if (!active && user.role === 'admin') ensureActiveAdmin(config, user.id);
    user.active = active;
    user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    user.updatedAt = new Date().toISOString();
    saveConfig(config);
    console.log(`${user.username}: ${active ? 'ativo' : 'desativado'}.`);
    return;
  }

  if (command === 'remove') {
    if (user.role === 'admin') ensureActiveAdmin(config, user.id);
    config.users = config.users.filter((item) => item.id !== user.id);
    saveConfig(config);
    console.log(`${user.username} removido.`);
    return;
  }

  throw new Error('Comando inválido. Use: list, add, password, role, enable, disable ou remove.');
}

main().catch((error) => {
  console.error(`Erro: ${error.message}`);
  process.exit(1);
});
