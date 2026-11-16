import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row";

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function rowSelector(id) {
  const safe = String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${ROW}[data-id="${safe}"]`;
}

async function load(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROW, { timeout: 10000 }).catch(() => {});
}

async function firstRowId(page) {
  return page.locator(ROW).first().getAttribute("data-id", { timeout: 1000 }).catch(() => null);
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

  const sel = rowSelector(id);
  let row = null;
  for (let i = 0; i < 100; i++) {
    const candidate = page.locator(sel);
    if ((await candidate.count()) > 0) {
      row = candidate.first();
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!row) return { cancelled: false, id };

  // Native JS dialogs (alert/confirm), if the site ever uses them.
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);

  try {
    await row.getByRole("button", { name: /cancel/i }).click();

    // The site uses a native <dialog id="confirm"> (not role="dialog" in the DOM
    // attribute sense), so target it explicitly along with common modal patterns.
    const confirmDialog = page
      .locator('dialog[open], #confirm[open], [role="dialog"], [role="alertdialog"], .modal')
      .filter({ visible: true })
      .first();
    try {
      await confirmDialog.waitFor({ state: "visible", timeout: 3000 });
      const confirmBtn = confirmDialog
        .getByRole("button", { name: /^\s*(confirm|yes|ok|proceed)/i })
        .first();
      await confirmBtn.click({ timeout: 3000 });
    } catch {
      // No confirmation step appeared; continue to verification.
    }

    try {
      await expect(page.locator(sel)).toHaveCount(0, { timeout: 7000 });
      return { cancelled: true, id };
    } catch {
      return { cancelled: false, id };
    }
  } finally {
    page.off("dialog", onDialog);
  }
}
