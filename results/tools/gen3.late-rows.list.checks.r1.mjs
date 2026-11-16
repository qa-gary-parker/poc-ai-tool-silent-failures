import { expect } from "@playwright/test";

const ROW = "#orders-root tr.order-row";
const COUNT = '[data-testid="open-count"]';

function parseTotal(text) {
  const cleaned = (text || "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function attr(id) {
  return String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function readRows(page) {
  const rows = await page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => ({
      id:
        (r.querySelector(".id")?.textContent || "").trim() ||
        r.getAttribute("data-id") ||
        "",
      customer: (r.querySelector(".customer")?.textContent || "").trim(),
      totalText: (r.querySelector(".total")?.textContent || "").trim(),
    }))
  );
  return rows.filter((r) => r.id);
}

async function expectedCount(page) {
  try {
    const t = await page.locator(COUNT).first().textContent({ timeout: 500 });
    const m = (t || "").match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  } catch {
    return null;
  }
}

// Wait until real rows (with ids) have rendered and the list has settled.
async function waitForRows(page, timeout = 10000) {
  const start = Date.now();
  let lastSig = "";
  let stableSince = Date.now();
  while (Date.now() - start < timeout) {
    let rows = [];
    try {
      rows = await readRows(page);
    } catch {}
    const sig = rows.map((r) => `${r.id}|${r.customer}|${r.totalText}`).join(";");
    if (sig !== lastSig) {
      lastSig = sig;
      stableSince = Date.now();
    }
    if (rows.length > 0) {
      const expected = await expectedCount(page);
      if (expected !== null && rows.length >= expected) return;
      if (Date.now() - stableSince > 800) return;
    }
    await page.waitForTimeout(100);
  }
}

async function load(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForRows(page);
}

async function firstRowId(page) {
  const rows = await readRows(page).catch(() => []);
  return rows.length ? rows[0].id : null;
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
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const now = await firstRowId(page);
    if (now && now !== before) {
      await waitForRows(page, 3000);
      return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
}

export async function listOpenOrders(page, baseUrl) {
  await load(page, baseUrl);

  const seen = new Map();
  for (let i = 0; i < 100; i++) {
    const rows = await readRows(page);
    for (const r of rows) {
      if (!seen.has(r.id)) {
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
  await load(page, baseUrl);

  const sel = `${ROW}[data-id="${attr(id)}"]`;
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

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await row.getByRole("button", { name: /cancel/i }).click();

    const confirm = page
      .locator('[role="dialog"], [role="alertdialog"], .modal')
      .getByRole("button", { name: /confirm|yes|ok|proceed/i })
      .first();
    try {
      await confirm.click({ timeout: 1000 });
    } catch {}

    try {
      await expect(page.locator(sel)).toHaveCount(0, { timeout: 7000 });
      return { cancelled: true, id };
    } catch {
      return { cancelled: false, id };
    }
  } finally {
    page.off("dialog", onDialog);
  }
}
