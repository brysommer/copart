import fs from "fs";
import path from "path";

export type LogLevel = "info" | "warn" | "error" | "debug";

type LogMeta = Record<string, unknown>;

function logsDir(): string {
  return path.resolve(process.env.STORAGE_DIR || "./storage", "logs");
}

function logFilePath(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(logsDir(), `bot-${day}.log`);
}

function ensureLogsDir(): void {
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
  } catch {
    // ignore
  }
}

function serializeMeta(meta?: LogMeta): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  try {
    return " " + JSON.stringify(meta);
  } catch {
    return " [meta_unserializable]";
  }
}

function writeLine(level: LogLevel, message: string, meta?: LogMeta): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${serializeMeta(meta)}\n`;
  const consoleFn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  consoleFn(line.trimEnd());

  try {
    ensureLogsDir();
    fs.appendFileSync(logFilePath(), line, "utf8");
  } catch (err) {
    console.error(
      "[log] failed to write log file:",
      err instanceof Error ? err.message : err
    );
  }
}

export const log = {
  info: (message: string, meta?: LogMeta) => writeLine("info", message, meta),
  warn: (message: string, meta?: LogMeta) => writeLine("warn", message, meta),
  error: (message: string, meta?: LogMeta) => writeLine("error", message, meta),
  debug: (message: string, meta?: LogMeta) => writeLine("debug", message, meta),
};

/** Classify antibot / block HTML from Copart or IAAI (Incapsula etc.). */
export function classifyAntibotResponse(
  bufferOrText: Buffer | string,
  contentType = ""
): {
  blocked: boolean;
  reason: string;
  signals: string[];
} {
  const text =
    typeof bufferOrText === "string"
      ? bufferOrText
      : bufferOrText.toString("utf8", 0, Math.min(bufferOrText.length, 8000));
  const lower = text.toLowerCase();
  const ct = contentType.toLowerCase();
  const signals: string[] = [];

  if (ct.includes("text/html") || /<!doctype|<html/i.test(text.slice(0, 200))) {
    signals.push("html_instead_of_zip");
  }
  if (/incapsula|_incapsula_resource|imperva/i.test(lower)) {
    signals.push("incapsula_imperva");
  }
  if (/reese84|incap_ses|visid_incap/i.test(lower)) {
    signals.push("incapsula_cookies_mentioned");
  }
  if (/captcha|hcaptcha|recaptcha|challenge/i.test(lower)) {
    signals.push("captcha_or_challenge");
  }
  if (/access denied|request unsuccessful|blocked|forbidden/i.test(lower)) {
    signals.push("access_denied_text");
  }
  if (/robot|bot detected|automated/i.test(lower)) {
    signals.push("bot_detected_text");
  }
  if (/cdn|distil|perimeterx|akamai/i.test(lower)) {
    signals.push("other_waf");
  }

  const blocked = signals.length > 0;
  let reason = "unknown_html_response";
  if (signals.includes("incapsula_imperva")) {
    reason = "Incapsula/Imperva antibot (cookies застарілі, інший IP/VPN, або сесія згоріла)";
  } else if (signals.includes("captcha_or_challenge")) {
    reason = "Показано captcha/challenge — потрібна свіжа браузерна сесія";
  } else if (signals.includes("access_denied_text") || signals.includes("bot_detected_text")) {
    reason = "Access denied / bot detected у відповіді";
  } else if (signals.includes("html_instead_of_zip")) {
    reason = "Замість ZIP прийшов HTML (ймовірно антибот або редірект на логін)";
  }

  return { blocked, reason, signals };
}

export function getTodayLogPath(): string {
  return logFilePath();
}
