module.exports = {
  apps: [
    {
      name: 'pm2-manager',
      script: './server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 4333,
        HOST: '127.0.0.1'
      }
    }
  ]
};