import fs from "fs/promises";
import path from "path";
import { PDFParse } from "pdf-parse";
import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey });
}

export async function extractPdfText(
  pdfPath: string,
  maxChars = 28000
): Promise<string> {
  const buf = await fs.readFile(pdfPath);
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    const text = (result.text || "").replace(/\s+\n/g, "\n").trim();
    return text.slice(0, maxChars);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

export async function analyzeCarfaxText(
  vin: string,
  pdfText: string
): Promise<string> {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "Ти аналітик Carfax для покупця авто зі США в Україну. " +
          "Дай стислий звіт українською: історія власників/штати, аварії/damage, odometer issues, " +
          "title brands (salvage/rebuilt/flood/lemon), service records, last reported mileage, " +
          "червоні прапорці, чи узгоджується з salvage-аукціоном. Без води, списками.",
      },
      {
        role: "user",
        content: `VIN: ${vin}\n\nТекст Carfax (уривок):\n${pdfText || "(порожньо)"}`,
      },
    ],
  });
  return (
    completion.choices[0]?.message?.content?.trim() ||
    "Не вдалося проаналізувати Carfax."
  );
}

export async function analyzeWindowStickerFile(
  vin: string,
  filePath: string
): Promise<string> {
  const client = getClient();
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    const text = await extractPdfText(filePath, 12000);
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Ти розбираєш OEM Window Sticker (Monroney). Українською, коротко: " +
            "комплектація/пакети, колір (paint code), інтер'єр, двигун/привід, MSRP якщо є, важливі опції.",
        },
        {
          role: "user",
          content: `VIN: ${vin}\n\nТекст sticker PDF:\n${text || "(мало тексту — можливо скан)"}`,
        },
      ],
    });
    return (
      completion.choices[0]?.message?.content?.trim() ||
      "Не вдалося розібрати window sticker PDF."
    );
  }

  const buf = await fs.readFile(filePath);
  const mime =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "Ти розбираєш OEM Window Sticker з фото. Українською: комплектація, колір/код фарби, " +
          "опції, MSRP якщо видно.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: `VIN: ${vin}. Проаналізуй window sticker.` },
          {
            type: "image_url",
            image_url: { url: dataUrl, detail: "high" },
          },
        ],
      },
    ],
  });

  return (
    completion.choices[0]?.message?.content?.trim() ||
    "Не вдалося розібрати window sticker."
  );
}
