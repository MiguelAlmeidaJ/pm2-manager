const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function defaultAuthFile() {
  const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
  return process.env.PM2_MANAGER_AUTH_FILE || path.join(pm2Home, 'pm2-manager-auth.json');
}

function migrateLegacyAuthFile(authFile = defaultAuthFile()) {
  if (!fs.existsSync(authFile)) return { migrated: false, reason: 'missing' };

  const parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));

  if (Array.isArray(parsed.users)) {
    return { migrated: false, reason: 'already-v2', users: parsed.users.length };
  }

  if (!parsed.username || !parsed.passwordHash || !parsed.sessionSecret) {
    return { migrated: false, reason: 'unknown-format' };
  }

  const now = parsed.updatedAt || new Date().toISOString();
  const migrated = {
    version: 2,
    sessionSecret: parsed.sessionSecret,
    users: [
      {
        id: crypto.randomUUID(),
        username: String(parsed.username).trim().toLowerCase(),
        passwordHash: parsed.passwordHash,
        role: 'admin',
        active: true,
        sessionVersion: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    updatedAt: new Date().toISOString(),
  };

  const temporary = `${authFile}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(migrated, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'w',
  });
  fs.renameSync(temporary, authFile);
  if (process.platform !== 'win32') fs.chmodSync(authFile, 0o600);

  return { migrated: true, users: 1, username: migrated.users[0].username };
}

module.exports = { migrateLegacyAuthFile };
