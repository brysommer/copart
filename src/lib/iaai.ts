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
import {
  bootstrapCookiesOnce,
  downloadFileViaChrome,
  getBrowserContext,
  useBrowserDownloads,
} from "./browser";

const DETAIL_RE =
  /https?:\/\/(?:www\.)?iaai\.com\/VehicleDetail\/(\d+)(?:~([A-Z]{2}))?(?:\/[^\s]*)?/i;
const DOWNLOAD_URL_RE =
  /https?:\/\/(?:www\.)?iaai\.com\/VehicleDetail\/DownloadImages\?([^\s]+)/i;

const DEFAULT_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36";

export type IaaiDownloadParams = {
  stockNumber: string;
  branchCode: string;
  branchId: string;
  salvageId: string;
};

export type ParsedIaaiLot = {
  lotId: string;
  url: string;
  source: "iaai";
  params: IaaiDownloadParams | null;
};

export class IaaiDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IaaiDownloadError";
  }
}

export function iaaiStorageLotId(salvageId: string): string {
  return `iaai-${salvageId}`;
}

export function parseIaaiUrl(text: string): ParsedIaaiLot | null {
  const download = text.match(DOWNLOAD_URL_RE);
  if (download) {
    const qs = new URLSearchParams(download[1]);
    const stockNumber = qs.get("stockNumber")?.trim() || "";
    const branchCode = qs.get("branchCode")?.trim() || "";
    const branchId = qs.get("branchId")?.trim() || "";
    const salvageId =
      qs.get("salvageId")?.replace(/~[A-Z]{2}$/i, "").trim() || "";
    if (!stockNumber || !branchCode || !branchId || !salvageId) {
      return null;
    }
    return {
      lotId: iaaiStorageLotId(salvageId),
      url: `https://www.iaai.com/VehicleDetail/${salvageId}~US`,
      source: "iaai",
      params: { stockNumber, branchCode, branchId, salvageId },
    };
  }

  const detail = text.match(DETAIL_RE);
  if (!detail) return null;
  const salvageId = detail[1];
  const country = (detail[2] || "US").toUpperCase();
  return {
    lotId: iaaiStorageLotId(salvageId),
    url: `https://www.iaai.com/VehicleDetail/${salvageId}~${country}`,
    source: "iaai",
    params: null,
  };
}

function chromeMajorFromUa(userAgent: string): string {
  const m = userAgent.match(/Chrome\/(\d+)/i);
  return m?.[1] || "151";
}

function getIaaiHeaders(referer: string, navigate: boolean): Record<string, string> {
  const cookie = process.env.IAAI_COOKIE?.trim();
  const userAgent =
    process.env.IAAI_USER_AGENT?.trim() ||
    process.env.COPART_USER_AGENT?.trim() ||
    DEFAULT_UA;
  const isMobile = /Android|iPhone|iPad|Mobile/i.test(userAgent);
  const chromeMajor = chromeMajorFromUa(userAgent);

  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: navigate
      ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"
      : "application/octet-stream,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer,
    "sec-ch-ua": `"Not=A?Brand";v="99", "Google Chrome";v="${chromeMajor}", "Chromium";v="${chromeMajor}"`,
    "sec-ch-ua-mobile": isMobile ? "?1" : "?0",
    "sec-ch-ua-platform": isMobile ? `"Android"` : `"Windows"`,
    "sec-fetch-dest": navigate ? "document" : "empty",
    "sec-fetch-mode": navigate ? "navigate" : "cors",
    "sec-fetch-site": "same-origin",
  };
  if (navigate) {
    headers["upgrade-insecure-requests"] = "1";
    headers["sec-fetch-user"] = "?1";
  }
  if (cookie) {
    headers.Cookie = cookie;
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
    const debugPath = path.join(debugDir, `iaai-${lotId}-response.html`);
    await fs.writeFile(debugPath, buffer);
    return debugPath;
  } catch {
    return null;
  }
}

function buildDownloadUrl(params: IaaiDownloadParams): string {
  const salvageId = params.salvageId.includes("~")
    ? params.salvageId
    : `${params.salvageId}~US`;
  const branchId = params.branchId.includes("~")
    ? params.branchId
    : `${params.branchCode}~US`;
  const qs = new URLSearchParams({
    stockNumber: params.stockNumber,
    branchCode: params.branchCode,
    branchId,
    salvageId,
  });
  return `https://www.iaai.com/VehicleDetail/DownloadImages?${qs.toString()}`;
}

function extractParamsFromHtml(
  html: string,
  fallbackSalvageId: string
): IaaiDownloadParams | null {
  const linkMatch = html.match(
    /\/VehicleDetail\/DownloadImages\?([^"'<\s]+)/i
  );
  if (linkMatch) {
    const qs = new URLSearchParams(linkMatch[1].replace(/&amp;/g, "&"));
    const stockNumber = qs.get("stockNumber")?.trim() || "";
    const branchCode = qs.get("branchCode")?.trim() || "";
    const branchId = qs.get("branchId")?.trim() || "";
    const salvageRaw = qs.get("salvageId")?.trim() || fallbackSalvageId;
    const salvageId = salvageRaw.replace(/~[A-Z]{2}$/i, "");
    if (stockNumber && branchCode && branchId && salvageId) {
      return {
        stockNumber,
        branchCode,
        branchId: branchId.includes("~") ? branchId : `${branchCode}~US`,
        salvageId,
      };
    }
  }

  const stockNumber =
    html.match(/"stockNumber"\s*:\s*"?(\d+)"?/i)?.[1] ||
    html.match(/stockNumber["'\s:=]+(\d{6,})/i)?.[1];
  const branchCode =
    html.match(/"branchCode"\s*:\s*"?(\d+)"?/i)?.[1] ||
    html.match(/branchCode["'\s:=]+(\d+)/i)?.[1];
  const branchIdRaw =
    html.match(/"branchId"\s*:\s*"([^"]+)"/i)?.[1] ||
    html.match(/branchId["'\s:=]+([0-9]+~[A-Z]{2})/i)?.[1];
  const salvageId =
    html.match(/"salvageId"\s*:\s*"?(\d+)/i)?.[1] || fallbackSalvageId;

  if (!stockNumber || !branchCode) return null;

  return {
    stockNumber,
    branchCode,
    branchId: branchIdRaw || `${branchCode}~US`,
    salvageId: String(salvageId).replace(/~[A-Z]{2}$/i, ""),
  };
}

async function resolveIaaiDownloadParamsViaBrowser(
  parsed: ParsedIaaiLot
): Promise<IaaiDownloadParams> {
  if (parsed.params) return parsed.params;

  const salvageId = parsed.lotId.replace(/^iaai-/, "");
  await bootstrapCookiesOnce(
    "iaai",
    ".iaai.com",
    process.env.IAAI_COOKIE
  );
  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    log.info("IAAI browser resolve detail", {
      salvageId,
      url: parsed.url,
    });
    await page.goto(parsed.url, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    for (let i = 0; i < 15; i++) {
      const html = await page.content();
      if (!/_Incapsula_Resource|Request unsuccessful/i.test(html)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const html = await page.content();
    const params = extractParamsFromHtml(html, salvageId);
    if (!params) {
      const debugPath = await saveDebugResponse(
        parsed.lotId,
        Buffer.from(html)
      );
      throw new IaaiDownloadError(
        `Chrome не знайшов stockNumber/branch для IAAI ${salvageId}. ` +
          `Надішліть повний DownloadImages URL.` +
          (debugPath ? ` Debug: ${debugPath}` : "")
      );
    }
    log.info("IAAI browser params resolved", {
      salvageId,
      stockNumber: params.stockNumber,
      branchCode: params.branchCode,
      branchId: params.branchId,
    });
    return params;
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function resolveIaaiDownloadParams(
  parsed: ParsedIaaiLot
): Promise<IaaiDownloadParams> {
  if (parsed.params) return parsed.params;

  if (useBrowserDownloads()) {
    try {
      return await resolveIaaiDownloadParamsViaBrowser(parsed);
    } catch (err) {
      log.warn("IAAI browser resolve failed, trying fetch", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const salvageId = parsed.lotId.replace(/^iaai-/, "");
  const detailUrl = parsed.url;
  const hasCookie = Boolean(process.env.IAAI_COOKIE?.trim());

  log.info("IAAI resolve detail page", { salvageId, detailUrl, hasCookie });

  const response = await fetch(detailUrl, {
    headers: getIaaiHeaders(detailUrl, true),
    redirect: "follow",
  });

  if (!response.ok) {
    log.error("IAAI detail HTTP error", {
      salvageId,
      status: response.status,
      xCdn: response.headers.get("x-cdn"),
      xIinfo: response.headers.get("x-iinfo"),
    });
    throw new IaaiDownloadError(
      `Не вдалося відкрити IAAI лот ${salvageId} (HTTP ${response.status}).` +
        (hasCookie
          ? " Оновіть IAAI_COOKIE з браузера."
          : " Додайте IAAI_COOKIE у .env.")
    );
  }

  const html = await response.text();
  const antibot = classifyAntibotResponse(html, "text/html");
  if (
    antibot.signals.includes("incapsula_imperva") ||
    antibot.signals.includes("captcha_or_challenge")
  ) {
    log.warn("IAAI detail page blocked by antibot", {
      salvageId,
      reason: antibot.reason,
      signals: antibot.signals,
      hasCookie,
    });
    throw new IaaiDownloadError(
      `IAAI заблокував сторінку лота ${salvageId} (${antibot.reason}). Оновіть IAAI_COOKIE (той самий VPN/IP, що в браузері).`
    );
  }

  const params = extractParamsFromHtml(html, salvageId);
  if (!params) {
    const debugPath = await saveDebugResponse(parsed.lotId, Buffer.from(html));
    log.warn("IAAI could not parse stockNumber/branch", {
      salvageId,
      debugPath,
      htmlBytes: html.length,
    });
    throw new IaaiDownloadError(
      `Не знайшов stockNumber/branch для IAAI лота ${salvageId}. ` +
        `Надішліть повний DownloadImages URL з DevTools.` +
        (debugPath ? ` Debug: ${debugPath}` : "")
    );
  }
  log.info("IAAI params resolved", {
    salvageId,
    stockNumber: params.stockNumber,
    branchCode: params.branchCode,
    branchId: params.branchId,
  });
  return params;
}

export async function downloadIaaiImagesZip(
  parsed: ParsedIaaiLot
): Promise<{ zipPath: string; imagePaths: string[] }> {
  if (useBrowserDownloads()) {
    try {
      return await downloadIaaiImagesZipViaBrowser(parsed);
    } catch (err) {
      log.warn("IAAI browser download failed, falling back to fetch", {
        lotId: parsed.lotId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return downloadIaaiImagesZipViaFetch(parsed);
}

async function downloadIaaiImagesZipViaBrowser(
  parsed: ParsedIaaiLot
): Promise<{ zipPath: string; imagePaths: string[] }> {
  const lotId = parsed.lotId;
  await ensureLotDirs(lotId);
  const params = await resolveIaaiDownloadParamsViaBrowser(parsed);
  const zipUrl = buildDownloadUrl(params);
  const zipPath = getLotZipPath(lotId);
  const imagesDir = getLotImagesDir(lotId);

  log.info("IAAI browser download start", {
    lotId,
    zipUrl,
    stockNumber: params.stockNumber,
  });

  const { bytes } = await downloadFileViaChrome({
    warmUrl: parsed.url,
    downloadUrl: zipUrl,
    targetPath: zipPath,
    cookieDomain: ".iaai.com",
    cookieHeader: process.env.IAAI_COOKIE,
    cookieKey: "iaai",
    label: `iaai-${params.salvageId}`,
  });

  const buf = await fs.readFile(zipPath);
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    const debugPath = await saveDebugResponse(lotId, buf);
    const antibot = classifyAntibotResponse(buf);
    throw new IaaiDownloadError(
      `Chrome-завантаження IAAI ${params.salvageId}: не ZIP. ${antibot.reason}` +
        (debugPath ? ` Debug: ${debugPath}` : "")
    );
  }

  await fs.rm(imagesDir, { recursive: true, force: true });
  await fs.mkdir(imagesDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(imagesDir, true);
  const imagePaths = await listImageFiles(imagesDir);
  if (imagePaths.length === 0) {
    throw new IaaiDownloadError(
      `ZIP IAAI для ${params.salvageId} завантажено, але зображень не знайдено.`
    );
  }
  log.info("IAAI browser download ok", {
    lotId,
    bytes,
    images: imagePaths.length,
  });
  return { zipPath, imagePaths };
}

async function downloadIaaiImagesZipViaFetch(
  parsed: ParsedIaaiLot
): Promise<{ zipPath: string; imagePaths: string[] }> {
  const lotId = parsed.lotId;
  await ensureLotDirs(lotId);

  const params = await resolveIaaiDownloadParams(parsed);
  const zipUrl = buildDownloadUrl(params);
  const zipPath = getLotZipPath(lotId);
  const imagesDir = getLotImagesDir(lotId);
  const hasCookie = Boolean(process.env.IAAI_COOKIE?.trim());
  const referer = parsed.url;

  log.info("IAAI fetch download start", {
    lotId,
    zipUrl,
    hasCookie,
    stockNumber: params.stockNumber,
  });

  const response = await fetch(zipUrl, {
    headers: getIaaiHeaders(referer, true),
    redirect: "follow",
  });

  if (!response.ok) {
    log.error("IAAI download HTTP error", {
      lotId,
      status: response.status,
      xCdn: response.headers.get("x-cdn"),
      xIinfo: response.headers.get("x-iinfo"),
    });
    throw new IaaiDownloadError(
      `Не вдалося завантажити фото IAAI ${params.salvageId} (HTTP ${response.status}).`
    );
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());

  if (looksLikeHtml(buffer, contentType)) {
    const debugPath = await saveDebugResponse(lotId, buffer);
    const antibot = classifyAntibotResponse(buffer, contentType);
    const hint = hasCookie
      ? "Cookies в IAAI_COOKIE застарілі — оновіть з успішного DownloadImages у браузері (той самий VPN/IP)."
      : "Додайте IAAI_COOKIE у .env.";
    log.warn("IAAI antibot / HTML instead of ZIP", {
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
    throw new IaaiDownloadError(
      `Не вдалося завантажити фото IAAI ${params.salvageId}: замість ZIP отримано HTML` +
        (antibot.signals.includes("incapsula_imperva")
          ? " (Incapsula/антибот)"
          : "") +
        `. Причина: ${antibot.reason}. ${hint}` +
        (debugPath ? ` Debug: ${debugPath}` : "")
    );
  }

  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    const debugPath = await saveDebugResponse(lotId, buffer);
    log.warn("IAAI response not a ZIP", {
      lotId,
      bytes: buffer.length,
      contentType,
      debugPath,
    });
    throw new IaaiDownloadError(
      `Не вдалося завантажити фото IAAI ${params.salvageId}: відповідь не схожа на ZIP.`
    );
  }

  await fs.writeFile(zipPath, buffer);
  await fs.rm(imagesDir, { recursive: true, force: true });
  await fs.mkdir(imagesDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(imagesDir, true);

  const imagePaths = await listImageFiles(imagesDir);
  if (imagePaths.length === 0) {
    log.error("IAAI ZIP empty of images", { lotId, zipPath });
    throw new IaaiDownloadError(
      `ZIP IAAI для ${params.salvageId} завантажено, але зображень не знайдено.`
    );
  }

  log.info("IAAI fetch download ok", {
    lotId,
    bytes: buffer.length,
    images: imagePaths.length,
  });

  return { zipPath, imagePaths };
}
