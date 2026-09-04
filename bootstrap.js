const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateLegacyAuthFile } = require('./lib/auth-migration');

function configureWindowsScanRoots() {
  if (process.platform !== 'win32' || process.env.PM2_MANAGER_SCAN_ROOTS) return;

  const driveRoot = path.parse(process.cwd()).root || `${process.env.SystemDrive || 'C:'}\\`;
  const ignored = new Set([
    'windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin',
    'system volume information', 'recovery', 'perflogs',
  ]);

  const roots = [];
  try {
    for (const entry of fs.readdirSync(driveRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (ignored.has(entry.name.toLowerCase())) continue;
      roots.push(path.join(driveRoot, entry.name));
    }
  } catch (_) {
    // fallback abaixo
  }

  for (const fallback of [os.homedir(), path.dirname(process.cwd())]) {
    if (fs.existsSync(fallback) && !roots.some((item) => item.toLowerCase() === fallback.toLowerCase())) {
      roots.push(fallback);
    }
  }

  if (roots.length) process.env.PM2_MANAGER_SCAN_ROOTS = roots.join(',');
}

configureWindowsScanRoots();

const { installExpressExtension } = require('./lib/tools-extension-v2');

const migration = migrateLegacyAuthFile();
if (migration.migrated) {
  console.log(`Autenticação legada migrada para multiusuário: ${migration.username} (admin)`);
}

installExpressExtension();
require('./server');
