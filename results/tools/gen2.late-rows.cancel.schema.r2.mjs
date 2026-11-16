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

async function openCount(page) {
  const t = await page
    .locator('[data-testid="open-count"]')
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null);
  const m = t && t.match(/\d+/);
  return m ? Number(m[0]) : null;
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

// Click a visible confirmation button that is outside any order row (modal or plain div).
async function clickConfirmIfPresent(page) {
  const candidates = page
    .locator("button, [role=button]")
    .filter({ hasText: /^\s*(confirm|yes|ok|okay|proceed|yes,? cancel.*|cancel order|confirm cancel.*)\s*$/i });
  const n = await candidates.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const c = candidates.nth(i);
    const inRow = await c.evaluate((el) => !!el.closest("tr.order-row")).catch(() => true);
    if (inRow) continue;
    if (await c.isVisible().catch(() => false)) {
      await c.click().catch(() => {});
      return true;
    }
  }
  return false;
}

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);
  id = String(id);

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);

  try {
    const row = page.locator(`${ROW}[data-id=${JSON.stringify(id)}]`);

    let found = false;
    for (let i = 0; i < 100; i++) {
      if (await row.count()) {
        found = true;
        break;
      }
      if (!(await goNext(page))) break;
    }
    if (!found) return { cancelled: false, id };

    const countBefore = await openCount(page);

    for (let attempt = 0; attempt < 2; attempt++) {
      if ((await row.count()) === 0) return { cancelled: true, id };

      const btn = row.getByRole("button", { name: /cancel/i }).first();
      await btn.click({ timeout: 5000 }).catch(() => {});

      // Give a confirmation step a moment to appear, then confirm it.
      await page.waitForTimeout(150);
      await clickConfirmIfPresent(page);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await row.count()) === 0) return { cancelled: true, id };

        const text = (await row.first().textContent({ timeout: 500 }).catch(() => "")) || "";
        if (/cancell?ed/i.test(text)) return { cancelled: true, id };

        const now = await openCount(page);
        if (countBefore !== null && now !== null && now < countBefore) {
          return { cancelled: true, id };
        }

        const toast =
          (await page.locator(".toast").first().textContent({ timeout: 300 }).catch(() => "")) || "";
        if (/cancell?ed/i.test(toast) && !/fail|error|unable|could not/i.test(toast)) {
          return { cancelled: true, id };
        }

        // A late confirmation step may have appeared.
        await clickConfirmIfPresent(page);

        const stillCancelable = await row
          .getByRole("button", { name: /^\s*cancel\s*$/i })
          .first()
          .isEnabled({ timeout: 300 })
          .catch(() => false);
        if (!stillCancelable && (await row.count()) > 0) {
          // Button gone/disabled: wait briefly for a settled state, then accept.
          await page.waitForTimeout(500);
          if ((await row.count()) === 0) return { cancelled: true, id };
          const t2 = (await row.first().textContent({ timeout: 500 }).catch(() => "")) || "";
          if (/fail|error/i.test(t2)) break; // retry the click
          return { cancelled: true, id };
        }

        await page.waitForTimeout(200);
      }
    }
    return { cancelled: false, id };
  } finally {
    page.off("dialog", onDialog);
  }
}
