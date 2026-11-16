import { expect } from "@playwright/test";

const ROW = "tr.order-row";
const COUNT = '[data-testid="open-count"]';

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#orders-root table", { timeout: 15000 });
  await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
}

function parseTotal(text) {
  const cleaned = String(text).replace(/[^0-9.,-]/g, "");
  return Number(cleaned.replace(/,/g, ""));
}

async function rowsSignature(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-id")).join("|")
  );
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-id") || el.querySelector(".id")?.textContent.trim(),
      customer: el.querySelector(".customer")?.textContent.trim() ?? "",
      totalText: el.querySelector(".total")?.textContent.trim() ?? "",
    }))
  );
}

async function readOpenCount(page) {
  const t = await page.locator(COUNT).first().textContent({ timeout: 500 }).catch(() => null);
  const m = t && t.match(/\d+/);
  return m ? Number(m[0]) : null;
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

function rowLocator(page, id) {
  return page.locator(`${ROW}[data-id=${JSON.stringify(String(id))}]`);
}

// Walks pages until the row is found. Returns true if found.
async function findRow(page, id) {
  const row = rowLocator(page, id);
  for (let i = 0; i < 100; i++) {
    if (await row.count()) return true;
    if (!(await goNext(page))) break;
  }
  return false;
}

async function isMarkedCancelled(row) {
  if (!(await row.count())) return true;
  return row.first().evaluate((el) => {
    const txt = el.textContent || "";
    const cls = el.className || "";
    return (
      /cancell?ed/i.test(txt) ||
      /cancell?ed/i.test(cls) ||
      el.getAttribute("data-status") === "cancelled" ||
      el.hidden
    );
  }).catch(() => true);
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
  id = String(id);
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await openHome(page, baseUrl);

    if (!(await findRow(page, id))) return { cancelled: false, id };

    const row = rowLocator(page, id);
    const countBefore = await readOpenCount(page);

    await row.getByRole("button", { name: /cancel/i }).first().click();

    // In-page confirmation modal, if any.
    const confirm = page
      .locator('[role="dialog"], [role="alertdialog"], .modal, dialog[open]')
      .getByRole("button", { name: /confirm|yes|ok|proceed|cancel order/i })
      .first();
    if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirm.click();
    }

    // Wait for any sign of success: row gone/marked, or open count decreased.
    const deadline = Date.now() + 10000;
    let signal = false;
    while (Date.now() < deadline) {
      if (await isMarkedCancelled(row)) { signal = true; break; }
      const c = await readOpenCount(page);
      if (countBefore !== null && c !== null && c < countBefore) { signal = true; break; }
      await page.waitForTimeout(200);
    }

    // Verify against server state with a fresh load.
    await openHome(page, baseUrl).catch(() => {});
    const stillThere = await findRow(page, id);
    if (!stillThere) return { cancelled: true, id };
    const cancelledNow = await isMarkedCancelled(rowLocator(page, id));
    return { cancelled: cancelledNow || (signal && false), id };
  } finally {
    page.off("dialog", onDialog);
  }
}
