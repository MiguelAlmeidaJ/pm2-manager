const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { migrateLegacyAuthFile } = require('../lib/auth-migration');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-manager-auth-test-'));
const file = path.join(dir, 'auth.json');

try {
  const legacy = {
    username: 'Admin.Teste',
    passwordHash: `scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`,
    sessionSecret: 'c'.repeat(128),
    updatedAt: '2026-09-04T12:00:00.000Z',
  };

  fs.writeFileSync(file, JSON.stringify(legacy));

  const result = migrateLegacyAuthFile(file);
  assert.equal(result.migrated, true);

  const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.sessionSecret, legacy.sessionSecret);
  assert.equal(migrated.users.length, 1);
  assert.equal(migrated.users[0].username, 'admin.teste');
  assert.equal(migrated.users[0].role, 'admin');
  assert.equal(migrated.users[0].active, true);
  assert.equal(migrated.users[0].passwordHash, legacy.passwordHash);

  const second = migrateLegacyAuthFile(file);
  assert.equal(second.migrated, false);
  assert.equal(second.reason, 'already-v2');

  console.log('Legacy auth migration: OK');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
