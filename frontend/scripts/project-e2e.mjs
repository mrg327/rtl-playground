// End-to-end check of the Project view against a running host with a toolchain:
// create a project from the sad_pe template, lint, test, run the flow to finish, screenshot each step.
// Usage: node scripts/project-e2e.mjs <screenshot dir> "http://127.0.0.1:8765/#token=<token>"
import { chromium } from 'playwright';
const S = process.argv[2]; const url = process.argv[3];
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push('pageerror: ' + e.stack)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const answers = ['sad_pe', 'final_project'];
page.on('dialog', d => d.type() === 'prompt' ? d.accept(answers.shift() ?? '') : d.accept());
const waitJob = async (label, title, timeoutMs) => {
  await page.waitForFunction(want => { const t = document.querySelector('#pj-status')?.textContent ?? ''; return t.startsWith(want) && / · (passed|failed|error|cancelled) · /.test(t); }, title, { timeout: timeoutMs });
  const status = await page.textContent('#pj-status'); console.log(label, '→', status); return status;
};
await page.goto(url); await page.waitForTimeout(600);
await page.click('#m-proj'); await page.waitForSelector('#pj-select');
await page.waitForTimeout(800);
await page.screenshot({ path: `${S}/p1-empty.png` });
await page.click('#pj-newproj'); await page.waitForTimeout(1500);
await page.screenshot({ path: `${S}/p2-project.png` });
const out = {};
await page.click('#pj-lint'); out.lint = await waitJob('lint', 'Lint', 120_000);
await page.screenshot({ path: `${S}/p3-lint.png` });
await page.click('#pj-test'); out.test = await waitJob('test', 'Test', 300_000);
await page.waitForTimeout(300);
await page.screenshot({ path: `${S}/p4-tests.png` });
out.testSummary = await page.textContent('#pj-tests .pj-sum');
if (process.env.SKIP_FLOW) { out.errors = errors; console.log(JSON.stringify(out, null, 1)); await browser.close(); process.exit(0); }
await page.click('#pj-flow'); await page.waitForTimeout(3000);
await page.screenshot({ path: `${S}/p5-running.png` });
out.flow = await waitJob('flow', 'Implement', 900_000);
await page.waitForTimeout(800);
await page.screenshot({ path: `${S}/p6-reports.png` });
out.tiles = await page.$$eval('#pj-reports .pj-tile', ts => ts.map(t => t.innerText.replace(/\n/g, ' | ')));
const shots = await page.$$('#pj-reports .pj-shots button');
if (shots.length > 3) { await shots[4].click(); await page.waitForTimeout(500); await page.screenshot({ path: `${S}/p7-worstpath.png` }); }
out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close();
