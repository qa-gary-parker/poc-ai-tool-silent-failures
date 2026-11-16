import { expect } from "@playwright/test";

const ROW = ".order-row";
const BANNER = '.banner, [role="alert"]';

async function openHome(page, baseUrl) {
  const attempts = 6;
  let lastError = "unknown";
  for (let attempt = 0; attempt < attempts; attempt++) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.locator("#orders-root").waitFor();

    // Wait for either rows or an error banner to show up.
    await page
      .locator(`${ROW}, ${BANNER}`)
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => {});

    if ((await page.locator(ROW).count()) > 0) return;

    const banner = page.locator(`#orders-root ${BANNER}`).first();
    if (await banner.isVisible().catch(() => false)) {
      lastError = (await banner.textContent().catch(() => "")) || "error banner";
      // Transient load failure: back off and reload.
      await page.waitForTimeout(500 * (attempt + 1));
      continue;
    }

    // No rows and no error: genuinely empty list.
    return;
  }
  throw new Error(`Orders failed to load after ${attempts} attempts: ${String(lastError).trim()}`);
}

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  return Number(cleaned);
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
  return true;
}

async function findRow(page, id) {
  const row = page.locator(`${ROW}[data-id="${id}"]`);
  for (let i = 0; i < 200; i++) {
    if ((await row.count()) > 0) return row;
    if (!(await goNext(page))) break;
  }
  return null;
}

export async function listOpenOrders(page, baseUrl) {
  await openHome(page, baseUrl);
  const seen = new Map();
  for (let i = 0; i < 200; i++) {
    for (const r of await readRows(page)) {
      if (r.id && !seen.has(r.id)) {
        seen.set(r.id, { id: r.id, customer: r.customer, total: parseTotal(r.totalText) });
      }
    }
    if (!(await goNext(page))) break;
  }
  return Array.from(seen.values());
}

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);
  const row = await findRow(page, id);
  if (!row) return { cancelled: false, id };

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
    // Fall back to verifying from a fresh load.
    try {
      await openHome(page, baseUrl);
      const still = await findRow(page, id);
      return { cancelled: !still, id };
    } catch {
      return { cancelled: false, id };
    }
  }
}
