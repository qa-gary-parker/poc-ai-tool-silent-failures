import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row";

function parseTotal(text) {
  const s = (text == null ? "" : String(text)).replace(/[^0-9.,\-]/g, "");
  if (!/[0-9]/.test(s)) return NaN;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let normalized;
  if (lastDot !== -1 && lastComma !== -1) {
    normalized =
      lastComma > lastDot
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (lastComma !== -1) {
    normalized = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  } else {
    normalized = s;
  }
  const n = parseFloat(normalized);
  return Number.isNaN(n) ? NaN : n;
}

// Collect order totals from any JSON the page loads (fallback when the DOM never shows them).
function captureApiTotals(page) {
  const totals = new Map();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const id = v.id ?? v.orderId ?? v.order_id;
      const t = v.total ?? v.totalAmount ?? v.total_amount ?? v.amount ?? v.price;
      if (id != null && t != null && typeof t !== "object") {
        const n = typeof t === "number" ? t : parseTotal(t);
        if (!Number.isNaN(n)) totals.set(String(id), n);
      }
      Object.values(v).forEach(walk);
    }
  };
  const handler = async (resp) => {
    try {
      const ct = resp.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      walk(await resp.json());
    } catch {}
  };
  page.on("response", handler);
  return { totals, stop: () => page.off("response", handler) };
}

async function load(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROW, { timeout: 10000 }).catch(() => {});
}

async function nudgeLazyTotals(page) {
  // Some UIs fill totals only once rows are visible/hovered.
  const rows = page.locator(ROW);
  const n = Math.min(await rows.count().catch(() => 0), 50);
  for (let i = 0; i < n; i++) {
    await rows.nth(i).scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => {});
  }
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
}

async function waitForTotals(page) {
  await nudgeLazyTotals(page);
  await page
    .waitForFunction(
      (sel) => {
        const rows = [...document.querySelectorAll(sel)];
        if (rows.length === 0) return true;
        return rows.every((r) => {
          const t = r.querySelector(".total")?.textContent || "";
          if (/[0-9]/.test(t)) return true;
          return [r, r.querySelector(".total")].some(
            (el) => el && [...el.attributes].some((a) => /total|amount|price/i.test(a.name) && /[0-9]/.test(a.value))
          );
        });
      },
      ROW,
      { timeout: 20000, polling: 200 }
    )
    .catch(() => {});
}

async function firstRowId(page) {
  return page.locator(ROW).first().getAttribute("data-id").catch(() => null);
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => {
      const cell = r.querySelector(".total");
      const attrs = [];
      for (const el of [cell, r]) {
        if (!el) continue;
        for (const a of el.attributes) {
          if (/total|amount|price/i.test(a.name)) attrs.push(a.value);
        }
      }
      return {
        id: r.getAttribute("data-id") || r.querySelector(".id")?.textContent?.trim() || "",
        customer: r.querySelector(".customer")?.textContent?.trim() || "",
        totalText: cell?.textContent?.trim() || "",
        totalAttrs: attrs,
      };
    })
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

export async function listOpenOrders(page, baseUrl) {
  const api = captureApiTotals(page);
  try {
    await load(page, baseUrl);

    const seen = new Map();
    for (let i = 0; i < 100; i++) {
      await waitForTotals(page);
      const rows = await readRows(page);
      let added = 0;
      for (const r of rows) {
        if (r.id && !seen.has(r.id)) {
          let total = parseTotal(r.totalText);
          for (const a of r.totalAttrs) {
            if (!Number.isNaN(total)) break;
            total = parseTotal(a);
          }
          if (Number.isNaN(total) && api.totals.has(r.id)) total = api.totals.get(r.id);
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
  } finally {
    api.stop();
  }
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
