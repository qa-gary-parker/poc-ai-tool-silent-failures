import { expect } from "@playwright/test";

const ROW = "tr.order-row";
const ALERT = '#orders-root [role="alert"], #orders-root .banner';

class SiteLoadError extends Error {
  constructor(message) {
    super(message);
    this.name = "SiteLoadError";
  }
}

// Loads the home page and waits for one of: rows rendered, an error banner, or a genuine empty state.
// An error banner always wins over the "0 open orders" counter, because the counter
// reads 0 when the load failed. Throws SiteLoadError rather than returning an empty list.
async function openHome(page, baseUrl, attempts = 3) {
  let lastMessage = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const state = await page
      .waitForFunction(
        ({ row, alert }) => {
          if (document.querySelector(alert)) return "error";
          if (document.querySelector(row)) return "rows";
          const count = document.querySelector('[data-testid="open-count"]');
          if (count && /^\s*0\b/.test(count.textContent || "")) return "empty";
          return false;
        },
        { row: ROW, alert: ALERT },
        { timeout: 10000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => "timeout");

    if (state === "rows" || state === "empty") return state;

    if (state === "error") {
      lastMessage = (await page.locator(ALERT).first().innerText()).trim();
    } else {
      lastMessage = "orders list did not render within 10s";
    }
    if (attempt < attempts) await page.waitForTimeout(1000 * attempt);
  }
  throw new SiteLoadError(`Orders page failed to load: ${lastMessage}`);
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
  const state = await openHome(page, baseUrl);
  if (state === "empty") return [];

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
  const state = await openHome(page, baseUrl);
  if (state === "empty") return { cancelled: false, id };

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
