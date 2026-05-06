// PM2 process config for the production VM.
// `npm run start` resolves to `node server.js`; we point pm2 at server.js
// directly to keep its boot logs clean.
//
// .env loading: server.js calls `import 'dotenv/config'` so the file at
// /home/azureuser/mocount/.env (mode 600) is the source of truth — pm2
// doesn't need env_file.

module.exports = {
  apps: [{
    name: 'mocount',
    script: 'server.js',
    cwd: '/home/azureuser/mocount',
    instances: 1,
    autorestart: true,
    max_memory_restart: '500M',
    error_file: '/home/azureuser/mocount/logs/err.log',
    out_file: '/home/azureuser/mocount/logs/out.log',
    time: true,
  }],
};
