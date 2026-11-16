import { expect } from "@playwright/test";

const ROW = ".order-row";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator("#orders-root").waitFor();
  await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
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

function rowLocator(page, id) {
  return page.locator(ROW).filter({
    has: page.locator(`xpath=self::*[@data-id=${JSON.stringify(String(id))}]`),
  });
}

function exactRow(page, id) {
  return page.locator(`${ROW}[data-id=${JSON.stringify(String(id))}]`);
}

async function findRow(page, id) {
  const row = exactRow(page, id);
  for (let i = 0; i < 200; i++) {
    if ((await row.count()) > 0) return true;
    if (!(await goNext(page))) break;
  }
  return false;
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

  if (!(await findRow(page, id))) return { cancelled: false, id };

  const row = exactRow(page, id);
  const nativeHandler = (d) => d.accept().catch(() => {});
  page.on("dialog", nativeHandler);

  try {
    await row.getByRole("button", { name: /cancel/i }).click();

    // The site uses a native <dialog id="confirm"> (not matched by [role=dialog] CSS).
    const dialog = page.locator("dialog[open], #confirm[open], [role='dialog'], [role='alertdialog'], .modal");
    const confirm = dialog
      .getByRole("button", { name: /^(confirm|yes|ok|yes, cancel.*|cancel order)$/i })
      .first();
    try {
      await confirm.waitFor({ state: "visible", timeout: 3000 });
      await confirm.click();
    } catch {
      // confirmation may not appear (e.g. native dialog already handled)
    }

    try {
      await expect(row).toHaveCount(0, { timeout: 7000 });
      return { cancelled: true, id };
    } catch {
      // Fall back to a fresh load to verify the order is really gone.
      await openHome(page, baseUrl);
      const stillThere = await findRow(page, id);
      return { cancelled: !stillThere, id };
    }
  } finally {
    page.off("dialog", nativeHandler);
  }
}
