// node harness/run.mjs [--gens 3] [--repairs 2] [--model sonnet] [--only drift,drift]
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { z } from "zod";
import { DRIFTS, start, truth } from "../app/server.mjs";

const run = promisify(execFile);
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const GENS = Number(arg("gens", 3));
const REPAIRS = Number(arg("repairs", 2));
const MODEL = arg("model", "sonnet");
const ONLY = arg("only", "")?.split(",").filter(Boolean);
const drifts = ONLY.length ? DRIFTS.filter((d) => ONLY.includes(d)) : DRIFTS;
const OUT = "results";
const CANCEL_ID = "A-1003";
const EXPECT_FAIL = { list: ["soft-error"], cancel: ["cancel-409"] };

const browser = await chromium.launch();

async function withApp(drift, fn) {
	const server = await start(drift);
	const baseUrl = `http://127.0.0.1:${server.address().port}/`;
	const context = await browser.newContext();
	const page = await context.newPage();
	page.setDefaultTimeout(8000);
	try {
		return await fn(page, baseUrl);
	} finally {
		await context.close();
		server.close();
	}
}

const renderedHtml = (drift) =>
	withApp(drift, async (page, baseUrl) => {
		await page.goto(baseUrl);
		await page.waitForTimeout(3500);
		return page.content();
	});

async function ask(prompt) {
	// No tools, no MCP, no CLAUDE.md or memory, empty cwd: the model sees only the prompt.
	const isolation = JSON.stringify({ claudeMdExcludes: ["**/CLAUDE.md"], autoMemoryEnabled: false });
	const args = ["-p", prompt, "--model", MODEL, "--output-format", "text", "--tools", "", "--strict-mcp-config"];
	const { stdout } = await run("claude", [...args, "--settings", isolation], {
		cwd: mkdtempSync(join(tmpdir(), "gen-")),
		maxBuffer: 10 * 1024 * 1024,
		timeout: 300_000,
	});
	const code = stdout.match(/```(?:js|javascript|mjs)?\n([\s\S]*?)```/)?.[1];
	if (!code) throw new Error(`no code block in model output:\n${stdout.slice(0, 500)}`);
	return code;
}

const CONTRACT = `Write an ES module that uses Playwright to expose two tools for this website:
- export async function listOpenOrders(page, baseUrl): returns an array of { id, customer, total } for every open order. total is a number.
- export async function cancelOrder(page, baseUrl, id): cancels the order with that id and returns { cancelled, id }.
page is a Playwright Page; baseUrl is the site's home page URL. You may import from "@playwright/test".
Return only the code, in one \`\`\`js block.`;

const generatePrompt = (html) =>
	`You turn websites into tools that AI agents can call.\n${CONTRACT}\n\nRendered HTML of baseUrl:\n${html}`;

const repairPrompt = (code, error, html) =>
	`You maintain tools that AI agents call. This tool just failed.\n${CONTRACT}\n\nError:\n${error}\n\nCurrent code:\n\`\`\`js\n${code}\n\`\`\`\n\nRendered HTML of baseUrl now:\n${html}`;

const listSchema = z.array(
	z.object({ id: z.string().min(1), customer: z.string().min(1), total: z.number().finite().positive() }),
);
const cancelSchema = z.object({ cancelled: z.literal(true), id: z.string() });

async function load(file) {
	return import(`${new URL(`../${file}`, import.meta.url).href}?v=${Date.now()}${Math.random()}`);
}

const sameOrders = (got) => {
	const want = truth();
	if (!Array.isArray(got) || got.length !== want.length) return false;
	const byId = new Map(got.map((o) => [o?.id, o]));
	return want.every((w) => {
		const g = byId.get(w.id);
		return g && g.customer === w.customer && typeof g.total === "number" && Math.abs(g.total - w.total) < 0.005;
	});
};

// Postconditions written against the baseline page only: they know its count label,
// its row markup and its error role, not any drift.
async function openCount(page, baseUrl) {
	await page.goto(baseUrl);
	await page.waitForLoadState("networkidle");
	if (await page.getByRole("alert").count()) throw new Error("check: the page shows an error");
	return Number.parseInt(await page.getByTestId("open-count").textContent(), 10);
}

async function checkList(page, baseUrl, orders) {
	const shown = await openCount(page, baseUrl);
	if (shown !== orders.length) throw new Error(`check: page says ${shown} open orders, tool returned ${orders.length}`);
	for (const o of orders) {
		const row = page.locator(`[data-id="${o.id}"]`);
		if (!(await row.count())) continue;
		const digits = (await row.innerText()).replace(o.id, "").replace(/\D/g, "");
		if (digits !== o.total.toFixed(2).replace(/\D/g, ""))
			throw new Error(`check: ${o.id} total ${o.total} does not match the page`);
	}
}

async function checkCancel(page, baseUrl, before) {
	const after = await openCount(page, baseUrl);
	if (after !== before - 1 || (await page.locator(`[data-id="${CANCEL_ID}"]`).count()))
		throw new Error(`check: open orders went ${before} -> ${after}; ${CANCEL_ID} still listed or count wrong`);
}

async function attempt(file, task, drift, validate) {
	return withApp(drift, async (page, baseUrl) => {
		const started = Date.now();
		let result;
		let error;
		try {
			const tool = await load(file);
			const before = validate === "checks" && task === "cancel" ? await openCount(page, baseUrl) : undefined;
			result =
				task === "list"
					? await tool.listOpenOrders(page, baseUrl)
					: await tool.cancelOrder(page, baseUrl, CANCEL_ID);
			if (validate) (task === "list" ? listSchema : cancelSchema).parse(result);
			if (validate === "checks")
				task === "list" ? await checkList(page, baseUrl, result) : await checkCancel(page, baseUrl, before);
			if (task === "cancel" && result?.cancelled === false) error = "tool reported cancelled: false";
		} catch (e) {
			error = String(e?.message ?? e).split("\n").slice(0, 12).join("\n");
		}
		const state = await (await fetch(`${baseUrl}__state`)).json();
		const expectFail = EXPECT_FAIL[task].includes(drift);
		let outcome;
		if (error) outcome = expectFail ? "correct" : "loud";
		else if (expectFail) outcome = "silent";
		else if (task === "list") outcome = sameOrders(result) ? "correct" : "silent";
		else outcome = state.find((o) => o.id === CANCEL_ID).status === "cancelled" ? "correct" : "silent";
		return { outcome, error, result, ms: Date.now() - started };
	});
}

mkdirSync(`${OUT}/tools`, { recursive: true });
const baseHtml = await renderedHtml("baseline");
const htmlCache = {};
const rows = [];
const save = () => writeFileSync(`${OUT}/runs.json`, `${JSON.stringify(rows, null, 2)}\n`);

for (let g = 1; g <= GENS; g++) {
	const genFile = `${OUT}/tools/gen${g}.mjs`;
	if (!existsSync(genFile)) {
		console.log(`generating gen${g}`);
		writeFileSync(genFile, await ask(generatePrompt(baseHtml)));
	}
	for (const drift of drifts) {
		for (const task of ["list", "cancel"]) {
			for (const [arm, validate] of [
				["generated", false],
				["generated+schema", "schema"],
				["generated+checks", "checks"],
			]) {
				let file = genFile;
				let r = await attempt(file, task, drift, validate);
				let repairs = 0;
				while (r.outcome === "loud" && repairs < REPAIRS) {
					repairs++;
					htmlCache[drift] ??= await renderedHtml(drift);
					const next = `${OUT}/tools/gen${g}.${drift}.${task}.${validate || "plain"}.r${repairs}.mjs`;
					if (!existsSync(next)) {
						console.log(`  repair ${repairs} gen${g} ${drift} ${task} ${arm}`);
						writeFileSync(next, await ask(repairPrompt(readFileSync(file, "utf8"), r.error, htmlCache[drift])));
					}
					file = next;
					r = await attempt(file, task, drift, validate);
				}
				rows.push({ gen: g, drift, task, arm, repairs, ...r });
				console.log(`gen${g} ${drift.padEnd(14)} ${task.padEnd(6)} ${arm.padEnd(16)} ${r.outcome} (repairs ${repairs})`);
				save();
			}
		}
	}
}

for (const drift of drifts) {
	for (const task of ["list", "cancel"]) {
		const r = await attempt("tools/handwritten.mjs", task, drift, false);
		rows.push({ gen: 0, drift, task, arm: "handwritten", repairs: 0, ...r });
		console.log(`hand ${drift.padEnd(14)} ${task.padEnd(6)} handwritten      ${r.outcome}`);
		save();
	}
}
await browser.close();
