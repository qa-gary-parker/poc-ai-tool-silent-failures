import { expect } from "@playwright/test";

const ROW = "#orders-root [data-id]";

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
    rows.map((r) => {
      const txt = (r.textContent || "").replace(/\s+/g, " ");
      const m = txt.match(/Total:\s*([^\s]+)/i);
      return {
        id: r.getAttribute("data-id") || "",
        customer: (
          r.querySelector(".customer, h1, h2, h3, h4")?.textContent || ""
        ).trim(),
        totalText: (
          r.querySelector(".total, strong")?.textContent || (m ? m[1] : "")
        ).trim(),
      };
    })
  );
}

async function rowSignature(page) {
  return page
    .locator(ROW)
    .evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
}

async function goNext(page) {
  const next = page
    .locator("#pager")
    .locator("button, a")
    .filter({ hasText: /next|›|»|>/i })
    .first();
  if ((await next.count()) === 0) return false;
  if (!(await next.isVisible().catch(() => false))) return false;
  if (await next.isDisabled().catch(() => false)) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;
  const before = await rowSignature(page);
  await next.click();
  try {
    await page.waitForFunction(
      (prev) =>
        Array.from(document.querySelectorAll("#orders-root [data-id]"))
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

export async function listOpenOrders(page, baseUrl) {
  await openHome(page, baseUrl);
  const seen = new Map();
  for (let i = 0; i < 200; i++) {
    for (const r of await readRows(page)) {
      if (r.id && !seen.has(r.id)) {
        seen.set(r.id, {
          id: r.id,
          customer: r.customer,
          total: parseTotal(r.totalText),
        });
      }
    }
    if (!(await goNext(page))) break;
  }
  return Array.from(seen.values());
}

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);
  const row = page.locator(ROW).filter({ has: page.locator("button") }).and(
    page.locator(`[data-id="${String(id).replace(/"/g, '\\"')}"]`)
  );

  let found = false;
  for (let i = 0; i < 200; i++) {
    if ((await row.count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await row.getByRole("button", { name: /cancel/i }).first().click();

    // Optional in-page confirmation dialog
    const confirm = page
      .locator('[role="dialog"], [role="alertdialog"], .modal')
      .getByRole("button", {
        name: /^(confirm|yes|ok|cancel order|yes, cancel.*)$/i,
      })
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
  } finally {
    page.off("dialog", onDialog);
  }
}
