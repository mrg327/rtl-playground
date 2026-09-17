import { chromium } from 'playwright';
const S = process.argv[2]; const url = process.argv[3];
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push('pageerror: ' + e.stack)); page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
await page.goto(url); await page.waitForTimeout(800);
await page.screenshot({ path: `${S}/01-empty.png` });
// open example 06 via the app API
await page.evaluate(async () => { const r = await fetch('/api/file?path=examples/06-counter.rtlp'); const f = await r.json(); window.rtlp.loadDesign(JSON.parse(f.text), 'examples/06-counter.rtlp'); });
await page.waitForTimeout(300);
for (let i = 0; i < 5; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(60); }
await page.screenshot({ path: `${S}/02-counter.png` });
const cycle = await page.textContent('#cycle');
// a long run must not widen the app grid (the header would slide out of view and could not be scrolled back)
const gridSize = () => page.evaluate(() => { const a = document.querySelector('#app'); return { w: a.scrollWidth, h: a.scrollHeight, runVisible: document.querySelector('#run').getBoundingClientRect().right <= innerWidth }; });
const before = await gridSize();
for (let i = 0; i < 300; i++) await page.keyboard.press('Space');
const after = await gridSize();
const gridOverflow = { grew: after.w !== before.w || after.h !== before.h, before, after };
for (let i = 0; i < 300; i++) await page.keyboard.press('Shift+Space');
// click the counter block to inspect
await page.click('[data-b="cnt"] .body'); await page.waitForTimeout(200);
await page.screenshot({ path: `${S}/03-inspect.png` });
// step back twice
await page.keyboard.press('Shift+Space'); await page.keyboard.press('Shift+Space'); await page.waitForTimeout(100);
const cycle2 = await page.textContent('#cycle');
// run the accumulator example and the tests tab
await page.evaluate(async () => { const r = await fetch('/api/file?path=examples/08-accumulator.rtlp'); const f = await r.json(); window.rtlp.loadDesign(JSON.parse(f.text), 'examples/08-accumulator.rtlp'); });
await page.waitForTimeout(200); await page.click('[data-tab="tests"]'); await page.click('#runtests'); await page.waitForTimeout(200);
await page.screenshot({ path: `${S}/04-tests.png` });
const passes = await page.$$eval('.pass-badge', els => els.length);
// toggle a 1-bit input by click in gates example
await page.evaluate(async () => { const r = await fetch('/api/file?path=examples/01-gates.rtlp'); const f = await r.json(); window.rtlp.loadDesign(JSON.parse(f.text), 'examples/01-gates.rtlp'); });
await page.waitForTimeout(200); await page.click('[data-tab="wave"]'); await page.click('[data-b="a"] .body'); await page.waitForTimeout(100);
const aval = await page.evaluate(() => window.rtlp.store.module.blocks.find(b => b.id === 'a').params.value);
// add a block from palette, wire it by dragging
await page.click('.pal button[data-t="and"]'); await page.waitForTimeout(100);
const nblocks = await page.evaluate(() => window.rtlp.store.module.blocks.length);
await page.keyboard.press('Control+z'); const nblocks2 = await page.evaluate(() => window.rtlp.store.module.blocks.length);
await page.screenshot({ path: `${S}/05-gates.png` });
// presentation mode + command palette
await page.keyboard.press('F11'); await page.waitForTimeout(200); await page.screenshot({ path: `${S}/06-present.png` }); await page.keyboard.press('F11');
await page.keyboard.press('Control+k'); await page.waitForTimeout(100); await page.keyboard.type('vcd'); await page.screenshot({ path: `${S}/07-palette.png` }); await page.keyboard.press('Escape');
const wv = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#wave .wv-row')].map(r => r.querySelector('.wv-name, span')?.textContent), namesTop: document.querySelector('#wave .wv-names-body').scrollTop, paneTop: document.querySelector('#wave .wv-canvas-pane').scrollTop }));
console.log(JSON.stringify({ wv, cycle, gridOverflow, cycle2, passes, aval, nblocks, nblocks2, errors }, null, 1));
await browser.close();
