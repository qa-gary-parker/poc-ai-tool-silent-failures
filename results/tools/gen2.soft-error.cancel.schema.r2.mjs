import { expect } from "@playwright/test";

const ROW = "tr.order-row";
const ERROR_BANNER = '#orders-root [role="alert"], #orders-root .banner';
const MAX_LOAD_ATTEMPTS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bannerText(page) {
  const banner = page.locator(ERROR_BANNER).first();
  if (await banner.isVisible().catch(() => false)) {
    return (await banner.textContent().catch(() => ""))?.trim() || "error banner shown";
  }
  return null;
}

// Loads the orders page, retrying with backoff when the page shows a load error
// (the failure is often transient). Throws only if every attempt fails.
async function openHome(page, baseUrl) {
  let lastMsg = null;
  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt++) {
    if (attempt === 1) {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    } else {
      await sleep(500 * 2 ** (attempt - 2));
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    }

    // Wait for either order rows or an error banner. The table is hidden when
    // empty, so don't wait on the table itself.
    const outcome = page.locator(ROW).first().or(page.locator(ERROR_BANNER).first());
    try {
      await outcome.waitFor({ state: "visible", timeout: 15000 });
    } catch {
      // Neither appeared: possibly a genuinely empty list.
    }

    let msg = await bannerText(page);
    if (!msg) return;

    // Banner may be transient; give rows a short chance to appear before retrying.
    try {
      await page.locator(ROW).first().waitFor({ state: "visible", timeout: 2000 });
    } catch {
      // still no rows
    }
    if (await page.locator(ROW).count()) {
      if (!(await bannerText(page))) return;
    }
    msg = await bannerText(page);
    if (!msg) return;
    lastMsg = msg;
  }
  throw new Error(`Orders page failed to load: ${lastMsg}`);
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
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await openHome(page, baseUrl);

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
