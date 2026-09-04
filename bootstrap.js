const { migrateLegacyAuthFile } = require('./lib/auth-migration');
const { installExpressExtension } = require('./lib/tools-extension');

const migration = migrateLegacyAuthFile();
if (migration.migrated) {
  console.log(`Autenticação legada migrada para multiusuário: ${migration.username} (admin)`);
}

installExpressExtension();
require('./server');
