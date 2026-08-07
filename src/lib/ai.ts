import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const VIN_RETRY_MODEL = process.env.OPENAI_VIN_RETRY_MODEL || "gpt-4o";
const TRIAGE_MODEL = process.env.OPENAI_TRIAGE_MODEL || MODEL;
const TRIAGE_BATCH = 7;
const VIN_BATCH = 5;
const VIN_CANDIDATE_LIMIT = 6;
const DAMAGE_IMAGE_LIMIT = 16;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  return new OpenAI({ apiKey });
}

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

async function toDataUrl(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const mime = mimeForPath(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function imageContents(
  imagePaths: string[],
  detail: "low" | "high"
) {
  return Promise.all(
    imagePaths.map(async (p) => ({
      type: "image_url" as const,
      image_url: { url: await toDataUrl(p), detail },
    }))
  );
}

/** VIN: 17 chars, no I/O/Q */
export function normalizeVin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "");
  if (cleaned.length !== 17) return null;
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(cleaned)) return null;
  return cleaned;
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

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export type TriageRole = "vin_plate" | "damage" | "overview" | "other";

export type TriageItem = {
  index: number;
  path: string;
  roles: TriageRole[];
  vinReadable: boolean;
};

function filenameHintBoost(filePath: string): Partial<TriageItem> {
  const name = path.basename(filePath).toLowerCase();
  if (/vin|plate|label|jamb/.test(name)) {
    return { roles: ["vin_plate"], vinReadable: true };
  }
  if (/dmg|damage|front|rear|side|hood|door|bumper/.test(name)) {
    return { roles: ["damage"], vinReadable: false };
  }
  return {};
}

export async function triageImages(
  imagePaths: string[]
): Promise<TriageItem[]> {
  const client = getClient();
  const results: TriageItem[] = imagePaths.map((p, index) => ({
    index,
    path: p,
    roles: ["other"] as TriageRole[],
    vinReadable: false,
    ...filenameHintBoost(p),
  }));

  // Reset to other before AI; keep filename only as fallback if AI fails a batch
  for (const item of results) {
    const hint = filenameHintBoost(item.path);
    item.roles = (hint.roles as TriageRole[]) || ["other"];
    item.vinReadable = Boolean(hint.vinReadable);
  }

  const batches = chunkArray(
    imagePaths.map((p, index) => ({ path: p, index })),
    TRIAGE_BATCH
  );

  for (const batch of batches) {
    const images = await imageContents(
      batch.map((b) => b.path),
      "low"
    );

    try {
      const completion = await client.chat.completions.create({
        model: TRIAGE_MODEL,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You classify Copart auction photos. Images are numbered starting at 0 in this batch. " +
              "JSON only, no markdown: {\"items\":[{\"index\":0,\"roles\":[\"vin_plate\"|\"damage\"|\"overview\"|\"other\"],\"vinReadable\":boolean}]}. " +
              "vin_plate = VIN sticker/plate/door jamb close-up. damage = visible crash/body damage. " +
              "overview = full vehicle / yard shot. vinReadable=true only if VIN digits look readable.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Classify these ${batch.length} photos. index is 0..${batch.length - 1} within this batch.`,
              },
              ...images,
            ],
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = extractJsonObject(raw) as {
        items?: Array<{
          index?: number;
          roles?: string[];
          vinReadable?: boolean;
        }>;
      };

      for (const row of parsed.items ?? []) {
        const localIdx = Number(row.index);
        if (!Number.isInteger(localIdx) || localIdx < 0 || localIdx >= batch.length) {
          continue;
        }
        const global = batch[localIdx];
        const roles = (row.roles ?? [])
          .map((r) => String(r).toLowerCase())
          .filter((r): r is TriageRole =>
            r === "vin_plate" ||
            r === "damage" ||
            r === "overview" ||
            r === "other"
          );
        results[global.index] = {
          index: global.index,
          path: global.path,
          roles: roles.length ? roles : ["other"],
          vinReadable: Boolean(row.vinReadable),
        };
      }
    } catch (err) {
      console.warn("Triage batch failed, keeping filename hints:", err);
    }
  }

  return results;
}

export function selectVinCandidates(triage: TriageItem[]): string[] {
  const scored = triage.map((t) => {
    let score = 0;
    if (t.roles.includes("vin_plate")) score += 10;
    if (t.vinReadable) score += 8;
    if (t.roles.includes("overview")) score += 1;
    return { path: t.path, score, index: t.index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const preferred = scored.filter((s) => s.score >= 8).map((s) => s.path);
  if (preferred.length) return preferred.slice(0, VIN_CANDIDATE_LIMIT);
  // fallback: later gallery shots often include plate
  return [...triage]
    .sort((a, b) => b.index - a.index)
    .slice(0, VIN_CANDIDATE_LIMIT)
    .map((t) => t.path);
}

export function selectDamageCandidates(triage: TriageItem[]): string[] {
  const damage = triage.filter((t) => t.roles.includes("damage"));
  const overview = triage.filter((t) => t.roles.includes("overview"));
  const picked: string[] = [];
  for (const t of damage) {
    if (picked.length >= DAMAGE_IMAGE_LIMIT) break;
    picked.push(t.path);
  }
  for (const t of overview) {
    if (picked.length >= DAMAGE_IMAGE_LIMIT) break;
    if (!picked.includes(t.path)) picked.push(t.path);
  }
  if (picked.length >= 4) return picked;

  // fallback: spread across gallery
  const step = Math.max(1, Math.floor(triage.length / DAMAGE_IMAGE_LIMIT));
  for (let i = 0; i < triage.length && picked.length < DAMAGE_IMAGE_LIMIT; i += step) {
    if (!picked.includes(triage[i].path)) picked.push(triage[i].path);
  }
  return picked;
}

async function extractVinOnce(
  imagePaths: string[],
  model: string
): Promise<{ vin: string | null; reason: string; raw: string }> {
  if (!imagePaths.length) {
    return { vin: null, reason: "немає кандидатів з табличкою", raw: "" };
  }

  const client = getClient();
  const images = await imageContents(imagePaths, "high");

  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You read Copart auction photos and extract the vehicle VIN from a metal plate, door-jamb sticker, or windshield label. " +
          "Be strict: do not guess or invent characters. If blurry/partial/uncertain, return vin null. " +
          "JSON only: {\"vin\":\"XXXXXXXXXXXXXXXXX\"|null,\"reason\":\"short English or Ukrainian note\"}. " +
          "VIN must be exactly 17 characters (A-H,J-N,P-R,Z,0-9). No markdown.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Extract the VIN only if clearly readable on a plate/label.",
          },
          ...images,
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  try {
    const parsed = extractJsonObject(raw) as {
      vin?: string | null;
      reason?: string;
    };
    return {
      vin: normalizeVin(parsed.vin ?? null),
      reason: String(parsed.reason ?? "").trim() || "ok",
      raw,
    };
  } catch {
    return {
      vin: normalizeVin(raw),
      reason: "parse_fallback",
      raw,
    };
  }
}

export async function extractVinFromImages(
  imagePaths: string[]
): Promise<{ vin: string | null; reason: string; raw: string; modelUsed: string }> {
  const batches = chunkArray(imagePaths, VIN_BATCH);

  for (const batch of batches) {
    const first = await extractVinOnce(batch, MODEL);
    if (first.vin) {
      return { ...first, modelUsed: MODEL };
    }
  }

  // Retry once on gpt-4o with best candidates (first batch / all if small)
  if (VIN_RETRY_MODEL !== MODEL && imagePaths.length) {
    const retryPaths = imagePaths.slice(0, VIN_CANDIDATE_LIMIT);
    const retry = await extractVinOnce(retryPaths, VIN_RETRY_MODEL);
    if (retry.vin) {
      return { ...retry, modelUsed: VIN_RETRY_MODEL };
    }
    return { ...retry, modelUsed: VIN_RETRY_MODEL };
  }

  return {
    vin: null,
    reason: "табличку не класифіковано або текст нечитабельний",
    raw: "",
    modelUsed: MODEL,
  };
}

export type RepairStrategy = "restore" | "replace_used_color" | "replace_new";

export type DefectLine = {
  work: string;
  kind: "part" | "labor" | "both";
  strategy: RepairStrategy;
  estimateUahMin: number | null;
  estimateUahMax: number | null;
  estimateUsdMin: number | null;
  estimateUsdMax: number | null;
  notes: string;
};

export type HiddenWorkRisk = {
  area: string;
  probabilityPercent: number;
  why: string;
  possibleExtraUahMin: number | null;
  possibleExtraUahMax: number | null;
  possibleExtraUsdMin: number | null;
  possibleExtraUsdMax: number | null;
};

export type DamageAnalysisResult = {
  summary: string;
  /** Totals in UAH */
  repairEstimateMin: number | null;
  repairEstimateMax: number | null;
  repairEstimateMinUsd: number | null;
  repairEstimateMaxUsd: number | null;
  /** @deprecated use hiddenWorkRisks */
  risks: string[];
  hiddenWorkRisks: HiddenWorkRisk[];
  defectList: DefectLine[];
  damageZones: Array<{ zone: string; severity: string; notes: string }>;
  observedDamages: ObservedDamage[];
  photosAnalyzed: number;
  confidence: "low" | "medium" | "high";
  limitations: string[];
  fxUahPerUsd: number;
  currency: "UAH+USD";
  rawAiResponse: unknown;
};

function getFxUahPerUsd(): number {
  const n = Number(process.env.UAH_PER_USD || "41");
  return Number.isFinite(n) && n > 0 ? n : 41;
}

function roundMoney(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
}

function dualCurrency(
  uahMin: number | null,
  uahMax: number | null,
  usdMin: number | null,
  usdMax: number | null,
  fx: number
): {
  uahMin: number | null;
  uahMax: number | null;
  usdMin: number | null;
  usdMax: number | null;
} {
  let uMin = uahMin;
  let uMax = uahMax;
  let dMin = usdMin;
  let dMax = usdMax;
  if (uMin == null && dMin != null) uMin = Math.round(dMin * fx);
  if (uMax == null && dMax != null) uMax = Math.round(dMax * fx);
  if (dMin == null && uMin != null) dMin = Math.round(uMin / fx);
  if (dMax == null && uMax != null) dMax = Math.round(uMax / fx);
  return { uahMin: uMin, uahMax: uMax, usdMin: dMin, usdMax: dMax };
}

function parseStrategy(raw: unknown): RepairStrategy {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("restore") || s.includes("repair") || s.includes("віднов")) {
    return "restore";
  }
  if (s.includes("used") || s.includes("color") || s.includes("б/у") || s.includes("колір")) {
    return "replace_used_color";
  }
  if (s.includes("new") || s.includes("нов")) return "replace_new";
  return "replace_used_color";
}

export function parseDefectList(
  raw: unknown,
  fx = getFxUahPerUsd()
): DefectLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const r = row as Record<string, unknown>;
      const kindRaw = String(r.kind ?? r.partOrLabor ?? "both").toLowerCase();
      const kind: DefectLine["kind"] =
        kindRaw === "part" || kindRaw === "labor" ? kindRaw : "both";
      const money = dualCurrency(
        roundMoney(r.estimateUahMin ?? r.minUah),
        roundMoney(r.estimateUahMax ?? r.maxUah),
        roundMoney(r.estimateUsdMin ?? r.minUsd),
        roundMoney(r.estimateUsdMax ?? r.maxUsd),
        fx
      );
      // legacy single-currency fields stored as estimateUsd*
      if (
        money.uahMin == null &&
        money.usdMin == null &&
        (r.estimateUsdMin != null || r.estimateUahMin != null)
      ) {
        // already handled above
      }
      return {
        work: String(r.work ?? r.action ?? "робота").trim(),
        kind,
        strategy: parseStrategy(r.strategy ?? r.approach),
        estimateUahMin: money.uahMin,
        estimateUahMax: money.uahMax,
        estimateUsdMin: money.usdMin,
        estimateUsdMax: money.usdMax,
        notes: String(r.notes ?? "").trim(),
      };
    })
    .filter((d) => d.work);
}

export function parseHiddenWorkRisks(
  raw: unknown,
  fx = getFxUahPerUsd()
): HiddenWorkRisk[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const r = row as Record<string, unknown>;
      let pct = Number(r.probabilityPercent ?? r.probability ?? 0);
      if (!Number.isFinite(pct)) pct = 0;
      pct = Math.max(0, Math.min(100, Math.round(pct)));
      const money = dualCurrency(
        roundMoney(r.possibleExtraUahMin ?? r.extraUahMin),
        roundMoney(r.possibleExtraUahMax ?? r.extraUahMax),
        roundMoney(r.possibleExtraUsdMin ?? r.extraUsdMin),
        roundMoney(r.possibleExtraUsdMax ?? r.extraUsdMax),
        fx
      );
      return {
        area: String(r.area ?? r.risk ?? "приховані роботи").trim(),
        probabilityPercent: pct,
        why: String(r.why ?? r.reason ?? "").trim(),
        possibleExtraUahMin: money.uahMin,
        possibleExtraUahMax: money.uahMax,
        possibleExtraUsdMin: money.usdMin,
        possibleExtraUsdMax: money.usdMax,
      };
    })
    .filter((d) => d.area);
}

function formatMoneyRange(
  uahMin: number | null | undefined,
  uahMax: number | null | undefined,
  usdMin: number | null | undefined,
  usdMax: number | null | undefined
): string {
  const hasUah = uahMin != null || uahMax != null;
  const hasUsd = usdMin != null || usdMax != null;
  if (!hasUah && !hasUsd) return "ціна н/д";

  const parts: string[] = [];
  if (hasUsd) {
    const a = usdMin != null ? `$${usdMin.toLocaleString("en-US")}` : "$?";
    const b = usdMax != null ? `$${usdMax.toLocaleString("en-US")}` : "$?";
    parts.push(`${a} – ${b}`);
  }
  if (hasUah) {
    const a = uahMin != null ? uahMin.toLocaleString("uk-UA") : "?";
    const b = uahMax != null ? uahMax.toLocaleString("uk-UA") : "?";
    parts.push(`${a} – ${b} грн`);
  }
  return parts.join(" / ");
}

function strategyLabel(s: RepairStrategy): string {
  switch (s) {
    case "restore":
      return "відновлення";
    case "replace_new":
      return "нова запч.";
    default:
      return "б/у в колір";
  }
}

export type ObservedDamage = {
  area: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  confidence: "low" | "medium" | "high";
  evidence: string;
};

export type DamageInventoryResult = {
  photosAnalyzed: number;
  items: ObservedDamage[];
  missedPossible: string[];
  raw: unknown;
};

export function formatDamageInventory(
  inventory: DamageInventoryResult
): string {
  const lines: string[] = [];
  lines.push(
    `Інвентар пошкоджень (ШІ переглянув ${inventory.photosAnalyzed} фото перед кошторисом):`
  );
  if (!inventory.items.length) {
    lines.push("• Явних пошкоджень на відібраних фото не зафіксовано (або кадри неінформативні).");
  } else {
    for (const [i, item] of inventory.items.slice(0, 20).entries()) {
      lines.push(
        `${i + 1}. ${item.area}: ${item.description} ` +
          `[тяжкість: ${item.severity}, впевненість: ${item.confidence}]` +
          (item.evidence ? ` — ${item.evidence}` : "")
      );
    }
  }
  if (inventory.missedPossible.length) {
    lines.push("");
    lines.push("Можливо не видно / сумнівно (не включаю як факт):");
    for (const m of inventory.missedPossible.slice(0, 8)) {
      lines.push(`• ${m}`);
    }
  }
  lines.push("");
  lines.push(
    "Перевір список: інколи ШІ може щось вигадати або пропустити. Далі рахую кошторис тільки по зафіксованому."
  );
  return lines.join("\n");
}

export async function inventoryDamagesFromImages(
  imagePaths: string[],
  context?: { lotId?: string; vin?: string | null }
): Promise<DamageInventoryResult> {
  const client = getClient();
  const images = await imageContents(imagePaths, "high");

  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Ти інспектор кузова. За фото Copart склади ТІЛЬКИ список видимих пошкоджень. Без цін. JSON only.\n" +
          "Schema: {\n" +
          '  "items": [{"area":"зона","description":"що саме видно","severity":"low|medium|high|critical","confidence":"low|medium|high","evidence":"на якому типі кадру видно"}],\n' +
          '  "missedPossible": ["що могло б бути, але на цих фото НЕ підтверджено"]\n' +
          "}\n" +
          "Правила: НЕ вигадуй. Якщо невпевнено — confidence low або в missedPossible. " +
          "Не дублюй одне й те саме. Українською.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Лот: ${context?.lotId ?? "?"}. VIN: ${context?.vin ?? "?"}. ` +
              `Кількість фото в цьому запиті: ${imagePaths.length}. ` +
              "Перелічи всі помічені пошкодження.",
          },
          ...images,
        ],
      },
    ],
  });

  const rawText = completion.choices[0]?.message?.content ?? "{}";
  const parsed = extractJsonObject(rawText) as {
    items?: Array<{
      area?: string;
      description?: string;
      severity?: string;
      confidence?: string;
      evidence?: string;
    }>;
    missedPossible?: string[];
  };

  const normSev = (s: string): ObservedDamage["severity"] => {
    const v = s.toLowerCase();
    if (v === "critical" || v === "high" || v === "medium") return v;
    return "low";
  };
  const normConf = (s: string): ObservedDamage["confidence"] => {
    const v = s.toLowerCase();
    if (v === "high" || v === "medium") return v;
    return "low";
  };

  const items: ObservedDamage[] = Array.isArray(parsed.items)
    ? parsed.items
        .map((it) => ({
          area: String(it.area ?? "зона").trim(),
          description: String(it.description ?? "").trim(),
          severity: normSev(String(it.severity ?? "medium")),
          confidence: normConf(String(it.confidence ?? "medium")),
          evidence: String(it.evidence ?? "").trim(),
        }))
        .filter((it) => it.description)
    : [];

  return {
    photosAnalyzed: imagePaths.length,
    items,
    missedPossible: Array.isArray(parsed.missedPossible)
      ? parsed.missedPossible.map(String).filter(Boolean)
      : [],
    raw: parsed,
  };
}

export async function analyzeDamageFromImages(
  imagePaths: string[],
  context?: {
    lotId?: string;
    vin?: string | null;
    inventory?: DamageInventoryResult;
  }
): Promise<DamageAnalysisResult> {
  const client = getClient();
  const images = await imageContents(imagePaths, "high");
  const fx = getFxUahPerUsd();

  const inventoryBlock =
    context?.inventory && context.inventory.items.length
      ? "ЗАФІКСОВАНИЙ ІНВЕНТАР ПОШКОДЖЕНЬ (рахуй дефектовку переважно по ньому, не вигадуй нові зони без потреби):\n" +
        context.inventory.items
          .map(
            (it, i) =>
              `${i + 1}. ${it.area}: ${it.description} (${it.severity}, conf=${it.confidence})`
          )
          .join("\n")
      : "Інвентар не передано — спирайся лише на видиме на фото.";

  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.15,
    messages: [
      {
        role: "system",
        content:
          "Ти експерт кузовного ремонту для імпорту зі США в Україну. " +
          "Спочатку врахуй переданий інвентар пошкоджень, потім склади дефектовку з цінами в USD і UAH. JSON only, no markdown.\n" +
          "Schema:\n" +
          "{\n" +
          '  "summary": "короткий підсумок українською",\n' +
          '  "repairEstimateMinUsd": number|null,\n' +
          '  "repairEstimateMaxUsd": number|null,\n' +
          '  "repairEstimateMinUah": number|null,\n' +
          '  "repairEstimateMaxUah": number|null,\n' +
          '  "defectList": [{"work":"що зробити","kind":"part|labor|both","strategy":"restore|replace_used_color|replace_new","estimateUsdMin":number|null,"estimateUsdMax":number|null,"estimateUahMin":number|null,"estimateUahMax":number|null,"notes":"string"}],\n' +
          '  "hiddenWorkRisks": [{"area":"зона","probabilityPercent":0-100,"why":"string","possibleExtraUsdMin":number|null,"possibleExtraUsdMax":number|null,"possibleExtraUahMin":number|null,"possibleExtraUahMax":number|null}],\n' +
          '  "damageZones": [{"zone":"string","severity":"low|medium|high|critical","notes":"string"}],\n' +
          '  "confidence": "low|medium|high",\n' +
          '  "limitations": ["string"]\n' +
          "}\n" +
          "ПРАВИЛА РІШЕННЯ (strategy):\n" +
          "1) restore — якщо деталь реально відновити і це ВИГІДНІШЕ за заміну.\n" +
          "2) replace_used_color — під заміну: є місяці до прибуття авто, рахуй Б/У У КОЛЬОРІ + установку.\n" +
          "3) replace_new — лише якщо б/у майже нереальний або критична безпека.\n" +
          "Не роздувай кошторис пошкодженнями, яких немає в інвентарі, якщо їх не видно явно на фото. " +
          `Курс ~${fx} грн/$. Суми defectList ≈ totals. Ризики = % прихованих додаткових робіт.`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Лот: ${context?.lotId ?? "невідомо"}. VIN: ${context?.vin ?? "невідомо"}. ` +
              `ШІ проаналізував ${imagePaths.length} фото для оцінки. Курс: ${fx} грн/$.\n\n` +
              `${inventoryBlock}\n\n` +
              "Тепер фінансова дефектовка ($ і грн).",
          },
          ...images,
        ],
      },
    ],
  });

  const rawText = completion.choices[0]?.message?.content ?? "{}";
  const parsed = extractJsonObject(rawText) as {
    summary?: string;
    repairEstimateMinUah?: number | null;
    repairEstimateMaxUah?: number | null;
    repairEstimateMinUsd?: number | null;
    repairEstimateMaxUsd?: number | null;
    defectList?: unknown;
    hiddenWorkRisks?: unknown;
    risks?: unknown;
    damageZones?: Array<{ zone?: string; severity?: string; notes?: string }>;
    confidence?: string;
    limitations?: string[];
  };

  const confidenceRaw = String(parsed.confidence ?? "low").toLowerCase();
  const confidence: DamageAnalysisResult["confidence"] =
    confidenceRaw === "high" || confidenceRaw === "medium"
      ? confidenceRaw
      : "low";

  const defectList = parseDefectList(parsed.defectList, fx);
  let hiddenWorkRisks = parseHiddenWorkRisks(parsed.hiddenWorkRisks, fx);
  if (!hiddenWorkRisks.length && Array.isArray(parsed.risks)) {
    hiddenWorkRisks = parsed.risks.map((r) => ({
      area: String(r),
      probabilityPercent: 50,
      why: "",
      possibleExtraUahMin: null,
      possibleExtraUahMax: null,
      possibleExtraUsdMin: null,
      possibleExtraUsdMax: null,
    }));
  }

  const totals = dualCurrency(
    roundMoney(parsed.repairEstimateMinUah),
    roundMoney(parsed.repairEstimateMaxUah),
    roundMoney(parsed.repairEstimateMinUsd),
    roundMoney(parsed.repairEstimateMaxUsd),
    fx
  );

  return {
    summary: parsed.summary?.trim() || "Аналіз пошкоджень недоступний.",
    repairEstimateMin: totals.uahMin,
    repairEstimateMax: totals.uahMax,
    repairEstimateMinUsd: totals.usdMin,
    repairEstimateMaxUsd: totals.usdMax,
    risks: hiddenWorkRisks.map(
      (r) => `${r.area}: ~${r.probabilityPercent}% прихованих робіт`
    ),
    hiddenWorkRisks,
    defectList,
    damageZones: Array.isArray(parsed.damageZones)
      ? parsed.damageZones.map((z) => ({
          zone: String(z.zone ?? "unknown"),
          severity: String(z.severity ?? "unknown"),
          notes: String(z.notes ?? ""),
        }))
      : [],
    observedDamages: context?.inventory?.items ?? [],
    photosAnalyzed: imagePaths.length,
    confidence,
    limitations: Array.isArray(parsed.limitations)
      ? parsed.limitations.map(String).filter(Boolean)
      : [],
    fxUahPerUsd: fx,
    currency: "UAH+USD",
    rawAiResponse: {
      ...parsed,
      observedDamages: context?.inventory?.items ?? [],
      photosAnalyzed: imagePaths.length,
      inventoryRaw: context?.inventory?.raw,
    },
  };
}

export function formatDamageReport(
  analysis: DamageAnalysisResult,
  vin: string | null,
  meta?: {
    totalPhotos?: number;
    vinCandidates?: number;
    damagePhotos?: number;
    vinReason?: string;
  }
): string {
  const lines: string[] = [];
  lines.push("Аналіз лота");
  if (vin) {
    lines.push(`VIN: ${vin}`);
  } else {
    lines.push(
      `VIN: не прочитано` +
        (meta?.vinReason ? ` (${meta.vinReason})` : "") +
        ". Перевірте табличку вручну в галереї лота."
    );
  }

  if (meta?.totalPhotos != null) {
    lines.push(
      `Фото: ${meta.totalPhotos} у ZIP` +
        (meta.vinCandidates != null ? `, VIN-кандидати: ${meta.vinCandidates}` : "") +
        (meta.damagePhotos != null ? `, на damage: ${meta.damagePhotos}` : "")
    );
  }

  lines.push(`Впевненість оцінки: ${analysis.confidence}`);
  lines.push(
    `ШІ проаналізував ${analysis.photosAnalyzed} фото для оцінки пошкоджень.`
  );
  lines.push(
    `Ринок: Україна (СТО). Курс орієнтир ~${analysis.fxUahPerUsd} грн/$. Логіка: відновлення якщо вигідно, інакше б/у в колір (є місяці до прибуття авто).`
  );

  if (analysis.observedDamages.length) {
    lines.push("");
    lines.push("Зафіксовані пошкодження (до кошторису):");
    for (const [i, item] of analysis.observedDamages.slice(0, 16).entries()) {
      lines.push(
        `${i + 1}. ${item.area}: ${item.description} [${item.severity}/${item.confidence}]`
      );
    }
  }

  if (
    analysis.repairEstimateMin != null ||
    analysis.repairEstimateMax != null ||
    analysis.repairEstimateMinUsd != null ||
    analysis.repairEstimateMaxUsd != null
  ) {
    lines.push(
      `Орієнтовний ремонт (видиме): ${formatMoneyRange(
        analysis.repairEstimateMin,
        analysis.repairEstimateMax,
        analysis.repairEstimateMinUsd,
        analysis.repairEstimateMaxUsd
      )}`
    );
  }

  lines.push("");
  lines.push(analysis.summary);

  if (analysis.defectList.length) {
    lines.push("");
    lines.push("Дефектовка (що робити + ціни $ / грн):");
    for (const d of analysis.defectList.slice(0, 16)) {
      const kind =
        d.kind === "part"
          ? "запчастина"
          : d.kind === "labor"
            ? "робота"
            : "запч.+робота";
      lines.push(
        `• ${d.work} [${kind}, ${strategyLabel(d.strategy)}]: ${formatMoneyRange(
          d.estimateUahMin,
          d.estimateUahMax,
          d.estimateUsdMin,
          d.estimateUsdMax
        )}${d.notes ? ` — ${d.notes}` : ""}`
      );
    }
  }

  if (analysis.damageZones.length) {
    lines.push("");
    lines.push("Зони пошкоджень:");
    for (const z of analysis.damageZones.slice(0, 10)) {
      lines.push(`• ${z.zone} (${z.severity})${z.notes ? `: ${z.notes}` : ""}`);
    }
  }

  if (analysis.hiddenWorkRisks.length) {
    lines.push("");
    lines.push("Ризики прихованих робіт (імовірність %):");
    for (const r of analysis.hiddenWorkRisks.slice(0, 12)) {
      const extra =
        r.possibleExtraUsdMin != null ||
        r.possibleExtraUahMin != null ||
        r.possibleExtraUsdMax != null ||
        r.possibleExtraUahMax != null
          ? ` | можливий плюс ${formatMoneyRange(
              r.possibleExtraUahMin,
              r.possibleExtraUahMax,
              r.possibleExtraUsdMin,
              r.possibleExtraUsdMax
            )}`
          : "";
      lines.push(
        `• ${r.area}: ${r.probabilityPercent}%${r.why ? ` — ${r.why}` : ""}${extra}`
      );
    }
  } else if (analysis.risks.length) {
    lines.push("");
    lines.push("Ризики прихованих робіт:");
    for (const r of analysis.risks.slice(0, 10)) {
      lines.push(`• ${r}`);
    }
  }

  if (analysis.limitations.length) {
    lines.push("");
    lines.push("Обмеження (не видно на фото):");
    for (const l of analysis.limitations.slice(0, 8)) {
      lines.push(`• ${l}`);
    }
  }

  lines.push("");
  lines.push(
    "Оцінка приблизна: $ і грн для українського СТО; б/у в колір з урахуванням часу доставки авто."
  );
  lines.push("Повторний повний аналіз: додайте слово force до повідомлення з посиланням.");
  return lines.join("\n");
}
