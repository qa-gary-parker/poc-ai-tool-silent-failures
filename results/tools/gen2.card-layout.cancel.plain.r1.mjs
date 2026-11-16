import { expect } from "@playwright/test";

const ITEM = "#orders-root [data-id]";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  // Wait for at least one order; an empty list is also a valid outcome.
  await page
    .locator(ITEM)
    .first()
    .waitFor({ state: "visible", timeout: 15000 })
    .catch(() => {});
}

function parseTotal(text) {
  const cleaned = String(text).replace(/[^0-9.,-]/g, "");
  return Number(cleaned.replace(/,/g, ""));
}

async function readItems(page) {
  return page.locator(ITEM).evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-id"),
      customer:
        (
          el.querySelector("h1, h2, h3, h4, .customer") || {}
        ).textContent?.trim() ?? "",
      totalText:
        (
          el.querySelector("strong, .total") || {}
        ).textContent?.trim() ?? "",
    }))
  );
}

async function signature(page) {
  return page
    .locator(ITEM)
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-id")).join("|"));
}

// Optional pagination: only used if the pager actually renders a usable "next" control.
async function goNext(page) {
  const next = page
    .locator("#pager")
    .locator("button, a")
    .filter({ hasText: /next|›|»|>/i })
    .first();
  if (!(await next.count())) return false;
  if (!(await next.isVisible()) || !(await next.isEnabled())) return false;
  if ((await next.getAttribute("aria-disabled")) === "true") return false;

  const before = await signature(page);
  await next.click();
  try {
    await page.waitForFunction(
      ({ sel, before }) =>
        Array.from(document.querySelectorAll(sel))
          .map((e) => e.getAttribute("data-id"))
          .join("|") !== before,
      { sel: ITEM, before },
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
    for (const r of await readItems(page)) {
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
    const card = page.locator(
      `${ITEM}[data-id=${JSON.stringify(String(id))}]`
    );

    let found = false;
    for (let i = 0; i < 100; i++) {
      if (await card.count()) {
        found = true;
        break;
      }
      if (!(await goNext(page))) break;
    }
    if (!found) return { cancelled: false, id };

    await card.getByRole("button", { name: /cancel/i }).first().click();

    // Handle an in-page confirmation modal, if one appears.
    const confirm = page
      .getByRole("dialog")
      .getByRole("button", { name: /confirm|yes|ok|cancel order/i })
      .first();
    if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirm.click();
    }

    try {
      await card.waitFor({ state: "detached", timeout: 8000 });
      return { cancelled: true, id };
    } catch {
      return { cancelled: false, id };
    }
  } finally {
    page.off("dialog", onDialog);
  }
}
