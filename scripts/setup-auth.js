const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const PM2_HOME = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
const AUTH_FILE = process.env.PM2_MANAGER_AUTH_FILE || path.join(PM2_HOME, 'pm2-manager-auth.json');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
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
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function main() {
  fs.mkdirSync(PM2_HOME, { recursive: true, mode: 0o700 });

  const current = fs.existsSync(AUTH_FILE)
    ? JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    : null;

  console.log('\nPM2 Manager - configuração de autenticação');
  console.log(`Arquivo: ${AUTH_FILE}\n`);

  const defaultUsername = current?.username || 'admin';
  const inputUsername = (await ask(`Usuário [${defaultUsername}]: `)).trim();
  const username = inputUsername || defaultUsername;

  if (username.length < 3 || username.length > 64) {
    throw new Error('O usuário deve ter entre 3 e 64 caracteres.');
  }

  const password = await askHidden('Senha: ');
  const confirmation = await askHidden('Confirme a senha: ');

  if (password !== confirmation) throw new Error('As senhas não conferem.');
  if (password.length < 12) throw new Error('Use uma senha com pelo menos 12 caracteres.');

  const config = {
    username,
    passwordHash: hashPassword(password),
    sessionSecret: crypto.randomBytes(64).toString('hex'),
    updatedAt: new Date().toISOString(),
  };

  const temporary = `${AUTH_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'w' });
  fs.renameSync(temporary, AUTH_FILE);

  if (process.platform !== 'win32') fs.chmodSync(AUTH_FILE, 0o600);

  console.log('\nAutenticação configurada com sucesso.');
  console.log('A senha não foi gravada em texto puro.');
  console.log('Reinicie o PM2 Manager para aplicar a nova configuração:\n');
  console.log('  pm2 restart pm2-manager\n');
}

main().catch((error) => {
  console.error(`\nErro: ${error.message}`);
  process.exit(1);
});
