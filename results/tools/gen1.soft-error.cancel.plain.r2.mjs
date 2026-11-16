import { expect } from "@playwright/test";

const ROW = ".order-row";
const ERROR_BANNER = '#orders-root [role="alert"], #orders-root .banner';
const MAX_ATTEMPTS = 4;

async function loadState(page) {
  // Wait until rows, an error banner, or an explicit empty state appears.
  await page
    .waitForFunction(
      () =>
        document.querySelector(".order-row") ||
        document.querySelector('#orders-root [role="alert"], #orders-root .banner') ||
        /^\s*0\s+open/i.test(document.querySelector('[data-testid="open-count"]')?.textContent || ""),
      null,
      { timeout: 8000 }
    )
    .catch(() => {});
  if ((await page.locator(ROW).count()) > 0) return { ok: true };
  const banner = page.locator(ERROR_BANNER).first();
  if (await banner.isVisible().catch(() => false)) {
    const msg = ((await banner.textContent().catch(() => "")) || "").trim();
    return { ok: false, message: msg };
  }
  return { ok: true }; // genuinely empty
}

async function openHome(page, baseUrl) {
  let last = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt === 0) {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    } else {
      await page.waitForTimeout(1500 * attempt);
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.locator("#orders-root").waitFor();
    const state = await loadState(page);
    if (state.ok) return;
    last = state.message;
  }
  // Fail loudly: never return an empty list or cancelled:false when the site
  // itself could not load orders, since that would misreport real state.
  throw new Error(
    `The orders page failed to load after ${MAX_ATTEMPTS} attempts (site reported: "${last}"). ` +
      `This is a site-side error, not a missing order; try again later.`
  );
}

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  return Number(cleaned);
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

function nextControl(page) {
  return page
    .locator("#pager")
    .locator("button, a")
    .filter({ hasText: /next|›|»|>/i })
    .first();
}

async function goNext(page) {
  const next = nextControl(page);
  if ((await next.count()) === 0) return false;
  if (!(await next.isVisible().catch(() => false))) return false;
  if (await next.isDisabled().catch(() => false)) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;
  const before = await page
    .locator(ROW)
    .evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
  await next.click();
  try {
    await page.waitForFunction(
      (prev) =>
        Array.from(document.querySelectorAll(".order-row"))
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
  const row = page.locator(`${ROW}[data-id="${id}"]`);

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
