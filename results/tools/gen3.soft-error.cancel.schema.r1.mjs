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

// Load the page, retrying when the app shows its "couldn't load your orders" banner.
async function load(page, baseUrl, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(
        ({ row, banner }) =>
          document.querySelector(row) || document.querySelector(banner),
        { row: ROW, banner: BANNER },
        { timeout: 8000 }
      );
    } catch {
      // Neither rows nor banner: treat as a legitimately empty list.
      return true;
    }
    if ((await page.locator(ROW).count()) > 0) return true;
    // Banner shown with no rows: back off and retry.
    await page.waitForTimeout(500 * (i + 1));
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

// Walk pages looking for the row with this id. Returns a locator or null.
async function findRow(page, id) {
  for (let i = 0; i < 100; i++) {
    const candidate = page.locator(rowSel(id));
    if ((await candidate.count()) > 0) return candidate.first();
    if (!(await goNext(page))) break;
  }
  return null;
}

export async function listOpenOrders(page, baseUrl) {
  await load(page, baseUrl);

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

export async function cancelOrder(page, baseUrl, id) {
  await load(page, baseUrl);

  const row = await findRow(page, id);
  if (!row) return { cancelled: false, id };

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await row.getByRole("button", { name: /cancel/i }).first().click();

    // Optional in-page confirmation modal.
    const confirm = page
      .locator('[role="dialog"], [role="alertdialog"], .modal')
      .getByRole("button", { name: /confirm|yes|ok|proceed/i })
      .first();
    try {
      await confirm.click({ timeout: 1500 });
    } catch {}

    // Row disappears, or is marked cancelled in place.
    let done = false;
    try {
      await expect
        .poll(
          async () => {
            const loc = page.locator(rowSel(id));
            if ((await loc.count()) === 0) return true;
            const text = (await loc.first().textContent()) || "";
            const cls = (await loc.first().getAttribute("class")) || "";
            const status = (await loc.first().getAttribute("data-status")) || "";
            return /cancel/i.test(text + " " + cls + " " + status) &&
              (await loc.first().getByRole("button", { name: /cancel/i }).count()) === 0;
          },
          { timeout: 7000 }
        )
        .toBe(true);
      done = true;
    } catch {}

    // Confirm against the server state with a fresh load.
    if (await load(page, baseUrl)) {
      const still = await findRow(page, id);
      if (!still) return { cancelled: true, id };
      const text = ((await still.textContent()) || "").toLowerCase();
      const hasCancelBtn = (await still.getByRole("button", { name: /cancel/i }).count()) > 0;
      if (!hasCancelBtn && /cancel/.test(text)) return { cancelled: true, id };
      return { cancelled: false, id };
    }
    return { cancelled: done, id };
  } finally {
    page.off("dialog", onDialog);
  }
}
