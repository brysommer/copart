import {
  connectFromRecommendations,
  publishLinkedInPost,
} from "./linkedin-actions";
import { generateLinkedInPost } from "./linkedin-ai";
import {
  linkedInEnabled,
  linkedInOwnerChatId,
} from "./linkedin-browser";
import { log } from "./logger";
import {
  addDays,
  loadLinkedInState,
  randomIntInclusive,
  saveLinkedInState,
  type LinkedInState,
} from "./linkedin-state";

export type LinkedInNotify = (text: string, opts?: { withDraftButtons?: boolean }) => Promise<void>;

function followProbability(): number {
  const n = Number(process.env.LINKEDIN_FOLLOW_PROBABILITY || "0.7");
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.7;
}

function postMinDays(): number {
  return Math.max(1, Number(process.env.LINKEDIN_POST_MIN_DAYS || "1") || 1);
}

function postMaxDays(): number {
  return Math.max(postMinDays(), Number(process.env.LINKEDIN_POST_MAX_DAYS || "5") || 5);
}

function scheduleNextPost(from = new Date()): Date {
  const days = randomIntInclusive(postMinDays(), postMaxDays());
  // Randomize time of day within working hours UTC+3 approx → use local random hour
  const d = addDays(from, days);
  d.setHours(10 + randomIntInclusive(0, 8), randomIntInclusive(0, 59), 0, 0);
  return d;
}

function scheduleNextFollowCheck(from = new Date()): Date {
  const d = addDays(from, 1);
  d.setHours(11 + randomIntInclusive(0, 7), randomIntInclusive(0, 59), 0, 0);
  return d;
}

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export async function ensureLinkedInSchedule(): Promise<LinkedInState> {
  const state = await loadLinkedInState();
  let changed = false;
  const now = new Date();
  if (!state.nextPostAt || new Date(state.nextPostAt).getTime() < now.getTime() - 7 * 864e5) {
    // if never set or stuck far past, schedule soon (tonight-ish window) but not immediate spam
    state.nextPostAt = scheduleNextPost(now).toISOString();
    // first post sooner: within 1 day
    const soon = new Date(now.getTime() + randomIntInclusive(2, 20) * 3600_000);
    state.nextPostAt = soon.toISOString();
    changed = true;
  }
  if (!state.nextFollowCheckAt) {
    state.nextFollowCheckAt = scheduleNextFollowCheck(now).toISOString();
    changed = true;
  }
  if (changed) await saveLinkedInState(state);
  return state;
}

export function formatLinkedInStatus(state: LinkedInState): string {
  return (
    `LinkedIn автопілот: ${linkedInEnabled() ? "ON" : "OFF"}\n` +
    `Власник chatId: ${linkedInOwnerChatId() ?? "не задано"}\n` +
    `Наступний пост: ${state.nextPostAt ?? "—"}\n` +
    `Останній пост: ${state.lastPostAt ?? "—"}\n` +
    `Наступна перевірка follow: ${state.nextFollowCheckAt ?? "—"}\n` +
    `Останній follow: ${state.lastFollowAt ?? "—"}\n` +
    `Збережених профілів: ${state.connectedProfiles.length}\n` +
    `Чернетка: ${state.pendingDraft ? `так (rev ${state.pendingDraft.revision})` : "немає"}`
  );
}

export async function offerDraftToTelegram(
  notify: LinkedInNotify,
  text: string,
  chatId: number,
  revision: number
): Promise<void> {
  const state = await loadLinkedInState();
  state.pendingDraft = {
    text,
    chatId,
    createdAt: new Date().toISOString(),
    revision,
  };
  await saveLinkedInState(state);
  await notify(
    `📝 LinkedIn чернетка (rev ${revision}):\n\n${text}\n\n` +
      `Відповідай:\n` +
      `• ТАК — опублікувати\n` +
      `• НІ — скіпнути\n` +
      `• або будь-який текст = промпт на нову версію`,
    { withDraftButtons: true }
  );
}

export async function generateAndOfferPost(
  notify: LinkedInNotify,
  chatId: number,
  hint?: string
): Promise<void> {
  const state = await loadLinkedInState();
  const prev = state.pendingDraft?.text;
  await notify("Генерую LinkedIn-пост…");
  const text = await generateLinkedInPost({
    userHint: hint,
    previousText: hint ? prev : undefined,
  });
  const revision = (state.pendingDraft?.revision || 0) + 1;
  await offerDraftToTelegram(notify, text, chatId, revision);
}

export async function handleDraftDecision(
  notify: LinkedInNotify,
  chatId: number,
  decision: "yes" | "no" | "revise",
  reviseHint?: string
): Promise<boolean> {
  const state = await loadLinkedInState();
  const draft = state.pendingDraft;
  if (!draft || draft.chatId !== chatId) return false;

  if (decision === "no") {
    state.pendingDraft = null;
    state.nextPostAt = scheduleNextPost(new Date()).toISOString();
    await saveLinkedInState(state);
    await notify("Ок, пост скіпнуто. Наступний за розкладом.");
    return true;
  }

  if (decision === "revise") {
    await generateAndOfferPost(notify, chatId, reviseHint || "");
    return true;
  }

  // yes — publish
  await notify("Публікую в LinkedIn…");
  try {
    await publishLinkedInPost(draft.text);
    state.pendingDraft = null;
    state.lastPostAt = new Date().toISOString();
    state.nextPostAt = scheduleNextPost(new Date()).toISOString();
    await saveLinkedInState(state);
    await notify(
      `Опубліковано.\nНаступний пост орієнтовно: ${state.nextPostAt}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("LinkedIn publish failed", { error: msg });
    await notify(`Не вдалося опублікувати: ${msg}`);
  }
  return true;
}

export async function runFollowTick(
  notify: LinkedInNotify,
  opts?: { force?: boolean }
): Promise<void> {
  const state = await loadLinkedInState();
  const now = new Date();
  state.nextFollowCheckAt = scheduleNextFollowCheck(now).toISOString();

  if (!opts?.force && state.lastFollowDay === dayKey(now)) {
    await saveLinkedInState(state);
    await notify("LinkedIn follow: сьогодні вже було — пропуск.");
    return;
  }

  const roll = Math.random();
  const p = followProbability();
  if (!opts?.force && roll > p) {
    state.lastFollowDay = dayKey(now);
    await saveLinkedInState(state);
    await notify(
      `LinkedIn follow: сьогодні пропускаємо (roll ${roll.toFixed(2)} > ${p}).`
    );
    return;
  }

  const count = randomIntInclusive(1, 2);
  await notify(`LinkedIn: спроба Connect/Follow × ${count}…`);
  try {
    const result = await connectFromRecommendations(count);
    state.lastFollowDay = dayKey(now);
    await saveLinkedInState(state);
    await notify(
      `LinkedIn follow: ${result.note}\n` +
        (result.names.length ? result.names.map((n) => `• ${n}`).join("\n") : "")
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await saveLinkedInState(state);
    await notify(`LinkedIn follow помилка: ${msg}`);
  }
}

export async function runPostTick(notify: LinkedInNotify, chatId: number): Promise<void> {
  const state = await loadLinkedInState();
  if (state.pendingDraft) {
    await notify("Є неопрацьована LinkedIn-чернетка — спочатку ТАК/НІ/промпт.");
    await offerDraftToTelegram(
      notify,
      state.pendingDraft.text,
      chatId,
      state.pendingDraft.revision
    );
    return;
  }
  await generateAndOfferPost(notify, chatId);
}

let schedulerStarted = false;

export function startLinkedInScheduler(
  notifyForOwner: (text: string, opts?: { withDraftButtons?: boolean }) => Promise<void>
): void {
  if (!linkedInEnabled()) {
    log.info("LinkedIn autopilot disabled (LINKEDIN_ENABLED off)");
    return;
  }
  if (schedulerStarted) return;
  schedulerStarted = true;

  const owner = linkedInOwnerChatId();
  if (!owner) {
    log.warn("LinkedIn enabled but no LINKEDIN_TELEGRAM_CHAT_ID / VINREPORT_USER_ID");
    return;
  }

  const tick = async () => {
    try {
      const state = await ensureLinkedInSchedule();
      const now = Date.now();
      if (
        state.nextFollowCheckAt &&
        new Date(state.nextFollowCheckAt).getTime() <= now
      ) {
        await runFollowTick((t) => notifyForOwner(t));
      }
      const fresh = await loadLinkedInState();
      if (fresh.nextPostAt && new Date(fresh.nextPostAt).getTime() <= now) {
        if (!fresh.pendingDraft) {
          await runPostTick((t, o) => notifyForOwner(t, o), owner);
        }
      }
    } catch (err) {
      log.error("LinkedIn scheduler tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  void ensureLinkedInSchedule().then((s) => {
    log.info("LinkedIn scheduler started", {
      nextPostAt: s.nextPostAt,
      nextFollowCheckAt: s.nextFollowCheckAt,
      ownerChatId: owner,
    });
  });

  // check every 10 minutes
  setInterval(() => void tick(), 10 * 60 * 1000);
  setTimeout(() => void tick(), 20_000);
}
