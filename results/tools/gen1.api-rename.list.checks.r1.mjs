import { expect } from "@playwright/test";

const ROW = ".order-row";

async function waitForTotals(page, timeout = 10000) {
  // Totals are rendered as a placeholder ("—") until the page fills them in.
  await page
    .waitForFunction(
      () => {
        const rows = Array.from(document.querySelectorAll(".order-row"));
        if (rows.length === 0) return false;
        return rows.every((r) => /\d/.test(r.querySelector(".total")?.textContent || ""));
      },
      undefined,
      { timeout }
    )
    .catch(() => {});
}

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator("#orders-root").waitFor();
  await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
  await waitForTotals(page);
}

function parseTotal(text) {
  const t = (text || "").trim();
  if (!/\d/.test(t)) return NaN; // placeholder such as "—"
  const cleaned = t.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
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

async function readRows(page) {
  let rows = await readRowsRaw(page);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (rows.every((r) => Number.isFinite(parseTotal(r.totalText)))) break;
    await waitForTotals(page, 3000);
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
  const ariaDisabled = await next.getAttribute("aria-disabled");
  if (ariaDisabled === "true") return false;
  const before = await page.locator(ROW).evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
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
      const total = parseTotal(r.totalText);
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

  // Optional in-page confirmation dialog
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
