import { createServer } from "node:http";

export const DRIFTS = [
	"baseline",
	"css-rename",
	"column-swap",
	"locale-format",
	"api-rename",
	"late-rows",
	"paginated",
	"soft-error",
	"cancel-409",
	"cancel-confirm",
	"card-layout",
];

const SEED = [
	{ id: "A-1001", customer: "Northwind Ltd", total: 1234.5, status: "open" },
	{ id: "A-1002", customer: "Contoso", total: 89.99, status: "shipped" },
	{ id: "A-1003", customer: "Fabrikam", total: 420, status: "open" },
	{ id: "A-1004", customer: "Tailspin Toys", total: 15.25, status: "open" },
	{ id: "A-1005", customer: "Litware", total: 3100, status: "shipped" },
	{ id: "A-1006", customer: "Adventure Works", total: 77.7, status: "open" },
	{ id: "A-1007", customer: "Wingtip", total: 640.1, status: "open" },
	{ id: "A-1008", customer: "Proseware", total: 12, status: "open" },
	{ id: "A-1009", customer: "Lucerne", total: 999.99, status: "shipped" },
	{ id: "A-1010", customer: "Coho Winery", total: 2500, status: "open" },
	{ id: "A-1011", customer: "Alpine Ski", total: 58.4, status: "open" },
	{ id: "A-1012", customer: "Margie's Travel", total: 1450, status: "shipped" },
];

export const truth = () =>
	SEED.filter((o) => o.status === "open").map(({ id, customer, total }) => ({ id, customer, total }));

const page = (drift) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Orders</title>
<style>
body{font-family:system-ui;margin:2rem} table{border-collapse:collapse} td,th{padding:.4rem .8rem;border-bottom:1px solid #ddd}
.toast{position:fixed;bottom:1rem;right:1rem;background:#222;color:#fff;padding:.5rem 1rem}
${drift === "card-layout" ? ".card{border:1px solid #ccc;border-radius:6px;padding:.6rem;margin:.4rem 0;max-width:24rem}" : ""}
${drift === "soft-error" ? ".banner{background:#fee;color:#900;padding:.6rem}" : ""}
${drift === "cancel-confirm" ? "dialog::backdrop{background:#0004}" : ""}
</style></head>
<body>
<h1>Open orders</h1>
<p class="${drift === "css-rename" ? "o-count__label" : "count"}" data-testid="open-count">Loading…</p>
<div id="${drift === "css-rename" ? "ord-root" : "orders-root"}"></div>
<div id="pager"></div>
${drift === "cancel-confirm" ? `<dialog id="confirm"><p>Cancel this order? This cannot be undone.</p>
<button value="keep" id="keep">Keep order</button> <button value="ok" id="ok">Confirm</button></dialog>` : ""}
<script src="/app.js"></script>
</body></html>`;

const script = (drift) => `const DRIFT = ${JSON.stringify(drift)};
const PAGE_SIZE = 5;
let pageNo = 0, orders = [];
const cls = (a, b) => DRIFT === "css-rename" ? b : a;
const money = (n) => n == null ? "—" : DRIFT === "locale-format"
  ? n.toLocaleString("de-DE", { minimumFractionDigits: 2 }) + " €"
  : "€" + n.toLocaleString("en-GB", { minimumFractionDigits: 2 });
const root = document.getElementById(cls("orders-root", "ord-root"));
const count = document.querySelector("[data-testid=open-count]");

function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status");
  t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 3000);
}

async function cancel(id) {
  if (DRIFT === "cancel-confirm") {
    const d = document.getElementById("confirm"); d.showModal();
    const choice = await new Promise((r) => d.addEventListener("close", () => r(d.returnValue), { once: true }));
    if (choice !== "ok") return;
  }
  const res = await fetch("/api/orders/" + id + "/cancel", { method: "POST" });
  if (DRIFT === "cancel-409" || res.ok) {
    orders = orders.filter((o) => o.id !== id); render(); toast("Order " + id + " cancelled");
  } else toast("Could not cancel " + id);
}
document.querySelectorAll("#confirm button").forEach((b) =>
  b.addEventListener("click", () => document.getElementById("confirm").close(b.value)));

function render() {
  count.textContent = orders.length + " open orders";
  const shown = DRIFT === "paginated" ? orders.slice(pageNo * PAGE_SIZE, pageNo * PAGE_SIZE + PAGE_SIZE) : orders;
  if (DRIFT === "card-layout") {
    root.innerHTML = shown.map((o) => '<article class="card" data-id="' + o.id + '"><h3>' + o.customer + '</h3><p>Order ' + o.id +
      '</p><p>Total: <strong>' + money(o.total) + '</strong></p><button>Cancel order</button></article>').join("");
  } else {
    const cols = DRIFT === "column-swap" ? ["id", "total", "customer"] : ["id", "customer", "total"];
    const head = { id: "Order", customer: "Customer", total: "Total" };
    const cell = (o, c) => '<td class="' + cls(c, "c-" + c.slice(0, 3)) + '">' + (c === "total" ? money(o.total) : o[c]) + "</td>";
    root.innerHTML = '<table class="' + cls("orders", "tbl-x9") + '"><thead><tr>' + cols.map((c) => "<th>" + head[c] + "</th>").join("") +
      "<th></th></tr></thead><tbody>" + shown.map((o) => '<tr class="' + cls("order-row", "r-k2") + '" data-id="' + o.id + '">' +
      cols.map((c) => cell(o, c)).join("") + "<td><button>Cancel</button></td></tr>").join("") + "</tbody></table>";
  }
  root.querySelectorAll("[data-id] button").forEach((b) =>
    b.addEventListener("click", () => cancel(b.closest("[data-id]").dataset.id)));
  const pager = document.getElementById("pager");
  pager.innerHTML = "";
  if (DRIFT === "paginated" && (pageNo + 1) * PAGE_SIZE < orders.length) {
    const n = document.createElement("button"); n.textContent = "Next page";
    n.onclick = () => { pageNo++; render(); }; pager.append(n);
  }
}

async function load() {
  if (DRIFT === "late-rows") {
    count.textContent = "0 open orders";
    root.innerHTML = '<table class="orders"><tbody>' + '<tr class="order-row"><td>Loading…</td><td></td><td></td></tr>'.repeat(3) + "</tbody></table>";
  }
  const res = await fetch("/api/orders");
  const body = await res.json();
  if (DRIFT === "soft-error") {
    count.textContent = "0 open orders"; root.innerHTML = '<div class="banner" role="alert">We couldn\\'t load your orders. Try again later.</div><table class="orders"><tbody></tbody></table>';
    return;
  }
  orders = body.orders.filter((o) => o.status === "open").map((o) => ({ ...o, total: o.total }));
  render();
}
load();
`;

export function start(drift, port = 0) {
	let db = structuredClone(SEED);
	const server = createServer(async (req, res) => {
		const send = (code, body, type = "application/json") => {
			res.writeHead(code, { "content-type": type });
			res.end(typeof body === "string" ? body : JSON.stringify(body));
		};
		if (req.method === "GET" && req.url === "/") return send(200, page(drift), "text/html");
		if (req.method === "GET" && req.url === "/app.js") return send(200, script(drift), "text/javascript");
		if (req.method === "GET" && req.url === "/api/orders") {
			if (drift === "late-rows") await new Promise((r) => setTimeout(r, 2500));
			if (drift === "soft-error") return send(200, { orders: [], error: "upstream timeout" });
			const orders = db.map((o) =>
				drift === "api-rename" ? { id: o.id, customer: o.customer, amount: o.total, status: o.status } : o,
			);
			return send(200, { orders });
		}
		const m = req.url.match(/^\/api\/orders\/([\w-]+)\/cancel$/);
		if (req.method === "POST" && m) {
			if (drift === "cancel-409") return send(409, { error: "order locked by fulfilment" });
			const o = db.find((x) => x.id === m[1]);
			if (!o || o.status !== "open") return send(404, { error: "not found" });
			o.status = "cancelled";
			return send(200, { ok: true });
		}
		if (req.url === "/__state") return send(200, db);
		if (req.url === "/__reset") {
			db = structuredClone(SEED);
			return send(200, { ok: true });
		}
		send(404, { error: "not found" });
	});
	return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const drift = process.argv[2] ?? "baseline";
	const s = await start(drift, Number(process.argv[3] ?? 4310));
	console.log(`${drift} on http://127.0.0.1:${s.address().port}`);
}
