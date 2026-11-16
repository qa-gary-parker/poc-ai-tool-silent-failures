import { expect } from "@playwright/test";

const ROW = ".order-row";

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator("#orders-root").waitFor();
  await page.locator(ROW).first().waitFor({ timeout: 5000 }).catch(() => {});
}

function parseTotal(text) {
  let s = (text || "").replace(/[^0-9.,-]/g, "");
  if (!/\d/.test(s)) return NaN;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // European style: 1.234,56 or 12,5
    const decimals = s.length - lastComma - 1;
    if (decimals > 0 && decimals <= 2) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else {
    s = s.replace(/,/g, "");
  }
  return Number(s);
}

// Totals are filled in asynchronously (placeholder "—" first), so wait for digits.
async function waitForTotals(page) {
  await page
    .waitForFunction(
      () => {
        const rows = Array.from(document.querySelectorAll(".order-row"));
        if (rows.length === 0) return false;
        return rows.every((r) => {
          const t = r.querySelector(".total");
          const txt = t ? t.textContent || "" : "";
          return /\d/.test(txt) || /\d/.test(r.getAttribute("data-total") || "");
        });
      },
      null,
      { timeout: 10000 }
    )
    .catch(() => {});
}

async function readRows(page) {
  await waitForTotals(page);
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => ({
      id: r.getAttribute("data-id") || r.querySelector(".id")?.textContent?.trim() || "",
      customer: r.querySelector(".customer")?.textContent?.trim() || "",
      totalText:
        (/\d/.test(r.querySelector(".total")?.textContent || "")
          ? r.querySelector(".total")?.textContent?.trim()
          : r.getAttribute("data-total")) || "",
    }))
  );
}

function nextControl(page) {
  return page
    .locator("#pager")
    .locator("button, a")
    .filter({ hasText: /next|›|»|>/i })
    .first();
}

async function goNext(page) {
  const next = nextControl(page);
  if ((await next.count()) === 0) return false;
  if (!(await next.isVisible().catch(() => false))) return false;
  if (await next.isDisabled().catch(() => false)) return false;
  const ariaDisabled = await next.getAttribute("aria-disabled");
  if (ariaDisabled === "true") return false;
  const before = await page.locator(ROW).evaluateAll((r) => r.map((x) => x.getAttribute("data-id")).join("|"));
  await next.click();
  try {
    await page.waitForFunction(
      (prev) =>
        Array.from(document.querySelectorAll(".order-row"))
          .map((x) => x.getAttribute("data-id"))
          .join("|") !== prev,
      before,
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
      if (!r.id) continue;
      const total = parseTotal(r.totalText);
      const prev = seen.get(r.id);
      if (!prev || (!(prev.total > 0) && total > 0)) {
        seen.set(r.id, { id: r.id, customer: r.customer, total: Number.isFinite(total) ? total : 0 });
      }
    }
    if (!(await goNext(page))) break;
  }
  return Array.from(seen.values());
}

export async function cancelOrder(page, baseUrl, id) {
  await openHome(page, baseUrl);
  const row = page.locator(`${ROW}[data-id="${id}"]`);

  let found = false;
  for (let i = 0; i < 200; i++) {
    if ((await row.count()) > 0) {
      found = true;
      break;
    }
    if (!(await goNext(page))) break;
  }
  if (!found) return { cancelled: false, id };

  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await row.getByRole("button", { name: /cancel/i }).click();

    // Optional in-page confirmation dialog
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
  } finally {
    page.off("dialog", onDialog);
  }
}
