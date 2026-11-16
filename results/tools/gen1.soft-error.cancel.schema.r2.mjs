import { expect } from "@playwright/test";

const ROW = ".order-row, #orders-root table tbody tr";
const BANNER = '#orders-root .banner, #orders-root [role="alert"]';

const rowsLoc = (page) => page.locator(ROW).filter({ hasNot: page.locator("th") });

async function settle(page) {
  // Wait until rows appear, or the banner is shown and stays shown.
  const deadline = Date.now() + 8000;
  let bannerSince = null;
  while (Date.now() < deadline) {
    if ((await rowsLoc(page).count()) > 0) return "rows";
    const bannerVisible = await page.locator(BANNER).first().isVisible().catch(() => false);
    if (bannerVisible) {
      bannerSince ??= Date.now();
      // Try an in-page retry control if the banner offers one.
      const retry = page
        .locator('#orders-root')
        .getByRole("button", { name: /retry|try again|reload/i })
        .first();
      if (await retry.isVisible().catch(() => false)) {
        await retry.click().catch(() => {});
        bannerSince = null;
      } else if (Date.now() - bannerSince > 2500) {
        return "error";
      }
    } else {
      bannerSince = null;
      const countText = (await page.getByTestId("open-count").textContent().catch(() => "")) || "";
      if (/^\s*0\b/.test(countText) && Date.now() - deadline + 8000 > 1500) return "empty";
    }
    await page.waitForTimeout(150);
  }
  return (await page.locator(BANNER).first().isVisible().catch(() => false)) ? "error" : "empty";
}

async function openHome(page, baseUrl) {
  const attempts = 6;
  let lastError = "unknown";
  for (let attempt = 0; attempt < attempts; attempt++) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#orders-root").waitFor();
    const state = await settle(page);
    if (state === "rows" || state === "empty") return;
    lastError =
      ((await page.locator(BANNER).first().textContent().catch(() => "")) || "error banner").trim();
    await page.waitForTimeout(1000 * (attempt + 1));
  }
  // Do not report an empty list when the site says it failed to load.
  throw new Error(`Orders failed to load after ${attempts} attempts: ${lastError}`);
}

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  return Number(cleaned);
}

async function readRows(page) {
  return rowsLoc(page).evaluateAll((rows) =>
    rows.map((r) => {
      const cells = Array.from(r.querySelectorAll("td")).map((c) => c.textContent.trim());
      const t = (sel) => r.querySelector(sel)?.textContent?.trim();
      return {
        id: r.getAttribute("data-id") || t(".id") || cells[0] || "",
        customer: t(".customer") || cells[1] || "",
        totalText: t(".total") || cells[2] || "",
      };
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
  return (await readRows(page)).map((r) => r.id).join("|");
}

async function goNext(page) {
  const next = nextControl(page);
  if ((await next.count()) === 0) return false;
  if (!(await next.isVisible().catch(() => false))) return false;
  if (await next.isDisabled().catch(() => false)) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;
  const before = await signature(page);
  await next.click();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await signature(page)) !== before) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function findRow(page, id) {
  for (let i = 0; i < 200; i++) {
    const rows = await readRows(page);
    const idx = rows.findIndex((r) => r.id === String(id));
    if (idx >= 0) {
      const byAttr = page.locator(`.order-row[data-id="${String(id).replace(/"/g, '\\"')}"]`);
      if ((await byAttr.count()) > 0) return byAttr.first();
      return rowsLoc(page).nth(idx);
    }
    if (!(await goNext(page))) break;
  }
  return null;
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
  const row = await findRow(page, id);
  if (!row) return { cancelled: false, id };

  page.once("dialog", (d) => d.accept().catch(() => {}));
  await row.getByRole("button", { name: /cancel/i }).first().click();

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
    try {
      await openHome(page, baseUrl);
      const still = await findRow(page, id);
      return { cancelled: !still, id };
    } catch {
      return { cancelled: false, id };
    }
  }
}
