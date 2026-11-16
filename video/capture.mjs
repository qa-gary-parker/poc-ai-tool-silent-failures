// Screenshots of the test site for the walkthrough: node capture.mjs
import { chromium } from "@playwright/test";
import { start } from "../app/server.mjs";

const shots = [
	["baseline", async () => {}],
	["locale-format", async () => {}],
	["card-layout", async () => {}],
	["api-rename", async () => {}],
	["paginated", async () => {}],
	["late-rows", async () => {}, { wait: 300 }],
	["soft-error", async () => {}],
	["cancel-409", async (page) => {
		await page.locator('[data-id="A-1003"] button').click();
		await page.getByRole("status").waitFor();
	}],
];
const browser = await chromium.launch();
for (const [drift, act, opts] of shots) {
	const server = await start(drift);
	const page = await browser.newPage({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 2 });
	await page.goto(`http://127.0.0.1:${server.address().port}/`);
	await page.waitForTimeout(opts?.wait ?? 3200);
	await act(page);
	await page.screenshot({ path: `assets/${drift}.png` });
	await page.close();
	server.close();
}
await browser.close();
