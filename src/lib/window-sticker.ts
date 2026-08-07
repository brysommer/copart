import fs from "fs/promises";
import path from "path";
import { ensureLotDirs, getLotDir } from "./storage";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * OEM window sticker endpoints often geo-block UA IPs.
 * Fetch from the bot host (e.g. Hetzner DE) may work; UA home IP often fails.
 */
function stickerCandidateUrls(vin: string): string[] {
  const v = vin.toUpperCase();
  const custom = process.env.WINDOW_STICKER_URL_TEMPLATE?.replaceAll(
    "{vin}",
    v
  );
  const urls = [
    custom,
    // Stellantis / FCA style Monroney
    `https://www.chrysler.com/hostd/windowsticker/getWindowStickerPdf.do?vin=${v}`,
    `https://www.dodge.com/hostd/windowsticker/getWindowStickerPdf.do?vin=${v}`,
    `https://www.jeep.com/hostd/windowsticker/getWindowStickerPdf.do?vin=${v}`,
    `https://www.ramtrucks.com/hostd/windowsticker/getWindowStickerPdf.do?vin=${v}`,
  ].filter(Boolean) as string[];
  return [...new Set(urls)];
}

function looksLikePdf(buf: Buffer): boolean {
  return buf.length > 500 && buf.subarray(0, 4).toString() === "%PDF";
}

function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 24) return false;
  // PNG / JPEG / WEBP
  if (buf[0] === 0x89 && buf[1] === 0x50) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (buf.subarray(0, 4).toString() === "RIFF") return true;
  return false;
}

export async function tryDownloadWindowSticker(
  vin: string
): Promise<{ path: string; sourceUrl: string } | null> {
  await ensureLotDirs(vin);
  const dir = getLotDir(vin);

  for (const url of stickerCandidateUrls(vin)) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/pdf,image/*,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = (res.headers.get("content-type") || "").toLowerCase();

      if (looksLikePdf(buf) || ct.includes("pdf")) {
        const out = path.join(dir, `window-sticker-${vin}.pdf`);
        await fs.writeFile(out, buf);
        return { path: out, sourceUrl: url };
      }
      if (looksLikeImage(buf) || ct.startsWith("image/")) {
        const ext = ct.includes("png") ? "png" : "jpg";
        const out = path.join(dir, `window-sticker-${vin}.${ext}`);
        await fs.writeFile(out, buf);
        return { path: out, sourceUrl: url };
      }
    } catch {
      // try next
    }
  }

  return null;
}

/** Pull http(s) links from Carfax text that look like sticker URLs and try them. */
export async function tryStickerFromCarfaxLinks(
  vin: string,
  carfaxText: string
): Promise<{ path: string; sourceUrl: string } | null> {
  const links = [
    ...carfaxText.matchAll(/https?:\/\/[^\s"'<>]+/gi),
  ].map((m) => m[0].replace(/[),.;]+$/, ""));

  const stickerLinks = links.filter((u) =>
    /window.?sticker|monroney|hostd\/windowsticker|predelivery|buildsheet/i.test(
      u
    )
  );

  await ensureLotDirs(vin);
  const dir = getLotDir(vin);

  for (const url of stickerLinks.slice(0, 5)) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/pdf,image/*,*/*" },
        redirect: "follow",
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (looksLikePdf(buf)) {
        const out = path.join(dir, `window-sticker-${vin}.pdf`);
        await fs.writeFile(out, buf);
        return { path: out, sourceUrl: url };
      }
      if (looksLikeImage(buf)) {
        const out = path.join(dir, `window-sticker-${vin}.jpg`);
        await fs.writeFile(out, buf);
        return { path: out, sourceUrl: url };
      }
    } catch {
      // next
    }
  }
  return null;
}
