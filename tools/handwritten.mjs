import { expect } from "@playwright/test";

const parseMoney = (text) => {
	const m = text.trim().match(/^€([\d,]+\.\d{2})$/);
	if (!m) throw new Error(`unexpected money format: "${text}"`);
	return Number(m[1].replaceAll(",", ""));
};

export async function listOpenOrders(page, baseUrl) {
	const loaded = page.waitForResponse("**/api/orders");
	await page.goto(baseUrl);
	await loaded;
	const count = page.getByTestId("open-count");
	await expect(count).toHaveText(/^\d+ open orders$/);
	await expect(page.getByRole("alert")).toHaveCount(0);
	const expected = Number((await count.textContent()).split(" ")[0]);
	const table = page.getByRole("table");
	const headers = await table.getByRole("columnheader").allTextContents();
	expect(headers.slice(0, 3)).toEqual(["Order", "Customer", "Total"]);
	const rows = table.locator("tbody tr");
	await expect(rows).toHaveCount(expected);
	const orders = [];
	for (const row of await rows.all()) {
		const [id, customer, total] = await row.getByRole("cell").allTextContents();
		expect(id).toMatch(/^A-\d{4}$/);
		expect(customer.trim()).not.toBe("");
		orders.push({ id, customer, total: parseMoney(total) });
	}
	return orders;
}

export async function cancelOrder(page, baseUrl, id) {
	await page.goto(baseUrl);
	const row = page.locator(`tr[data-id="${id}"]`);
	await row.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByRole("status")).toHaveText(`Order ${id} cancelled`);
	const reloaded = page.waitForResponse("**/api/orders");
	await page.reload();
	await reloaded;
	await expect(page.locator("tr[data-id]").first()).toBeVisible();
	await expect(page.locator(`tr[data-id="${id}"]`)).toHaveCount(0);
	return { cancelled: true, id };
}
