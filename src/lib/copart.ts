import fs from "fs/promises";
import path from "path";
import AdmZip from "adm-zip";
import {
  ensureLotDirs,
  getLotImagesDir,
  getLotZipPath,
  listImageFiles,
} from "./storage";

const LOT_URL_RE =
  /https?:\/\/(?:www\.)?copart\.com\/lot\/(\d+)(?:\/[^\s]*)?/i;

export type ParsedLotUrl = {
  lotId: string;
  url: string;
};

export function parseLotUrl(text: string): ParsedLotUrl | null {
  const match = text.match(LOT_URL_RE);
  if (!match) return null;
  const lotId = match[1];
  return {
    lotId,
    url: `https://www.copart.com/lot/${lotId}`,
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

function getCopartHeaders(lotId: string): Record<string, string> {
  const cookie = process.env.COPART_COOKIE?.trim();
  const userAgent = process.env.COPART_USER_AGENT?.trim() || DEFAULT_UA;

  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: "application/zip,application/octet-stream,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `https://www.copart.com/lot/${lotId}`,
    Origin: "https://www.copart.com",
  };

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
    const debugPath = path.join(debugDir, `copart-${lotId}-response.html`);
    await fs.writeFile(debugPath, buffer);
    return debugPath;
  } catch {
    return null;
  }
}

export async function downloadLotImagesZip(lotId: string): Promise<{
  zipPath: string;
  imagePaths: string[];
}> {
  await ensureLotDirs(lotId);

  const zipUrl = buildLotImagesZipUrl(lotId);
  const zipPath = getLotZipPath(lotId);
  const imagesDir = getLotImagesDir(lotId);
  const hasCookie = Boolean(process.env.COPART_COOKIE?.trim());

  const response = await fetch(zipUrl, {
    headers: getCopartHeaders(lotId),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new CopartDownloadError(
      `Не вдалося завантажити фото лота ${lotId} (HTTP ${response.status}). Copart міг заблокувати запит.`
    );
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());

  if (looksLikeHtml(buffer, contentType)) {
    const debugPath = await saveDebugResponse(lotId, buffer);
    const isIncapsula = buffer
      .toString("utf8", 0, Math.min(buffer.length, 4000))
      .toLowerCase()
      .includes("incapsula");
    const hint = hasCookie
      ? "Cookies в COPART_COOKIE застарілі або недостатні — оновіть їх з браузера (Application → Cookies → copart.com)."
      : "Додайте COPART_COOKIE у .env (скопіюйте Cookie header з браузера після відкриття сторінки лота).";
    const debugHint = debugPath ? ` Debug: ${debugPath}` : "";
    throw new CopartDownloadError(
      `Не вдалося завантажити фото лота ${lotId}: замість ZIP отримано HTML` +
        (isIncapsula ? " (Incapsula/антибот)" : "") +
        `. ${hint}${debugHint}`
    );
  }

  // ZIP local header magic: PK\x03\x04
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    await saveDebugResponse(lotId, buffer);
    throw new CopartDownloadError(
      `Не вдалося завантажити фото лота ${lotId}: відповідь не схожа на ZIP-архів.`
    );
  }

  await fs.writeFile(zipPath, buffer);

  // Clean previous images
  await fs.rm(imagesDir, { recursive: true, force: true });
  await fs.mkdir(imagesDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(imagesDir, true);

  const imagePaths = await listImageFiles(imagesDir);
  if (imagePaths.length === 0) {
    throw new CopartDownloadError(
      `ZIP для лота ${lotId} завантажено, але зображень не знайдено.`
    );
  }

  return { zipPath, imagePaths };
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
