import { expect } from "@playwright/test";

const ROW = "#orders-root [data-id]";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#orders-root").waitFor();
  await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
}

function parseTotal(text) {
  const m = (text || "").match(/-?\d[\d.,\s]*/);
  if (!m) return NaN;
  const cleaned = m[0].replace(/[\s,]/g, "");
  return Number(cleaned);
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => {
      const id = r.getAttribute("data-id") || "";
      const customer =
        (r.querySelector(".customer, h1, h2, h3, h4")?.textContent || "").trim();
      const totalEl = r.querySelector(".total, strong");
      let totalText = (totalEl?.textContent || "").trim();
      if (!totalText) {
        const m = (r.textContent || "").match(/Total:\s*([^\n]+)/i);
        totalText = m ? m[1].trim() : "";
      }
      return { id, customer, totalText };
    })
  );
}

function nextControl(page) {
  return page
    .locator("#pager")
    .locator("button, a")
    .filter({ hasText: /next|›|»|>/i })
    .first();
}

async function signature(page) {
  return page
    .locator(ROW)
    .evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
}

async function goNext(page) {
  const next = nextControl(page);
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

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);
  const row = page.locator(ROW).filter({ has: page.locator("xpath=.") }).and(
    page.locator(`[data-id="${String(id).replace(/"/g, '\\"')}"]`)
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
  await row.getByRole("button", { name: /cancel/i }).first().click();

  // Optional in-page confirmation dialog
  const confirm = page
    .locator('[role="dialog"], [role="alertdialog"], .modal')
    .getByRole("button", { name: /^(confirm|yes|ok|cancel order|yes, cancel.*)$/i })
    .first();
  if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
    await confirm.click();
  }

  try {
    await expect(async () => {
      const n = await row.count();
      if (n === 0) return;
      // Row still present: accept only if its cancel button is gone
      const btns = await row.getByRole("button", { name: /cancel/i }).count();
      expect(btns).toBe(0);
    }).toPass({ timeout: 7000 });
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  }
}
