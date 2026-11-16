import { expect } from "@playwright/test";

const ITEM = "#orders-root [data-id]";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#orders-root").waitFor({ state: "attached", timeout: 15000 });
  const first = page.locator(ITEM).first();
  try {
    await first.waitFor({ state: "visible", timeout: 10000 });
  } catch {
    // Possibly no open orders; accept if the counter says zero or the list is simply empty.
  }
}

function parseTotal(text) {
  const m = String(text).match(/-?\d[\d,]*(?:\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, "")) : NaN;
}

async function idsSignature(page) {
  return page.locator(ITEM).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-id")).join("|")
  );
}

async function readItems(page) {
  return page.locator(ITEM).evaluateAll((els) =>
    els.map((el) => {
      const txt = (n) => n?.textContent?.trim() ?? "";
      const customer =
        txt(el.querySelector(".customer")) ||
        txt(el.querySelector("h1,h2,h3,h4"));
      const totalText =
        txt(el.querySelector(".total")) ||
        txt(el.querySelector("strong")) ||
        (txt(el).match(/Total:?\s*([^\n]+)/i)?.[1] ?? "");
      return { id: el.getAttribute("data-id"), customer, totalText };
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

  const before = await idsSignature(page);
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
    const row = page.locator(`${ITEM}[data-id=${JSON.stringify(String(id))}]`);

    let found = false;
    for (let i = 0; i < 100; i++) {
      if (await row.count()) {
        found = true;
        break;
      }
      if (!(await goNext(page))) break;
    }
    if (!found) return { cancelled: false, id };

    await row.getByRole("button", { name: /cancel/i }).first().click();

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
