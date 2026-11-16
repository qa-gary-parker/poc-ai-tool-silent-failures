import { expect } from "@playwright/test";

const ROW = "tbody tr[data-id]";
const COUNT = '[data-testid="open-count"]';

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  // Wait for either the count label or rows, so an empty list doesn't time out.
  await page.locator(COUNT).or(page.locator(ROW).first()).first().waitFor({ state: "visible", timeout: 15000 });
  const label = await page.locator(COUNT).first().textContent({ timeout: 1000 }).catch(() => null);
  const n = label ? Number((label.match(/\d+/) || [])[0]) : NaN;
  if (Number.isNaN(n) || n > 0) {
    await page.locator(ROW).first().waitFor({ state: "visible", timeout: 15000 });
  }
}

function parseTotal(text) {
  const cleaned = String(text).replace(/[^0-9.,-]/g, "");
  return Number(cleaned.replace(/,/g, ""));
}

async function rowsSignature(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-id")).join("|")
  );
}

// Reads rows using header text to locate columns (falls back to positions 0,1,2).
async function readRows(page) {
  return page.locator(ROW).evaluateAll((els) => {
    const table = els[0]?.closest("table");
    const heads = table
      ? Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim().toLowerCase())
      : [];
    const find = (re, dflt) => {
      const i = heads.findIndex((h) => re.test(h));
      return i >= 0 ? i : dflt;
    };
    const cIdx = find(/customer/, 1);
    const tIdx = find(/total|amount/, 2);
    return els.map((el) => {
      const cells = el.querySelectorAll("td");
      return {
        id: el.getAttribute("data-id"),
        customer: cells[cIdx]?.textContent.trim() ?? "",
        totalText: cells[tIdx]?.textContent.trim() ?? "",
      };
    });
  });
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
