import fs from "fs/promises";
import path from "path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { log } from "./logger";

let contextPromise: Promise<BrowserContext> | null = null;
let cookiesBootstrapped = new Set<string>();

/** Default on for Windows work PC; set AUCTION_USE_BROWSER=0 to disable. */
export function useBrowserDownloads(): boolean {
  const v = (process.env.AUCTION_USE_BROWSER || "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return process.platform === "win32";
}

function browserUserDataDir(): string {
  if (process.env.BROWSER_USER_DATA_DIR?.trim()) {
    return path.resolve(process.env.BROWSER_USER_DATA_DIR.trim());
  }
  const local =
    process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || process.cwd(), "AppData", "Local");
  return path.join(local, "copart-bot-chrome");
}

function headlessMode(): boolean {
  const v = (process.env.BROWSER_HEADLESS || "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  // Visible by default once — easier to pass Incapsula on first run
  return false;
}

export async function getBrowserContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const userDataDir = browserUserDataDir();
      await fs.mkdir(userDataDir, { recursive: true });
      const headless = headlessMode();
      log.info("Launching Chrome for auction downloads", {
        userDataDir,
        headless,
        channel: "chrome",
      });
      try {
        return await chromium.launchPersistentContext(userDataDir, {
          channel: "chrome",
          headless,
          acceptDownloads: true,
          viewport: { width: 1365, height: 900 },
          locale: "en-US",
          args: ["--disable-blink-features=AutomationControlled"],
        });
      } catch (err) {
        contextPromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Не вдалося запустити Chrome через Playwright: ${msg}. ` +
            `Встановіть Google Chrome і npm i playwright.`
        );
      }
    })();
  }
  return contextPromise;
}

/** Parse `a=b; c=d` Cookie header into Playwright cookies for a domain. */
export function parseCookieHeader(
  cookieHeader: string,
  domain: string
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
}> {
  const cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
  }> = [];
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) continue;
    cookies.push({ name, value, domain, path: "/" });
  }
  return cookies;
}

export async function bootstrapCookiesOnce(
  domainKey: string,
  domain: string,
  cookieHeader: string | undefined
): Promise<void> {
  if (!cookieHeader?.trim()) return;
  if (cookiesBootstrapped.has(domainKey)) return;
  const context = await getBrowserContext();
  const cookies = parseCookieHeader(cookieHeader, domain);
  if (cookies.length) {
    await context.addCookies(cookies);
    log.info("Bootstrapped browser cookies", {
      domain,
      count: cookies.length,
    });
  }
  cookiesBootstrapped.add(domainKey);
}

async function waitForIncapsulaSettle(page: Page, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const html = await page.content().catch(() => "");
    const blocked =
      /_Incapsula_Resource|iframe id="main-iframe"|Request unsuccessful/i.test(
        html
      );
    if (!blocked) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function isDownloadStartingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Download is starting/i.test(msg);
}

/**
 * Open a page URL (warm session / pass challenge), then trigger download URL.
 */
export async function downloadFileViaChrome(options: {
  warmUrl: string;
  downloadUrl: string;
  targetPath: string;
  cookieDomain: string;
  cookieHeader?: string;
  cookieKey: string;
  label: string;
}): Promise<{ bytes: number }> {
  await bootstrapCookiesOnce(
    options.cookieKey,
    options.cookieDomain,
    options.cookieHeader
  );

  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    log.info("Browser warm-up navigation", {
      label: options.label,
      warmUrl: options.warmUrl,
    });
    try {
      await page.goto(options.warmUrl, {
        waitUntil: "domcontentloaded",
        timeout: 180_000,
      });
      await waitForIncapsulaSettle(page, 90_000);
    } catch (err) {
      // Slow net: still try the direct ZIP URL with cookies from profile/bootstrap
      log.warn("Browser warm-up failed — trying download URL anyway", {
        label: options.label,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log.info("Browser download navigation", {
      label: options.label,
      downloadUrl: options.downloadUrl,
    });

    const downloadPromise = page.waitForEvent("download", { timeout: 180_000 });
    // page.goto rejects with "Download is starting" when ZIP begins — that is OK.
    const navPromise = page
      .goto(options.downloadUrl, {
        waitUntil: "commit",
        timeout: 180_000,
      })
      .catch((err) => {
        if (isDownloadStartingError(err)) return null;
        throw err;
      });

    const settled = await Promise.allSettled([downloadPromise, navPromise]);
    const downloadResult = settled[0];
    const navResult = settled[1];

    if (downloadResult.status === "fulfilled") {
      const download = downloadResult.value;
      await fs.mkdir(path.dirname(options.targetPath), { recursive: true });
      await download.saveAs(options.targetPath);
      const st = await fs.stat(options.targetPath);
      if (st.size < 4) {
        throw new Error(`Downloaded file too small (${st.size} B)`);
      }
      const head = Buffer.alloc(4);
      const fh = await fs.open(options.targetPath, "r");
      await fh.read(head, 0, 4, 0);
      await fh.close();
      if (head[0] !== 0x50 || head[1] !== 0x4b) {
        throw new Error(
          `Browser download is not a ZIP (${options.label}, ${st.size} B)`
        );
      }
      log.info("Browser download event ok", {
        label: options.label,
        bytes: st.size,
        suggested: download.suggestedFilename(),
      });
      return { bytes: st.size };
    }

    if (navResult.status === "rejected") {
      log.warn("Browser navigation failed", {
        label: options.label,
        error:
          navResult.reason instanceof Error
            ? navResult.reason.message
            : String(navResult.reason),
      });
    }

    log.warn("No download event — trying context.request", {
      label: options.label,
      downloadError:
        downloadResult.status === "rejected"
          ? downloadResult.reason instanceof Error
            ? downloadResult.reason.message
            : String(downloadResult.reason)
          : null,
    });

    const res = await context.request.get(options.downloadUrl, {
      timeout: 180_000,
    });
    const body = Buffer.from(await res.body());
    if (!res.ok()) {
      throw new Error(
        `Browser request HTTP ${res.status()} for ${options.label}`
      );
    }
    if (body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b) {
      const head = body.subarray(0, 200).toString("utf8");
      if (/incapsula|html/i.test(head)) {
        throw new Error(
          `Browser отримав HTML/Incapsula замість ZIP (${options.label}). ` +
            `За слабкого інтернету зачекайте або пройдіть challenge у вікні Chrome.`
        );
      }
      throw new Error(
        `Browser відповідь не ZIP (${options.label}, ${body.length} B)`
      );
    }
    await fs.mkdir(path.dirname(options.targetPath), { recursive: true });
    await fs.writeFile(options.targetPath, body);
    log.info("Browser request download ok", {
      label: options.label,
      bytes: body.length,
    });
    return { bytes: body.length };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function closeBrowserContext(): Promise<void> {
  if (!contextPromise) return;
  try {
    const ctx = await contextPromise;
    await ctx.close();
  } catch {
    // ignore
  } finally {
    contextPromise = null;
    cookiesBootstrapped.clear();
  }
}
