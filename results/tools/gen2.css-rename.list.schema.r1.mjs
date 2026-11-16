import { expect } from "@playwright/test";

const ROW = "tr[data-id]";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  try {
    await page.locator(ROW).first().waitFor({ state: "visible", timeout: 15000 });
    return true;
  } catch {
    return false; // no rows rendered (e.g. zero open orders)
  }
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
    // "12,50" -> decimal; "1,234" or "1,234,567" -> thousands.
    s = /,\d{1,2}$/.test(s) && s.split(",").length === 2
      ? s.replace(",", ".")
      : s.replace(/,/g, "");
  }
  return Number(s);
}

async function rowsSignature(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-id")).join("|")
  );
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((el) => {
      const table = el.closest("table");
      const heads = table
        ? Array.from(table.querySelectorAll("thead th")).map((th) =>
            th.textContent.trim().toLowerCase()
          )
        : [];
      const find = (re, fallback) => {
        const i = heads.findIndex((h) => re.test(h));
        return i >= 0 ? i : fallback;
      };
      const cells = Array.from(el.querySelectorAll("td"));
      const cell = (i) => cells[i]?.textContent.trim() ?? "";
      return {
        id: el.getAttribute("data-id"),
        customer: cell(find(/customer|client|name/, 1)),
        totalText: cell(find(/total|amount|price/, 2)),
      };
    })
  );
}

// Clicks the pager's "next" control if present and enabled. Returns true if the page changed.
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
  const hasRows = await openHome(page, baseUrl);
  if (!hasRows) return [];
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
  const hasRows = await openHome(page, baseUrl);
  if (!hasRows) return { cancelled: false, id };

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
