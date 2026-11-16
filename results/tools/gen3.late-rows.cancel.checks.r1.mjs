import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row";

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

async function load(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROW, { timeout: 10000 }).catch(() => {});
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

function rowSelector(id) {
  return `${ROW}[data-id="${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

async function findRow(page, id) {
  for (let i = 0; i < 100; i++) {
    const candidate = page.locator(rowSelector(id));
    if ((await candidate.count()) > 0) return candidate.first();
    if (!(await goNext(page))) break;
  }
  return null;
}

async function openCount(page) {
  const t = await page
    .locator('[data-testid="open-count"]')
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null);
  const m = t && t.match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
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

  const row = await findRow(page, id);
  if (!row) return { cancelled: false, id };

  const countBefore = await openCount(page);

  page.once("dialog", (d) => d.accept().catch(() => {}));
  await row.getByRole("button", { name: /cancel/i }).first().click();

  // Handle an in-page confirmation modal, if one appears.
  const confirm = page
    .locator('[role="dialog"], [role="alertdialog"], .modal')
    .getByRole("button", { name: /confirm|yes|ok|proceed/i })
    .first();
  try {
    await confirm.click({ timeout: 1000 });
  } catch {}

  // In-page signals that the cancellation took effect.
  const sel = rowSelector(id);
  try {
    await page.waitForFunction(
      ({ sel, countBefore }) => {
        const el = document.querySelector(sel);
        if (!el) return true;
        if (/cancell?ed/i.test(el.textContent || "")) return true;
        const btn = el.querySelector("button");
        if (!btn || btn.disabled) return true;
        if (countBefore !== null) {
          const c = document.querySelector('[data-testid="open-count"]');
          const m = c && c.textContent.match(/\d+/);
          if (m && parseInt(m[0], 10) < countBefore) return true;
        }
        return false;
      },
      { sel, countBefore },
      { timeout: 7000 }
    );
    return { cancelled: true, id };
  } catch {}

  // Ground truth: reload and check whether the order is still open.
  await load(page, baseUrl);
  const still = await findRow(page, id);
  return { cancelled: !still, id };
}
