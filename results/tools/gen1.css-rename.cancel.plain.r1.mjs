import { expect } from "@playwright/test";

const ROOT = "#ord-root";
const ROW = `${ROOT} tbody tr[data-id]`;
const PAGER = "#pager";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(ROOT).waitFor({ state: "attached", timeout: 15000 });
  // Wait for rows, or for the page to indicate there are none.
  await page
    .waitForFunction(
      () => {
        if (document.querySelector("#ord-root tbody tr[data-id]")) return true;
        const label = document.querySelector('[data-testid="open-count"]');
        return !!label && /^\s*0\b/.test(label.textContent || "");
      },
      null,
      { timeout: 10000 }
    )
    .catch(() => {});
}

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  return Number(cleaned);
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) => {
    const table = rows[0]?.closest("table");
    const heads = table
      ? Array.from(table.querySelectorAll("thead th")).map((th) =>
          (th.textContent || "").trim().toLowerCase()
        )
      : [];
    const find = (re, fallback) => {
      const i = heads.findIndex((h) => re.test(h));
      return i >= 0 ? i : fallback;
    };
    const idIdx = find(/order|id/, 0);
    const custIdx = find(/customer|client|name/, 1);
    const totIdx = find(/total|amount|price/, 2);
    return rows.map((r) => {
      const cells = r.querySelectorAll("td");
      const txt = (i) => (cells[i]?.textContent || "").trim();
      return {
        id: r.getAttribute("data-id") || txt(idIdx),
        customer: txt(custIdx),
        totalText: txt(totIdx),
      };
    });
  });
}

async function rowSignature(page) {
  return page
    .locator(ROW)
    .evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
}

async function goNext(page) {
  const next = page
    .locator(PAGER)
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
        Array.from(document.querySelectorAll("#ord-root tbody tr[data-id]"))
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
  const row = page.locator(ROW).filter({
    has: page.locator(":scope"),
  });
  const target = page.locator(`${ROOT} tbody tr[data-id="${String(id).replace(/"/g, '\\"')}"]`);

  let found = false;
  for (let i = 0; i < 200; i++) {
    if ((await target.count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  void row;
  if (!found) return { cancelled: false, id };

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await target.getByRole("button", { name: /cancel/i }).click();

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
      await expect(target).toHaveCount(0, { timeout: 7000 });
      return { cancelled: true, id };
    } catch {
      return { cancelled: false, id };
    }
  } finally {
    page.off("dialog", onDialog);
  }
}
