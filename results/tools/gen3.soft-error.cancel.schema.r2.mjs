import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row";
const BANNER = '#orders-root .banner, #orders-root [role="alert"]';

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function rowSel(id) {
  return `${ROW}[data-id="${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

async function pageState(page) {
  return page
    .evaluate(
      ({ row, banner }) => {
        if (document.querySelector(row)) return "rows";
        if (document.querySelector(banner)) return "banner";
        return "none";
      },
      { row: ROW, banner: BANNER }
    )
    .catch(() => "none");
}

// Load the page. The backend intermittently fails and the app shows a
// "couldn't load your orders" banner with no rows; reload until it works.
// Returns true when the list loaded (possibly legitimately empty), false if
// the banner never cleared.
async function load(page, baseUrl, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + 6000;
    let bannerSince = null;
    let noneSince = null;
    while (Date.now() < deadline) {
      const s = await pageState(page);
      if (s === "rows") return true;
      if (s === "banner") {
        noneSince = null;
        bannerSince = bannerSince ?? Date.now();
        // Give the app a moment to self-recover, then reload.
        if (Date.now() - bannerSince > 1200) break;
      } else {
        bannerSince = null;
        noneSince = noneSince ?? Date.now();
        // Stable with neither rows nor banner: a genuinely empty list.
        if (Date.now() - noneSince > 2000) return true;
      }
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(300 * (i + 1));
  }
  return false;
}

async function firstRowId(page) {
  return page.locator(ROW).first().getAttribute("data-id").catch(() => null);
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

async function goNext(page) {
  const next = page
    .locator("#pager")
    .locator("a, button")
    .filter({ hasText: /next|›|»|>/i })
    .first();
  if ((await next.count()) === 0) return false;
  if (!(await next.isEnabled().catch(() => false))) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;

  const before = await firstRowId(page);
  await next.click();
  try {
    await page.waitForFunction(
      ({ sel, before }) => {
        const el = document.querySelector(sel);
        return el && el.getAttribute("data-id") !== before;
      },
      { sel: ROW, before },
      { timeout: 5000 }
    );
  } catch {
    return false;
  }
  return true;
}

async function findRow(page, id) {
  for (let i = 0; i < 100; i++) {
    const candidate = page.locator(rowSel(id));
    if ((await candidate.count()) > 0) return candidate.first();
    if (!(await goNext(page))) break;
  }
  return null;
}

export async function listOpenOrders(page, baseUrl) {
  if (!(await load(page, baseUrl))) {
    throw new Error("Orders page failed to load (error banner persisted)");
  }

  const seen = new Map();
  for (let i = 0; i < 100; i++) {
    const rows = await readRows(page);
    let added = 0;
    for (const r of rows) {
      if (r.id && !seen.has(r.id)) {
        seen.set(r.id, { id: r.id, customer: r.customer, total: parseTotal(r.totalText) });
        added++;
      }
    }
    if (added === 0) break;
    if (!(await goNext(page))) break;
  }
  return [...seen.values()];
}

async function isCancelledRow(row) {
  const text = ((await row.textContent()) || "").toLowerCase();
  const cls = ((await row.getAttribute("class")) || "").toLowerCase();
  const status = ((await row.getAttribute("data-status")) || "").toLowerCase();
  const hasBtn = (await row.getByRole("button", { name: /cancel/i }).count()) > 0;
  return !hasBtn && /cancel/.test(text + " " + cls + " " + status);
}

export async function cancelOrder(page, baseUrl, id) {
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  let clicked = false;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!(await load(page, baseUrl))) continue;

      const row = await findRow(page, id);
      if (!row) {
        // Gone after we already clicked cancel => it worked.
        return { cancelled: clicked, id };
      }
      if (await isCancelledRow(row)) return { cancelled: true, id };

      const btn = row.getByRole("button", { name: /cancel/i }).first();
      if ((await btn.count()) === 0) return { cancelled: false, id };
      await btn.click();
      clicked = true;

      // Optional in-page confirmation modal.
      try {
        await page
          .locator('[role="dialog"], [role="alertdialog"], .modal')
          .getByRole("button", { name: /confirm|yes|ok|proceed/i })
          .first()
          .click({ timeout: 1500 });
      } catch {}

      // Wait for the row to disappear or be marked cancelled.
      try {
        await expect
          .poll(
            async () => {
              const loc = page.locator(rowSel(id));
              if ((await loc.count()) === 0) return true;
              return await isCancelledRow(loc.first());
            },
            { timeout: 7000 }
          )
          .toBe(true);
      } catch {}

      // Verify against server state with a fresh load.
      if (await load(page, baseUrl)) {
        const still = await findRow(page, id);
        if (!still) return { cancelled: true, id };
        if (await isCancelledRow(still)) return { cancelled: true, id };
        // Still open: loop and try again.
      }
    }
    return { cancelled: false, id };
  } finally {
    page.off("dialog", onDialog);
  }
}
