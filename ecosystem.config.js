module.exports = {
  apps: [{
    name: 'whatsapp-automation',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    restart_delay: 3000,
    autorestart: true,
    kill_timeout: 5000,
    listen_timeout: 10000,
    exp_backoff_restart_delay: 100,
    min_uptime: '30s',
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true
  }]
};
