const ROW = "tr.order-row";
const ERROR_BANNER = '#orders-root [role="alert"], #orders-root .banner';

async function openHome(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  // Wait for either order rows or an error banner. Don't wait for the table to
  // be visible: it is hidden whenever it has no rows.
  const outcome = page.locator(ROW).first().or(page.locator(ERROR_BANNER).first());
  try {
    await outcome.waitFor({ state: "visible", timeout: 15000 });
  } catch {
    // Neither appeared: treat as a genuinely empty list unless an error shows up below.
  }

  const banner = page.locator(ERROR_BANNER).first();
  if (await banner.isVisible().catch(() => false)) {
    const msg = (await banner.textContent().catch(() => ""))?.trim();
    throw new Error(`Orders page failed to load: ${msg || "error banner shown"}`);
  }
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
  page.on("dialog", (d) => d.accept().catch(() => {}));
  await openHome(page, baseUrl);

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
}
