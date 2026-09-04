const os = require('os');
const path = require('path');
const { migrateLegacyAuthFile } = require('./lib/auth-migration');

if (process.platform === 'win32' && !process.env.PM2_MANAGER_SCAN_ROOTS) {
  process.env.PM2_MANAGER_SCAN_ROOTS = [
    os.homedir(),
    path.dirname(process.cwd()),
  ].join(',');
}

const { installExpressExtension } = require('./lib/tools-extension');

const migration = migrateLegacyAuthFile();
if (migration.migrated) {
  console.log(`Autenticação legada migrada para multiusuário: ${migration.username} (admin)`);
}

installExpressExtension();
require('./server');
