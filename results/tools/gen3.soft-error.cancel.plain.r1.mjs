import { expect } from "@playwright/test";

const ROOT = "#orders-root";
const ROW = `${ROOT} tbody tr`;
const BANNER = `${ROOT} [role="alert"], ${ROOT} .banner`;

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function idSel(id) {
  return `${ROW}[data-id="${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

// Loads the page and waits until either rows or an error banner shows.
// Retries on the "couldn't load" banner; throws if it persists, so callers
// never mistake a failed load for "no orders" / "order not found".
async function load(page, baseUrl) {
  const attempts = 4;
  let lastMsg = "";
  for (let a = 0; a < attempts; a++) {
    if (a > 0) await page.waitForTimeout(500 * a);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(
        ({ row, banner }) => document.querySelector(row) || document.querySelector(banner),
        { row: ROW, banner: BANNER },
        { timeout: 8000 }
      );
    } catch {
      // Neither appeared: allow a short settle, then treat as legitimately empty.
      await page.waitForTimeout(500);
    }
    const banner = page.locator(BANNER).first();
    const hasRows = (await page.locator(ROW).count()) > 0;
    if (hasRows) return;
    if ((await banner.count()) > 0) {
      lastMsg = ((await banner.textContent()) || "").trim();
      continue; // retry
    }
    return; // loaded fine, genuinely no open orders
  }
  throw new Error(`Orders page failed to load after ${attempts} attempts: ${lastMsg || "unknown error"}`);
}

async function firstRowId(page) {
  return page.locator(ROW).first().getAttribute("data-id").catch(() => null);
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => ({
      id: r.getAttribute("data-id") || r.querySelector(".id")?.textContent?.trim() || "",
      customer: r.querySelector(".customer")?.textContent?.trim() || "",
      totalText: r.querySelector(".total")?.textContent?.trim() || "",
    }))
  );
}

async function goNext(page) {
  const next = page
    .locator("#pager")
    .locator("a, button")
    .filter({ hasText: /next|›|»|>/i })
    .first();
  if ((await next.count()) === 0) return false;
  if (!(await next.isEnabled().catch(() => false))) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;

  const before = await firstRowId(page);
  await next.click();
  try {
    await page.waitForFunction(
      ({ sel, before }) => {
        const el = document.querySelector(sel);
        return el && el.getAttribute("data-id") !== before;
      },
      { sel: ROW, before },
      { timeout: 5000 }
    );
  } catch {
    return false;
  }
  return true;
}

export async function listOpenOrders(page, baseUrl) {
  await load(page, baseUrl);

  const seen = new Map();
  for (let i = 0; i < 100; i++) {
    const rows = await readRows(page);
    let added = 0;
    for (const r of rows) {
      if (r.id && !seen.has(r.id)) {
        seen.set(r.id, { id: r.id, customer: r.customer, total: parseTotal(r.totalText) });
        added++;
      }
    }
    if (added === 0) break;
    if (!(await goNext(page))) break;
  }
  return [...seen.values()];
}

export async function cancelOrder(page, baseUrl, id) {
  await load(page, baseUrl);

  let found = false;
  for (let i = 0; i < 100; i++) {
    if ((await page.locator(idSel(id)).count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  const row = page.locator(idSel(id)).first();

  page.once("dialog", (d) => d.accept().catch(() => {}));
  await row.getByRole("button", { name: /cancel/i }).click();

  const confirm = page
    .locator('[role="dialog"], [role="alertdialog"], .modal')
    .getByRole("button", { name: /confirm|yes|ok|proceed/i })
    .first();
  try {
    await confirm.click({ timeout: 1000 });
  } catch {}

  try {
    await expect(page.locator(idSel(id))).toHaveCount(0, { timeout: 7000 });
    return { cancelled: true, id };
  } catch {
    // If the page now shows a load error, surface it instead of a silent false.
    if ((await page.locator(BANNER).count()) > 0) {
      const msg = ((await page.locator(BANNER).first().textContent()) || "").trim();
      throw new Error(`Cancel did not complete; page shows error: ${msg}`);
    }
    return { cancelled: false, id };
  }
}
