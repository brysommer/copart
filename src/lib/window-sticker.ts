import fs from "fs/promises";
import path from "path";
import { ensureLotDirs, getLotDir } from "./storage";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Matches Carfax phoenix sticker links, OEM Monroney, etc. */
const STICKER_URL_RE =
  /window.?sticker|monroney|hostd\/windowsticker|predelivery|build.?sheet|getWindowSticker|windowsticker\.|phoenix\/sticker|\/sticker\/v\d+|\.cfx(?:\b|$)/i;

function looksLikePdf(buf: Buffer): boolean {
  return buf.length > 500 && buf.subarray(0, 4).toString() === "%PDF";
}

function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 24) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (buf.subarray(0, 4).toString() === "RIFF") return true;
  return false;
}

function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 200).toString("utf8").toLowerCase();
  return head.includes("<!doctype") || head.includes("<html");
}

function cleanUrl(raw: string): string {
  return raw.replace(/[),.;\]}>]+$/g, "").trim();
}

function decodePdfLiteralString(raw: string): string {
  return raw
    .replace(/\\(\d{1,3})/g, (_, oct) =>
      String.fromCharCode(parseInt(oct, 8))
    )
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function stickerUrlScore(url: string): number {
  if (/phoenix\/sticker/i.test(url)) return 100;
  if (/\.cfx(?:\b|$)/i.test(url)) return 90;
  if (/windowsticker|getWindowSticker|monroney/i.test(url)) return 80;
  if (/window.?sticker|build.?sheet/i.test(url)) return 50;
  return 1;
}

/** Clickable PDF links (/URI annotations) — Carfax puts Window Sticker here, not in plain text. */
export async function extractPdfUriAnnotations(
  pdfPath: string
): Promise<string[]> {
  const buf = await fs.readFile(pdfPath);
  const s = buf.toString("latin1");
  const urls: string[] = [];

  for (const m of s.matchAll(/\/URI\s*\(([^)]*)\)/g)) {
    urls.push(decodePdfLiteralString(m[1]));
  }
  for (const m of s.matchAll(/\/URI\s*<([0-9A-Fa-f]+)>/g)) {
    try {
      urls.push(Buffer.from(m[1], "hex").toString("utf8"));
    } catch {
      // ignore bad hex
    }
  }

  return [
    ...new Set(
      urls
        .map(cleanUrl)
        .filter((u) => /^https?:\/\//i.test(u))
    ),
  ];
}

/** Collect Window Sticker URLs from Carfax PDF plain text. */
export function extractWindowStickerLinks(carfaxText: string): string[] {
  const allLinks = [...carfaxText.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map(
    (m) => cleanUrl(m[0])
  );

  const byUrl = allLinks.filter((u) => STICKER_URL_RE.test(u));

  const contextUrls: string[] = [];
  const lower = carfaxText.toLowerCase();
  let from = 0;
  while (from < lower.length) {
    const hit = lower.indexOf("window sticker", from);
    if (hit < 0) break;
    const slice = carfaxText.slice(Math.max(0, hit - 120), hit + 350);
    for (const m of slice.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      contextUrls.push(cleanUrl(m[0]));
    }
    from = hit + 14;
  }

  return [...new Set([...byUrl, ...contextUrls])];
}

export async function collectCarfaxStickerLinks(
  carfaxText: string,
  pdfPath: string
): Promise<string[]> {
  const fromUri = (await extractPdfUriAnnotations(pdfPath)).filter((u) =>
    STICKER_URL_RE.test(u)
  );
  const fromText = extractWindowStickerLinks(carfaxText);
  const merged = [...new Set([...fromUri, ...fromText])];
  return merged.sort((a, b) => stickerUrlScore(b) - stickerUrlScore(a));
}

export type StickerFetchResult =
  | { status: "no_links" }
  | { status: "ok"; path: string; sourceUrl: string }
  | { status: "download_failed"; urls: string[]; detail: string };

async function fetchStickerFile(
  vin: string,
  url: string
): Promise<{ path: string } | { error: string }> {
  const dir = getLotDir(vin);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/pdf,image/*,text/html,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.carfax.com/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (looksLikePdf(buf) || ct.includes("pdf")) {
      // Tiny PDFs are usually error stubs — reject and try next URL
      if (buf.length < 5_000 && !/phoenix\/sticker/i.test(url)) {
        return { error: `занадто малий PDF (${buf.length} B)` };
      }
      const out = path.join(dir, `window-sticker-${vin}.pdf`);
      await fs.writeFile(out, buf);
      return { path: out };
    }
    if (looksLikeImage(buf) || ct.startsWith("image/")) {
      const ext = ct.includes("png") ? "png" : "jpg";
      const out = path.join(dir, `window-sticker-${vin}.${ext}`);
      await fs.writeFile(out, buf);
      return { path: out };
    }
    // Carfax phoenix sticker sometimes returns HTML page with Monroney content
    if (
      looksLikeHtml(buf) ||
      ct.includes("text/html") ||
      ct.includes("text/plain")
    ) {
      if (buf.length < 800) {
        return { error: `порожня HTML-відповідь (${buf.length} B)` };
      }
      const out = path.join(dir, `window-sticker-${vin}.html`);
      await fs.writeFile(out, buf);
      return { path: out };
    }
    return {
      error: `не PDF/зображення/HTML (content-type: ${ct || "unknown"}, ${buf.length} B)`,
    };
  } catch (err) {
    const cause =
      err instanceof Error && "cause" in err && err.cause instanceof Error
        ? err.cause.message
        : "";
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : "network error";
    if (name === "TimeoutError" || /aborted|timeout/i.test(msg)) {
      return { error: "timeout 45s (мережа/блок carfax.com)" };
    }
    return { error: cause ? `${msg}: ${cause}` : msg };
  }
}

/**
 * Download Window Sticker from Carfax PDF: clickable /URI annotations + plain text links.
 */
export async function tryStickerFromCarfaxLinks(
  vin: string,
  carfaxText: string,
  pdfPath: string
): Promise<StickerFetchResult> {
  const stickerLinks = await collectCarfaxStickerLinks(carfaxText, pdfPath);
  if (stickerLinks.length === 0) {
    return { status: "no_links" };
  }

  await ensureLotDirs(vin);
  const errors: string[] = [];

  for (const url of stickerLinks.slice(0, 8)) {
    const result = await fetchStickerFile(vin, url);
    if ("path" in result) {
      return { status: "ok", path: result.path, sourceUrl: url };
    }
    errors.push(`${url.slice(0, 120)}… → ${result.error}`);
  }

  return {
    status: "download_failed",
    urls: stickerLinks.slice(0, 8),
    detail: errors.join("; "),
  };
}
