const fs = require('fs');

const pm2Cli = require.resolve('pm2/bin/pm2');
if (!fs.existsSync(pm2Cli)) {
  throw new Error(`CLI do PM2 não encontrado: ${pm2Cli}`);
}

require('../lib/tools-extension-v2');
console.log(`Tools v2 OK · PM2 CLI: ${pm2Cli}`);
