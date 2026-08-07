# Copart Telegram Bot

Telegram-бот: кидаєш посилання на лот Copart → ZIP з фото → OpenAI Vision читає VIN і оцінює ремонт/ризики → відповідь у чат + запис у PostgreSQL.

## Стек

- Next.js (App Router) + TypeScript
- Prisma + PostgreSQL
- `node-telegram-bot-api` (long polling)
- OpenAI `gpt-4o-mini` (pay-as-you-go)

## Швидкий старт

### 1. PostgreSQL

Створіть БД, наприклад `copart`.

### 2. Env

```bash
cp .env.example .env
```

Заповніть:

- `TELEGRAM_BOT_TOKEN` — від [@BotFather](https://t.me/BotFather)
- `OPENAI_API_KEY` — з [OpenAI API](https://platform.openai.com/api-keys)
- `DATABASE_URL` — рядок підключення Postgres
- `COPART_COOKIE` — Cookie з браузера (Incapsula блокує запити без сесії)

### 3. Залежності та схема

```bash
npm install
npm run db:push
```

### 4. Запуск

Термінал 1 — веб (health + список лотів):

```bash
npm run dev:web
```

Термінал 2 — Telegram-бот:

```bash
npm run dev:bot
```

Напишіть боту `/start`, потім посилання виду:

`https://www.copart.com/lot/57493376/salvage-...`

Бот підставить `lotId` у:

`https://www.copart.com/public/data/lotImages/download/{lotId}/1?isHD=true`

Аналіз фото: спочатку triage (VIN plate / damage / overview), потім VIN з `detail=high` (+ retry `gpt-4o` якщо треба), потім inventory пошкоджень і кошторис. Повтор: додайте `force` до повідомлення з URL.

Після аналізу бот пропонує **купити Carfax** ([VinReport PDF API](https://vinreport.shop/api/docs/v3-pdf.html)): PDF у чат + ШІ-аналіз, спроба Window Sticker з сервера (з UA IP часто блок). Потрібні `VINREPORT_API_KEY` і `VINREPORT_USER_ID`. Команда: `/carfax <VIN>`.

## Production: PM2

На сервері (Node 20+):

```bash
git clone https://github.com/brysommer/copart.git
cd copart
cp .env.example .env
# заповніть .env
npm install
npm run db:push
npm run build
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Корисно:

```bash
pm2 status
pm2 logs copart-bot
pm2 restart copart-bot
pm2 stop all
```

Процеси з `ecosystem.config.cjs`:

- `copart-bot` — Telegram long polling (`tsx src/bot/index.ts`)
- `copart-web` — Next.js на порту 3000 (`next start`)

Лише бот:

```bash
pm2 start ecosystem.config.cjs --only copart-bot
```

## Скрипти

| Script | Опис |
|--------|------|
| `npm run dev:web` | Next.js (dev) |
| `npm run dev:bot` | Telegram long polling (dev) |
| `npm run start:bot` | Telegram bot (prod-like) |
| `npm run build` | Prisma generate + Next build |
| `npm run pm2:start` | PM2 start ecosystem |
| `npm run db:push` | Prisma db push |
| `npm run db:generate` | Prisma generate |
| `npm run db:studio` | Prisma Studio |

## Copart cookies (обовʼязково для ZIP)

Без cookies Copart/Incapsula віддає HTML замість ZIP.

1. Відкрий лот у Chrome (залогінься, якщо треба).
2. F12 → **Network** → онови сторінку.
3. Клікни будь-який запит на `copart.com` → **Request Headers** → скопіюй значення **Cookie**.
4. Встав у `.env`:

```env
COPART_COOKIE=reese84=...; incap_ses_...=...; visid_incap_...=...
```

5. Перезапусти бота: `npm run dev:bot`.

Якщо знову HTML — cookies протухли, скопіюй свіжі. Debug HTML: `storage/debug/copart-{lotId}-response.html`.

## Примітки

- Фото зберігаються в `storage/lots/{lotId}/`.
- Повторний запит того самого лота повертає збережений результат, якщо статус `DONE`.
