import { expect } from "@playwright/test";

const ITEM = "#orders-root [data-id]";

function parseTotal(text) {
  const t = (text || "").replace(/[^0-9.,\-]/g, "");
  if (!t) return 0;
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  let cleaned;
  if (lastComma > lastDot) {
    // European style: 1.234,50
    cleaned = t.replace(/\./g, "").replace(",", ".");
  } else {
    // 1,234.50
    cleaned = t.replace(/,/g, "");
  }
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function sel(id) {
  return `${ITEM}[data-id="${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

async function load(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ITEM, { timeout: 10000 }).catch(() => {});
}

async function firstId(page) {
  return page.locator(ITEM).first().getAttribute("data-id", { timeout: 1000 }).catch(() => null);
}

async function readItems(page) {
  return page.locator(ITEM).evaluateAll((els) =>
    els.map((el) => {
      const id = el.getAttribute("data-id") || "";
      const customer =
        el.querySelector("h1, h2, h3, h4, .customer")?.textContent?.trim() || "";
      const totalEl =
        el.querySelector(".total, strong, [data-testid='total']") || null;
      let totalText = totalEl?.textContent?.trim() || "";
      if (!/\d/.test(totalText)) {
        const m = (el.textContent || "").match(/Total:?\s*([^\n]*)/i);
        totalText = m ? m[1] : "";
      }
      return { id, customer, totalText };
    })
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
    const candidate = page.locator(sel(id));
    if ((await candidate.count()) > 0) {
      item = candidate.first();
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!item) return { cancelled: false, id };

  page.once("dialog", (d) => d.accept().catch(() => {}));
  await item.getByRole("button", { name: /cancel/i }).first().click();

  // Handle an in-page confirmation modal, if one appears.
  const confirm = page
    .locator('[role="dialog"], [role="alertdialog"], .modal')
    .getByRole("button", { name: /confirm|yes|ok|proceed/i })
    .first();
  try {
    await confirm.click({ timeout: 1000 });
  } catch {}

  try {
    // Success: the item disappears, or it remains but is marked cancelled / loses its cancel button.
    await page.waitForFunction(
      (s) => {
        const el = document.querySelector(s);
        if (!el) return true;
        if (/cancell?ed/i.test(el.textContent || "")) {
          return !Array.from(el.querySelectorAll("button")).some(
            (b) => /cancel/i.test(b.textContent || "") && !b.disabled
          );
        }
        return false;
      },
      sel(id),
      { timeout: 7000 }
    );
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  }
}
