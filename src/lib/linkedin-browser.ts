import fs from "fs/promises";
import path from "path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { log } from "./logger";

export function linkedInEnabled(): boolean {
  const v = (process.env.LINKEDIN_ENABLED || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function linkedInOwnerChatId(): number | null {
  const raw =
    process.env.LINKEDIN_TELEGRAM_CHAT_ID?.trim() ||
    process.env.VINREPORT_USER_ID?.trim() ||
    "";
  const n = Number(raw);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function linkedInUserDataDir(): string {
  if (process.env.LINKEDIN_USER_DATA_DIR?.trim()) {
    return path.resolve(process.env.LINKEDIN_USER_DATA_DIR.trim());
  }
  const home = process.env.HOME || process.cwd();
  return path.join(home, ".linkedin-bot-chrome");
}

function headlessMode(): boolean {
  const v = (process.env.LINKEDIN_HEADLESS || process.env.BROWSER_HEADLESS || "")
    .trim()
    .toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return false;
}

export async function withLinkedInPage<T>(
  label: string,
  fn: (page: Page, context: BrowserContext) => Promise<T>
): Promise<T> {
  const userDataDir = linkedInUserDataDir();
  await fs.mkdir(userDataDir, { recursive: true });
  const headless = headlessMode();
  log.info("Launching Chrome for LinkedIn", { label, userDataDir, headless });

  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless,
      viewport: { width: 1365, height: 900 },
      locale: "uk-UA",
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const page = context.pages()[0] || (await context.newPage());
    return await fn(page, context);
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function ensureLinkedInLoggedIn(page: Page): Promise<void> {
  await page.goto("https://www.linkedin.com/feed/", {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await page.waitForTimeout(2500);
  const url = page.url();
  if (/login|uas\/|checkpoint|authwall/i.test(url)) {
    throw new Error(
      "LinkedIn: потрібен логін. Відкрий на VM Chrome-профіль " +
        `(${linkedInUserDataDir()}) і увійди вручну, потім /li_status.`
    );
  }
}
