import { expect } from "@playwright/test";

const ROW = ".order-row";
const apiTotals = new WeakMap(); // page -> Map(id -> number), from JSON responses seen on the wire

function parseTotal(text) {
  const t = (text ?? "").toString().trim();
  if (!/\d/.test(t)) return NaN; // placeholder such as "—"
  const n = Number(t.replace(/[^0-9.,-]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function watchApi(page) {
  if (apiTotals.has(page)) return;
  const map = new Map();
  apiTotals.set(page, map);
  page.on("response", async (res) => {
    try {
      const type = res.headers()["content-type"] || "";
      if (!type.includes("json")) return;
      const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (v && typeof v === "object") {
          const id = v.id ?? v.orderId ?? v.order_id;
          const tot = v.total ?? v.amount ?? v.totalAmount;
          if (id != null && tot != null) {
            const n = typeof tot === "number" ? tot : parseTotal(tot);
            if (Number.isFinite(n)) map.set(String(id), n);
          }
          Object.values(v).forEach(walk);
        }
      };
      walk(await res.json());
    } catch {}
  });
}

async function totalsReady(page, timeout) {
  try {
    await page.waitForFunction(
      () => {
        const rows = Array.from(document.querySelectorAll(".order-row"));
        return (
          rows.length > 0 &&
          rows.every((r) => /\d/.test(r.querySelector(".total")?.textContent || ""))
        );
      },
      undefined,
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

// Totals may be filled lazily (scroll/hover/viewport) or slowly; nudge the page, then wait.
async function nudge(page) {
  const rows = page.locator(ROW);
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const r = rows.nth(i);
    await r.scrollIntoViewIfNeeded().catch(() => {});
    await r.hover({ timeout: 500 }).catch(() => {});
  }
}

async function waitForTotals(page, timeout = 15000) {
  if (await totalsReady(page, 3000)) return true;
  await nudge(page);
  return totalsReady(page, timeout);
}

async function openHome(page, baseUrl) {
  watchApi(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.locator("#orders-root").waitFor();
    await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
    if (await waitForTotals(page)) return;
    // second attempt reloads the page in case the fill-in script stalled
  }
}

async function readRowsRaw(page) {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => ({
      id: r.getAttribute("data-id") || r.querySelector(".id")?.textContent?.trim() || "",
      customer: r.querySelector(".customer")?.textContent?.trim() || "",
      totalText: r.querySelector(".total")?.textContent?.trim() || "",
    }))
  );
}

function resolveTotal(page, r) {
  const fromDom = parseTotal(r.totalText);
  if (Number.isFinite(fromDom)) return fromDom;
  const fromApi = apiTotals.get(page)?.get(r.id);
  return Number.isFinite(fromApi) ? fromApi : NaN;
}

async function readRows(page) {
  let rows = await readRowsRaw(page);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (rows.every((r) => Number.isFinite(resolveTotal(page, r)))) break;
    await waitForTotals(page, 5000);
    await page.waitForTimeout(300);
    rows = await readRowsRaw(page);
  }
  return rows;
}

function nextControl(page) {
  return page
    .locator("#pager")
    .locator("button, a")
    .filter({ hasText: /next|›|»|>/i })
    .first();
}

async function goNext(page) {
  const next = nextControl(page);
  if ((await next.count()) === 0) return false;
  if (!(await next.isVisible().catch(() => false))) return false;
  if (await next.isDisabled().catch(() => false)) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;
  const before = await page
    .locator(ROW)
    .evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
  await next.click();
  try {
    await page.waitForFunction(
      (prev) =>
        Array.from(document.querySelectorAll(".order-row"))
          .map((x) => x.getAttribute("data-id"))
          .join("|") !== prev,
      before,
      { timeout: 5000 }
    );
  } catch {
    return false;
  }
  await waitForTotals(page);
  return true;
}

export async function listOpenOrders(page, baseUrl) {
  await openHome(page, baseUrl);
  const seen = new Map();
  for (let i = 0; i < 200; i++) {
    for (const r of await readRows(page)) {
      if (!r.id || seen.has(r.id)) continue;
      const total = resolveTotal(page, r);
      if (!Number.isFinite(total)) {
        throw new Error(`Total for order ${r.id} did not load (saw "${r.totalText}")`);
      }
      seen.set(r.id, { id: r.id, customer: r.customer, total });
    }
    if (!(await goNext(page))) break;
  }
  return Array.from(seen.values());
}

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);
  const row = page.locator(`${ROW}[data-id="${id}"]`);

  let found = false;
  for (let i = 0; i < 200; i++) {
    if ((await row.count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  page.once("dialog", (d) => d.accept().catch(() => {}));
  await row.getByRole("button", { name: /cancel/i }).click();

  const confirm = page
    .locator('[role="dialog"], [role="alertdialog"], .modal')
    .getByRole("button", { name: /^(confirm|yes|ok|cancel order|yes, cancel.*)$/i })
    .first();
  if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
    await confirm.click();
  }

  try {
    await expect(row).toHaveCount(0, { timeout: 7000 });
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  }
}
