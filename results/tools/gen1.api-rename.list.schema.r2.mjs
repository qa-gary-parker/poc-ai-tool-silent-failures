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

// Collect order totals from any JSON the page loads (fallback when the DOM total is a placeholder).
function trackApiTotals(page) {
  const totals = new Map();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const id = node.id ?? node.orderId ?? node.order_id;
    const raw = node.total ?? node.amount ?? node.totalAmount ?? node.total_amount;
    if (id != null && raw != null) {
      const n = typeof raw === "number" ? raw : parseTotal(String(raw));
      if (Number.isFinite(n) && n > 0) totals.set(String(id), n);
    }
    Object.values(node).forEach(walk);
  };
  const handler = async (res) => {
    try {
      const ct = res.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      walk(await res.json());
    } catch {}
  };
  page.on("response", handler);
  return { totals, stop: () => page.off("response", handler) };
}

// Totals are filled in asynchronously (placeholder "—" first), so wait for digits.
async function waitForTotals(page, timeout = 15000) {
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
      { timeout }
    )
    .catch(() => {});
}

async function readRows(page) {
  await waitForTotals(page);
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((r) => {
      const totalEl = r.querySelector(".total");
      const cell = totalEl ? (totalEl.textContent || "").trim() : "";
      return {
        id: r.getAttribute("data-id") || r.querySelector(".id")?.textContent?.trim() || "",
        customer: r.querySelector(".customer")?.textContent?.trim() || "",
        totalText: /\d/.test(cell) ? cell : r.getAttribute("data-total") || "",
      };
    })
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
  if ((await next.getAttribute("aria-disabled")) === "true") return false;
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
  const api = trackApiTotals(page);
  try {
    await openHome(page, baseUrl);
    const seen = new Map();
    const unresolved = new Set();

    for (let i = 0; i < 200; i++) {
      let rows = await readRows(page);
      // If any total is still a placeholder, give the page one more chance to fill in.
      if (rows.some((r) => !(parseTotal(r.totalText) > 0) && !(api.totals.get(r.id) > 0))) {
        await waitForTotals(page, 10000);
        rows = await readRows(page);
      }
      for (const r of rows) {
        if (!r.id) continue;
        let total = parseTotal(r.totalText);
        if (!(total > 0)) total = api.totals.get(r.id);
        if (total > 0) {
          unresolved.delete(r.id);
          seen.set(r.id, { id: r.id, customer: r.customer, total });
        } else if (!seen.has(r.id)) {
          unresolved.add(r.id);
        }
      }
      if (!(await goNext(page))) break;
    }

    if (unresolved.size > 0) {
      throw new Error(`Totals never loaded for orders: ${Array.from(unresolved).join(", ")}`);
    }
    return Array.from(seen.values());
  } finally {
    api.stop();
  }
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
