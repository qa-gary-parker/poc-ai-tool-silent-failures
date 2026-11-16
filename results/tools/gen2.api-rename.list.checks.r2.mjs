import { expect } from "@playwright/test";

const ROW = "tr.order-row";
const PLACEHOLDER_TIMEOUT = 30000;

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#orders-root table", { timeout: 15000 });
  await page.locator(ROW).first().waitFor({ timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
}

function parseTotal(text) {
  let s = String(text).replace(/[^0-9.,-]/g, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  return Number(s);
}

async function snapshotRows(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-id") || el.querySelector(".id")?.textContent.trim(),
      customer: el.querySelector(".customer")?.textContent.trim() ?? "",
      totalText: el.querySelector(".total")?.textContent.trim() ?? "",
    }))
  );
}

async function rowsSignature(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-id")).join("|")
  );
}

// Totals load asynchronously (placeholder "—"). Poll until every row on the
// current page has a numeric total, nudging lazy loaders by scrolling/hovering.
async function readRows(page) {
  const deadline = Date.now() + PLACEHOLDER_TIMEOUT;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await snapshotRows(page);
    if (rows.length && rows.every((r) => /\d/.test(r.totalText))) return rows;
    // Nudge possible lazy/intersection/hover-based loading.
    const locs = page.locator(ROW);
    const n = await locs.count();
    for (let i = 0; i < n; i++) {
      await locs.nth(i).scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => {});
      await locs.nth(i).locator(".total").hover({ timeout: 500 }).catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  if (!rows.length) return rows;
  const missing = rows.filter((r) => !/\d/.test(r.totalText)).map((r) => r.id);
  throw new Error(`Totals never loaded for orders: ${missing.join(", ")}`);
}

async function goNext(page) {
  const next = page
    .locator("#pager")
    .locator("button, a")
    .filter({ hasText: /next|›|»|>/i })
    .first();
  if (!(await next.count())) return false;
  if (!(await next.isVisible()) || !(await next.isEnabled())) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;

  const before = await rowsSignature(page);
  await next.click();
  try {
    await page.waitForFunction(
      ({ sel, before }) =>
        Array.from(document.querySelectorAll(sel))
          .map((e) => e.getAttribute("data-id"))
          .join("|") !== before,
      { sel: ROW, before },
      { timeout: 5000 }
    );
  } catch {
    return false;
  }
  return true;
}

export async function listOpenOrders(page, baseUrl) {
  await openHome(page, baseUrl);
  const seen = new Map();
  for (let i = 0; i < 100; i++) {
    for (const r of await readRows(page)) {
      if (r.id && !seen.has(r.id)) {
        seen.set(r.id, {
          id: r.id,
          customer: r.customer,
          total: parseTotal(r.totalText),
        });
      }
    }
    if (!(await goNext(page))) break;
  }
  return [...seen.values()];
}

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);
  page.once("dialog", (d) => d.accept().catch(() => {}));

  const row = page.locator(`${ROW}[data-id=${JSON.stringify(String(id))}]`);

  let found = false;
  for (let i = 0; i < 100; i++) {
    if (await row.count()) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  await row.getByRole("button", { name: /cancel/i }).click();

  const confirm = page
    .getByRole("dialog")
    .getByRole("button", { name: /confirm|yes|ok|cancel order/i })
    .first();
  if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
    await confirm.click();
  }

  try {
    await row.waitFor({ state: "detached", timeout: 8000 });
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  }
}
