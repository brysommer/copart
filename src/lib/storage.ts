import fs from "fs/promises";
import path from "path";

export function getStorageRoot(): string {
  return path.resolve(process.env.STORAGE_DIR || "./storage");
}

export function getLotDir(lotId: string): string {
  return path.join(getStorageRoot(), "lots", lotId);
}

export function getLotZipPath(lotId: string): string {
  return path.join(getLotDir(lotId), "photos.zip");
}

export function getLotImagesDir(lotId: string): string {
  return path.join(getLotDir(lotId), "images");
}

export async function ensureLotDirs(lotId: string): Promise<void> {
  await fs.mkdir(getLotImagesDir(lotId), { recursive: true });
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);

export async function listImageFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listImageFiles(full)));
      continue;
    }
    if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }

  return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
