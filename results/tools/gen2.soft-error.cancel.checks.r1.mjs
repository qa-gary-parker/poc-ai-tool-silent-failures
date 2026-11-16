import { expect } from "@playwright/test";

const ROW = "tr.order-row";
const BANNER = '#orders-root [role="alert"], #orders-root .banner';

function parseTotal(text) {
  const cleaned = String(text).replace(/[^0-9.,-]/g, "");
  return Number(cleaned.replace(/,/g, ""));
}

// Loads the home page and waits until orders are shown, the list is legitimately
// empty, or the page reports an error. On error, retries (retry button, then reload)
// and finally throws so callers don't mistake a failed load for "no orders".
async function openHome(page, baseUrl) {
  const attempts = 4;
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt === 0) {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    } else {
      await page.waitForTimeout(500 * attempt);
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    // Wait for rows or an error banner to settle.
    await page
      .waitForFunction(
        ({ row, banner }) =>
          document.querySelector(row) || document.querySelector(banner),
        { row: ROW, banner: BANNER },
        { timeout: 5000 }
      )
      .catch(() => {});

    if (await page.locator(ROW).count()) return;

    const banner = page.locator(BANNER).first();
    if (await banner.isVisible().catch(() => false)) {
      lastError = (await banner.textContent().catch(() => ""))?.trim() || "unknown error";
      // Try an in-page retry control if one exists.
      const retry = page
        .locator("#orders-root")
        .getByRole("button", { name: /retry|try again|reload/i })
        .first();
      if (await retry.isVisible().catch(() => false)) {
        await retry.click().catch(() => {});
        await page
          .waitForFunction(
            (row) => document.querySelector(row),
            ROW,
            { timeout: 5000 }
          )
          .catch(() => {});
        if (await page.locator(ROW).count()) return;
      }
      continue;
    }

    // No rows and no error: a genuinely empty list.
    return;
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
  await openHome(page, baseUrl);
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);

  try {
    const row = page.locator(`${ROW}[data-id=${JSON.stringify(String(id))}]`);

    let found = false;
    for (let i = 0; i < 100; i++) {
      if (await row.count()) {
        found = true;
        break;
      }
      if (!(await goNext(page))) break;
    }
    if (!found) return { cancelled: false, id };

    await row.getByRole("button", { name: /cancel/i }).click();

    // Handle an in-page confirmation modal, if one appears.
    const confirm = page
      .getByRole("dialog")
      .getByRole("button", { name: /confirm|yes|ok|cancel order/i })
      .first();
    if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirm.click();
    }

    try {
      await row.waitFor({ state: "detached", timeout: 8000 });
      return { cancelled: true, id };
    } catch {
      return { cancelled: false, id };
    }
  } finally {
    page.off("dialog", onDialog);
  }
}
