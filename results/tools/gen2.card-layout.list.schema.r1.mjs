import { expect } from "@playwright/test";

const CARD = "#orders-root [data-id]";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  // Orders may be rendered by app.js after load; wait for the first card.
  // An empty list simply times out here and yields [].
  await page.locator(CARD).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
}

function parseTotal(text) {
  let s = String(text).replace(/[^0-9.,-]/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // European style: 1.234,50
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  return Number(s);
}

async function signature(page) {
  return page.locator(CARD).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-id")).join("|")
  );
}

async function readCards(page) {
  return page.locator(CARD).evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-id"),
      customer: (el.querySelector("h3, .customer")?.textContent ?? "").trim(),
      totalText: (el.querySelector("strong, .total")?.textContent ?? "").trim(),
    }))
  );
}

// Clicks the pager's "next" control if one exists and is enabled.
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
      { sel: CARD, before },
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
    for (const r of await readCards(page)) {
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
  const sid = String(id);
  const card = page.locator(`#orders-root [data-id=${JSON.stringify(sid)}]`);

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
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

    // In-page confirmation modal, if one appears (avoid matching "cancel").
    const confirm = page
      .getByRole("dialog")
      .getByRole("button", { name: /confirm|yes|ok|proceed/i })
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
