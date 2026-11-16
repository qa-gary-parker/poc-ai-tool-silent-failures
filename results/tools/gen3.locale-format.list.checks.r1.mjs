import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row";

// Parses amounts in either "1,234.50" or "1.234,50" style (with any currency symbol/spaces).
function parseTotal(text) {
  const s = (text || "").replace(/[\u00a0\u202f\s]/g, "");
  const negative = /^-|^\(.*\)$|-$/.test(s);
  const cleaned = s.replace(/[^0-9.,]/g, "");
  if (!cleaned) return 0;

  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let decimalSep = null;

  if (lastDot !== -1 && lastComma !== -1) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const parts = cleaned.split(sep);
    if (parts.length > 2) {
      decimalSep = null; // repeated separator => thousands grouping
    } else {
      const [head, tail] = parts;
      const looksThousands = tail.length === 3 && head.length >= 1 && head.length <= 3 && head !== "0";
      decimalSep = looksThousands ? null : sep;
    }
  }

  let normalized;
  if (decimalSep) {
    const idx = cleaned.lastIndexOf(decimalSep);
    const intPart = cleaned.slice(0, idx).replace(/[.,]/g, "");
    const fracPart = cleaned.slice(idx + 1).replace(/[.,]/g, "");
    normalized = `${intPart || "0"}.${fracPart}`;
  } else {
    normalized = cleaned.replace(/[.,]/g, "");
  }

  const n = parseFloat(normalized);
  if (Number.isNaN(n)) return 0;
  return negative ? -n : n;
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
      id: r.getAttribute("data-id") || r.querySelector(".id")?.textContent?.trim() || "",
      customer: r.querySelector(".customer")?.textContent?.trim() || "",
      totalText: r.querySelector(".total")?.textContent?.trim() || "",
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
