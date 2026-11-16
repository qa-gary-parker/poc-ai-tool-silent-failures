import { expect } from "@playwright/test";

const ROOT = "#ord-root";
const ROW = `${ROOT} tbody tr[data-id]`;

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(ROOT).waitFor({ state: "visible" });
  // Rows may be absent when there are no open orders, so don't fail on that.
  await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
}

function parseTotal(text) {
  let s = (text || "").replace(/[^0-9.,-]/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // Whichever separator comes last is the decimal separator.
    s = lastComma > lastDot
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  return Number(s);
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => {
      const cells = r.querySelectorAll("td");
      const text = (i) => (cells[i]?.textContent || "").trim();
      return {
        id: r.getAttribute("data-id") || text(0),
        customer: text(1),
        totalText: text(2),
      };
    })
  );
}

async function rowIds(page) {
  return page
    .locator(ROW)
    .evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
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
  const before = await rowIds(page);
  await next.click();
  try {
    await page.waitForFunction(
      ([sel, prev]) =>
        Array.from(document.querySelectorAll(sel))
          .map((x) => x.getAttribute("data-id"))
          .join("|") !== prev,
      [ROW, before],
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
  const row = page.locator(ROW).and(page.locator(`[data-id=${JSON.stringify(String(id))}]`));

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
    await row.getByRole("button", { name: /cancel/i }).click();

    // Optional in-page confirmation dialog.
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
