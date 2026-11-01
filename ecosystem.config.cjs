// pm2 process file for DbBackup.
//
//   npm ci && npm run build && (cd server && npx prisma migrate deploy)
//   pm2 start ecosystem.config.cjs && pm2 save
//
// DbBackup must run as ONE process: passkey challenges, login lockouts, rate
// limits, real-time sync polling and restore drills live in process memory.
// Cluster mode or instances > 1 would split that state, so the app refuses
// to start any instance other than the first.
module.exports = {
  apps: [
    {
      name: 'dbbackup',
      cwd: './server', // the app reads server/.env from its working directory
      script: 'dist/index.js',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production', // also makes the server serve client/dist
      },
      // Let running backups/restores finish their current step on restart
      kill_timeout: 30000,
      // Restart if the process grows past this (raise it for very large exports)
      max_memory_restart: '1G',
      time: true,
    },
  ],
};
