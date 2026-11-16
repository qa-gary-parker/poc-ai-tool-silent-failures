import { expect } from "@playwright/test";

// Selectors rely on stable hooks (data-id, data-testid, table structure),
// not generated class names like .r-k2 / .c-tot or container ids like #ord-root.
const ROW = "tbody tr[data-id]";
const COUNT = '[data-testid="open-count"]';

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  // Wait for either rows or the count label (the list may legitimately be empty).
  await page.locator(ROW).first().or(page.locator(COUNT)).first().waitFor({ state: "visible", timeout: 15000 });
}

function parseTotal(text) {
  let s = (text || "").replace(/[^0-9.,-]/g, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastComma > lastDot) {
    // European format: 1.234,50
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  return Number(s);
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => {
      const cells = Array.from(r.querySelectorAll("td")).map((c) => c.textContent.trim());
      return {
        id: r.getAttribute("data-id") || cells[0] || "",
        customer: cells[1] || "",
        totalText: cells[2] || "",
      };
    })
  );
}

async function pageSignature(page) {
  return page.locator(ROW).evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
}

// Pagination is optional: the pager is currently empty, but handle it if it appears.
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
  const before = await pageSignature(page);
  await next.click();
  try {
    await page.waitForFunction(
      (prev) =>
        Array.from(document.querySelectorAll("tbody tr[data-id]"))
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
        seen.set(r.id, { id: r.id, customer: r.customer, total: parseTotal(r.totalText) });
      }
    }
    if (!(await goNext(page))) break;
  }
  return Array.from(seen.values());
}

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);
  const row = page.locator(`tbody tr[data-id=${JSON.stringify(String(id))}]`);

  let found = false;
  for (let i = 0; i < 200; i++) {
    if ((await row.count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  // Native confirm() dialogs
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await row.getByRole("button", { name: /cancel/i }).click();

    // Optional in-page confirmation dialog
    const confirm = page
      .locator('[role="dialog"], [role="alertdialog"], .modal')
      .getByRole("button", { name: /^(confirm|yes|ok|cancel order|yes, cancel.*)$/i })
      .first();
    if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirm.click();
    }

    await expect(row).toHaveCount(0, { timeout: 7000 });
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  } finally {
    page.off("dialog", onDialog);
  }
}
