import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import { purchaseAndAnalyzeCarfax, VinReportError } from "../lib/carfax-service";
import { normalizeVin } from "../lib/ai";
import { prisma } from "../lib/prisma";
import { processLotFromMessage } from "../lib/pipeline";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

process.env.NTBA_FIX_319 = "1";
process.env.NTBA_FIX_350 = "1";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

/** last analyzed VIN per chat for Carfax offer */
const lastVinByChat = new Map<number, { vin: string; lotId?: string }>();

const START_TEXT =
  "Надішліть посилання на лот Copart, наприклад:\n" +
  "https://www.copart.com/lot/57493376/salvage-2022-ford-edge-sel-ca-bakersfield\n\n" +
  "Я завантажу фото, прочитаю VIN, зроблю інвентар пошкоджень і кошторис.\n" +
  "Після аналізу запропоную купити Carfax (VinReport).\n" +
  "Повторний аналіз лота: додайте слово force.";

async function sendText(chatId: number, text: string) {
  const chunks: string[] = [];
  const max = 4000;
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk);
  }
}

async function offerCarfax(
  chatId: number,
  vin: string,
  lotId?: string
) {
  lastVinByChat.set(chatId, { vin, lotId });
  await bot.sendMessage(
    chatId,
    `Купити Carfax для VIN \`${vin}\`?\n` +
      "Якщо так — завантажу PDF у чат, зроблю ШІ-аналіз і спробую Window Sticker " +
      "(часто блокується з UA IP; з сервера DE/US шанс вищий).",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Так, купити Carfax",
              callback_data: `carfax:yes:${vin}`,
            },
            {
              text: "❌ Ні",
              callback_data: `carfax:no:${vin}`,
            },
          ],
        ],
      },
    }
  );
}

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, START_TEXT);
});

bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat.id;
  const data = query.data || "";
  if (!chatId) return;

  try {
    await bot.answerCallbackQuery(query.id);

    if (data.startsWith("carfax:no:")) {
      await sendText(chatId, "Ок, без Carfax.");
      return;
    }

    if (!data.startsWith("carfax:yes:")) return;

    const vin = normalizeVin(data.slice("carfax:yes:".length));
    if (!vin) {
      await sendText(chatId, "Невалідний VIN для Carfax.");
      return;
    }

    if (!process.env.VINREPORT_API_KEY || !process.env.VINREPORT_USER_ID) {
      await sendText(
        chatId,
        "Carfax API ще не налаштований. Додайте VINREPORT_API_KEY і VINREPORT_USER_ID у .env."
      );
      return;
    }

    await sendText(chatId, `Купую / отримую Carfax для ${vin}...`);

    const result = await purchaseAndAnalyzeCarfax(vin, async (msg) => {
      await sendText(chatId, msg);
    });

    if (fs.existsSync(result.pdfPath)) {
      await bot.sendDocument(chatId, result.pdfPath, {
        caption: `Carfax PDF — ${vin}`,
      });
    }

    await sendText(chatId, `Аналіз Carfax:\n\n${result.carfaxAnalysis}`);

    if (result.stickerPath && fs.existsSync(result.stickerPath)) {
      const isPdf = result.stickerPath.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        await bot.sendDocument(chatId, result.stickerPath, {
          caption: `Window Sticker — ${vin}`,
        });
      } else {
        await bot.sendPhoto(chatId, result.stickerPath, {
          caption: `Window Sticker — ${vin}`,
        });
      }
      if (result.stickerAnalysis) {
        await sendText(
          chatId,
          `Аналіз Window Sticker:\n\n${result.stickerAnalysis}`
        );
      }
    } else if (result.stickerNote) {
      await sendText(chatId, result.stickerNote);
    }

    if (result.balance != null) {
      await sendText(chatId, `Баланс VinReport: ${result.balance} кредит(ів).`);
    }

    const ctx = lastVinByChat.get(chatId);
    let dbLotId: string | undefined;
    if (ctx?.lotId) {
      const lot = await prisma.lot.findUnique({ where: { lotId: ctx.lotId } });
      dbLotId = lot?.id;
    }

    await prisma.carfaxReport.upsert({
      where: { vin },
      create: {
        vin,
        lotId: dbLotId,
        pdfPath: result.pdfPath,
        stickerPath: result.stickerPath,
        carfaxAnalysis: result.carfaxAnalysis,
        stickerAnalysis: result.stickerAnalysis,
        rawMeta: {
          balance: result.balance ?? null,
          stickerNote: result.stickerNote ?? null,
        },
      },
      update: {
        lotId: dbLotId,
        pdfPath: result.pdfPath,
        stickerPath: result.stickerPath,
        carfaxAnalysis: result.carfaxAnalysis,
        stickerAnalysis: result.stickerAnalysis,
        rawMeta: {
          balance: result.balance ?? null,
          stickerNote: result.stickerNote ?? null,
        },
      },
    });
  } catch (err) {
    const message =
      err instanceof VinReportError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Помилка Carfax.";
    if (chatId) await sendText(chatId, message);
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text || text.startsWith("/")) return;

  const telegramId = String(msg.from?.id ?? chatId);
  const username = msg.from?.username;

  try {
    const result = await processLotFromMessage({
      text,
      telegramId,
      username,
      onProgress: async (p) => {
        if (p.stage === "cached" && p.report) {
          await sendText(chatId, p.message);
          await sendText(chatId, p.report);
          return;
        }
        if (p.stage === "done" && p.report) {
          await sendText(chatId, p.report);
          return;
        }
        if (p.stage === "error") return;
        await sendText(chatId, p.message);
      },
    });

    if (result.vin) {
      await offerCarfax(chatId, result.vin, result.lotId);
    } else {
      await sendText(
        chatId,
        "VIN не прочитано з фото — Carfax запропонувати не можу. Можна надіслати VIN окремо командою: /carfax VIN"
      );
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Сталася невідома помилка.";
    await sendText(chatId, message);
  }
});

bot.onText(/\/carfax(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const raw = match?.[1]?.trim() || lastVinByChat.get(chatId)?.vin;
  const vin = normalizeVin(raw || "");
  if (!vin) {
    await sendText(
      chatId,
      "Використання: /carfax <17-символьний VIN> (або спочатку проаналізуйте лот)."
    );
    return;
  }
  await offerCarfax(chatId, vin, lastVinByChat.get(chatId)?.lotId);
});

bot.on("polling_error", (err) => {
  console.error("Telegram polling error:", err.message);
});

console.log("Copart Telegram bot is running (long polling)...");
