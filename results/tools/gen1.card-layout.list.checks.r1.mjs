import { expect } from "@playwright/test";

const ROW = "#orders-root [data-id]";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#orders-root").waitFor();
  const countText = await page
    .getByTestId("open-count")
    .textContent({ timeout: 5000 })
    .catch(() => null);
  const expected = countText ? Number((countText.match(/\d+/) || [])[0]) : NaN;
  if (Number.isFinite(expected) && expected > 0) {
    await page
      .waitForFunction(
        (n) => document.querySelectorAll("#orders-root [data-id]").length >= n,
        expected,
        { timeout: 10000 }
      )
      .catch(() => {});
  } else {
    await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
  }
}

function parseTotal(text) {
  const m = (text || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

async function readRows(page) {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => {
      const totalEl = r.querySelector("strong, .total");
      let totalText = totalEl?.textContent?.trim() || "";
      if (!totalText) {
        const m = (r.textContent || "").match(/Total:?\s*([^\s]+)/i);
        totalText = m ? m[1] : "";
      }
      return {
        id: r.getAttribute("data-id") || "",
        customer: (r.querySelector("h3, .customer")?.textContent || "").trim(),
        totalText,
      };
    })
  );
}

async function goNext(page) {
  const next = page
    .locator("#pager")
    .locator("button, a")
    .filter({ hasText: /next|›|»|>/i })
    .first();
  if ((await next.count()) === 0) return false;
  if (!(await next.isVisible().catch(() => false))) return false;
  if (await next.isDisabled().catch(() => false)) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;
  const sig = () =>
    Array.from(document.querySelectorAll("#orders-root [data-id]"))
      .map((x) => x.getAttribute("data-id"))
      .join("|");
  const before = await page.evaluate(sig);
  await next.click();
  try {
    await page.waitForFunction(
      ({ prev, src }) => {
        const f = new Function(`return (${src})()`);
        return f() !== prev;
      },
      { prev: before, src: sig.toString() },
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
  for (let i = 0; i < 200; i++) {
    for (const r of await readRows(page)) {
      if (r.id && !seen.has(r.id)) {
        seen.set(r.id, { id: r.id, customer: r.customer, total: parseTotal(r.totalText) });
      }
    }
    if (!(await goNext(page))) break;
  }
  return Array.from(seen.values());
}

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);
  const row = page.locator(ROW).and(page.locator(`[data-id="${id}"]`));

  let found = false;
  for (let i = 0; i < 200; i++) {
    if ((await row.count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  page.once("dialog", (d) => d.accept().catch(() => {}));
  await row.getByRole("button", { name: /cancel/i }).first().click();

  const confirm = page
    .locator('[role="dialog"], [role="alertdialog"], .modal')
    .getByRole("button", { name: /^(confirm|yes|ok|cancel order|yes, cancel.*)$/i })
    .first();
  if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
    await confirm.click();
  }

  try {
    await expect(row).toHaveCount(0, { timeout: 7000 });
    return { cancelled: true, id };
  } catch {
    return { cancelled: false, id };
  }
}
