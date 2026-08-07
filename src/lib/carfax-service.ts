import {
  analyzeCarfaxText,
  analyzeWindowStickerFile,
  extractPdfText,
} from "./carfax-ai";
import { downloadCarfaxPdf, VinReportError } from "./vinreport";
import {
  tryDownloadWindowSticker,
  tryStickerFromCarfaxLinks,
} from "./window-sticker";

export type CarfaxBundleResult = {
  pdfPath: string;
  stickerPath: string | null;
  carfaxAnalysis: string;
  stickerAnalysis: string | null;
  balance?: number;
  stickerNote?: string;
};

export async function purchaseAndAnalyzeCarfax(
  vin: string,
  onStatus?: (msg: string) => Promise<void> | void
): Promise<CarfaxBundleResult> {
  const { pdfPath, balance } = await downloadCarfaxPdf(vin, onStatus);

  await onStatus?.("Читаю PDF Carfax для ШІ-аналізу...");
  const pdfText = await extractPdfText(pdfPath);
  const carfaxAnalysis = await analyzeCarfaxText(vin, pdfText);

  await onStatus?.(
    "Шукаю Window Sticker (з сервера; з UA IP часто блокується)..."
  );

  let sticker =
    (await tryDownloadWindowSticker(vin)) ||
    (await tryStickerFromCarfaxLinks(vin, pdfText));

  let stickerAnalysis: string | null = null;
  let stickerNote: string | undefined;

  if (sticker) {
    await onStatus?.("Знайшов sticker — аналізую...");
    try {
      stickerAnalysis = await analyzeWindowStickerFile(vin, sticker.path);
    } catch (err) {
      stickerNote =
        err instanceof Error
          ? `Sticker скачано, але аналіз не вдався: ${err.message}`
          : "Sticker скачано, але аналіз не вдався.";
    }
  } else {
    stickerNote =
      "Window Sticker не вдалося завантажити (geo-блок або немає для VIN). Спробуйте з VPS у DE/US.";
  }

  return {
    pdfPath,
    stickerPath: sticker?.path ?? null,
    carfaxAnalysis,
    stickerAnalysis,
    balance,
    stickerNote,
  };
}

export { VinReportError };
