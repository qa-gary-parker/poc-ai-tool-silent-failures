import { expect } from "@playwright/test";

const ROOT = "#ord-root";
const ROW = `${ROOT} tbody tr[data-id]`;

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(ROOT).waitFor({ state: "attached" });
  // Rows may be absent when there are no open orders, so don't fail on that.
  await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
}

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.-]/g, "");
  return Number(cleaned);
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => {
      const cells = r.querySelectorAll("td");
      const t = (i) => (cells[i]?.textContent || "").trim();
      return {
        id: r.getAttribute("data-id") || t(0),
        customer: t(1),
        totalText: t(2),
      };
    })
  );
}

async function rowSignature(page) {
  return page.locator(ROW).evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
}

// Pager is currently empty, but handle pagination if the app renders one.
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
  const before = await rowSignature(page);
  await next.click();
  try {
    await page.waitForFunction(
      ([sel, prev]) =>
        Array.from(document.querySelectorAll(sel))
          .map((x) => x.getAttribute("data-id"))
          .join("|") !== prev,
      [ROW, before],
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
  const row = page.locator(ROW).filter({ has: page.locator("td").first() }).and(
    page.locator(`[data-id="${String(id).replace(/["\\]/g, "\\$&")}"]`)
  );

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
