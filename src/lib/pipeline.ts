import { ImageRole, LotStatus, Prisma } from "@prisma/client";
import {
  analyzeDamageFromImages,
  extractVinFromImages,
  formatDamageInventory,
  formatDamageReport,
  inventoryDamagesFromImages,
  parseDefectList,
  parseHiddenWorkRisks,
  selectDamageCandidates,
  selectVinCandidates,
  triageImages,
  type DamageAnalysisResult,
  type ObservedDamage,
  type TriageItem,
} from "./ai";
import {
  CopartDownloadError,
  downloadLotImagesZip,
  parseLotUrl,
  type ParsedLotUrl,
} from "./copart";
import { prisma } from "./prisma";

const processingLots = new Set<string>();

export type PipelineProgress = {
  stage:
    | "start"
    | "download"
    | "triage"
    | "vin"
    | "inventory"
    | "damage"
    | "done"
    | "cached"
    | "error";
  message: string;
  vin?: string | null;
  report?: string;
};

export type PipelineResult = {
  lotId: string;
  vin: string | null;
  report: string;
  analysis: DamageAnalysisResult | null;
  fromCache: boolean;
};

function hasForceFlag(text: string): boolean {
  return /\bforce\b/i.test(text);
}

function triageToImageRole(item: TriageItem): ImageRole {
  if (item.roles.includes("vin_plate") || item.vinReadable) {
    return ImageRole.VIN_PLATE;
  }
  if (item.roles.includes("damage")) {
    return ImageRole.DAMAGE;
  }
  return ImageRole.OTHER;
}

async function upsertUser(telegramId: string, username?: string) {
  return prisma.user.upsert({
    where: { telegramId },
    create: { telegramId, username: username ?? null },
    update: { username: username ?? null },
  });
}

async function saveImagesWithRoles(
  dbLotId: string,
  triage: TriageItem[]
): Promise<void> {
  await prisma.lotImage.deleteMany({ where: { lotId: dbLotId } });
  if (!triage.length) return;
  await prisma.lotImage.createMany({
    data: triage.map((t) => ({
      lotId: dbLotId,
      path: t.path,
      role: triageToImageRole(t),
    })),
  });
}

function analysisFromCache(analysis: {
  summary: string;
  repairEstimateMin: number | null;
  repairEstimateMax: number | null;
  risks: Prisma.JsonValue;
  damageZones: Prisma.JsonValue | null;
  rawAiResponse: Prisma.JsonValue;
}): DamageAnalysisResult {
  const raw =
    analysis.rawAiResponse &&
    typeof analysis.rawAiResponse === "object" &&
    !Array.isArray(analysis.rawAiResponse)
      ? (analysis.rawAiResponse as Record<string, unknown>)
      : {};

  const confidenceRaw = String(raw.confidence ?? "low").toLowerCase();
  const confidence: DamageAnalysisResult["confidence"] =
    confidenceRaw === "high" || confidenceRaw === "medium"
      ? confidenceRaw
      : "low";

  const limitations = Array.isArray(raw.limitations)
    ? raw.limitations.map(String)
    : [];

  let damageZones: DamageAnalysisResult["damageZones"] = [];
  let defectFromColumn: unknown = raw.defectList;

  if (Array.isArray(analysis.damageZones)) {
    damageZones = (
      analysis.damageZones as Array<{
        zone?: string;
        severity?: string;
        notes?: string;
      }>
    ).map((z) => ({
      zone: String(z.zone ?? "unknown"),
      severity: String(z.severity ?? "unknown"),
      notes: String(z.notes ?? ""),
    }));
  } else if (
    analysis.damageZones &&
    typeof analysis.damageZones === "object"
  ) {
    const packed = analysis.damageZones as {
      zones?: unknown;
      defectList?: unknown;
    };
    if (Array.isArray(packed.zones)) {
      damageZones = (
        packed.zones as Array<{
          zone?: string;
          severity?: string;
          notes?: string;
        }>
      ).map((z) => ({
        zone: String(z.zone ?? "unknown"),
        severity: String(z.severity ?? "unknown"),
        notes: String(z.notes ?? ""),
      }));
    }
    if (packed.defectList != null) defectFromColumn = packed.defectList;
  }

  const mapped = mapStoredAnalysisFields({
    defectList: defectFromColumn ?? raw.defectList,
    hiddenWorkRisks: raw.hiddenWorkRisks ?? analysis.risks,
    risks: analysis.risks,
  });

  const fxRaw = Number(raw.fxUahPerUsd ?? process.env.UAH_PER_USD ?? 41);
  const fx = Number.isFinite(fxRaw) && fxRaw > 0 ? fxRaw : 41;

  let minUsd =
    typeof raw.repairEstimateMinUsd === "number"
      ? Math.round(raw.repairEstimateMinUsd)
      : null;
  let maxUsd =
    typeof raw.repairEstimateMaxUsd === "number"
      ? Math.round(raw.repairEstimateMaxUsd)
      : null;
  if (minUsd == null && analysis.repairEstimateMin != null) {
    minUsd = Math.round(analysis.repairEstimateMin / fx);
  }
  if (maxUsd == null && analysis.repairEstimateMax != null) {
    maxUsd = Math.round(analysis.repairEstimateMax / fx);
  }

  return {
    summary: analysis.summary,
    repairEstimateMin: analysis.repairEstimateMin,
    repairEstimateMax: analysis.repairEstimateMax,
    repairEstimateMinUsd: minUsd,
    repairEstimateMaxUsd: maxUsd,
    damageZones,
    confidence,
    limitations,
    fxUahPerUsd: fx,
    currency: "UAH+USD",
    photosAnalyzed:
      typeof raw.photosAnalyzed === "number"
        ? raw.photosAnalyzed
        : 0,
    observedDamages: Array.isArray(raw.observedDamages)
      ? (raw.observedDamages as ObservedDamage[])
      : [],
    rawAiResponse: analysis.rawAiResponse,
    ...mapped,
  };
}

function mapStoredAnalysisFields(raw: {
  defectList?: unknown;
  hiddenWorkRisks?: unknown;
  risks?: unknown;
}): Pick<DamageAnalysisResult, "defectList" | "hiddenWorkRisks" | "risks"> {
  const defectList = parseDefectList(raw.defectList);
  let hiddenWorkRisks = parseHiddenWorkRisks(raw.hiddenWorkRisks);
  if (!hiddenWorkRisks.length && Array.isArray(raw.risks)) {
    hiddenWorkRisks = parseHiddenWorkRisks(raw.risks);
  }
  if (!hiddenWorkRisks.length && Array.isArray(raw.risks)) {
    hiddenWorkRisks = raw.risks.map((r) => ({
      area: typeof r === "string" ? r : String((r as { area?: string }).area ?? "ризик"),
      probabilityPercent:
        typeof r === "object" && r && "probabilityPercent" in r
          ? Number((r as { probabilityPercent?: number }).probabilityPercent ?? 50)
          : 50,
      why: "",
      possibleExtraUahMin: null,
      possibleExtraUahMax: null,
      possibleExtraUsdMin: null,
      possibleExtraUsdMax: null,
    }));
  }

  return {
    defectList,
    hiddenWorkRisks,
    risks: hiddenWorkRisks.map(
      (r) => `${r.area}: ~${r.probabilityPercent}% прихованих робіт`
    ),
  };
}

export async function processLotFromMessage(options: {
  text: string;
  telegramId: string;
  username?: string;
  onProgress?: (p: PipelineProgress) => Promise<void> | void;
}): Promise<PipelineResult> {
  const parsed = parseLotUrl(options.text);
  if (!parsed) {
    throw new Error(
      "Надішліть посилання Copart виду:\nhttps://www.copart.com/lot/57493376/salvage-...\n\n" +
        "Для повторного аналізу додайте слово force."
    );
  }

  return processLot({
    parsed,
    telegramId: options.telegramId,
    username: options.username,
    force: hasForceFlag(options.text),
    onProgress: options.onProgress,
  });
}

export async function processLot(options: {
  parsed: ParsedLotUrl;
  telegramId: string;
  username?: string;
  force?: boolean;
  onProgress?: (p: PipelineProgress) => Promise<void> | void;
}): Promise<PipelineResult> {
  const { parsed, telegramId, username, onProgress } = options;
  const force = Boolean(options.force);
  const { lotId, url } = parsed;

  const notify = async (p: PipelineProgress) => {
    if (onProgress) await onProgress(p);
  };

  const existing = await prisma.lot.findUnique({
    where: { lotId },
    include: { analysis: true },
  });

  if (
    !force &&
    existing?.status === LotStatus.DONE &&
    existing.analysis
  ) {
    const cached = analysisFromCache(existing.analysis);
    const report = formatDamageReport(cached, existing.vin);
    await notify({
      stage: "cached",
      message:
        "Лот уже проаналізовано — віддаю збережений результат. Для перерахунку додайте force.",
      vin: existing.vin,
      report,
    });
    return {
      lotId,
      vin: existing.vin,
      report,
      analysis: cached,
      fromCache: true,
    };
  }

  if (
    processingLots.has(lotId) ||
    (!force &&
      (existing?.status === LotStatus.DOWNLOADING ||
        existing?.status === LotStatus.ANALYZING))
  ) {
    throw new Error(`Лот ${lotId} уже в обробці. Зачекайте.`);
  }

  processingLots.add(lotId);

  try {
    const user = await upsertUser(telegramId, username);

    const lot = await prisma.lot.upsert({
      where: { lotId },
      create: {
        lotId,
        url,
        status: LotStatus.DOWNLOADING,
        userId: user.id,
        error: null,
        vin: null,
      },
      update: {
        url,
        status: LotStatus.DOWNLOADING,
        userId: user.id,
        error: null,
        ...(force ? { vin: null } : {}),
      },
    });

    await notify({
      stage: "download",
      message: `Завантажую фото лота ${lotId}${force ? " (force)" : ""}...`,
    });

    let imagePaths: string[];
    try {
      ({ imagePaths } = await downloadLotImagesZip(lotId));
    } catch (err) {
      const message =
        err instanceof CopartDownloadError
          ? err.message
          : `Не вдалося завантажити фото лота ${lotId}.`;
      await prisma.lot.update({
        where: { id: lot.id },
        data: { status: LotStatus.FAILED, error: message },
      });
      throw err instanceof Error ? err : new Error(message);
    }

    await prisma.lot.update({
      where: { id: lot.id },
      data: { status: LotStatus.ANALYZING },
    });

    await notify({
      stage: "triage",
      message: `Фото в ZIP: ${imagePaths.length}. Класифікую кадри (VIN / damage)...`,
    });

    const triage = await triageImages(imagePaths);
    await saveImagesWithRoles(lot.id, triage);

    const vinCandidates = selectVinCandidates(triage);
    const damagePhotos = selectDamageCandidates(triage);
    const vinPlateCount = triage.filter(
      (t) => t.roles.includes("vin_plate") || t.vinReadable
    ).length;
    const damageCount = triage.filter((t) =>
      t.roles.includes("damage")
    ).length;

    await notify({
      stage: "vin",
      message:
        `Класифікація: VIN-кадри ${vinPlateCount}, damage ${damageCount}. ` +
        `Читаю VIN з ${vinCandidates.length} кандидатів...`,
    });

    const { vin, reason: vinReason } = await extractVinFromImages(vinCandidates);

    await prisma.lot.update({
      where: { id: lot.id },
      data: { vin },
    });

    await notify({
      stage: "vin",
      message: vin
        ? `VIN: ${vin}`
        : `VIN не прочитано (${vinReason}). Перевірте табличку вручну.`,
      vin,
    });

    await notify({
      stage: "inventory",
      message: `ШІ переглядає ${damagePhotos.length} фото для списку пошкоджень (ще без цін)...`,
    });

    const inventory = await inventoryDamagesFromImages(damagePhotos, {
      lotId,
      vin,
    });

    await notify({
      stage: "inventory",
      message: formatDamageInventory(inventory),
    });

    await notify({
      stage: "damage",
      message: `Рахую кошторис по ${inventory.items.length} зафіксованих пунктах на основі ${damagePhotos.length} фото...`,
    });

    const analysis = await analyzeDamageFromImages(damagePhotos, {
      lotId,
      vin,
      inventory,
    });

    await prisma.lotAnalysis.upsert({
      where: { lotId: lot.id },
      create: {
        lotId: lot.id,
        repairEstimateMin: analysis.repairEstimateMin,
        repairEstimateMax: analysis.repairEstimateMax,
        risks: analysis.hiddenWorkRisks as unknown as Prisma.InputJsonValue,
        summary: analysis.summary,
        damageZones: {
          zones: analysis.damageZones,
          defectList: analysis.defectList,
        } as unknown as Prisma.InputJsonValue,
        rawAiResponse: analysis.rawAiResponse as Prisma.InputJsonValue,
      },
      update: {
        repairEstimateMin: analysis.repairEstimateMin,
        repairEstimateMax: analysis.repairEstimateMax,
        risks: analysis.hiddenWorkRisks as unknown as Prisma.InputJsonValue,
        summary: analysis.summary,
        damageZones: {
          zones: analysis.damageZones,
          defectList: analysis.defectList,
        } as unknown as Prisma.InputJsonValue,
        rawAiResponse: analysis.rawAiResponse as Prisma.InputJsonValue,
      },
    });

    await prisma.lot.update({
      where: { id: lot.id },
      data: { status: LotStatus.DONE, error: null },
    });

    const report = formatDamageReport(analysis, vin, {
      totalPhotos: imagePaths.length,
      vinCandidates: vinCandidates.length,
      damagePhotos: damagePhotos.length,
      vinReason,
    });
    await notify({ stage: "done", message: "Готово.", vin, report });

    return {
      lotId,
      vin,
      report,
      analysis,
      fromCache: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.lot
      .updateMany({
        where: { lotId },
        data: { status: LotStatus.FAILED, error: message },
      })
      .catch(() => undefined);
    await notify({ stage: "error", message });
    throw err;
  } finally {
    processingLots.delete(lotId);
  }
}
