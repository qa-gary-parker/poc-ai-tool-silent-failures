import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row";

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function rowSel(id) {
  return `${ROW}[data-id="${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
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

async function openCount(page) {
  const txt = await page
    .locator('[data-testid="open-count"]')
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null);
  const m = (txt || "").match(/\d+/);
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
  id = String(id);
  await load(page, baseUrl);

  let found = false;
  for (let i = 0; i < 100; i++) {
    if ((await page.locator(rowSel(id)).count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  const countBefore = await openCount(page);

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);

  try {
    const row = page.locator(rowSel(id)).first();
    const btn = row.getByRole("button", { name: /cancel/i }).first();
    const target = (await btn.count()) > 0 ? btn : row.locator("button").first();
    await target.click({ timeout: 5000 });

    // Handle an in-page confirmation modal, if one appears.
    const confirm = page
      .locator('[role="dialog"], [role="alertdialog"], .modal')
      .getByRole("button", { name: /confirm|yes|ok|proceed/i })
      .first();
    await confirm.click({ timeout: 1000 }).catch(() => {});

    // Success signals: row gone, row marked cancelled, count decreased, or toast.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const rowLoc = page.locator(rowSel(id));
      if ((await rowLoc.count()) === 0) return { cancelled: true, id };

      const rowText = ((await rowLoc.first().textContent({ timeout: 500 }).catch(() => "")) || "");
      const rowClass = (await rowLoc.first().getAttribute("class").catch(() => "")) || "";
      const rowStatus = (await rowLoc.first().getAttribute("data-status").catch(() => "")) || "";
      if (/cancell?ed/i.test(rowText) || /cancell?ed/i.test(rowClass) || /cancell?ed/i.test(rowStatus)) {
        return { cancelled: true, id };
      }

      const countNow = await openCount(page);
      if (countBefore !== null && countNow !== null && countNow < countBefore) {
        return { cancelled: true, id };
      }

      const toast = await page
        .locator(".toast")
        .first()
        .textContent({ timeout: 200 })
        .catch(() => null);
      if (toast && /cancell?ed/i.test(toast) && !/fail|error|unable|could not/i.test(toast)) {
        return { cancelled: true, id };
      }

      await page.waitForTimeout(150);
    }
    return { cancelled: false, id };
  } catch {
    return { cancelled: false, id };
  } finally {
    page.off("dialog", onDialog);
  }
}
