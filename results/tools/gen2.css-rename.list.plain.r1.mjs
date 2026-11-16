import { expect } from "@playwright/test";

// Selectors rely on stable semantics (table, data-id, header text, button text),
// not on generated class names or container ids.
const TABLE = "table";
const ROW = "tbody tr[data-id]";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(TABLE).first().waitFor({ state: "visible", timeout: 15000 });
  // Rows may render slightly after the table; an empty list is valid, so don't fail here.
  await page.locator(ROW).first().waitFor({ timeout: 3000 }).catch(() => {});
}

function parseTotal(text) {
  let s = String(text).replace(/[^0-9.,-]/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // Whichever separator comes last is the decimal separator.
    s = lastComma > lastDot
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    // Lone comma: decimal if followed by 1-2 digits, otherwise thousands.
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  return Number(s);
}

async function rowsSignature(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-id")).join("|")
  );
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) => {
    const table = rows[0]?.closest("table");
    const headers = table
      ? Array.from(table.querySelectorAll("thead th")).map((th) =>
          th.textContent.trim().toLowerCase()
        )
      : [];
    const idx = (re, fallback) => {
      const i = headers.findIndex((h) => re.test(h));
      return i >= 0 ? i : fallback;
    };
    const iCustomer = idx(/customer|client|name/, 1);
    const iTotal = idx(/total|amount|price/, 2);
    return rows.map((tr) => {
      const cells = tr.querySelectorAll("td");
      return {
        id: tr.getAttribute("data-id"),
        customer: cells[iCustomer]?.textContent.trim() ?? "",
        totalText: cells[iTotal]?.textContent.trim() ?? "",
      };
    });
  });
}

// Clicks the pager's "next" control if present and enabled. Returns true if the rows changed.
async function goNext(page) {
  const next = page
    .locator("#pager")
    .locator("button, a")
    .filter({ hasText: /next|›|»|>/i })
    .first();
  if (!(await next.count())) return false;
  if (!(await next.isVisible()) || !(await next.isEnabled())) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;

  const before = await rowsSignature(page);
  await next.click();
  try {
    await page.waitForFunction(
      ({ sel, before }) =>
        Array.from(document.querySelectorAll(sel))
          .map((e) => e.getAttribute("data-id"))
          .join("|") !== before,
      { sel: ROW, before },
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
  for (let i = 0; i < 100; i++) {
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
  return [...seen.values()];
}

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    const row = page.locator(`${ROW}[data-id=${JSON.stringify(String(id))}]`);

    let found = false;
    for (let i = 0; i < 100; i++) {
      if (await row.count()) {
        found = true;
        break;
      }
      if (!(await goNext(page))) break;
    }
    if (!found) return { cancelled: false, id };

    await row.getByRole("button", { name: /cancel/i }).click();

    // Handle an in-page confirmation modal, if one appears.
    const confirm = page
      .getByRole("dialog")
      .getByRole("button", { name: /confirm|yes|ok|cancel order/i })
      .first();
    if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirm.click();
    }

    try {
      await row.waitFor({ state: "detached", timeout: 8000 });
      return { cancelled: true, id };
    } catch {
      return { cancelled: false, id };
    }
  } finally {
    page.off("dialog", onDialog);
  }
}
