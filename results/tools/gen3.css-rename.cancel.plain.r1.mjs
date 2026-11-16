import { expect } from "@playwright/test";

const ROW = "#ord-root tbody tr[data-id]";

function parseTotal(text) {
  let s = (text || "").replace(/[^0-9.,\-]/g, "");
  // Handle both "1,234.50" and "1.234,50" styles.
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastComma > lastDot) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

function rowFor(page, id) {
  return page.locator(ROW).and(page.locator(`[data-id="${String(id).replace(/(["\\])/g, "\\$1")}"]`));
}

async function load(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROW, { timeout: 10000 }).catch(() => {});
}

async function firstRowId(page) {
  return page.locator(ROW).first().getAttribute("data-id").catch(() => null);
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => ({
      id: r.getAttribute("data-id") || r.querySelector(".c-id")?.textContent?.trim() || "",
      customer: r.querySelector(".c-cus")?.textContent?.trim() || "",
      totalText: r.querySelector(".c-tot")?.textContent?.trim() || "",
    }))
  );
}

// Advance to the next page if a pager control exists. Returns false when there is none.
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

  let found = false;
  for (let i = 0; i < 100; i++) {
    if ((await rowFor(page, id).count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  const row = rowFor(page, id).first();
  const dialogHandler = (d) => d.accept().catch(() => {});
  page.on("dialog", dialogHandler);

  try {
    await row.getByRole("button", { name: /cancel/i }).click();

    // Handle an in-page confirmation modal, if one appears.
    const confirm = page
      .locator('[role="dialog"], [role="alertdialog"], .modal')
      .getByRole("button", { name: /confirm|yes|ok|proceed/i })
      .first();
    try {
      await confirm.click({ timeout: 1000 });
    } catch {}

    try {
      await expect(rowFor(page, id)).toHaveCount(0, { timeout: 7000 });
      return { cancelled: true, id };
    } catch {
      // Row may remain but be marked as cancelled / no longer open.
      const still = rowFor(page, id);
      if ((await still.count()) > 0) {
        const text = ((await still.first().textContent().catch(() => "")) || "").toLowerCase();
        const btnVisible = await still
          .first()
          .getByRole("button", { name: /cancel/i })
          .isVisible()
          .catch(() => false);
        if (/cancell?ed/.test(text) && !btnVisible) return { cancelled: true, id };
      }
      return { cancelled: false, id };
    }
  } finally {
    page.off("dialog", dialogHandler);
  }
}
