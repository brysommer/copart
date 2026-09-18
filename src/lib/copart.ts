import fs from "fs/promises";
import path from "path";
import AdmZip from "adm-zip";
import {
  ensureLotDirs,
  getLotImagesDir,
  getLotZipPath,
  listImageFiles,
} from "./storage";
import { classifyAntibotResponse, log } from "./logger";
import { downloadFileViaChrome, useBrowserDownloads } from "./browser";

const LOT_URL_RE =
  /https?:\/\/(?:www\.)?copart\.com\/lot\/(\d+)(?:\/[^\s]*)?/i;

export type ParsedLotUrl = {
  lotId: string;
  url: string;
  source: "copart";
};

export function parseLotUrl(text: string): ParsedLotUrl | null {
  const match = text.match(LOT_URL_RE);
  if (!match) return null;
  const lotId = match[1];
  return {
    lotId,
    url: `https://www.copart.com/lot/${lotId}`,
    source: "copart",
  };
}

export function buildLotImagesZipUrl(lotId: string): string {
  return `https://www.copart.com/public/data/lotImages/download/${lotId}/1?isHD=true`;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export class CopartDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopartDownloadError";
  }
}

function getCookieValue(cookie: string, name: string): string | null {
  const re = new RegExp(
    `(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`
  );
  const m = cookie.match(re);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1].trim());
  } catch {
    return m[1].trim();
  }
}

function chromeMajorFromUa(userAgent: string): string {
  const m = userAgent.match(/Chrome\/(\d+)/i);
  return m?.[1] || "151";
}

function resolveXsrfToken(cookie?: string): string | undefined {
  const fromEnv = process.env.COPART_XSRF_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!cookie) return undefined;
  return (
    getCookieValue(cookie, "XSRF-TOKEN") ||
    getCookieValue(cookie, "X-XSRF-TOKEN") ||
    getCookieValue(cookie, "_csrf") ||
    undefined
  );
}

/** Headers aligned with Copart SPA XHR (lotImages/download), not a bare ZIP client. */
function getCopartHeaders(lotId: string): Record<string, string> {
  const cookie = process.env.COPART_COOKIE?.trim();
  const userAgent = process.env.COPART_USER_AGENT?.trim() || DEFAULT_UA;
  const isMobile = /Android|iPhone|iPad|Mobile/i.test(userAgent);
  const chromeMajor = chromeMajorFromUa(userAgent);
  const xsrf = resolveXsrfToken(cookie);

  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `https://www.copart.com/lot/${lotId}`,
    Origin: "https://www.copart.com",
    "X-Requested-With": "XMLHttpRequest",
    "sec-ch-ua": `"Not=A?Brand";v="99", "Google Chrome";v="${chromeMajor}", "Chromium";v="${chromeMajor}"`,
    "sec-ch-ua-mobile": isMobile ? "?1" : "?0",
    "sec-ch-ua-platform": isMobile ? `"Android"` : `"Windows"`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };

  if (cookie) {
    headers.Cookie = cookie;
  }
  if (xsrf) {
    headers["X-XSRF-TOKEN"] = xsrf;
  }

  return headers;
}

function looksLikeHtml(buffer: Buffer, contentType: string): boolean {
  if (contentType.includes("text/html")) return true;
  const head = buffer.subarray(0, 64).toString("utf8").toLowerCase();
  return (
    head.includes("<!doctype") ||
    head.includes("<html") ||
    head.includes("incapsula")
  );
}

async function saveDebugResponse(
  lotId: string,
  buffer: Buffer
): Promise<string | null> {
  try {
    const debugDir = path.join(
      process.env.STORAGE_DIR || "./storage",
      "debug"
    );
    await fs.mkdir(debugDir, { recursive: true });
    const debugPath = path.join(debugDir, `copart-${lotId}-response.html`);
    await fs.writeFile(debugPath, buffer);
    return debugPath;
  } catch {
    return null;
  }
}

async function extractZipImages(
  lotId: string,
  zipPath: string,
  imagesDir: string
): Promise<string[]> {
  await fs.rm(imagesDir, { recursive: true, force: true });
  await fs.mkdir(imagesDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(imagesDir, true);
  const imagePaths = await listImageFiles(imagesDir);
  if (imagePaths.length === 0) {
    log.error("Copart ZIP empty of images", { lotId, zipPath });
    throw new CopartDownloadError(
      `ZIP для лота ${lotId} завантажено, але зображень не знайдено.`
    );
  }
  return imagePaths;
}

async function downloadLotImagesZipViaBrowser(lotId: string): Promise<{
  zipPath: string;
  imagePaths: string[];
}> {
  await ensureLotDirs(lotId);
  const zipUrl = buildLotImagesZipUrl(lotId);
  const zipPath = getLotZipPath(lotId);
  const imagesDir = getLotImagesDir(lotId);
  const lotUrl = `https://www.copart.com/lot/${lotId}`;

  log.info("Copart browser download start", { lotId, zipUrl });

  const { bytes } = await downloadFileViaChrome({
    warmUrl: lotUrl,
    downloadUrl: zipUrl,
    targetPath: zipPath,
    cookieDomain: ".copart.com",
    cookieHeader: process.env.COPART_COOKIE,
    cookieKey: "copart",
    label: `copart-${lotId}`,
  });

  const buf = await fs.readFile(zipPath);
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    const debugPath = await saveDebugResponse(lotId, buf);
    const antibot = classifyAntibotResponse(buf, "application/octet-stream");
    log.warn("Copart browser got non-ZIP", {
      lotId,
      bytes: buf.length,
      reason: antibot.reason,
      signals: antibot.signals,
      debugPath,
    });
    throw new CopartDownloadError(
      `Chrome-завантаження Copart ${lotId}: не ZIP. ${antibot.reason}` +
        (debugPath ? ` Debug: ${debugPath}` : "")
    );
  }

  const imagePaths = await extractZipImages(lotId, zipPath, imagesDir);
  log.info("Copart browser download ok", {
    lotId,
    bytes,
    images: imagePaths.length,
  });
  return { zipPath, imagePaths };
}

async function downloadLotImagesZipViaFetch(lotId: string): Promise<{
  zipPath: string;
  imagePaths: string[];
}> {
  await ensureLotDirs(lotId);

  const zipUrl = buildLotImagesZipUrl(lotId);
  const zipPath = getLotZipPath(lotId);
  const imagesDir = getLotImagesDir(lotId);
  const hasCookie = Boolean(process.env.COPART_COOKIE?.trim());

  log.info("Copart fetch download start", {
    lotId,
    zipUrl,
    hasCookie,
    hasUa: Boolean(process.env.COPART_USER_AGENT?.trim()),
  });

  const response = await fetch(zipUrl, {
    headers: getCopartHeaders(lotId),
    redirect: "follow",
  });

  if (!response.ok) {
    log.error("Copart download HTTP error", {
      lotId,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
      xCdn: response.headers.get("x-cdn"),
      xIinfo: response.headers.get("x-iinfo"),
    });
    throw new CopartDownloadError(
      `Не вдалося завантажити фото лота ${lotId} (HTTP ${response.status}). Copart міг заблокувати запит.`
    );
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());

  if (looksLikeHtml(buffer, contentType)) {
    const debugPath = await saveDebugResponse(lotId, buffer);
    const antibot = classifyAntibotResponse(buffer, contentType);
    const hint = hasCookie
      ? "Cookies в COPART_COOKIE застарілі або недостатні — оновіть їх з браузера (Application → Cookies → copart.com)."
      : "Додайте COPART_COOKIE у .env (скопіюйте Cookie header з браузера після відкриття сторінки лота).";
    const debugHint = debugPath ? ` Debug: ${debugPath}` : "";
    log.warn("Copart antibot / HTML instead of ZIP", {
      lotId,
      reason: antibot.reason,
      signals: antibot.signals,
      bytes: buffer.length,
      contentType,
      xCdn: response.headers.get("x-cdn"),
      xIinfo: response.headers.get("x-iinfo"),
      debugPath,
      hasCookie,
    });
    throw new CopartDownloadError(
      `Не вдалося завантажити фото лота ${lotId}: замість ZIP отримано HTML` +
        (antibot.signals.includes("incapsula_imperva")
          ? " (Incapsula/антибот)"
          : "") +
        `. Причина: ${antibot.reason}. ${hint}${debugHint}`
    );
  }

  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    const debugPath = await saveDebugResponse(lotId, buffer);
    log.warn("Copart response not a ZIP", {
      lotId,
      bytes: buffer.length,
      contentType,
      debugPath,
      head: buffer.subarray(0, 32).toString("utf8"),
    });
    throw new CopartDownloadError(
      `Не вдалося завантажити фото лота ${lotId}: відповідь не схожа на ZIP-архів.`
    );
  }

  await fs.writeFile(zipPath, buffer);
  const imagePaths = await extractZipImages(lotId, zipPath, imagesDir);
  log.info("Copart fetch download ok", {
    lotId,
    bytes: buffer.length,
    images: imagePaths.length,
  });
  return { zipPath, imagePaths };
}

export async function downloadLotImagesZip(lotId: string): Promise<{
  zipPath: string;
  imagePaths: string[];
}> {
  if (useBrowserDownloads()) {
    try {
      return await downloadLotImagesZipViaBrowser(lotId);
    } catch (err) {
      log.warn("Copart browser download failed, falling back to fetch", {
        lotId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return downloadLotImagesZipViaFetch(lotId);
}

export function pickImageSubset(
  imagePaths: string[],
  limit: number
): string[] {
  // Weak filename hint only — primary selection is AI triage in pipeline.
  if (imagePaths.length <= limit) return imagePaths;

  const scored = imagePaths.map((p, index) => {
    const name = path.basename(p).toLowerCase();
    let score = 0;
    if (/vin|plate|label|detail|close|jamb/.test(name)) score += 5;
    if (/dmg|damage|front|rear|side|hood|door|bumper/.test(name)) score += 2;
    // Prefer spreading across gallery rather than only first frames
    score += Math.min(3, Math.floor(index / Math.max(1, imagePaths.length / 4)));
    return { path: p, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.path);
}
