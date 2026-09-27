// Result panels for project jobs: lint problems, cocotb test suites, and the physical-design report.
import type { JobInfo, ProjectInfo } from '../host/api';

const esc = (t: string) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

interface Diag { severity: 'error' | 'warning'; code: string; file: string | null; line: number | null; col: number | null; message: string }
interface Case { name: string; module: string; status: 'passed' | 'failed' | 'skipped'; message: string; time: number | null; simTimeNs: number | null }
interface Suite { name: string; cases: Case[]; missing?: boolean; message?: string; waves: string | null }

/** Metrics produced by reports.py; every field may be missing when the flow stopped early. */
export interface FlowResult {
  stage: string; platform: string; predictive: boolean; note: string;
  clockPeriodNs: number | null;
  timing: { setupWnsNs: number | null; setupTnsNs: number | null; holdWnsNs: number | null; holdTnsNs: number | null; fmaxMHz: number | null; met: boolean | null; source: string } | null;
  area: { designUm2: number | null; coreUm2: number | null; utilization: number | null; cells: number | null; sequential: number | null } | null;
  power: { totalW: number | null; internalW: number | null; switchingW: number | null; leakageW: number | null; activity: string } | null;
  route: { wirelengthUm: number | null; drcErrors: number | null } | null;
  steps: { name: string; elapsedS: number | null; peakMemMB: number | null }[];
  files: { label: string; path: string }[];
  layoutPng: string | null;
  images: { label: string; path: string }[];
  warnings: string[];
}

/** Result of the "power" job (reports.collect_power): simulated-activity power and the
 * energy it implies over one test, alongside the default-activity numbers for comparison. */
export interface PowerResult {
  test: string; clockPeriodNs: number | null; simTimeNs: number | null;
  power: { totalW: number | null; internalW: number | null; switchingW: number | null; leakageW: number | null; activity: string } | null;
  energyJ: number | null; energyPerCycleJ: number | null;
  defaultPower: FlowResult['power'];
  annotatedPins: number | null; annotatedPinsTotal: number | null;
  waves: string | null;
  warnings: string[];
}

function none(el: HTMLElement, text: string): void { el.innerHTML = `<p class="pj-empty">${text}</p>`; }

export function renderLintReport(el: HTMLElement, job: JobInfo | undefined, open: (file: string, line?: number) => void): void {
  if (!job) return none(el, 'Run <b>Lint</b> to check the RTL with Verilator. Problems also show in the editor gutter.');
  const d = (job.result.diagnostics ?? []) as Diag[];
  if (job.status === 'error' || job.status === 'cancelled' || (!job.result.diagnostics && job.status === 'failed')) return none(el, `Lint ${job.status}${job.error ? `: ${esc(job.error)}` : ''}. See the log.`);
  if (!d.length) return none(el, '✓ Verilator found no problems.');
  el.innerHTML = `<div class="pj-sum">${job.result.errors} error${job.result.errors === 1 ? '' : 's'}, ${job.result.warnings} warning${job.result.warnings === 1 ? '' : 's'}</div>` +
    d.map((x, i) => `<div class="item ${x.severity}" data-i="${i}"><b>${x.code || x.severity}</b> ${x.file ? `<code>${esc(x.file)}:${x.line ?? ''}</code> ` : ''}${esc(x.message)}</div>`).join('');
  el.onclick = e => { const it = (e.target as HTMLElement).closest<HTMLElement>('.item'); if (!it) return; const x = d[+it.dataset.i!]; if (x.file) open(x.file, x.line ?? undefined); };
}

export function renderTestReport(el: HTMLElement, job: JobInfo | undefined, project: ProjectInfo | null, raw: (p: string) => string): void {
  if (!project?.tests.length) return none(el, 'This project defines no tests. Add a cocotb module under <code>tb/</code> and list it in <code>tests</code> in <code>rtlp-project.json</code>.');
  if (!job) return none(el, `Run <b>Test</b> to run ${project.tests.map(t => `<code>${esc(t.module)}</code>`).join(', ')} on Verilator.`);
  const suites = (job.result.suites ?? []) as Suite[];
  if (!suites.length) return none(el, `Tests ${job.status}${job.error ? `: ${esc(job.error)}` : ''}. See the log.`);
  const passed = suites.reduce((n, s) => n + s.cases.filter(c => c.status === 'passed').length, 0);
  const broken = suites.filter(s => s.missing).length;
  let h = `<div class="pj-sum">${broken ? `${broken} test suite${broken === 1 ? '' : 's'} did not run · ` : ''}${passed} / ${job.result.total} tests passed</div>`;
  for (const s of suites) {
    h += `<h4>${esc(s.name)} ${s.waves ? `<a class="pj-wave" href="${raw(s.waves)}" download title="Open in Surfer (surfer-project.org) or GTKWave">waves ↓</a>` : ''}</h4>`;
    if (s.missing) h += `<div class="item error">${esc(s.message ?? 'no results')}</div>`;
    h += `<table class="pj-table"><tr><th></th><th>test</th><th>sim time</th><th>wall</th><th>message</th></tr>` +
      s.cases.map(c => `<tr class="${c.status}"><td>${c.status === 'passed' ? '✓' : c.status === 'skipped' ? '–' : '✗'}</td><td>${esc(c.name)}</td><td>${c.simTimeNs != null ? fmtTime(c.simTimeNs) : ''}</td><td>${c.time != null ? c.time.toFixed(2) + ' s' : ''}</td><td class="msg">${esc(c.message)}</td></tr>`).join('') + `</table>`;
  }
  el.innerHTML = h;
}

function fmtTime(ns: number): string { return ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : ns >= 1e3 ? `${(ns / 1e3).toFixed(2)} µs` : `${ns.toFixed(0)} ns`; }
const n = (v: number | null | undefined, digits = 3) => v == null ? '–' : Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(digits).replace(/\.?0+$/, '') || '0';
function watts(v: number | null | undefined): string { if (v == null) return '–'; const a = Math.abs(v); return a >= 1 ? `${n(v)} W` : a >= 1e-3 ? `${n(v * 1e3)} mW` : a >= 1e-6 ? `${n(v * 1e6)} µW` : `${n(v * 1e9)} nW`; }
function joules(v: number | null | undefined): string { if (v == null) return '–'; const a = Math.abs(v); return a >= 1 ? `${n(v)} J` : a >= 1e-3 ? `${n(v * 1e3)} mJ` : a >= 1e-6 ? `${n(v * 1e6)} µJ` : a >= 1e-9 ? `${n(v * 1e9)} nJ` : `${n(v * 1e12)} pJ`; }

export function renderFlowReport(el: HTMLElement, job: JobInfo | undefined, power: JobInfo | undefined, project: ProjectInfo | null, raw: (p: string) => string, open: (file: string) => void): void {
  if (!job) return none(el, `Run <b>Synthesize</b> or <b>Implement</b> to take <code>${esc(project?.top ?? 'the design')}</code> through OpenROAD on ${esc(project?.platform.title ?? 'the chosen platform')}. Timing, area, power and the layout appear here.`);
  const r = job.result as Partial<FlowResult>;
  if (!r.stage) return none(el, `${esc(job.title)} ${job.status}${job.error ? `: ${esc(job.error)}` : ''}. See the log.`);
  const t = r.timing, a = r.area, p = r.power, rt = r.route;
  const met = t?.met; const slackCls = met == null ? '' : met ? 'good' : 'bad';
  const tile = (label: string, value: string, sub = '', cls = '') => `<div class="pj-tile ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
  let h = `<div class="pj-sum">${esc(job.title)} · ${job.status}${r.stage !== 'finish' ? ` · stopped after <b>${esc(r.stage)}</b>` : ''}</div>`;
  if (r.predictive) h += `<div class="pj-hint warn">${esc(r.note ?? '')}</div>`;
  for (const w of r.warnings ?? []) h += `<div class="item warning">${esc(w)}</div>`;
  h += `<div class="pj-tiles">`;
  h += tile('Setup slack (WNS)', t?.setupWnsNs != null ? `${n(t.setupWnsNs)} ns` : '–', t ? `TNS ${n(t.setupTnsNs)} ns · ${esc(t.source)}` : '', slackCls);
  h += tile('Clock', r.clockPeriodNs ? `${n(r.clockPeriodNs)} ns` : '–', r.clockPeriodNs ? `${n(1000 / r.clockPeriodNs, 1)} MHz target` : '');
  h += tile('Achievable', t?.fmaxMHz != null ? `${n(t.fmaxMHz, 1)} MHz` : '–', 'period − WNS', slackCls);
  h += tile('Hold slack', t?.holdWnsNs != null ? `${n(t.holdWnsNs)} ns` : '–', '', t?.holdWnsNs != null ? (t.holdWnsNs >= 0 ? 'good' : 'bad') : '');
  h += tile('Cell area', a?.designUm2 != null ? `${n(a.designUm2, 2)} µm²` : '–', a?.utilization != null ? `${n(a.utilization * 100, 1)}% utilization` : '');
  h += tile('Cells', a?.cells != null ? n(a.cells, 0) : '–', a?.sequential != null ? `${n(a.sequential, 0)} flops` : '');
  h += tile('Power (default activity)', watts(p?.totalW), p ? `int ${watts(p.internalW)} · sw ${watts(p.switchingW)} · leak ${watts(p.leakageW)}` : '');
  if (p) h += tile('Energy / cycle (default activity)', p.totalW != null && r.clockPeriodNs ? `${n(p.totalW * r.clockPeriodNs * 1e3, 3)} pJ` : '–', esc(p.activity));
  if (rt) h += tile('Wirelength', rt.wirelengthUm != null ? `${n(rt.wirelengthUm, 0)} µm` : '–', rt.drcErrors != null ? `${rt.drcErrors} DRC errors` : '', rt.drcErrors ? 'bad' : '');
  const pr = power?.result as Partial<PowerResult> | undefined;
  if (pr?.power) {
    const sp = pr.power;
    const wave = pr.waves ? ` · <a class="pj-wave" href="${raw(pr.waves)}" download title="Open in Surfer (surfer-project.org) or GTKWave">waves ↓</a>` : '';
    h += tile('Power (simulated activity)', watts(sp.totalW), `int ${watts(sp.internalW)} · sw ${watts(sp.switchingW)} · leak ${watts(sp.leakageW)}${wave}`);
    h += tile('Energy over test', joules(pr.energyJ), `${esc(sp.activity)}${pr.simTimeNs != null ? ` over ${fmtTime(pr.simTimeNs)}` : ''}${pr.energyPerCycleJ != null ? ` · ${joules(pr.energyPerCycleJ)}/cycle` : ''}`);
  } else if (power && power.status !== 'running' && power.status !== 'queued') {
    h += tile('Power (simulated activity)', '–', power.error ?? 'See the log.', 'bad');
  }
  h += `</div>`;
  for (const w of pr?.warnings ?? []) h += `<div class="item warning">${esc(w)}</div>`;
  const imgs = r.images?.length ? r.images : r.layoutPng ? [{ label: 'Layout', path: r.layoutPng }] : [];
  if (imgs.length) {
    const src = (p: string) => `${raw(p)}&t=${job.ended ?? 0}`;
    h += `<figure class="pj-layout"><img id="pj-shot" src="${src(imgs[0].path)}" alt="${esc(imgs[0].label)} of ${esc(project?.top ?? '')}"><figcaption id="pj-shotcap">${esc(imgs[0].label)} (${esc(r.platform ?? '')}) · click to open full size</figcaption></figure>`;
    if (imgs.length > 1) h += `<div class="pj-shots">${imgs.map((im, i) => `<button class="tool${i ? '' : ' active'}" data-shot="${esc(im.path)}" data-label="${esc(im.label)}">${esc(im.label)}</button>`).join('')}</div>`;
  }
  if (r.steps?.length) h += `<h4>Stages</h4><table class="pj-table"><tr><th>stage</th><th>time</th><th>peak memory</th></tr>${r.steps.map(s => `<tr><td>${esc(s.name)}</td><td>${s.elapsedS != null ? `${n(s.elapsedS, 1)} s` : ''}</td><td>${s.peakMemMB != null ? `${n(s.peakMemMB, 0)} MB` : ''}</td></tr>`).join('')}</table>`;
  if (r.files?.length) h += `<h4>Outputs</h4><ul class="pj-files-out">${r.files.map(f => `<li><a href="#" data-f="${esc(f.path)}">${esc(f.label)}</a> <code>${esc(f.path)}</code></li>`).join('')}</ul>`;
  el.innerHTML = h;
  el.onclick = e => {
    const target = e.target as HTMLElement;
    const shot = target.closest<HTMLButtonElement>('button[data-shot]');
    if (shot) {
      el.querySelectorAll('.pj-shots button').forEach(b => b.classList.toggle('active', b === shot));
      el.querySelector<HTMLImageElement>('#pj-shot')!.src = `${raw(shot.dataset.shot!)}&t=${job.ended ?? 0}`;
      el.querySelector('#pj-shotcap')!.textContent = `${shot.dataset.label} (${r.platform ?? ''}) · click to open full size`;
      return;
    }
    if (target.id === 'pj-shot') { window.open((target as HTMLImageElement).src, '_blank'); return; }
    const a2 = target.closest<HTMLAnchorElement>('a[data-f]'); if (!a2) return; e.preventDefault(); const f = a2.dataset.f!;
    if (/\.(png|webp|gds|odb|def|spef)$/i.test(f)) window.open(raw(f), '_blank'); else open(f);
  };
}
