import fs from "fs/promises";
import path from "path";
import { PDFParse } from "pdf-parse";
import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const SEP = "────────────";

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey });
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("AI response is not valid JSON");
  }
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String).map((s) => s.trim()).filter(Boolean);
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

type CarfaxStructured = {
  verdict: string;
  owners: string[];
  accidents: string[];
  titleBrands: string[];
  odometer: string[];
  service: string[];
  lastMileage: string;
  redFlags: string[];
  salvageFit: string;
  summary: string;
};

function formatCarfaxReport(vin: string, data: CarfaxStructured): string {
  const lines: string[] = [];
  lines.push("📄 ЗВІТ CARFAX");
  lines.push(SEP);
  lines.push(`VIN: ${vin}`);
  if (data.verdict) {
    lines.push(`Вердикт: ${data.verdict}`);
  }
  if (data.lastMileage) {
    lines.push(`Останній пробіг у звіті: ${data.lastMileage}`);
  }

  if (data.summary) {
    lines.push("");
    lines.push("📝 Коротко");
    lines.push(SEP);
    lines.push(data.summary);
  }

  const sections: Array<[string, string[]]> = [
    ["👤 Власники / історія", data.owners],
    ["💥 Аварії / damage", data.accidents],
    ["🏷️ Title brands", data.titleBrands],
    ["📏 Odometer", data.odometer],
    ["🛠️ Сервіс / записи", data.service],
    ["🚩 Червоні прапорці", data.redFlags],
  ];

  for (const [title, items] of sections) {
    if (!items.length) continue;
    lines.push("");
    lines.push(title);
    lines.push(SEP);
    for (const item of items.slice(0, 12)) {
      lines.push(`• ${item}`);
    }
  }

  if (data.salvageFit) {
    lines.push("");
    lines.push("🔗 Узгодження з salvage-аукціоном");
    lines.push(SEP);
    lines.push(data.salvageFit);
  }

  lines.push("");
  lines.push(SEP);
  lines.push("Орієнтир для покупця з Copart/IAAI → Україна. Перевіряйте оригінал PDF.");
  return lines.join("\n");
}

type StickerStructured = {
  vehicle: string;
  exterior: string;
  interior: string;
  engine: string;
  drivetrain: string;
  packages: string[];
  options: string[];
  msrp: string;
  summary: string;
};

function formatWindowStickerReport(
  vin: string,
  data: StickerStructured
): string {
  const lines: string[] = [];
  lines.push("🏷️ WINDOW STICKER (Monroney)");
  lines.push(SEP);
  lines.push(`VIN: ${vin}`);
  if (data.vehicle) lines.push(`Авто: ${data.vehicle}`);
  if (data.msrp) lines.push(`MSRP: ${data.msrp}`);

  if (data.summary) {
    lines.push("");
    lines.push("📝 Коротко");
    lines.push(SEP);
    lines.push(data.summary);
  }

  const facts: Array<[string, string]> = [
    ["🎨 Колір кузова", data.exterior],
    ["💺 Інтер'єр", data.interior],
    ["⚙️ Двигун", data.engine],
    ["🔩 Привід / КПП", data.drivetrain],
  ];
  const factLines = facts.filter(([, v]) => Boolean(v.trim()));
  if (factLines.length) {
    lines.push("");
    lines.push("📦 Базова комплектація");
    lines.push(SEP);
    for (const [k, v] of factLines) {
      lines.push(`• ${k}: ${v}`);
    }
  }

  if (data.packages.length) {
    lines.push("");
    lines.push("📦 Пакети");
    lines.push(SEP);
    for (const p of data.packages.slice(0, 15)) lines.push(`• ${p}`);
  }

  if (data.options.length) {
    lines.push("");
    lines.push("✨ Опції");
    lines.push(SEP);
    for (const o of data.options.slice(0, 20)) lines.push(`• ${o}`);
  }

  lines.push("");
  lines.push(SEP);
  lines.push("OEM sticker / reproduction. Звіряйте з реальним авто.");
  return lines.join("\n");
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
          "Ти аналітик Carfax для покупця авто зі США в Україну. JSON only, no markdown.\n" +
          "Schema:\n" +
          "{\n" +
          '  "verdict": "1 рядок: ок / обережно / ризик",\n' +
          '  "summary": "2-4 речення українською",\n' +
          '  "lastMileage": "останній пробіг або порожньо",\n' +
          '  "owners": ["факти про власників/штати"],\n' +
          '  "accidents": ["аварії/damage records"],\n' +
          '  "titleBrands": ["salvage/rebuilt/flood/lemon/..."],\n' +
          '  "odometer": ["проблеми з пробігом або норма"],\n' +
          '  "service": ["ключові сервісні записи"],\n' +
          '  "redFlags": ["червоні прапорці"],\n' +
          '  "salvageFit": "чи узгоджується з salvage-аукціоном"\n' +
          "}\n" +
          "Українською. Без води. Якщо даних немає — порожній масив, не вигадуй.",
      },
      {
        role: "user",
        content: `VIN: ${vin}\n\nТекст Carfax (уривок):\n${pdfText || "(порожньо)"}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "";
  try {
    const parsed = extractJsonObject(raw) as Record<string, unknown>;
    return formatCarfaxReport(vin, {
      verdict: String(parsed.verdict ?? "").trim(),
      summary: String(parsed.summary ?? "").trim(),
      lastMileage: String(parsed.lastMileage ?? "").trim(),
      owners: asStringList(parsed.owners),
      accidents: asStringList(parsed.accidents),
      titleBrands: asStringList(parsed.titleBrands),
      odometer: asStringList(parsed.odometer),
      service: asStringList(parsed.service),
      redFlags: asStringList(parsed.redFlags),
      salvageFit: String(parsed.salvageFit ?? "").trim(),
    });
  } catch {
    return (
      `📄 ЗВІТ CARFAX\n${SEP}\nVIN: ${vin}\n\n` +
      (raw || "Не вдалося проаналізувати Carfax.")
    );
  }
}

async function analyzeStickerContent(
  vin: string,
  userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] | string
): Promise<string> {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "Ти розбираєш OEM Window Sticker (Monroney). JSON only, no markdown.\n" +
          "Schema:\n" +
          "{\n" +
          '  "vehicle": "рік марка модель trim",\n' +
          '  "exterior": "колір + paint code якщо є",\n' +
          '  "interior": "салон",\n' +
          '  "engine": "двигун",\n' +
          '  "drivetrain": "привід/КПП",\n' +
          '  "packages": ["пакети"],\n' +
          '  "options": ["важливі опції"],\n' +
          '  "msrp": "MSRP або порожньо",\n' +
          '  "summary": "2-3 речення українською"\n' +
          "}\n" +
          "Українською. Не вигадуй опції, яких немає на стікері.",
      },
      {
        role: "user",
        content: userContent,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "";
  try {
    const parsed = extractJsonObject(raw) as Record<string, unknown>;
    return formatWindowStickerReport(vin, {
      vehicle: String(parsed.vehicle ?? "").trim(),
      exterior: String(parsed.exterior ?? "").trim(),
      interior: String(parsed.interior ?? "").trim(),
      engine: String(parsed.engine ?? "").trim(),
      drivetrain: String(parsed.drivetrain ?? "").trim(),
      packages: asStringList(parsed.packages),
      options: asStringList(parsed.options),
      msrp: String(parsed.msrp ?? "").trim(),
      summary: String(parsed.summary ?? "").trim(),
    });
  } catch {
    return (
      `🏷️ WINDOW STICKER\n${SEP}\nVIN: ${vin}\n\n` +
      (raw || "Не вдалося розібрати window sticker.")
    );
  }
}

export async function analyzeWindowStickerFile(
  vin: string,
  filePath: string
): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    const text = await extractPdfText(filePath, 12000);
    return analyzeStickerContent(
      vin,
      `VIN: ${vin}\n\nТекст sticker PDF:\n${text || "(мало тексту — можливо скан)"}`
    );
  }

  if (ext === ".html" || ext === ".htm" || ext === ".txt") {
    const raw = await fs.readFile(filePath, "utf8");
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 16000);
    return analyzeStickerContent(
      vin,
      `VIN: ${vin}\n\nТекст Window Sticker (з Carfax link):\n${text || "(порожньо)"}`
    );
  }

  const buf = await fs.readFile(filePath);
  const mime =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

  return analyzeStickerContent(vin, [
    { type: "text", text: `VIN: ${vin}. Проаналізуй window sticker на зображенні.` },
    {
      type: "image_url",
      image_url: { url: dataUrl, detail: "high" },
    },
  ]);
}
