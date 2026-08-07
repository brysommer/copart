import fs from "fs/promises";
import path from "path";
import { getLotDir, ensureLotDirs } from "./storage";

const BASE = process.env.VINREPORT_BASE_URL || "https://vinreport.shop";

export class VinReportError extends Error {
  constructor(
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "VinReportError";
  }
}

type PdfApiResponse =
  | { status: "ok"; vin: string; url: string; balance?: number }
  | {
      status: "processing";
      vin: string;
      retry_after?: number;
      message?: string;
    }
  | { status: "error"; error: string; detail?: string; message?: string };

function requireCreds(): { apiKey: string; userId: string } {
  const apiKey = process.env.VINREPORT_API_KEY?.trim();
  const userId = process.env.VINREPORT_USER_ID?.trim();
  if (!apiKey || !userId) {
    throw new VinReportError(
      "Не налаштовано VINREPORT_API_KEY / VINREPORT_USER_ID у .env",
      "missing_creds"
    );
  }
  return { apiKey, userId };
}

async function requestCarfaxPdf(vin: string): Promise<PdfApiResponse> {
  const { apiKey, userId } = requireCreds();
  const url = new URL("/api/v2/getCarfaxPdf", BASE);
  url.searchParams.set("vin", vin);
  url.searchParams.set("user_id", userId);

  const res = await fetch(url, {
    headers: {
      "X-API-KEY": apiKey,
      Accept: "application/json",
    },
  });

  const body = (await res.json().catch(() => null)) as PdfApiResponse | null;
  if (!body || typeof body !== "object") {
    throw new VinReportError(
      `VinReport: неочікувана відповідь (HTTP ${res.status})`,
      "bad_response"
    );
  }

  if (res.status === 401) {
    throw new VinReportError("VinReport: невірний API key", "unauthorized");
  }
  if (res.status === 403) {
    throw new VinReportError("VinReport: user_id не авторизований", "forbidden");
  }

  return body;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll getCarfaxPdf until ok or give up (per VinReport docs). */
export async function fetchCarfaxPdfUrl(
  vin: string,
  onStatus?: (msg: string) => Promise<void> | void
): Promise<{ url: string; balance?: number }> {
  const maxAttempts = Number(process.env.VINREPORT_MAX_ATTEMPTS || 4);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const data = await requestCarfaxPdf(vin);

    if (data.status === "ok" && data.url) {
      return { url: data.url, balance: data.balance };
    }

    if (data.status === "processing") {
      const waitSec = Math.max(5, Number(data.retry_after ?? 60));
      await onStatus?.(
        `Carfax генерується (спроба ${attempt}/${maxAttempts}). Чекаю ~${waitSec}с...`
      );
      await sleep(waitSec * 1000);
      continue;
    }

    if (data.status === "error") {
      const code = data.error;
      if (code === "no_balance") {
        throw new VinReportError("Немає кредитів на VinReport", code);
      }
      if (code === "invalid_vin") {
        throw new VinReportError(
          `Невалідний VIN (${data.detail ?? "invalid"})`,
          code
        );
      }
      throw new VinReportError(
        data.message || `VinReport error: ${code}`,
        code
      );
    }

    throw new VinReportError("VinReport: невідомий статус відповіді");
  }

  throw new VinReportError(
    "Carfax не готовий після кількох спроб (VIN може бути недоступний)",
    "timeout"
  );
}

export async function downloadCarfaxPdf(
  vin: string,
  onStatus?: (msg: string) => Promise<void> | void
): Promise<{ pdfPath: string; balance?: number }> {
  await ensureLotDirs(vin);
  const { url, balance } = await fetchCarfaxPdfUrl(vin, onStatus);

  await onStatus?.("Завантажую PDF Carfax...");
  const res = await fetch(url, {
    headers: {
      Accept: "application/pdf,*/*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new VinReportError(
      `Не вдалося скачати PDF (HTTP ${res.status})`,
      "download_failed"
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf.subarray(0, 4).toString() !== "%PDF") {
    throw new VinReportError(
      "Завантажений файл не схожий на PDF",
      "not_pdf"
    );
  }

  const pdfPath = path.join(getLotDir(vin), `carfax-${vin}.pdf`);
  await fs.writeFile(pdfPath, buf);
  return { pdfPath, balance };
}
