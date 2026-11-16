import { expect } from "@playwright/test";

const ROW = "#ord-root tbody tr[data-id]";

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function rowById(page, id) {
  const safe = String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return page.locator(`${ROW}[data-id="${safe}"]`);
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
    rows.map((r) => {
      const cells = r.querySelectorAll("td");
      return {
        id:
          r.getAttribute("data-id") ||
          cells[0]?.textContent?.trim() ||
          "",
        customer: cells[1]?.textContent?.trim() || "",
        totalText: cells[2]?.textContent?.trim() || "",
      };
    })
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
        seen.set(r.id, {
          id: r.id,
          customer: r.customer,
          total: parseTotal(r.totalText),
        });
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
    if ((await rowById(page, id).count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  const row = rowById(page, id).first();

  page.once("dialog", (d) => d.accept().catch(() => {}));
  await row.getByRole("button", { name: /cancel/i }).click();

  // Handle an in-page confirmation modal, if one appears.
  const confirm = page
    .locator('[role="dialog"], [role="alertdialog"], .modal')
    .getByRole("button", { name: /confirm|yes|ok|proceed/i })
    .first();
  try {
    await confirm.click({ timeout: 1000 });
  } catch {}

  // Success: the row disappears, or it no longer offers a Cancel button.
  try {
    await expect(async () => {
      const target = rowById(page, id);
      const count = await target.count();
      if (count === 0) return;
      const stillCancellable = await target
        .first()
        .getByRole("button", { name: /^\s*cancel\s*$/i })
        .count();
      expect(stillCancellable).toBe(0);
    }).toPass({ timeout: 7000 });
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  }
}
