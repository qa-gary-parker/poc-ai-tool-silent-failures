import { expect } from "@playwright/test";

const ITEM = "#orders-root [data-id]";

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function itemById(page, id) {
  return page.locator(ITEM).and(page.locator(`[data-id=${JSON.stringify(String(id))}]`));
}

async function load(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ITEM, { timeout: 10000 }).catch(() => {});
}

async function firstId(page) {
  return page.locator(ITEM).first().getAttribute("data-id").catch(() => null);
}

async function readItems(page) {
  return page.locator(ITEM).evaluateAll((els) =>
    els.map((el) => {
      const text = (sel) => el.querySelector(sel)?.textContent?.trim() || "";
      return {
        id: el.getAttribute("data-id") || "",
        customer: text(".customer") || text("h3") || text("h2") || text("td:nth-child(2)"),
        totalText: text(".total") || text("strong") || text("td:last-child"),
      };
    })
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

  const before = await firstId(page);
  await next.click();
  try {
    await page.waitForFunction(
      ({ sel, before }) => {
        const el = document.querySelector(sel);
        return el && el.getAttribute("data-id") !== before;
      },
      { sel: ITEM, before },
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
    const items = await readItems(page);
    let added = 0;
    for (const r of items) {
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

  let item = null;
  for (let i = 0; i < 100; i++) {
    const candidate = itemById(page, id);
    if ((await candidate.count()) > 0) {
      item = candidate.first();
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!item) return { cancelled: false, id };

  page.once("dialog", (d) => d.accept().catch(() => {}));
  await item.getByRole("button", { name: /cancel/i }).click();

  // Handle an in-page confirmation modal, if one appears.
  const confirm = page
    .locator('[role="dialog"], [role="alertdialog"], .modal')
    .getByRole("button", { name: /confirm|yes|ok|proceed/i })
    .first();
  try {
    await confirm.click({ timeout: 1000 });
  } catch {}

  try {
    await expect(itemById(page, id)).toHaveCount(0, { timeout: 7000 });
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  }
}
