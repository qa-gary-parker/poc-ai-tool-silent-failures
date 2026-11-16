import { expect } from "@playwright/test";

const ROW = "tbody tr[data-id]";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  // Wait for either the rendered rows or the open-count label (covers empty list).
  await page
    .locator(`${ROW}, [data-testid="open-count"]`)
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
  await page.locator(ROW).first().waitFor({ timeout: 3000 }).catch(() => {});
}

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  return Number(cleaned);
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) => {
    const table = rows[0]?.closest("table");
    const heads = table
      ? Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim().toLowerCase())
      : [];
    let cIdx = heads.findIndex((h) => /customer/.test(h));
    let tIdx = heads.findIndex((h) => /total|amount/.test(h));
    if (cIdx < 0) cIdx = 1;
    if (tIdx < 0) tIdx = 2;
    return rows.map((r) => {
      const cells = r.querySelectorAll("td");
      return {
        id: r.getAttribute("data-id") || cells[0]?.textContent?.trim() || "",
        customer: cells[cIdx]?.textContent?.trim() || "",
        totalText: cells[tIdx]?.textContent?.trim() || "",
      };
    });
  });
}

async function rowIds(page) {
  return page.locator(ROW).evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
}

// Pagination is optional: the pager may be empty (all orders on one page).
async function goNext(page) {
  const next = page
    .locator("#pager")
    .locator("button, a")
    .filter({ hasText: /next|›|»|>/i })
    .first();
  if ((await next.count()) === 0) return false;
  if (!(await next.isVisible().catch(() => false))) return false;
  if (await next.isDisabled().catch(() => false)) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;
  const before = await rowIds(page);
  await next.click();
  try {
    await page.waitForFunction(
      (prev) =>
        Array.from(document.querySelectorAll("tbody tr[data-id]"))
          .map((x) => x.getAttribute("data-id"))
          .join("|") !== prev,
      before,
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
  for (let i = 0; i < 200; i++) {
    for (const r of await readRows(page)) {
      if (r.id && !seen.has(r.id)) {
        seen.set(r.id, { id: r.id, customer: r.customer, total: parseTotal(r.totalText) });
      }
    }
    if (!(await goNext(page))) break;
  }
  return Array.from(seen.values());
}

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);
  const row = page.locator(`${ROW}[data-id=${JSON.stringify(String(id))}]`);

  let found = false;
  for (let i = 0; i < 200; i++) {
    if ((await row.count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  page.once("dialog", (d) => d.accept().catch(() => {}));
  await row.getByRole("button", { name: /cancel/i }).click();

  // Optional in-page confirmation dialog
  const confirm = page
    .locator('[role="dialog"], [role="alertdialog"], .modal')
    .getByRole("button", { name: /^(confirm|yes|ok|cancel order|yes, cancel.*)$/i })
    .first();
  if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
    await confirm.click();
  }

  try {
    await expect(row).toHaveCount(0, { timeout: 7000 });
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  }
}
