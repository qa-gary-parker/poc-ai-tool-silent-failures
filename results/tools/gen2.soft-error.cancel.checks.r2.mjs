import { expect } from "@playwright/test";

const ROW = "tr.order-row";
const BANNER = '#orders-root [role="alert"], #orders-root .banner';

function parseTotal(text) {
  const cleaned = String(text).replace(/[^0-9.,-]/g, "");
  return Number(cleaned.replace(/,/g, ""));
}

const sleep = (page, ms) => page.waitForTimeout(ms);

async function hasRows(page) {
  return (await page.locator(ROW).count()) > 0;
}

async function bannerText(page) {
  const banner = page.locator(BANNER).first();
  if (await banner.isVisible().catch(() => false)) {
    return (await banner.textContent().catch(() => ""))?.trim() || "unknown error";
  }
  return null;
}

// Waits until rows or a banner is present (or timeout).
async function settle(page, timeout) {
  await page
    .waitForFunction(
      ({ row, banner }) =>
        document.querySelector(row) || document.querySelector(banner),
      { row: ROW, banner: BANNER },
      { timeout }
    )
    .catch(() => {});
}

// Loads the home page. Retries with exponential backoff when the page reports an
// error, and finally throws so callers never mistake a failed load for "no orders".
async function openHome(page, baseUrl) {
  const attempts = 6;
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt === 0) {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    } else {
      await sleep(page, Math.min(500 * 2 ** (attempt - 1), 5000));
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    }
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await settle(page, 8000);

    let err = await bannerText(page);
    if (err === null) {
      // Rows, or a genuinely empty list with no error.
      return;
    }

    // The app may recover by itself; give it a moment.
    await page
      .waitForFunction(
        ({ row, banner }) =>
          document.querySelector(row) || !document.querySelector(banner),
        { row: ROW, banner: BANNER },
        { timeout: 2000 }
      )
      .catch(() => {});
    if (await hasRows(page)) return;
    err = await bannerText(page);
    if (err === null) return;
    lastError = err;

    // Try an in-page retry control if one exists.
    const retry = page
      .locator("#orders-root")
      .getByRole("button", { name: /retry|try again|reload/i })
      .first();
    if (await retry.isVisible().catch(() => false)) {
      await retry.click().catch(() => {});
      await settle(page, 5000);
      if (await hasRows(page)) return;
      if ((await bannerText(page)) === null) return;
    }
  }
  throw new Error(`Orders page failed to load after ${attempts} attempts: ${lastError}`);
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

// Clicks the pager's "next" control if present and enabled. Returns true if the page changed.
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

function rowFor(page, id) {
  return page.locator(`${ROW}[data-id=${JSON.stringify(String(id))}]`);
}

// Walks pages from the current one until the row is found.
async function findRow(page, id) {
  const row = rowFor(page, id);
  for (let i = 0; i < 100; i++) {
    if (await row.count()) return row;
    if (!(await goNext(page))) break;
  }
  return null;
}

export async function listOpenOrders(page, baseUrl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await openHome(page, baseUrl);
    const seen = new Map();
    let failed = false;
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
      if ((await bannerText(page)) !== null) {
        failed = true;
        break;
      }
    }
    if (!failed) return [...seen.values()];
  }
  throw new Error("Orders list kept failing while paging");
}

export async function cancelOrder(page, baseUrl, id) {
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await openHome(page, baseUrl);
      const row = await findRow(page, id);
      if (!row) {
        // Not found on a clean load: confirm it's not just gone because of an error.
        if ((await bannerText(page)) === null) return { cancelled: false, id };
        continue;
      }

      await row.getByRole("button", { name: /cancel/i }).click();

      // Handle an in-page confirmation modal, if one appears.
      const confirm = page
        .getByRole("dialog")
        .getByRole("button", { name: /confirm|yes|ok|cancel order/i })
        .first();
      if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
        await confirm.click();
      }

      // Let the UI settle; an error banner means the action (or re-render) failed.
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await row.waitFor({ state: "detached", timeout: 8000 }).catch(() => {});

      // Verify against a fresh load rather than trusting the row disappearing.
      await openHome(page, baseUrl);
      const still = await findRow(page, id);
      if (!still) return { cancelled: true, id };
    }
    return { cancelled: false, id };
  } finally {
    page.off("dialog", onDialog);
  }
}
