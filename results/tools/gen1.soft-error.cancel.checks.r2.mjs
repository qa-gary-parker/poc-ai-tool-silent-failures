import { expect } from "@playwright/test";

const ROW = ".order-row, table.orders tbody tr";
const ROWS_SELECTOR = ROW;
const BANNER = '#orders-root [role="alert"], #orders-root .banner';
const MAX_LOAD_ATTEMPTS = 8;

async function readBanner(page) {
  const banner = page.locator(BANNER).first();
  if ((await banner.count()) === 0) return null;
  if (!(await banner.isVisible().catch(() => false))) return null;
  return ((await banner.textContent().catch(() => "")) || "").trim() || "error";
}

async function hasRows(page) {
  return (await page.locator(ROW).count()) > 0;
}

async function openHome(page, baseUrl) {
  let lastError = "unknown error";
  const failures = [];
  const onResponse = (res) => {
    if (res.status() >= 400) failures.push(`${res.status()} ${res.url()}`);
  };
  page.on("response", onResponse);
  try {
    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt++) {
      failures.length = 0;
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.locator("#orders-root").waitFor();

      // Wait until rows render or an error banner appears.
      await page
        .waitForFunction(
          ([rowSel, bannerSel]) =>
            document.querySelector(rowSel) !== null || document.querySelector(bannerSel) !== null,
          [ROWS_SELECTOR, BANNER],
          { timeout: 5000 }
        )
        .catch(() => {});

      let banner = await readBanner(page);
      if (banner && !(await hasRows(page))) {
        // Maybe a transient banner: try an in-page retry control, then give it a moment.
        const retry = page
          .locator("#orders-root")
          .getByRole("button", { name: /retry|try again|reload/i })
          .first();
        if (await retry.isVisible().catch(() => false)) {
          await retry.click().catch(() => {});
        }
        await page.waitForTimeout(1500);
        await page.waitForLoadState("networkidle").catch(() => {});
        banner = await readBanner(page);
      }

      if (!banner || (await hasRows(page))) return; // loaded (rows present, or genuinely empty)
      lastError = banner + (failures.length ? ` [${failures.join("; ")}]` : "");
      // Exponential backoff (capped) before reloading.
      await page.waitForTimeout(Math.min(1000 * 2 ** attempt, 10000));
    }
  } finally {
    page.off("response", onResponse);
  }
  throw new Error(`Orders page failed to load after ${MAX_LOAD_ATTEMPTS} attempts: ${lastError}`);
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

async function rowSignature(page) {
  return page.locator(ROW).evaluateAll((r) =>
    r.map((x) => x.getAttribute("data-id") || x.textContent.trim()).join("|")
  );
}

async function goNext(page) {
  const next = nextControl(page);
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
          .map((x) => x.getAttribute("data-id") || x.textContent.trim())
          .join("|") !== prev,
      [ROWS_SELECTOR, before],
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
  const row = page.locator(`${ROW}`).and(page.locator(`[data-id="${id}"]`));

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
