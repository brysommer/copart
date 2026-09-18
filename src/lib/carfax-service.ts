import {
  analyzeCarfaxText,
  analyzeWindowStickerFile,
  extractPdfText,
} from "./carfax-ai";
import { downloadCarfaxPdf, VinReportError } from "./vinreport";
import { tryStickerFromCarfaxLinks } from "./window-sticker";

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
    "Шукаю Window Sticker у Carfax (клікабельні PDF-лінки + текст)..."
  );

  const stickerResult = await tryStickerFromCarfaxLinks(
    vin,
    pdfText,
    pdfPath
  );

  let stickerPath: string | null = null;
  let stickerAnalysis: string | null = null;
  let stickerNote: string | undefined;

  if (stickerResult.status === "ok") {
    stickerPath = stickerResult.path;
    await onStatus?.(
      `Знайшов посилання в Carfax — завантажив sticker:\n${stickerResult.sourceUrl}`
    );
    try {
      stickerAnalysis = await analyzeWindowStickerFile(vin, stickerResult.path);
    } catch (err) {
      stickerNote =
        err instanceof Error
          ? `Sticker скачано, але аналіз не вдався: ${err.message}`
          : "Sticker скачано, але аналіз не вдався.";
    }
  } else if (stickerResult.status === "no_links") {
    stickerNote =
      "У Carfax немає посилання на Window Sticker (ні в тексті, ні в клікабельних лінках PDF).";
  } else {
    stickerNote =
      "У Carfax є посилання на Window Sticker, але завантажити не вдалося.\n" +
      stickerResult.urls.map((u) => `• ${u}`).join("\n") +
      `\nДеталі: ${stickerResult.detail}`;
  }

  return {
    pdfPath,
    stickerPath,
    carfaxAnalysis,
    stickerAnalysis,
    balance,
    stickerNote,
  };
}

export { VinReportError };
