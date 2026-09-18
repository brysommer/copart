import {
  ensureLinkedInLoggedIn,
  withLinkedInPage,
} from "./linkedin-browser";
import { log } from "./logger";
import {
  loadLinkedInState,
  randomDelayMs,
  saveLinkedInState,
  sleep,
} from "./linkedin-state";

async function humanPause(min = 800, max = 2200): Promise<void> {
  await sleep(randomDelayMs(min, max));
}

export type ConnectResult = {
  attempted: number;
  connected: number;
  names: string[];
  note: string;
};

export async function connectFromRecommendations(
  maxPeople: number
): Promise<ConnectResult> {
  const limit = Math.max(1, Math.min(2, maxPeople));
  return withLinkedInPage("connect", async (page) => {
    await ensureLinkedInLoggedIn(page);
    const state = await loadLinkedInState();
    const known = new Set(state.connectedProfiles);

    // People You May Know / grow network
    const urls = [
      "https://www.linkedin.com/mynetwork/grow/",
      "https://www.linkedin.com/mynetwork/",
    ];
    let opened = false;
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await humanPause(1500, 3000);
        opened = true;
        break;
      } catch (err) {
        log.warn("LinkedIn mynetwork navigation failed", {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!opened) {
      return {
        attempted: 0,
        connected: 0,
        names: [],
        note: "Не вдалося відкрити сторінку рекомендацій",
      };
    }

    // Prefer Connect; fall back to Follow
    const actionButtons = page.locator(
      'button:has-text("Connect"), button:has-text("З’єднатися"), button:has-text("З\'єднатися"), button:has-text("Follow"), button:has-text("Підписатися")'
    );

    const names: string[] = [];
    let connected = 0;
    let attempted = 0;
    const count = await actionButtons.count();
    log.info("LinkedIn recommendation buttons found", { count, limit });

    for (let i = 0; i < count && connected < limit; i++) {
      const btn = actionButtons.nth(i);
      try {
        if (!(await btn.isVisible())) continue;
        const label = ((await btn.innerText()) || "").trim();
        // Skip Invite / Message / Pending
        if (/pending|очіку|message|повідом|withdraw|скасув/i.test(label)) {
          continue;
        }
        if (!/connect|з.?єднат|follow|підпис/i.test(label)) continue;

        const card = btn.locator(
          "xpath=ancestor::*[self::li or self::div][1]"
        );
        let profileKey = `idx-${i}-${label}`;
        try {
          const href = await card.locator('a[href*="/in/"]').first().getAttribute("href");
          if (href) profileKey = href.split("?")[0];
        } catch {
          /* ignore */
        }
        if (known.has(profileKey)) continue;

        attempted += 1;
        await btn.scrollIntoViewIfNeeded();
        await humanPause();
        await btn.click({ timeout: 10_000 });
        await humanPause(1000, 2500);

        // If "Add a note" modal — send without note
        const sendWithout = page.locator(
          'button:has-text("Send without a note"), button:has-text("Надіслати без повідомлення"), button:has-text("Send now"), button:has-text("Надіслати")'
        );
        if (await sendWithout.first().isVisible({ timeout: 2500 }).catch(() => false)) {
          await sendWithout.first().click();
          await humanPause();
        }

        // Dismiss other dialo gs
        const dismiss = page.locator(
          'button:has-text("Cancel"), button:has-text("Скасувати"), button[aria-label="Dismiss"]'
        );
        if (await dismiss.first().isVisible({ timeout: 1200 }).catch(() => false)) {
          await dismiss.first().click().catch(() => undefined);
        }

        known.add(profileKey);
        state.connectedProfiles = [...known].slice(-500);
        let name = profileKey;
        try {
          name =
            (
              await card.locator('a[href*="/in/"]').first().innerText()
            )?.trim() || profileKey;
        } catch {
          /* ignore */
        }
        names.push(name);
        connected += 1;
        await humanPause(2000, 4500);
      } catch (err) {
        log.warn("LinkedIn connect click failed", {
          index: i,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    state.lastFollowAt = new Date().toISOString();
    await saveLinkedInState(state);

    return {
      attempted,
      connected,
      names,
      note:
        connected > 0
          ? `Зроблено: ${connected} (Connect/Follow)`
          : "Кнопок Connect/Follow не знайдено або вже все в pending — зайди на VM і перевір UI LinkedIn",
    };
  });
}

export async function publishLinkedInPost(text: string): Promise<void> {
  const body = text.trim();
  if (!body) throw new Error("Порожній текст поста");

  await withLinkedInPage("publish", async (page) => {
    await ensureLinkedInLoggedIn(page);
    await page
      .locator(".scaffold-layout__main, .share-box-feed-entry, main")
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .catch(() => undefined);
    await humanPause(1500, 3000);

    const dismiss = page.locator(
      'button[aria-label="Dismiss"], button[aria-label="Dismiss reminder"], button:has-text("Not now"), button:has-text("Skip"), button:has-text("Пізніше"), button:has-text("Пропустити")'
    );
    if (await dismiss.first().isVisible({ timeout: 800 }).catch(() => false)) {
      await dismiss.first().click().catch(() => undefined);
    }

    const startLocators = [
      page.getByRole("button", {
        name: /start a post|draft with ai|почніть публікац|почніть допис|створити допис|створити публікац|написати допис|почати публікац/i,
      }),
      page.locator(
        'button[data-test-id="share-box-feed-entry__trigger"], [data-test-id="share-box-feed-entry__trigger"]'
      ),
      page.locator(
        "button.share-box-feed-entry__trigger, .share-box-feed-entry__trigger, .share-box-feed-entry__top-bar"
      ),
      page.locator(".share-box-feed-entry"),
    ];

    let opened = false;
    for (const loc of startLocators) {
      const el = loc.first();
      if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
        await el.click({ timeout: 10_000 });
        opened = true;
        break;
      }
    }

    if (!opened) {
      await page.goto("https://www.linkedin.com/sharing/compose", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await humanPause(1500, 3000);
    }

    const editor = page
      .locator(
        '[role="dialog"] [contenteditable="true"], .ql-editor, div[role="textbox"][contenteditable="true"], div.ProseMirror, div[contenteditable="true"]'
      )
      .first();
    await editor.waitFor({ state: "visible", timeout: 20_000 });
    await editor.click();
    await humanPause(400, 900);
    await page.keyboard.type(body, { delay: randomDelayMs(15, 45) });
    await humanPause(1500, 3000);

    const dialog = page.getByRole("dialog");
    const postBtn = dialog
      .getByRole("button", { name: /^(Post|Опублікувати)$/ })
      .or(page.getByRole("button", { name: /^(Post|Опублікувати)$/ }))
      .first();
    await postBtn.waitFor({ state: "visible", timeout: 15_000 });
    if (await postBtn.isDisabled().catch(() => false)) {
      await editor.click();
      await humanPause(500, 1000);
    }
    await postBtn.click();
    await humanPause(3000, 5000);
    log.info("LinkedIn post publish clicked", { chars: body.length });
  });
}

/** Warm profile: open LinkedIn once so user can log in via VNC/Console. */
export async function openLinkedInForLogin(holdMs = 180_000): Promise<string> {
  return withLinkedInPage("login-warm", async (page) => {
    await page.goto("https://www.linkedin.com/login", {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await sleep(holdMs);
    return page.url();
  });
}
