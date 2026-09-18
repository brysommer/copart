import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

const SYSTEM = `Ти пишеш пости для LinkedIn від першої особи українською (можна змішувати з англійськими термінами IT).
Автор — інженер/підприємець: електроніка, сервери, Proxmox/homelab, розумний дім, Apple-екосистема,
фінанси, автоматизація бухгалтерії, програмування (TypeScript/Node, боти, інтеграції).
Стиль: живо, по суті, без корпоративного води і без емодзі-спаму. 1–3 короткі абзаци або 4–8 рядків.
Можна 3–5 хештегів в кінці, але не обов'язково.
Не вигадуй чужі кейси як факти — пиши як особистий досвід/спостереження/думку.
Поверни ЛИШЕ текст поста, без лапок і без пояснень.`;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey });
}

const TOPICS = [
  "homelab / Proxmox / сервери вдома",
  "розумний дім і практичні граблі",
  "Apple в роботі й побуті",
  "електроніка та DIY",
  "автоматизація бухгалтерії / фінансів для малого бізнесу",
  "Telegram-боти та інтеграції",
  "TypeScript/Node у реальних задачах",
  "безпека, VPN/Tailscale, домашня інфраструктура",
  "продуктивність і як не тонути в рутині",
];

export async function generateLinkedInPost(options?: {
  userHint?: string;
  previousText?: string;
}): Promise<string> {
  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  const userParts: string[] = [
    `Тема орієнтир: ${topic}.`,
    "Згенеруй свіжий пост.",
  ];
  if (options?.previousText) {
    userParts.push("Попередня версія:\n" + options.previousText);
  }
  if (options?.userHint?.trim()) {
    userParts.push("Правки / промпт від автора:\n" + options.userHint.trim());
  }

  const client = getClient();
  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.9,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userParts.join("\n\n") },
    ],
  });
  const text = res.choices[0]?.message?.content?.trim() || "";
  if (!text) throw new Error("LinkedIn AI: порожня відповідь моделі");
  return text.replace(/^["«]|["»]$/g, "").trim();
}
