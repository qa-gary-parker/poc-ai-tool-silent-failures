import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row, #orders-root tr[data-id]";
const ERROR_BANNER = '#orders-root [role="alert"], #orders-root .banner';

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

async function hasError(page) {
  return (await page.locator(ERROR_BANNER).count()) > 0;
}

// Load the orders page. If the page shows a load error, retry with backoff.
// Throws if the error persists, so callers don't mistake a failure for "no orders".
async function load(page, baseUrl) {
  const attempts = 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    // Wait until either rows or an error banner shows up.
    await page
      .waitForFunction(
        ({ row, banner }) =>
          document.querySelector(row) || document.querySelector(banner),
        { row: ROW, banner: ERROR_BANNER },
        { timeout: 10000 }
      )
      .catch(() => {});

    // Possibly a genuinely empty list: let network settle, then re-check.
    if ((await page.locator(ROW).count()) === 0 && !(await hasError(page))) {
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    }

    if ((await page.locator(ROW).count()) > 0) return;
    if (!(await hasError(page))) return; // loaded fine, just empty

    // Error banner: try an in-page retry control if there is one, then back off and reload.
    const retryBtn = page
      .locator(ERROR_BANNER)
      .getByRole("button", { name: /retry|try again|reload/i })
      .first();
    if ((await retryBtn.count()) > 0) {
      await retryBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
      if ((await page.locator(ROW).count()) > 0) return;
    }
    await page.waitForTimeout(1000 * (attempt + 1));
  }
  throw new Error("Orders page failed to load: the site keeps showing an error banner.");
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

// Advance to the next page if a pager control exists. Returns false when there is none.
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

  const escaped = String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const rowSel = `#orders-root tr[data-id="${escaped}"]`;

  let row = null;
  for (let i = 0; i < 100; i++) {
    const candidate = page.locator(rowSel);
    if ((await candidate.count()) > 0) {
      row = candidate.first();
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!row) return { cancelled: false, id };

  page.once("dialog", (d) => d.accept().catch(() => {}));
  await row.getByRole("button", { name: /cancel/i }).click();

  // Handle an in-page confirmation modal, if one appears.
  const confirm = page
    .locator('[role="dialog"], [role="alertdialog"], .modal')
    .getByRole("button", { name: /confirm|yes|ok|proceed/i })
    .first();
  try {
    await confirm.click({ timeout: 1000 });
  } catch {}

  try {
    await expect(page.locator(rowSel)).toHaveCount(0, { timeout: 7000 });
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  }
}
