import { expect } from "@playwright/test";

const ROOT = "#orders-root";
const ROW = `${ROOT} [data-id]`;

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator(ROOT).waitFor();
  await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
}

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  return Number(cleaned);
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => {
      const txt = (sel) => r.querySelector(sel)?.textContent?.trim() || "";
      let totalText = txt("strong") || txt(".total");
      if (!totalText) {
        const m = (r.textContent || "").match(/Total:?\s*([^\s]+)/i);
        totalText = m ? m[1] : "";
      }
      return {
        id: r.getAttribute("data-id") || "",
        customer: txt("h3") || txt(".customer"),
        totalText,
      };
    })
  );
}

async function signature(page) {
  return page.locator(ROW).evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
}

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
  const before = await signature(page);
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

async function rowExists(page, id) {
  const escaped = String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return (await page.locator(`${ROW}[data-id="${escaped}"]`).count()) > 0;
}

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);
  const escaped = String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const row = page.locator(`${ROW}[data-id="${escaped}"]`).first();

  let found = false;
  for (let i = 0; i < 200; i++) {
    if ((await row.count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await row.getByRole("button", { name: /cancel/i }).first().click();

    // Optional in-page confirmation
    const confirm = page
      .locator('[role="dialog"], [role="alertdialog"], .modal')
      .getByRole("button", { name: /^(confirm|yes|ok|cancel order|yes, cancel.*)$/i })
      .first();
    if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirm.click();
    }

    let gone = false;
    try {
      await expect(page.locator(`${ROW}[data-id="${escaped}"]`)).toHaveCount(0, { timeout: 7000 });
      gone = true;
    } catch {
      // Fall back to verifying persisted state after a reload
      await openHome(page, baseUrl);
      for (let i = 0; i < 200; i++) {
        if (await rowExists(page, id)) break;
        if (!(await goNext(page))) {
          gone = true;
          break;
        }
      }
    }
    return { cancelled: gone, id };
  } finally {
    page.off("dialog", onDialog);
  }
}
