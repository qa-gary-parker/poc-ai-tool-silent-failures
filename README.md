# poc-ai-tool-silent-failures

**The question:** when a website changes, how often does an AI-generated Playwright tool return wrong data with no error, and does an auto-repair loop catch it?

**The answer:** in 16 of 66 runs (24%; 16 of the 60 runs on a changed page) the generated tools returned wrong data and reported success. The repair loop never saw those runs, because it only starts on an error. A schema check on the output caught 3 of them. Four checks against the page (no error banner, row count, total digits, re-read after an action) caught the other 13: 0 silent failures in 66 runs. Of the 16, 8 were then repaired to correct, 5 ended with the correct error, and 3 stayed errors.

> Exploratory PoC, throwaway by default.

## Method

- `app/server.mjs` serves an orders page (12 orders, 8 open) and its API. It has a baseline and 10 changes, one per server:

| change | what the page or API does |
|---|---|
| css-rename | every class and container id renamed |
| column-swap | Customer and Total columns swapped |
| locale-format | totals shown as `1.234,50 €` in place of `€1,234.50` |
| api-rename | the API field `total` renamed to `amount`; the page shows `—` |
| late-rows | the API answers after 2.5 s; 3 placeholder rows and "0 open orders" until then |
| paginated | 5 orders per page, with a Next page button |
| soft-error | HTTP 200, an error banner, no rows, "0 open orders" |
| cancel-409 | the cancel API returns 409; the page still removes the row and shows "Order cancelled" |
| cancel-confirm | Cancel opens a confirm dialog |
| card-layout | cards in place of the table |

- Two tasks per run: `listOpenOrders` (return id, customer and total for every open order) and `cancelOrder("A-1003")`.
- `harness/run.mjs` generates 3 tools with `claude -p --model sonnet` (Claude Code 2.1.325) from the rendered HTML of the baseline page. The model gets the task prompt and the HTML: no tools, no MCP servers, no CLAUDE.md, no memory, an empty working directory. Claude Code 2.1.325 was the installed version; the run records do not store it. The page script is served from `/app.js`, so the HTML does not show the other versions.
- Repair: when a run fails with an error, the harness sends the error, the current code and the rendered HTML of the changed page to the same model, up to 2 times. This is the "repair on hard failure" model.
- Each run is classed against the server's data:
  - **correct**: the right orders, or the order is cancelled on the server. For soft-error (list) and cancel-409, an error is the correct result.
  - **loud**: an error, or `cancelled: false`.
  - **silent**: no error, but the data is wrong or the order is not cancelled.

Four arms:

| arm | what runs |
|---|---|
| generated | the generated tool, with repair |
| generated+schema | the same, then a zod schema: id and customer not empty, total a positive number, `cancelled: true` |
| generated+checks | the schema, then 4 checks against the page: no `role="alert"`; the page's "N open orders" equals the rows returned; the digits of each total match the row on the page; after a cancel, a reload shows one open order less and no row for the id |
| handwritten | `tools/handwritten.mjs`, Playwright assertions, no repair |

The checks were written against the baseline page, but after I saw which runs failed silently in the first two arms. The hand-written tool was written with the changes in mind. It is in the table to show how a strict tool fails, not as a fair comparison.

## Results

`results/runs.json` has every run, with the error or the returned data. The generated and repaired code is in `results/tools/`.

| arm | runs | correct | loud | silent |
|---|---|---|---|---|
| generated | 66 | 45 | 5 | **16** |
| generated+schema | 66 | 46 | 7 | **13** |
| generated+checks | 66 | 58 | 8 | **0** |
| handwritten | 22 | 14 | 8 | 0 |

Silent failures by change (3 tools each; generated / +schema / +checks):

| change | task | silent | what the tool returned |
|---|---|---|---|
| locale-format | list | 3 / 3 / 0 | 1234.50 read as 1.2345, 420.00 as 42000 |
| cancel-409 | cancel | 3 / 3 / 0 | `cancelled: true`; the order is still open |
| api-rename | list | 3 / 0 / 0 | every total 0 |
| late-rows | list | 2 / 2 / 0 | `[]` |
| soft-error | list | 2 / 2 / 0 | `[]` |
| card-layout | list | 2 / 2 / 0 | `[]` |
| css-rename | list | 1 / 1 / 0 | `[]` |

- No silent run started a repair. All 16 repaired runs in the generated arm (21 repairs) followed an error.
- In generated+checks, 27 runs needed a repair: 19 ended correct, 8 ended with an error (api-rename 3, soft-error cancel 3, late-rows cancel 2).
- No arm reported an error on the baseline page.
- Where the silent values came from, in the generated code: `Number.isNaN(n) ? 0 : n` and `waitForSelector(...).catch(() => {})` in gen3; `Number("")` returning 0 for `—` in gen1 and gen2; money parsers that drop every comma (all 3); a cancel that counts as done when the row leaves the page (all 3).
- In 2 api-rename runs, generated+checks failed a correct answer: the repaired tool read the right totals from the API, but the page shows `—`, so the digits check failed.

## Limits

- 3 generated tools from one model (Sonnet), 2 tasks, 1 small page. The rates are for this setup.
- The changes are mine. A real site changes in other ways and less often.
- The checks know this page: its count label, its row markup, its error role. A check for another site needs its own invariants.
- The generated and repaired code is saved and reused, so a re-run gives the same results. A new generation can give different code.

## Reproduce

```bash
npm install
npx playwright install chromium
node harness/run.mjs --gens 3     # reuses results/tools/*.mjs; delete them to generate again
node app/server.mjs late-rows      # serve one version on :4310
```

Generation needs a logged-in `claude` CLI.

MIT. Independent experiment; no affiliation with Anthropic, Microsoft or any vendor.
