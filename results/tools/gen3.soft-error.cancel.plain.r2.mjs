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

// The page renders an error banner as its initial/placeholder state and app.js
// fills in the rows (and removes the banner) once its fetch completes. The old
// code treated the banner's immediate presence as a failure and reloaded before
// the data arrived. Now we give the app time to settle: rows appearing wins,
// and only a banner that is still showing after the wait counts as a failed attempt.
async function load(page, baseUrl) {
  const attempts = 5;
  let lastMsg = "";
  for (let a = 0; a < attempts; a++) {
    if (a > 0) await page.waitForTimeout(1000 * a);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    // Wait for rows, or for the banner to go away (loaded, possibly empty).
    try {
      await page.waitForFunction(
        ({ row, banner }) =>
          document.querySelector(row) || !document.querySelector(banner),
        { row: ROW, banner: BANNER },
        { timeout: 10000 }
      );
    } catch {
      // Banner still showing after the wait; handled below.
    }

    if ((await page.locator(ROW).count()) > 0) return;

    const banner = page.locator(BANNER).first();
    if ((await banner.count()) > 0) {
      lastMsg = ((await banner.textContent()) || "").trim();
      continue; // genuine persistent error: retry
    }
    // Brief settle to make sure rows aren't about to render.
    await page.waitForTimeout(500);
    if ((await page.locator(ROW).count()) > 0) return;
    if ((await banner.count()) > 0) continue;
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
    if ((await page.locator(BANNER).count()) > 0) {
      const msg = ((await page.locator(BANNER).first().textContent()) || "").trim();
      throw new Error(`Cancel did not complete; page shows error: ${msg}`);
    }
    return { cancelled: false, id };
  }
}
