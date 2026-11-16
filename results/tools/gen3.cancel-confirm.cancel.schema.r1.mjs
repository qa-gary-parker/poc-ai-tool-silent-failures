import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row";

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function rowSelector(id) {
  return `${ROW}[data-id="${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

async function load(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROW, { timeout: 10000 }).catch(() => {});
}

async function firstRowId(page) {
  return page.locator(ROW).first().getAttribute("data-id").catch(() => null);
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

async function goNext(page) {
  const next = page
    .locator("#pager")
    .locator("a, button")
    .filter({ hasText: /next|›|»|>/i })
    .first();
  if ((await next.count()) === 0) return false;
  if (!(await next.isEnabled().catch(() => false))) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;

  const before = await firstRowId(page);
  await next.click();
  try {
    await page.waitForFunction(
      ({ sel, before }) => {
        const el = document.querySelector(sel);
        return el && el.getAttribute("data-id") !== before;
      },
      { sel: ROW, before },
      { timeout: 5000 }
    );
  } catch {
    return false;
  }
  return true;
}

export async function listOpenOrders(page, baseUrl) {
  await load(page, baseUrl);

  const seen = new Map();
  for (let i = 0; i < 100; i++) {
    const rows = await readRows(page);
    let added = 0;
    for (const r of rows) {
      if (r.id && !seen.has(r.id)) {
        seen.set(r.id, { id: r.id, customer: r.customer, total: parseTotal(r.totalText) });
        added++;
      }
    }
    if (added === 0) break;
    if (!(await goNext(page))) break;
  }
  return [...seen.values()];
}

export async function cancelOrder(page, baseUrl, id) {
  await load(page, baseUrl);

  const sel = rowSelector(id);
  let row = null;
  for (let i = 0; i < 100; i++) {
    const candidate = page.locator(sel);
    if ((await candidate.count()) > 0) {
      row = candidate.first();
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!row) return { cancelled: false, id };

  // Native window.confirm support (if the site uses it).
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);

  try {
    await row.getByRole("button", { name: /cancel/i }).click();

    // The site uses a native <dialog id="confirm"> opened via showModal().
    // It has no explicit role attribute, so target it by tag/id and [open].
    const openDialog = page.locator("dialog[open]").first();
    try {
      await openDialog.waitFor({ state: "visible", timeout: 3000 });
      const ok = openDialog.locator("#ok");
      if ((await ok.count()) > 0) {
        await ok.click({ timeout: 3000 });
      } else {
        await openDialog
          .getByRole("button", { name: /confirm|yes|ok|proceed/i })
          .first()
          .click({ timeout: 3000 });
      }
    } catch {
      // No in-page dialog appeared; maybe a custom modal or native confirm.
      try {
        await page
          .locator('[role="dialog"], [role="alertdialog"], .modal')
          .getByRole("button", { name: /confirm|yes|ok|proceed/i })
          .first()
          .click({ timeout: 1000 });
      } catch {}
    }

    try {
      await expect(page.locator(sel)).toHaveCount(0, { timeout: 7000 });
    } catch {
      return { cancelled: false, id };
    }

    // Verify the cancellation persisted by reloading and searching all pages.
    await load(page, baseUrl);
    for (let i = 0; i < 100; i++) {
      if ((await page.locator(sel).count()) > 0) return { cancelled: false, id };
      if (!(await goNext(page))) break;
    }
    return { cancelled: true, id };
  } finally {
    page.off("dialog", onDialog);
  }
}
