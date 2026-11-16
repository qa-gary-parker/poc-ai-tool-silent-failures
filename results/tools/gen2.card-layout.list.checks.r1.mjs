import { expect } from "@playwright/test";

const CARD = "#orders-root article.card[data-id], #orders-root [data-id]";
const CARD_PRIMARY = "#orders-root article.card";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#orders-root").waitFor({ state: "attached", timeout: 15000 });
  // Wait for at least one order card; an empty list is acceptable.
  await page
    .locator(CARD_PRIMARY)
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => {});
}

function parseTotal(text) {
  const cleaned = String(text).replace(/[^0-9.,-]/g, "");
  return Number(cleaned.replace(/,/g, ""));
}

async function signature(page) {
  return page
    .locator(CARD_PRIMARY)
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-id")).join("|"));
}

async function readCards(page) {
  return page.locator(CARD_PRIMARY).evaluateAll((els) =>
    els.map((el) => {
      const idAttr = el.getAttribute("data-id");
      const orderP = Array.from(el.querySelectorAll("p")).find((p) =>
        /^\s*Order\s/i.test(p.textContent)
      );
      const id =
        idAttr ||
        (orderP ? orderP.textContent.replace(/^\s*Order\s+/i, "").trim() : "");
      const customer = el.querySelector("h3")?.textContent.trim() ?? "";
      const totalText = el.querySelector("strong")?.textContent.trim() ?? "";
      return { id, customer, totalText };
    })
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

  const before = await signature(page);
  await next.click();
  try {
    await page.waitForFunction(
      ({ sel, before }) =>
        Array.from(document.querySelectorAll(sel))
          .map((e) => e.getAttribute("data-id"))
          .join("|") !== before,
      { sel: CARD_PRIMARY, before },
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

  const card = page.locator(
    `${CARD_PRIMARY}[data-id=${JSON.stringify(String(id))}]`
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

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await card.getByRole("button", { name: /cancel/i }).click();

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
