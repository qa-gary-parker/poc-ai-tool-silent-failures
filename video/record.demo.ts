// Records the walkthrough from results/runs.json on stage.html, timed to the narration.
import { test, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(here, 'out');
const SPEED = process.env.SPEED ?? '1.15';
const VOICE = process.env.VOICE ?? '';
// Cache key for a cloned voice includes the reference clip, so a new reference re-renders every line.
const voiceRef = path.join(os.homedir(), '.local/share/voice', VOICE + '.wav');
const VOICE_KEY = VOICE && fs.existsSync(voiceRef) ? `${VOICE}:${crypto.createHash('sha1').update(fs.readFileSync(voiceRef)).digest('hex').slice(0, 8)}` : VOICE;
// HQ=1: 2x-DPR CDP screencast instead of recordVideo, voice chain, -14 LUFS, variable pauses, room tone
const HQ = !!process.env.HQ;
const GAP = 550;
const GAP_IN = 380; // HQ: pause within a chapter
const GAP_OUT = 1000; // HQ: pause before a new chapter
// FAST=1: no narration, one screenshot per step in out/frames, no video
const FAST = !!process.env.FAST;

type Run = { gen: number; drift: string; task: 'list' | 'cancel'; arm: string; repairs: number; outcome: string; error?: string; result?: unknown };
const runs: Run[] = JSON.parse(fs.readFileSync(path.join(root, 'results/runs.json'), 'utf8'));
const DRIFTS = ['baseline', 'css-rename', 'column-swap', 'locale-format', 'api-rename', 'late-rows', 'paginated', 'soft-error', 'cancel-409', 'cancel-confirm', 'card-layout'];
const n = (arm: string, outcome: string) => runs.filter((r) => r.arm === arm && r.outcome === outcome).length;
const cells = (arm: string) => runs.filter((r) => r.arm === arm).map((r) => [r.drift, `${r.task}-${r.gen - 1}`, r.outcome]);
const find = (arm: string, gen: number, drift: string, task: string) => runs.find((r) => r.arm === arm && r.gen === gen && r.drift === drift && r.task === task)!;
const shot = (name: string) => 'data:image/png;base64,' + fs.readFileSync(path.join(here, 'assets', `${name}.png`)).toString('base64');
const code = (file: string, from: number, to: number) => fs.readFileSync(path.join(root, 'results/tools', file), 'utf8').split('\n').slice(from - 1, to).join('\n');
const json = (v: unknown) => JSON.stringify(v).replace(/\},\{/g, '},\n {');

// Every number the narration says, checked against the data before recording
const SPOKEN: [string, number, number][] = [
  ['generated silent', n('generated', 'silent'), 16],
  ['generated correct', n('generated', 'correct'), 45],
  ['generated loud', n('generated', 'loud'), 5],
  ['schema silent', n('generated+schema', 'silent'), 13],
  ['checks silent', n('generated+checks', 'silent'), 0],
  ['checks correct', n('generated+checks', 'correct'), 58],
  ['checks loud', n('generated+checks', 'loud'), 8],
  ['generated repaired', runs.filter((r) => r.arm === 'generated' && r.repairs > 0).length, 16],
  ['generated correct after repair', runs.filter((r) => r.arm === 'generated' && r.outcome === 'correct' && r.repairs > 0).length, 11],
  ['generated loud after 2 repairs', runs.filter((r) => r.arm === 'generated' && r.outcome === 'loud' && r.repairs === 2).length, 5],
  ['schema api-rename fixed', runs.filter((r) => r.arm === 'generated+schema' && r.drift === 'api-rename' && r.task === 'list' && r.outcome === 'correct').length, 1],
  ['silent repaired', runs.filter((r) => r.arm === 'generated' && r.outcome === 'silent' && r.repairs > 0).length, 0],
  ['checks repaired', runs.filter((r) => r.arm === 'generated+checks' && r.repairs > 0).length, 27],
  ['runs per arm', runs.filter((r) => r.arm === 'generated').length, 66],
  ['baseline not correct', runs.filter((r) => r.drift === 'baseline' && r.outcome !== 'correct').length, 0],
];
for (const [what, got, said] of SPOKEN) if (got !== said) throw new Error(`narration says ${said} for ${what}, data has ${got}`);
const fromSilent = runs.filter((r) => r.arm === 'generated' && r.outcome === 'silent').map((r) => find('generated+checks', r.gen, r.drift, r.task));
const fixedBy = (pred: (r: Run) => boolean) => fromSilent.filter(pred).length;
if (fixedBy((r) => r.outcome === 'correct' && r.repairs > 0) !== 8 || fixedBy((r) => r.outcome === 'correct' && r.repairs === 0) !== 5 || fixedBy((r) => r.outcome === 'loud') !== 3)
  throw new Error('the 8 / 5 / 3 split of the formerly silent runs does not match the data');

function speech(text: string) {
  if (FAST) return { wav: '', seconds: 0.3 };
  const dir = path.join(outDir, 'tts');
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, crypto.createHash('sha1').update(VOICE_KEY + SPEED + text).digest('hex').slice(0, 12) + '.wav');
  if (!fs.existsSync(wav)) execFileSync(path.join(os.homedir(), 'bin/tts'), [...(VOICE ? ['-v', VOICE] : []), '-s', SPEED, '-o', wav, text]);
  const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], { encoding: 'utf8' }));
  return { wav, seconds };
}

type Stage = (fn: string, ...args: unknown[]) => Promise<void>;
type Step = { ch?: string; cap: string; say: string; act?: (S: Stage) => Promise<unknown> };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const locale = find('generated', 1, 'locale-format', 'list').result as { id: string; total: number }[];
const zeros = find('generated', 2, 'api-rename', 'list').result as { id: string; total: number }[];

const steps: Step[] = [
  {
    ch: 'The question',
    cap: 'A tool said "success". The data was wrong.',
    say: 'An AI-generated tool reported success. The data it returned was wrong, and nothing in the loop noticed.',
    act: (S) => S('card', '<h1>"success"</h1><h2 class="r">and the data was wrong</h2>'),
  },
  {
    cap: 'Tools that turn a website into an API',
    say: 'There is a new kind of tool for AI agents. It turns any website into an A P I. It writes Playwright code for the site, and when that code breaks, it repairs it.',
    act: async (S) => { await S('clear'); await S('card', '<h1>website → tool</h1><ul id="how"><li><b>1</b>a model writes Playwright code for the site</li></ul>'); },
  },
  {
    cap: 'When the code breaks, the model repairs it',
    say: 'One of them launched on Hacker News last week, with a claim that most of its errors are repaired automatically.',
    act: (S) => S('append', '#how', '<li><b>2</b>when the code fails, the model repairs it</li>'),
  },
  {
    cap: 'The questions from the thread',
    say: 'The comments asked the right questions. Can a tool return success when the action never happened? And does anything notice when a field goes empty, but the response still looks fine?',
    act: async (S) => {
      await S('clear');
      await S('card', '<blockquote>Can a tool return 200 while the action never completed?</blockquote><blockquote style="margin-top:40px">Does anything notice fields going null while the response looks fine?</blockquote><div class="src">Launch HN comments, paraphrased · news.ycombinator.com/item?id=50455811</div>');
    },
  },
  {
    cap: '16 of 66 runs: wrong data, no error',
    say: 'I measured it. In sixteen of sixty-six runs, a generated tool returned wrong data and reported success. The repair loop never saw a single one of them.',
    act: async (S) => { await S('clear'); await S('card', '<h1><span class="r">16</span> of 66 runs</h1><h2>wrong data, reported as success</h2><h2 class="m" id="h2"></h2>'); },
  },
  {
    cap: 'And what took that number to zero',
    say: 'And I found what took that number to zero. It was not a better model. It was four checks.',
    act: (S) => S('append', '#h2', '<span class="g">0</span> with four checks against the page'),
  },

  {
    ch: 'The site',
    cap: 'A small orders page: 8 open orders',
    say: 'Here is the site. A small orders page, with eight open orders. Each row has an order number, a customer, a total, and a cancel button.',
    act: async (S) => { await S('clear'); await S('shot', shot('baseline'), 'baseline'); await S('card', '<h1>Two tasks</h1><ul id="tasks"></ul>'); },
  },
  {
    cap: 'Task 1: list the open orders',
    say: 'The tool has two tasks. The first one lists the open orders, with the number, the customer, and the total as a number.',
    act: (S) => S('append', '#tasks', '<li><b>1</b>listOpenOrders()<span>id, customer, total</span></li>'),
  },
  {
    cap: 'Task 2: cancel order A-1003',
    say: 'The second one cancels one order: ten oh three.',
    act: (S) => S('append', '#tasks', '<li><b>2</b>cancelOrder("A-1003")<span>{ cancelled, id }</span></li>'),
  },
  {
    cap: 'Then I changed the site in 10 ways',
    say: 'Then I changed the site, in ten ways. Each change is something a real site does.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>10 changes</h1><div class="cols"><div class="col"><b class="b">looks different</b><span>renamed classes · swapped columns · cards in place of a table · 5 orders per page · a confirm dialog</span></div><div class="col"><b class="w">behaves different</b><span>German money format · renamed API field · rows that load late · an error banner on a 200 · a cancel the server refuses</span></div></div>');
    },
  },
  {
    cap: 'Some changes only move things around',
    say: 'Some only change how the page looks. Classes renamed, columns swapped, cards in place of a table, five orders per page, a confirmation dialog before a cancel.',
  },
  {
    cap: 'German format: 1.234,50 €',
    say: 'Others change what the page means. Here the totals use the German format. A dot for thousands, and a comma for the decimals.',
    act: async (S) => { await S('clear'); await S('shot', shot('locale-format'), 'locale-format'); await S('shot', shot('baseline'), 'baseline'); },
  },
  {
    cap: 'Rows that load 2.5 seconds late',
    say: 'Here the A P I is slow. For two and a half seconds the page shows placeholder rows, and says zero open orders.',
    act: async (S) => { await S('clear'); await S('shot', shot('late-rows'), 'late-rows · first 2.5 s'); await S('shot', shot('soft-error'), 'soft-error'); },
  },
  {
    cap: 'An error banner, on an HTTP 200',
    say: 'Here the page loads with a normal status code, but shows an error banner and no rows.',
  },
  {
    cap: 'The server refuses the cancel. The page says it worked.',
    say: 'And here the server refuses the cancel. But the page removes the row anyway, and shows a message: order cancelled. This is an optimistic update, and many real apps do it.',
    act: async (S) => { await S('clear'); await S('shot', shot('cancel-409'), 'cancel-409 · after the click'); await S('card', '<h1>POST /cancel</h1><h2 class="r">409 Conflict</h2><p>the page: "Order A-1003 cancelled"</p>'); },
  },
  {
    cap: 'Renamed API field: the page shows —',
    say: 'One more. The A P I renames the total field. The page has not caught up, so every total shows a dash.',
    act: async (S) => { await S('clear'); await S('shot', shot('api-rename'), 'api-rename'); await S('card', '<h1>GET /api/orders</h1><h2><span class="m">total</span> → <span class="w">amount</span></h2><p>the page: every total "—"</p>'); },
  },

  {
    ch: 'The tools',
    cap: 'Claude Sonnet writes the tool from the page',
    say: 'Now the tools. I gave Claude Sonnet the rendered H T M L of the original page and asked for the two functions.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>Generate</h1><ul id="gen"><li><b>&gt;</b>claude -p --model sonnet<span>input: the rendered HTML of the baseline page</span></li></ul>');
    },
  },
  {
    cap: '3 generations: 3 different tools',
    say: 'I did that three times, so there are three different tools. The model saw nothing else. No tools, no project files, and none of the changed pages.',
    act: (S) => S('append', '#gen', '<li><b>&gt;</b>3 generations<span>no tools · no project files · no CLAUDE.md</span></li>'),
  },
  {
    cap: 'Repair: on an error, up to 2 times',
    say: 'Then the repair loop. When a run fails with an error, the model gets the error, the code, and the changed page, and writes a fix. Up to two times.',
    act: (S) => S('append', '#gen', '<li><b>&gt;</b>repair on error, up to 2 times<span>input: the error, the code, the changed page</span></li>'),
  },
  {
    cap: 'Every run is checked against the server',
    say: 'Every run is scored against the server, not against the tool. Did it return the real open orders? Is the order really cancelled?',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>Three outcomes</h1><div class="cols"><div class="col"><b class="g">correct</b><span>the real orders, or the order really cancelled</span></div><div class="col"><b class="w">loud</b><span>an error, or cancelled: false</span></div><div class="col"><b class="r">silent</b><span>no error, but the result is wrong</span></div></div>');
    },
  },
  {
    cap: 'Loud is fine. Silent is the problem.',
    say: 'A loud failure is fine. Somebody sees it, and the repair loop can act on it. A silent failure is the problem. Your agent carries on with wrong data.',
  },
  {
    cap: 'Error banner, refused cancel: an error is correct',
    say: 'For two of the changes, the right answer is an error. The error banner, and the refused cancel. There, a tool that reports success is silent.',
  },

  {
    ch: 'The results',
    cap: 'Each square: one tool, one task, one version',
    say: 'Here are the results. Each row is one version of the site. Each square is one of the three tools, on one of the two tasks.',
    act: async (S) => { await S('clear'); await S('grid', 'Generated, with repair', '66 runs · 3 tools × 2 tasks × 11 versions', DRIFTS); },
  },
  {
    cap: 'Most runs are correct',
    say: 'Most runs are correct. Forty-five of sixty-six. Eleven of those needed a repair first, and the repair worked.',
    act: (S) => S('fill', cells('generated').filter((c) => c[2] === 'correct')),
  },
  {
    cap: '5 loud',
    say: 'Five runs failed loudly, even after two repairs. Those are fine. Somebody would see them.',
    act: (S) => S('fill', cells('generated').filter((c) => c[2] === 'loud'), 120),
  },
  {
    cap: '16 silent: wrong data, reported as success',
    say: 'And sixteen runs are silent. The tool returned wrong data, or said it cancelled an order it did not cancel, and it reported success.',
    act: (S) => S('fill', cells('generated').filter((c) => c[2] === 'silent'), 160),
  },
  {
    cap: 'Not one silent run started a repair',
    say: 'Not one of those sixteen started a repair. The loop only starts on an error, and there was no error.',
  },

  {
    ch: 'What silent looks like',
    cap: 'German format: 1.234,50 € came back as 1.2345',
    say: 'So what does silent look like? Start with the German format. The first total is one thousand two hundred and thirty-four euros fifty. The tool returned one point two three four five.',
    act: async (S) => {
      await S('clear');
      await S('shot', shot('locale-format'), 'locale-format');
      await S('term', 'a', 'listOpenOrders() → returned', 'gen');
      await S('code', 'a', json(locale.slice(0, 4)));
      await S('mark', 'a', 'A-1001');
    },
  },
  {
    cap: '420,00 € came back as 42000',
    say: 'Four hundred and twenty euros came back as forty-two thousand. All three tools did this.',
    act: (S) => S('mark', 'a', 'A-1003'),
  },
  {
    cap: 'The parser drops every comma',
    say: 'Here is why. The money parser strips everything that is not a digit, a dot, or a comma, and then it removes the commas. In the German format, the comma is the decimal point.',
    act: async (S) => {
      await S('clear');
      await S('term', 'c', 'results/tools/gen1.mjs', 'gen', 'big');
      await S('code', 'c', code('gen1.mjs', 12, 15));
    },
  },
  {
    cap: 'A total of 0, for every order',
    say: 'The renamed A P I field. Every total came back as zero. In one tool, a line turns anything that is not a number into zero. In the other two, the dash becomes an empty string, and the number of an empty string is zero.',
    act: async (S) => {
      await S('clear');
      await S('term', 'a', 'listOpenOrders() → returned', 'gen');
      await S('code', 'a', json(zeros.slice(0, 4)));
      await S('term', 'c', 'results/tools/gen3.mjs', 'gen');
      await S('code', 'c', code('gen3.mjs', 4, 9));
      await S('mark', 'c', 'isNaN');
    },
  },
  {
    cap: 'Late rows, error banner, cards: an empty list',
    say: 'Four changes gave an empty list. The late rows. The error banner. The cards. And, in one tool, the renamed classes. An empty list is a perfectly valid answer. It just was not true.',
    act: async (S) => {
      await S('clear');
      await S('term', 'c', 'results/tools/gen3.mjs', 'gen', 'big');
      await S('code', 'c', code('gen3.mjs', 11, 14));
      await S('mark', 'c', '.catch');
    },
  },
  {
    cap: '.catch(() => {}): a timeout becomes an empty list',
    say: 'This line is the pattern. Wait for the rows, and if the wait times out, catch the error and carry on. The tool then reads zero rows, and returns them.',
  },
  {
    cap: 'cancel-409: cancelled: true, the order is still open',
    say: 'And the cancel. The server refused it. The page removed the row and said cancelled. All three tools checked that the row was gone, saw what they expected, and returned cancelled true.',
    act: async (S) => {
      await S('clear');
      await S('shot', shot('cancel-409'), 'cancel-409 · after the click');
      await S('term', 'a', 'cancelOrder("A-1003") → returned', 'gen');
      await S('code', 'a', JSON.stringify(find('generated', 1, 'cancel-409', 'cancel').result));
      await S('code', 'a', '');
      await S('code', 'a', 'GET /__state  →  A-1003: "open"');
      await S('mark', 'a', 'open');
    },
  },
  {
    cap: 'Code that prefers a value to an error',
    say: 'Each of these is code that prefers a value to an error. That keeps a demo running. In a tool your agent depends on, it hides every change it does not understand.',
  },

  {
    ch: 'A schema check',
    cap: 'First fix: validate the output',
    say: 'The obvious first fix is to validate the output. I added a schema check. Every order needs an id, a customer, and a total that is a positive number. A cancel must say cancelled true.',
    act: async (S) => {
      await S('clear');
      await S('term', 'c', 'harness/run.mjs · zod', 'gen', 'big');
      await S('code', 'c', 'z.array(z.object({\n  id: z.string().min(1),\n  customer: z.string().min(1),\n  total: z.number().finite().positive(),\n}))');
    },
  },
  {
    cap: 'The schema caught the zeros. Nothing else.',
    say: 'It caught the totals of zero. That is three runs out of sixteen. The repair loop fixed one of them, and the other two ended as errors.',
    act: async (S) => { await S('clear'); await S('grid', 'Generated + schema check', '66 runs', DRIFTS); await S('fill', cells('generated'), 0); await pause(1500); await S('fill', cells('generated+schema'), 60); await S('note', 'api-rename', 'caught: total 0'); },
  },
  {
    cap: '13 still silent: [] and 1.2345 pass a schema',
    say: 'Thirteen runs stay silent. An empty list is a valid list. A total of one point two three four five is still a positive number. A schema checks the shape of an answer, not whether it is true.',
  },

  {
    ch: 'Checks against the page',
    cap: 'Ask the page, not the tool',
    say: 'So the next checks do not ask the tool. They ask the page. There are four of them, and they run after the tool returns.',
    act: async (S) => { await S('clear'); await S('card', '<h1>Four checks against the page</h1><ul id="checks"></ul>'); },
  },
  {
    cap: '1. No error banner',
    say: 'One. The page shows no error banner. That is an element with the alert role.',
    act: (S) => S('append', '#checks', '<li><b>1</b>no error on the page<span>getByRole("alert") has 0 matches</span></li>'),
  },
  {
    cap: '2. The count on the page equals the rows returned',
    say: 'Two. The page says how many open orders there are. That number must equal the number of orders the tool returned. This catches every empty list.',
    act: (S) => S('append', '#checks', '<li><b>2</b>"N open orders" = rows returned<span>catches every empty list</span></li>'),
  },
  {
    cap: '3. The digits of each total match the row',
    say: 'Three. For each order, the digits of the total must match the digits in that row on the page. This catches the German format, without knowing anything about it.',
    act: (S) => S('append', '#checks', '<li><b>3</b>total digits = digits in the row<span>1.2345 → "12345" vs "123450"</span></li>'),
  },
  {
    cap: '4. After a cancel, reload and count again',
    say: 'Four. After a cancel, reload the page. There must be one open order less, and no row for that order.',
    act: (S) => S('append', '#checks', '<li><b>4</b>reload: one order less, no row for the id<span>catches the refused cancel</span></li>'),
  },
  {
    cap: 'Written against the original page only',
    say: 'I wrote these against the original page. They know its count label, and its row markup. They know nothing about the ten changes.',
  },
  {
    cap: 'With the checks: 0 silent',
    say: 'Here is the same grid with the checks. Zero silent runs.',
    act: async (S) => { await S('clear'); await S('grid', 'Generated + schema + checks', '66 runs', DRIFTS); await S('fill', cells('generated'), 0); await pause(1500); await S('fill', cells('generated+checks'), 60); },
  },
  {
    cap: '58 correct, 8 loud',
    say: 'Fifty-eight runs are correct, and eight fail loudly. Every silent run became an error, and an error is something the repair loop can work on.',
  },
  {
    cap: 'Of the 16: 8 repaired, 5 correct errors, 3 still failing',
    say: 'Of the sixteen runs that had been silent, eight were repaired to the right answer. Five ended in an error, which is the right answer for the error banner and the refused cancel. And three still failed after two repairs. Loudly.',
    act: async (S) => { await S('note', 'locale-format', 'repaired'); await S('note', 'card-layout', 'repaired'); await S('note', 'cancel-409', 'correct error'); await S('note', 'api-rename', 'still failing, loudly'); },
  },
  {
    cap: '27 runs needed a repair',
    say: 'The repair loop was busier. Twenty-seven runs needed a repair, against sixteen without the checks. It does more work, because now it is told when something is wrong.',
  },
  {
    cap: 'Repair is only as good as what triggers it',
    say: 'That is the main finding. A repair loop is only as good as the checks that trigger it.',
    act: async (S) => { await S('clear'); await S('card', '<h1>A repair loop is only as good<br>as the checks that trigger it</h1>'); },
  },
  {
    cap: 'Same generated tools. Different checks.',
    say: 'The three generated tools are the same in both grids, from the same model. The only difference is what counts as a failure, and so what the repair loop gets to see.',
  },

  {
    ch: 'Where the checks were wrong',
    cap: 'api-rename: the API had the right totals',
    say: 'The checks were not perfect. On the renamed field, two repaired tools read the right totals from the A P I. But the page still shows a dash, so check three failed them.',
    act: async (S) => {
      await S('clear');
      await S('term', 'a', 'generated+checks · api-rename · gen1', 'loud', 'big');
      await S('code', 'a', find('generated+checks', 1, 'api-rename', 'list').error!);
    },
  },
  {
    cap: 'An error where the answer was right',
    say: 'That is an error where the answer was right. I count it as loud, not silent. A false alarm is still cheaper than a false success.',
  },
  {
    cap: 'Limits',
    say: 'Now the limits. I wrote the checks after I saw which runs failed silently. They are general checks, but they know this page. Another site needs its own.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>Limits</h1><ul><li><b>-</b>checks written after seeing the failures<span>general checks, but they know this page</span></li><li><b>-</b>3 tools, 1 model, 2 tasks, 1 small page</li><li><b>-</b>10 changes at once is not how a site changes</li></ul>');
    },
  },
  {
    cap: '3 tools, 1 model, 1 small page',
    say: 'It is three tools from one model, two tasks, and one small page. And a real site does not change in ten ways at once. The rates are for this setup, not for any product.',
  },
  {
    cap: 'The hand-written tool: not a fair comparison',
    say: 'The repository also has a hand-written tool, with Playwright assertions. It had no silent failures. But I wrote it knowing the changes, so I do not count it as a fair comparison.',
  },

  {
    ch: 'Try it',
    cap: 'Clone it and run one version of the site',
    say: 'To try this yourself, clone the repository. You can serve any version of the site, and point your own tool at it.',
    act: async (S) => {
      await S('clear');
      await S('term', 'a', 'your terminal', 'cli', 'big');
      await S('type', 'a', 'git clone https://github.com/qa-gary-parker/poc-ai-tool-silent-failures');
      await S('type', 'a', 'node app/server.mjs locale-format');
    },
  },
  {
    cap: 'Search your generated code for swallowed errors',
    say: 'And search your own generated code for the lines that turn an error into a value. A catch that does nothing. A zero for anything that is not a number.',
    act: async (S) => {
      await S('type', 'a', 'grep -rnE "catch\\(\\(\\) => \\{\\}\\)|isNaN" results/tools/');
    },
  },
  {
    cap: 'Re-run the experiment',
    say: 'The harness reuses the saved tools, so you get my numbers back. Delete them, and you get your own generation.',
    act: (S) => S('type', 'a', 'node harness/run.mjs --gens 3'),
  },

  {
    ch: 'What to do',
    cap: '1. Count silent results, not repairs',
    say: 'What would I do with this? One. If a tool repairs itself, check that it fails when it should. Count the silent results, not the repairs.',
    act: async (S) => { await S('clear'); await S('card', '<h1>What I would do</h1><ul id="todo"><li><b>1</b>Count silent results, not repairs<span>16 silent runs, 0 repairs started</span></li></ul>'); },
  },
  {
    cap: '2. Find the lines that swallow errors',
    say: 'Two. Read the generated code for lines that turn an error into a value. Most of the silent runs here came from one.',
    act: (S) => S('append', '#todo', '<li><b>2</b>Find the lines that swallow errors<span>.catch(() =&gt; {}) · isNaN ? 0 · Number("")</span></li>'),
  },
  {
    cap: '3. Check against the page, not the tool',
    say: 'Three. Add at least one check that comes from the page, not from the tool. A count the page shows, or a re-read after an action.',
    act: (S) => S('append', '#todo', '<li><b>3</b>Check against the page, not the tool<span>13 → 0 silent runs</span></li>'),
  },
  {
    cap: '4. A schema is the floor',
    say: 'Four. Treat a schema as the bare minimum. It catches missing values. It does not catch wrong ones.',
    act: (S) => S('append', '#todo', '<li><b>4</b>A schema is the floor<span>16 → 13 silent runs</span></li>'),
  },
];

const END_SECONDS = 10;
const END_SAY = 'The code, every generated tool, and the write-up are linked in the description.';

test('record the walkthrough', async ({ browser }, testInfo) => {
  const says = [...steps.map((s) => s.say), END_SAY];
  let lines = says.map(speech);
  if (VOICE && !FAST) {
    const tsv = path.join(outDir, 'narration-pre.tsv');
    fs.writeFileSync(tsv, says.map((s) => `0\t${s}`).join('\n') + '\n');
    execFileSync(path.join(os.homedir(), 'bin/tts-check'), [tsv, path.join(outDir, 'tts'), VOICE, SPEED, '4'], { stdio: 'inherit' });
    lines = says.map(speech);
  }
  const viewport = testInfo.project.use.viewport!;
  const context = await browser.newContext(HQ
    ? { viewport, deviceScaleFactor: 2 }
    : { viewport, recordVideo: { dir: testInfo.outputDir, size: viewport } });
  const page: Page = await context.newPage();
  const frames: { t: number; file: string }[] = [];
  const frameDir = path.join(outDir, 'hq-frames');
  let cdp: Awaited<ReturnType<typeof context.newCDPSession>> | undefined;
  if (HQ && !FAST) {
    fs.rmSync(frameDir, { recursive: true, force: true });
    fs.mkdirSync(frameDir, { recursive: true });
    cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = path.join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push({ t: metadata.timestamp! * 1000, file });
      cdp!.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
  }
  await page.goto('file://' + path.join(here, 'stage.html'));
  await page.evaluate(() => document.fonts.ready);
  const S: Stage = (fn, ...args) => page.evaluate(([f, a]) => (window as any).S[f as string](...(a as unknown[])), [fn, args] as const);

  if (cdp) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
  const start = Date.now();
  const at = () => (Date.now() - start) / 1000;
  const cues: { at: number; wav: string; say: string }[] = [];
  const chapters: string[] = [];
  let chapter = 0;
  if (FAST) fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });
  await page.waitForTimeout(400);
  for (const [i, step] of steps.entries()) {
    if (step.ch) {
      await S('chapter', ++chapter, step.ch);
      const t = Math.floor(at());
      chapters.push(`${chapter === 1 ? '0:00' : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`} ${step.ch}`);
    }
    const began = Date.now();
    cues.push({ at: at(), wav: lines[i].wav, say: step.say });
    await S('caption', step.cap);
    await step.act?.(S);
    const gap = HQ ? (steps[i + 1]?.ch || i === steps.length - 1 ? GAP_OUT : GAP_IN) : GAP;
    await page.waitForTimeout(Math.max(0, lines[i].seconds * 1000 + gap - (Date.now() - began)));
    if (FAST) await page.screenshot({ path: path.join(outDir, 'frames', `${String(i + 1).padStart(2, '0')}.png`) });
  }
  await S('end', [
    ['write-up', 'garyparker.dev/blog/\nai-generated-playwright-tools-silent-failures'],
    ['source', 'github.com/qa-gary-parker/\npoc-ai-tool-silent-failures'],
    ['try it', 'grep -rn "catch(() => {})" results/tools/'],
  ], 'generated tools: 16 of 66 runs silent · with page checks: 0');
  cues.push({ at: at(), wav: lines[steps.length].wav, say: END_SAY });
  if (FAST) {
    await page.screenshot({ path: path.join(outDir, 'frames', 'end.png') });
    await context.close();
    return;
  }
  await page.waitForTimeout(END_SECONDS * 1000);
  const length = at();

  const webm = path.join(outDir, 'walkthrough.webm');
  let videoIn: string[];
  if (HQ) {
    await cdp!.send('Page.stopScreencast');
    await context.close();
    // Frames arrive only when the page changes: hold each until the next one.
    const list = frames.map((f, i) => {
      const end = i + 1 < frames.length ? frames[i + 1].t : start + length * 1000;
      return `file '${f.file}'\nduration ${(Math.max(1, end - Math.max(f.t, start)) / 1000).toFixed(4)}`;
    });
    const concat = path.join(frameDir, 'list.txt');
    fs.writeFileSync(concat, list.join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`);
    const firstAt = Math.max(0, (frames[0].t - start) / 1000);
    videoIn = ['-f', 'concat', '-safe', '0', '-i', concat];
    if (firstAt > 0.01) videoIn = ['-itsoffset', firstAt.toFixed(3), ...videoIn];
  } else {
    const video = page.video()!;
    await context.close();
    await video.saveAs(webm);
    videoIn = ['-i', webm];
  }
  fs.writeFileSync(path.join(outDir, 'chapters.txt'), chapters.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'narration.tsv'), cues.map((c) => `${c.at.toFixed(2)}\t${c.say}`).join('\n') + '\n');

  const inputs = cues.flatMap((c) => ['-i', c.wav]);
  const delays = cues.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`).join(';');
  const mix = cues.map((_, i) => `[a${i}]`).join('');
  // HQ voice chain: rumble cut, less boxiness, presence, de-ess, gentle compression, faint room tone, -14 LUFS (YouTube)
  const voice = HQ
    ? 'highpass=f=80,equalizer=f=300:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1.2:g=2.5,deesser=i=0.4,acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=2'
    : 'anull';
  const room = HQ ? `;anoisesrc=colour=brown:amplitude=0.0035:sample_rate=48000:duration=${length.toFixed(3)},lowpass=f=3000[room]` : '';
  const voiceMix = `${mix}amix=inputs=${cues.length}:normalize=0:duration=longest,apad,${voice}`;
  const audio = HQ
    ? `${delays}${room};${voiceMix}[v];[v][room]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-14:TP=-1:LRA=11[aout]`
    : `${delays};${voiceMix},loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
  const video = HQ ? ['-vf', 'fps=30', '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-tune', 'stillimage'] : ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium'];
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...videoIn, ...inputs,
    '-filter_complex', audio,
    '-map', '0:v', '-map', '[aout]', ...video, '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-t', length.toFixed(3), '-movflags', '+faststart', path.join(outDir, 'walkthrough.mp4')]);
  if (HQ) {
    const LIMIT = 'alimiter=limit=0.5:attack=3:release=60:level=false';
    // Second loudness pass: measure the mix, then apply linear gain to exactly -14 LUFS / -1 dBTP.
    const mp4 = path.join(outDir, 'walkthrough.mp4');
    const tmp = path.join(outDir, 'walkthrough.pre-loudnorm.mp4');
    fs.renameSync(mp4, tmp);
    const err = spawnSync('ffmpeg', ['-hide_banner', '-i', tmp, '-af', `${LIMIT},loudnorm=I=-14:TP=-1:LRA=11:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const m = JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', tmp, '-c:v', 'copy', '-af',
      `${LIMIT},loudnorm=I=-14:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', mp4]);
    fs.rmSync(tmp);
  }
  console.log(`walkthrough.mp4 ${length.toFixed(1)} s, ${cues.length} lines, ${lines.reduce((a, l) => a + l.seconds, 0).toFixed(1)} s of speech`);
  console.log(chapters.join('\n'));
});
