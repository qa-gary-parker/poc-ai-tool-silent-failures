import { expect } from "@playwright/test";

const ROW = "tr.order-row";

// Totals render as a placeholder ("—") first and are filled in asynchronously.
// Returns true if every visible row has a total containing a digit.
async function waitForTotals(page, timeout = 20000) {
  try {
    await page.waitForFunction(
      (sel) => {
        const rows = Array.from(document.querySelectorAll(sel));
        if (!rows.length) return false;
        return rows.every((r) =>
          /\d/.test(r.querySelector(".total")?.textContent || "")
        );
      },
      ROW,
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#orders-root table", { timeout: 15000 });
  await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
}

// Returns NaN when the text holds no number (e.g. the "—" placeholder).
function parseTotal(text) {
  const raw = String(text);
  if (!/\d/.test(raw)) return NaN;
  const negative = /^\s*[-−(]/.test(raw);
  let s = raw.replace(/[^0-9.,]/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // European style: 1.234,56
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return negative ? -n : n;
}

async function rowsSignature(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-id")).join("|")
  );
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-id") || el.querySelector(".id")?.textContent.trim(),
      customer: el.querySelector(".customer")?.textContent.trim() ?? "",
      totalText: el.querySelector(".total")?.textContent.trim() ?? "",
    }))
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
  await openHome(page, baseUrl);
  const seen = new Map();
  for (let i = 0; i < 100; i++) {
    await waitForTotals(page);
    for (const r of await readRows(page)) {
      if (!r.id) continue;
      const total = parseTotal(r.totalText);
      if (!Number.isFinite(total) || total <= 0) {
        // Totals never loaded: fail loudly rather than return a bogus value.
        throw new Error(`Order ${r.id} has no valid total (got "${r.totalText}")`);
      }
      seen.set(r.id, { id: r.id, customer: r.customer, total });
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
