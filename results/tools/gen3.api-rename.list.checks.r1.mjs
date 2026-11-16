import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row";

function parseTotal(text) {
  const s = (text || "").replace(/[^0-9.,\-]/g, "");
  if (!/[0-9]/.test(s)) return NaN;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let normalized;
  if (lastDot !== -1 && lastComma !== -1) {
    // Whichever separator comes last is the decimal separator.
    normalized =
      lastComma > lastDot
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (lastComma !== -1) {
    // Single comma: decimal if followed by 1-2 digits at the end, else thousands.
    normalized = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  } else {
    normalized = s;
  }
  const n = parseFloat(normalized);
  return Number.isNaN(n) ? NaN : n;
}

async function load(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROW, { timeout: 10000 }).catch(() => {});
}

// Totals may render asynchronously (placeholder "—" first). Wait until every row has a digit.
async function waitForTotals(page) {
  await page
    .waitForFunction(
      (sel) => {
        const rows = [...document.querySelectorAll(sel)];
        if (rows.length === 0) return true;
        return rows.every((r) => {
          const t = r.querySelector(".total")?.textContent || "";
          return /[0-9]/.test(t) || /[0-9]/.test(r.getAttribute("data-total") || "");
        });
      },
      ROW,
      { timeout: 10000 }
    )
    .catch(() => {});
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
      totalAttr: r.getAttribute("data-total") || "",
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
    await waitForTotals(page);
    const rows = await readRows(page);
    let added = 0;
    for (const r of rows) {
      if (r.id && !seen.has(r.id)) {
        let total = parseTotal(r.totalText);
        if (Number.isNaN(total)) total = parseTotal(r.totalAttr);
        if (Number.isNaN(total)) {
          throw new Error(`Could not read a numeric total for order ${r.id} (got "${r.totalText}")`);
        }
        seen.set(r.id, { id: r.id, customer: r.customer, total });
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

  const sel = `${ROW}[data-id="${String(id).replace(/"/g, '\\"')}"]`;
  let row = null;
  for (let i = 0; i < 100; i++) {
    const candidate = page.locator(sel);
    if ((await candidate.count()) > 0) {
      row = candidate.first();
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!row) return { cancelled: false, id };

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

  try {
    await expect(page.locator(sel)).toHaveCount(0, { timeout: 7000 });
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  }
}
