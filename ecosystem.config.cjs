const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

// Load .env into this config so PM2 children inherit variables
const envFile = path.resolve(__dirname, ".env");
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile, override: true });
} else {
  console.warn("[pm2] .env not found at", envFile);
}

module.exports = {
  apps: [
    {
      name: "copart-bot",
      cwd: __dirname,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/bot/index.ts",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "800M",
      env: {
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
        OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o",
        OPENAI_VIN_RETRY_MODEL: process.env.OPENAI_VIN_RETRY_MODEL || "gpt-4o",
        DATABASE_URL: process.env.DATABASE_URL || "",
        STORAGE_DIR: process.env.STORAGE_DIR || "./storage",
        COPART_COOKIE: process.env.COPART_COOKIE || "",
        COPART_USER_AGENT: process.env.COPART_USER_AGENT || "",
        VINREPORT_API_KEY: process.env.VINREPORT_API_KEY || "",
        VINREPORT_USER_ID: process.env.VINREPORT_USER_ID || "",
        VINREPORT_BASE_URL: process.env.VINREPORT_BASE_URL || "",
        UAH_PER_USD: process.env.UAH_PER_USD || "41",
      },
    },
    {
      name: "copart-web",
      cwd: __dirname,
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
        DATABASE_URL: process.env.DATABASE_URL || "",
      },
    },
  ],
};
