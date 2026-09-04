module.exports = {
  apps: [
    {
      name: 'pm2-manager',
      script: './bootstrap.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 4333,
        HOST: '0.0.0.0',
        PM2_MANAGER_PROCESS_NAME: 'pm2-manager',
        PM2_MANAGER_BACKUP_KEEP: 30,
        PM2_MANAGER_SCAN_MAX_DEPTH: 7,
        PM2_MANAGER_SCAN_MAX_RESULTS: 500,
        PM2_MANAGER_SCAN_TIMEOUT_MS: 15000,
        PM2_MANAGER_TERMINAL_TIMEOUT_MS: 8000
      }
    }
  ]
};
