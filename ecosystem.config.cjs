module.exports = {
  apps: [
    {
      name: "copart-bot",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/bot/index.ts",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "800M",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "copart-web",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "800M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
    },
  ],
};
