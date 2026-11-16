import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row";
const COUNT = '[data-testid="open-count"]';

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
      closed:
        /cancell?ed|closed/i.test(r.className || "") ||
        /cancell?ed|closed/i.test(r.getAttribute("data-status") || ""),
    }))
  );
}

async function readCount(page) {
  const t = await page.locator(COUNT).first().textContent({ timeout: 1000 }).catch(() => null);
  const m = t && t.match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
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
        added++;
        if (!r.closed) {
          seen.set(r.id, { id: r.id, customer: r.customer, total: parseTotal(r.totalText) });
        } else {
          seen.set(r.id, null);
        }
      }
    }
    if (added === 0) break;
    if (!(await goNext(page))) break;
  }
  return [...seen.values()].filter(Boolean);
}

export async function cancelOrder(page, baseUrl, id) {
  await load(page, baseUrl);
  const wanted = String(id);

  let row = null;
  for (let i = 0; i < 100; i++) {
    const candidate = page
      .locator(ROW)
      .filter({ has: page.locator(".id", { hasText: wanted }) })
      .and(page.locator(`[data-id="${wanted.replace(/"/g, '\\"')}"]`));
    if ((await candidate.count()) > 0) {
      row = candidate.first();
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!row) return { cancelled: false, id };

  const beforeCount = await readCount(page);

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await row.locator("button").filter({ hasText: /cancel/i }).first().click();

    // In-page confirmation modal, if one appears.
    const confirm = page
      .locator('[role="dialog"], [role="alertdialog"], .modal, dialog[open]')
      .locator("button")
      .filter({ hasText: /confirm|yes|ok|proceed|cancel order|cancel it|delete/i })
      .first();
    try {
      await confirm.click({ timeout: 1500 });
    } catch {}

    // Success = row removed, row marked cancelled, or open count dropped.
    try {
      await page.waitForFunction(
        ({ sel, id, beforeCount }) => {
          const row = [...document.querySelectorAll(sel)].find(
            (r) => r.getAttribute("data-id") === id
          );
          if (!row) return true;
          if (
            /cancell?ed|closed/i.test(row.className || "") ||
            /cancell?ed|closed/i.test(row.getAttribute("data-status") || "") ||
            /cancell?ed|closed/i.test(row.textContent || "")
          )
            return true;
          const c = document.querySelector('[data-testid="open-count"]');
          const m = c && c.textContent.match(/\d+/);
          if (beforeCount != null && m && parseInt(m[0], 10) < beforeCount) return true;
          return false;
        },
        { sel: ROW, id: wanted, beforeCount },
        { timeout: 10000 }
      );
      return { cancelled: true, id };
    } catch {
      return { cancelled: false, id };
    }
  } catch {
    return { cancelled: false, id };
  } finally {
    page.off("dialog", onDialog);
  }
}
