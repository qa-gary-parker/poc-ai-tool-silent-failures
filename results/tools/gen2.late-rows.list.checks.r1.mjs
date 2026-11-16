import { expect } from "@playwright/test";

const ROW = "tr.order-row";

async function expectedCount(page) {
  const text = await page
    .locator('[data-testid="open-count"]')
    .first()
    .textContent({ timeout: 2000 })
    .catch(() => null);
  const m = text && text.match(/\d+/);
  return m ? Number(m[0]) : null;
}

async function rowCount(page) {
  return page.locator(ROW).count();
}

// Wait until rows have rendered and the row count has stopped changing.
async function waitForRows(page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const n = await rowCount(page);
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    }
    const exp = await expectedCount(page);
    if (n > 0 && Date.now() - stableSince >= 500) return;
    if (exp === 0 && Date.now() - stableSince >= 1000) return;
    await page.waitForTimeout(100);
  }
}

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForSelector("#orders-root table", { timeout: 15000 }).catch(() => {});
  await waitForRows(page);
}

function parseTotal(text) {
  const cleaned = String(text).replace(/[^0-9.,-]/g, "");
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let normalized;
  if (lastDot >= 0 && lastComma >= 0) {
    // The later separator is the decimal separator.
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // "1,5" / "12,50" => decimal; "1,234" / "1,234,567" => thousands.
    const parts = cleaned.split(",");
    normalized =
      parts.length === 2 && parts[1].length !== 3
        ? cleaned.replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else {
    normalized = cleaned;
  }
  return Number(normalized);
}

async function rowsSignature(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-id")).join("|")
  );
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((els) =>
    els.map((el) => ({
      id:
        el.getAttribute("data-id") ||
        el.querySelector(".id")?.textContent.trim(),
      customer: el.querySelector(".customer")?.textContent.trim() ?? "",
      totalText: el.querySelector(".total")?.textContent.trim() ?? "",
    }))
  );
}

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
  await waitForRows(page, 5000);
  return true;
}

async function collect(page, seen) {
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
}

export async function listOpenOrders(page, baseUrl) {
  const seen = new Map();
  for (let attempt = 0; attempt < 3; attempt++) {
    await openHome(page, baseUrl);
    const exp = await expectedCount(page);
    await collect(page, seen);
    if (exp === null || seen.size >= exp) break;
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
