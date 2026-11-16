import { expect } from "@playwright/test";

const ROW = "tr.order-row";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#orders-root table", { timeout: 15000 });
  await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
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

function rowLocator(page, id) {
  return page.locator(`${ROW}[data-id=${JSON.stringify(String(id))}]`);
}

// Walks pages from the current one onward; returns true if the row is found (page left on it).
async function seekRow(page, id) {
  const row = rowLocator(page, id);
  for (let i = 0; i < 100; i++) {
    if (await row.count()) return true;
    if (!(await goNext(page))) break;
  }
  return false;
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
  const sid = String(id);
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);

  try {
    await openHome(page, baseUrl);
    if (!(await seekRow(page, sid))) return { cancelled: false, id };

    const row = rowLocator(page, sid);
    await row.getByRole("button", { name: /cancel/i }).first().click();

    // In-page confirmation (role=dialog or a custom modal outside the row).
    const confirm = page
      .locator(
        '[role="dialog"] button, [role="alertdialog"] button, .modal button, dialog button'
      )
      .filter({ hasText: /confirm|yes|ok|proceed|cancel order/i })
      .first();
    if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) {
      await confirm.click();
    }

    // Give the UI a chance to update optimistically.
    await row.waitFor({ state: "detached", timeout: 4000 }).catch(() => {});

    // Verify against the server's state by reloading; the cancel may be delayed or async.
    for (let attempt = 0; attempt < 5; attempt++) {
      await openHome(page, baseUrl);
      const stillThere = await seekRow(page, sid);
      if (!stillThere) return { cancelled: true, id };
      await page.waitForTimeout(1000);
    }
    return { cancelled: false, id };
  } finally {
    page.off("dialog", onDialog);
  }
}
