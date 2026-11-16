import { expect } from "@playwright/test";

// Selectors rely on stable structure (data-id attributes, table cells by position)
// rather than generated class names like .r-k2 / .c-tot, which change between builds.
const ROOT = "#ord-root";
const ROW = `${ROOT} tbody tr[data-id]`;

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(`${ROOT} table`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
}

function parseTotal(text) {
  const cleaned = String(text).replace(/[^0-9.,-]/g, "");
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let normalized;
  if (lastDot >= 0 && lastComma >= 0) {
    // Whichever separator comes last is the decimal separator.
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // Lone comma: decimal if followed by 1-2 digits, otherwise thousands.
    normalized = /,\d{1,2}$/.test(cleaned)
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
    els.map((el) => {
      const cells = Array.from(el.querySelectorAll("td")).map((c) =>
        c.textContent.trim()
      );
      return {
        id: el.getAttribute("data-id") || cells[0] || "",
        customer: cells[1] ?? "",
        totalText: cells[2] ?? "",
      };
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
