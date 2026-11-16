import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row";
const TOTALS_TIMEOUT = 30000;

function parseTotal(text) {
  let s = (text || "").replace(/[^0-9.,\-]/g, "");
  if (!/\d/.test(s)) return NaN;
  // Handle European format "1.234,50" vs US "1,234.50"
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  return parseFloat(s);
}

async function load(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROW, { timeout: 15000 }).catch(() => {});
}

async function firstRowId(page) {
  return page.locator(ROW).first().getAttribute("data-id").catch(() => null);
}

async function snapshot(page) {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => ({
      id: r.getAttribute("data-id") || r.querySelector(".id")?.textContent?.trim() || "",
      customer: r.querySelector(".customer")?.textContent?.trim() || "",
      totalText: r.querySelector(".total")?.textContent?.trim() || "",
    }))
  );
}

// Totals are filled in asynchronously (placeholder "—" first). Re-read the rows
// until every total is numeric, tolerating re-renders, or until the timeout.
async function readRows(page, timeout = TOTALS_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let rows = [];
  for (;;) {
    try {
      rows = await snapshot(page);
    } catch {
      rows = [];
    }
    if (rows.length > 0 && rows.every((r) => !Number.isNaN(parseTotal(r.totalText)))) {
      return rows;
    }
    if (Date.now() >= deadline) return rows;
    await page.waitForTimeout(250);
  }
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
        const total = parseTotal(r.totalText);
        if (Number.isNaN(total)) {
          throw new Error(
            `Could not read a numeric total for order ${r.id} (got "${r.totalText}") after waiting ${TOTALS_TIMEOUT}ms`
          );
        }
        seen.set(r.id, { id: r.id, customer: r.customer, total });
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

  const sel = `${ROW}[data-id="${String(id).replace(/"/g, '\\"')}"]`;
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
    await expect(page.locator(sel)).toHaveCount(0, { timeout: 7000 });
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  }
}
