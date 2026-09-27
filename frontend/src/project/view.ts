// Project workspace: SystemVerilog + cocotb files, constraints, and tool jobs run by the host (DESIGN.md section 13).
import './project.css';
import type { Host, JobInfo, JobKind, ProjectInfo, ProjectRef, ToolsInfo } from '../host/api';
import { CodeEditor, type LineDiagnostic } from './editor';
import { renderFlowReport, renderTestReport, renderLintReport } from './reports';
import { WavesPanel } from './waves';

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const EDITABLE = /\.(sv|svh|v|vh|py|sdc|tcl|json|mk|md|txt|mem|hex)$/i;
const POLL_MS = 400;
type Tab = 'log' | 'problems' | 'tests' | 'reports' | 'waves';

interface FileNode { path: string; name: string; dir: boolean; children?: FileNode[]; open?: boolean }

export class ProjectView {
  el: Record<string, HTMLElement> = {};
  editor!: CodeEditor;
  waves!: WavesPanel;
  tools: ToolsInfo | null = null;
  projects: ProjectRef[] = [];
  project: ProjectInfo | null = null;
  projectPath = '';
  tree: FileNode[] = [];
  file: { path: string; mtime: number; dirty: boolean } | null = null;
  job: JobInfo | null = null;
  lastByKind: Partial<Record<JobKind, JobInfo>> = {};
  logText = '';
  tab: Tab = 'log';
  private pollTimer: number | null = null;
  private started = false;

  constructor(public root: HTMLElement, public host: Host, private toast: (msg: string) => void) {
    root.innerHTML = `
      <div class="pj-bar">
        <select id="pj-select" title="Project"></select><button id="pj-newproj" title="Create a project from a starter template">New project…</button>
        <span class="pj-tools" id="pj-tools">checking tools…</span>
        <span class="spacer"></span>
        <button id="pj-lint" title="Verilator lint of the RTL sources">Lint</button>
        <button id="pj-test" title="Run the cocotb testbenches on Verilator">Test</button>
        <button id="pj-synth" title="Yosys synthesis through OpenROAD-flow-scripts">Synthesize</button>
        <select id="pj-stage" title="Run the physical-design flow up to this stage"></select>
        <button id="pj-flow" class="primary" title="Floorplan, place, clock tree, route and sign-off">Implement</button>
        <button id="pj-power" title="Simulate a test with a VCD dump and report power from its switching activity">Power</button>
        <button id="pj-cancel" title="Stop the running job" disabled>Stop</button>
      </div>
      <aside class="pj-files"><h2>Files <button class="tool" id="pj-new" title="New file">+</button><button class="tool" id="pj-reload" title="Reload the file list">⟳</button></h2><div id="pj-tree" class="pj-tree"></div></aside>
      <div class="pj-main">
        <div class="pj-edhead"><span id="pj-path">No file open</span><span class="spacer"></span><button class="tool" id="pj-save" disabled>Save</button></div>
        <div class="pj-editor" id="pj-editor"></div>
      </div>
      <aside class="pj-side"><h2>Constraints and flow</h2><div id="pj-form" class="pj-form"></div></aside>
      <section class="pj-out">
        <div class="tabs"><button data-tab="log" class="active">Log</button><button data-tab="problems">Problems</button><button data-tab="tests">Tests</button><button data-tab="waves">Waves</button><button data-tab="reports">Reports</button>
          <span class="spacer"></span><span id="pj-status" class="pj-status"></span></div>
        <pre class="panel active" id="pj-log"></pre>
        <div class="panel" id="pj-problems"></div>
        <div class="panel" id="pj-tests"></div>
        <div class="panel" id="pj-waves"></div>
        <div class="panel" id="pj-reports"></div>
      </section>`;
    for (const id of ['pj-select', 'pj-newproj', 'pj-tools', 'pj-lint', 'pj-test', 'pj-synth', 'pj-stage', 'pj-flow', 'pj-power', 'pj-cancel', 'pj-new', 'pj-reload', 'pj-tree', 'pj-path', 'pj-save', 'pj-editor', 'pj-form', 'pj-status', 'pj-log', 'pj-problems', 'pj-tests', 'pj-waves', 'pj-reports']) this.el[id] = root.querySelector('#' + id)!;
    this.editor = new CodeEditor(this.el['pj-editor'], { onChange: () => this.markDirty(), onSave: () => void this.save() });
    this.waves = new WavesPanel(this.el['pj-waves'], host, toast);
    this.bind();
  }

  // ---------- lifecycle ----------
  async show(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.host.available) { this.el['pj-tree'].innerHTML = `<p class="pj-empty">Projects need the local host: start the app with <code>rtl-playground</code> or <code>uvx rtl-playground</code>.</p>`; this.setBusy(false); return; }
    await Promise.all([this.loadTools(false), this.loadProjects(), this.waves.refresh()]);
    const { jobs } = await this.host.jobs();
    const running = jobs.find(j => j.status === 'running' || j.status === 'queued');
    for (const j of jobs) if (j.project === this.projectPath && j.status !== 'running') this.lastByKind[j.kind] = j;
    if (running) this.follow(running); else { this.setBusy(false); this.renderResults(); }
  }

  async loadTools(refresh: boolean): Promise<void> {
    try { this.tools = await this.host.tools(refresh); } catch (e) { this.tools = null; this.toast(`Cannot query tools: ${(e as Error).message}`); }
    const t = this.tools; const badge = this.el['pj-tools'];
    if (!t) { badge.textContent = 'tools unknown'; badge.className = 'pj-tools bad'; return; }
    if (!t.available) { badge.innerHTML = `no tools · <a href="#" id="pj-toolhelp">set up</a>`; badge.className = 'pj-tools bad'; badge.title = t.reason; badge.querySelector('#pj-toolhelp')!.addEventListener('click', e => { e.preventDefault(); this.showToolHelp(); }); }
    else if (t.mode === 'docker' && !t.imageReady) { badge.innerHTML = `<a href="#" id="pj-setup">Set up tools</a>`; badge.className = 'pj-tools bad'; badge.title = `Download ${t.image} with ${t.engine} (one time, several GB)`; badge.querySelector('#pj-setup')!.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); void this.run('setup'); }); }
    else { badge.textContent = t.mode === 'docker' ? `tools: ${t.engine} · ${t.image?.replace(/^.*\//, '')}` : 'tools: native'; badge.className = 'pj-tools ok'; badge.title = Object.entries(t.tools).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n(click to re-check)'; }
    const stage = this.el['pj-stage'] as HTMLSelectElement;
    stage.innerHTML = (t.stages ?? []).filter(s => s !== 'synth').map(s => `<option value="${s}"${s === 'finish' ? ' selected' : ''}>to ${s}</option>`).join('');
    this.setBusy(!!this.job && !this.isDone(this.job));
  }

  showToolHelp(): void {
    this.tab = 'log'; this.syncTabs();
    this.el['pj-log'].textContent = [
      'The project tools (Verilator, cocotb, Yosys, OpenROAD, KLayout and the PDKs) run in one Docker image.',
      '',
      '1. Install Docker Desktop (Windows, macOS) or Docker Engine (Linux) and start it.',
      '2. Click the tools badge to re-check, then "Set up tools" to download the image once (several GB).',
      '',
      'No admin rights (a lab machine)? Start the app with  uvx --with udocker rtl-playground  instead:',
      'udocker runs the same image as an ordinary user, a little slower.',
      '',
      'Linux users with the tools installed natively can set RTLP_TOOLCHAIN=native, RTLP_TOOLS_PATH and RTLP_ORFS_FLOW instead.',
      '',
      `Detected: ${this.tools?.reason ?? 'unknown'}`,
    ].join('\n');
  }

  async loadProjects(select?: string): Promise<void> {
    try { this.projects = (await this.host.projects()).projects; } catch (e) { this.toast(`Cannot list projects: ${(e as Error).message}`); this.projects = []; }
    const sel = this.el['pj-select'] as HTMLSelectElement;
    if (!this.projects.length) {
      sel.innerHTML = `<option>no projects</option>`; sel.disabled = true;
      this.el['pj-tree'].innerHTML = `<p class="pj-empty">No <code>rtlp-project.json</code> found under the served folder. Click <b>New project…</b> to start from the <code>sad_pe</code> template (a motion-estimator processing element with cocotb tests and the course constraints).</p>`;
      this.setBusy(false); return;
    }
    sel.disabled = false;
    sel.innerHTML = this.projects.map(p => `<option value="${esc(p.path)}">${esc(p.path || '.')} · ${esc(p.name)}${p.problems.length ? ' ⚠' : ''}</option>`).join('');
    const want = select ?? (this.projects.some(p => p.path === this.projectPath) ? this.projectPath : this.projects[0].path);
    sel.value = want;
    await this.openProject(want);
  }

  async openProject(path: string): Promise<void> {
    if (this.file?.dirty && !confirm(`Discard unsaved changes to ${this.file.path}?`)) { (this.el['pj-select'] as HTMLSelectElement).value = this.projectPath; return; }
    this.projectPath = path; this.file = null; this.el['pj-path'].textContent = 'No file open'; this.editor.open('', '');
    this.lastByKind = {};
    try { this.project = await this.host.project(path); }
    catch (e) {
      this.project = null;
      const probs: string[] = (e as { data?: { problems?: string[] } }).data?.problems ?? [(e as Error).message];
      this.el['pj-form'].innerHTML = `<div class="pj-problems-list">${probs.map(p => `<div class="item error">${esc(p)}</div>`).join('')}</div><p>Fix <code>rtlp-project.json</code> and reload.</p>`;
    }
    this.renderForm();
    await this.loadTree();
    this.setBusy(!!this.job && !this.isDone(this.job));
    const first = this.project?.sources[0];
    if (first) await this.openFile(this.rel(first));
    this.renderResults();
  }

  rel(p: string): string { return this.projectPath ? `${this.projectPath}/${p}` : p; }
  unrel(p: string): string { return this.projectPath && p.startsWith(this.projectPath + '/') ? p.slice(this.projectPath.length + 1) : p; }

  // ---------- file tree ----------
  async loadTree(): Promise<void> {
    const openDirs = new Set<string>(); const walk = (ns: FileNode[]) => { for (const n of ns) if (n.dir) { if (n.open) openDirs.add(n.path); walk(n.children ?? []); } }; walk(this.tree);
    const list = async (dir: string, depth: number): Promise<FileNode[]> => {
      const { entries } = await this.host.list(dir);
      const out: FileNode[] = [];
      for (const e of entries) {
        const path = dir ? `${dir}/${e.name}` : e.name;
        if (e.type === 'dir') {
          const isBuild = depth === 0 && e.name === 'build';
          const open = openDirs.has(path) || (!isBuild && depth === 0 && !openDirs.size);
          out.push({ path, name: e.name, dir: true, open, children: open && depth < 4 ? await list(path, depth + 1) : undefined });
        } else out.push({ path, name: e.name, dir: false });
      }
      return out;
    };
    try { this.tree = await list(this.projectPath, 0); } catch (e) { this.tree = []; this.toast(`Cannot list files: ${(e as Error).message}`); }
    this.renderTree();
  }

  renderTree(): void {
    const row = (n: FileNode, depth: number): string => {
      const pad = `style="padding-left:${8 + depth * 14}px"`;
      if (n.dir) return `<div class="pj-node dir${n.open ? ' open' : ''}" data-path="${esc(n.path)}" ${pad}>${n.open ? '▾' : '▸'} ${esc(n.name)}</div>` + (n.open && n.children ? n.children.map(c => row(c, depth + 1)).join('') : '');
      const cls = this.file?.path === n.path ? ' cur' : '';
      return `<div class="pj-node file${cls}" data-path="${esc(n.path)}" ${pad}>${esc(n.name)}</div>`;
    };
    this.el['pj-tree'].innerHTML = this.tree.map(n => row(n, 0)).join('') || `<p class="pj-empty">Empty folder.</p>`;
  }

  findNode(path: string, ns = this.tree): FileNode | null { for (const n of ns) { if (n.path === path) return n; if (n.children) { const f = this.findNode(path, n.children); if (f) return f; } } return null; }

  async toggleDir(path: string): Promise<void> {
    const n = this.findNode(path); if (!n) return;
    n.open = !n.open;
    if (n.open && !n.children) {
      const { entries } = await this.host.list(path);
      n.children = entries.map(e => ({ path: `${path}/${e.name}`, name: e.name, dir: e.type === 'dir' }));
    }
    this.renderTree();
  }

  // ---------- editor ----------
  async openFile(path: string, line?: number): Promise<void> {
    if (this.file?.path === path) { if (line) this.editor.goto(line); return; }
    if (this.file?.dirty && !confirm(`Discard unsaved changes to ${this.file.path}?`)) return;
    if (!EDITABLE.test(path)) { window.open(this.host.rawUrl(path), '_blank'); return; }
    try {
      const r = await this.host.read(path);
      const readOnly = this.unrel(path).startsWith('build/');
      this.file = { path, mtime: r.mtime, dirty: false };
      this.editor.open(path, r.text, readOnly);
      this.el['pj-path'].textContent = this.unrel(path) + (readOnly ? ' (generated, read-only)' : '');
      (this.el['pj-save'] as HTMLButtonElement).disabled = true;
      this.applyDiagnostics();
      if (line) this.editor.goto(line);
      this.renderTree();
    } catch (e) { this.toast(`Cannot open ${path}: ${(e as Error).message}`); }
  }

  markDirty(): void { if (!this.file || this.file.dirty) return; this.file.dirty = true; (this.el['pj-save'] as HTMLButtonElement).disabled = false; this.el['pj-path'].classList.add('dirty'); }

  async save(): Promise<boolean> {
    const f = this.file; if (!f || !f.dirty) return true;
    try {
      const r = await this.host.write(f.path, this.editor.text, f.mtime);
      f.mtime = r.mtime; f.dirty = false; (this.el['pj-save'] as HTMLButtonElement).disabled = true; this.el['pj-path'].classList.remove('dirty');
      if (this.unrel(f.path) === 'rtlp-project.json') await this.reloadProject();
      return true;
    } catch (e) {
      const st = (e as { status?: number }).status;
      this.toast(st === 409 ? `${f.path} changed on disk since you opened it; reopen it to see the new version.` : `Save failed: ${(e as Error).message}`);
      return false;
    }
  }

  async newFile(): Promise<void> {
    const name = prompt('New file (relative to the project), e.g. rtl/sad_tree.sv or tb/test_sad.py'); if (!name) return;
    const path = this.rel(name.replace(/^\/+/, ''));
    const mod = name.replace(/^.*\//, '').replace(/\.\w+$/, '');
    const text = /\.s?v$/.test(name) ? `module ${mod} (\n  input  logic clk,\n  input  logic rst\n);\n\nendmodule\n` : /\.py$/.test(name) ? `import os\n\nimport cocotb\nfrom cocotb.clock import Clock\nfrom cocotb.triggers import RisingEdge\n\n# The constrained clock period, passed in by the app (keeps simulated power honest).\nPERIOD_PS = round(float(os.environ.get("RTLP_CLOCK_PERIOD_NS", "10")) * 1000)\n\n\n@cocotb.test()\nasync def smoke(dut):\n    cocotb.start_soon(Clock(dut.clk, PERIOD_PS, period_high=PERIOD_PS // 2, unit="ps").start())\n    dut.rst.value = 1\n    await RisingEdge(dut.clk)\n    dut.rst.value = 0\n    await RisingEdge(dut.clk)\n` : '';
    try { await this.host.write(path, text); await this.loadTree(); await this.openFile(path); } catch (e) { this.toast(`Cannot create ${name}: ${(e as Error).message}`); }
  }

  async newProject(): Promise<void> {
    let list: { name: string; title: string }[] = [];
    try { list = (await this.host.templates()).templates; } catch (e) { this.toast((e as Error).message); return; }
    if (!list.length) { this.toast('No project templates are installed.'); return; }
    const template = list.length === 1 ? list[0].name : prompt(`Template (${list.map(t => t.name).join(', ')})`, list[0].name);
    if (!template) return;
    const path = prompt(`New project folder, relative to ${this.host.info?.root ?? 'the served folder'}`, 'final_project');
    if (!path) return;
    try { const r = await this.host.newProject(path, template); this.toast(`Created ${r.path} from ${template}`); await this.loadProjects(r.path); }
    catch (e) { this.toast(`Cannot create the project: ${(e as Error).message}`); }
  }

  async reloadProject(): Promise<void> { const keep = this.file; try { this.project = await this.host.project(this.projectPath); } catch { this.project = null; } this.renderForm(); if (keep) this.file = keep; }

  // ---------- constraints form ----------
  renderForm(): void {
    const p = this.project; if (!p) return;
    const c = p.constraints; const f = p.flow; const plats = this.tools?.platforms ?? [p.platform];
    const num = (id: string, label: string, v: number, step: string, unit: string, tip: string) => `<label title="${esc(tip)}"><span>${label}</span><input type="number" id="${id}" value="${v}" step="${step}" min="0"><em>${unit}</em></label>`;
    const fmax = c.clock.periodNs > 0 ? (1000 / c.clock.periodNs).toFixed(1) : '–';
    this.el['pj-form'].innerHTML = `
      <div class="pj-kv"><span>Top module</span><code>${esc(p.top)}</code></div>
      <div class="pj-kv"><span>Sources</span><span>${p.sources.length} file${p.sources.length === 1 ? '' : 's'}</span></div>
      <h3>Timing constraints</h3>
      <label><span>Clock port</span><input type="text" id="f-clk" value="${esc(c.clock.port)}"></label>
      ${num('f-period', 'Clock period', c.clock.periodNs, '0.001', 'ns', 'create_clock -period')}
      <div class="pj-hint">= ${fmax} MHz</div>
      ${num('f-unc', 'Setup uncertainty', c.clock.uncertaintyNs, '0.01', 'ns', 'set_clock_uncertainty -setup: jitter and skew margin taken off every register-to-register path')}
      ${num('f-hunc', 'Hold uncertainty', c.clock.holdUncertaintyNs, '0.001', 'ns', 'set_clock_uncertainty -hold: keep this small; a setup-sized hold margin makes the tools pad every short path with buffers')}
      ${num('f-in', 'Input delay', c.inputDelayNs, '0.01', 'ns', 'set_input_delay on every input except the clock')}
      ${num('f-out', 'Output delay', c.outputDelayNs, '0.01', 'ns', 'set_output_delay on every output')}
      ${c.sdc ? `<div class="pj-hint">Using the hand-written SDC <code>${esc(c.sdc)}</code>; these fields are ignored.</div>` : ''}
      <h3>Physical design</h3>
      <label><span>Platform</span><select id="f-plat">${plats.map(x => `<option value="${esc(x.name)}"${x.name === f.platform ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select></label>
      <div class="pj-hint ${p.platform.predictive ? 'warn' : ''}">${esc(p.platform.note)}</div>
      ${num('f-util', 'Core utilization', f.coreUtilization, '1', '%', 'CORE_UTILIZATION: cell area as a share of the core area')}
      ${num('f-dens', 'Placement density', f.placeDensity, '0.05', '', 'PLACE_DENSITY: target density for global placement, 0.1 to 1')}
      <div class="pj-formbtns"><button id="f-save" class="primary" disabled>Save to project</button><button id="f-edit">Edit JSON</button></div>`;
    const form = this.el['pj-form'];
    const saveBtn = form.querySelector<HTMLButtonElement>('#f-save')!;
    form.querySelectorAll('input,select').forEach(i => i.addEventListener('input', () => { saveBtn.disabled = false; }));
    saveBtn.onclick = () => void this.saveForm();
    form.querySelector<HTMLButtonElement>('#f-edit')!.onclick = () => void this.openFile(this.rel('rtlp-project.json'));
  }

  async saveForm(): Promise<void> {
    const q = (id: string) => this.el['pj-form'].querySelector<HTMLInputElement>('#' + id)!.value;
    const path = this.rel('rtlp-project.json');
    try {
      const cur = await this.host.read(path);
      const data = JSON.parse(cur.text);
      data.constraints = { ...(data.constraints ?? {}), clock: { ...(data.constraints?.clock ?? {}), port: q('f-clk'), periodNs: +q('f-period'), uncertaintyNs: +q('f-unc'), holdUncertaintyNs: +q('f-hunc') }, inputDelayNs: +q('f-in'), outputDelayNs: +q('f-out') };
      data.flow = { ...(data.flow ?? {}), platform: q('f-plat'), coreUtilization: +q('f-util'), placeDensity: +q('f-dens') };
      await this.host.write(path, JSON.stringify(data, null, 2) + '\n', cur.mtime);
      if (this.file?.path === path && !this.file.dirty) { this.file = null; await this.openFile(path); }
      await this.reloadProject();
      this.toast('Saved constraints to rtlp-project.json');
    } catch (e) {
      const probs = (e as { data?: { problems?: string[] } }).data?.problems;
      this.toast(probs ? probs.join('; ') : `Cannot save: ${(e as Error).message}`);
      await this.reloadProject();
    }
  }

  // ---------- jobs ----------
  isDone(j: JobInfo): boolean { return !['queued', 'running'].includes(j.status); }

  setBusy(busy: boolean): void {
    const can = !!this.tools?.available && (this.tools.mode !== 'docker' || this.tools.imageReady) && !!this.project && !busy;
    for (const id of ['pj-lint', 'pj-test', 'pj-synth', 'pj-flow', 'pj-stage']) (this.el[id] as HTMLButtonElement).disabled = !can;
    (this.el['pj-test'] as HTMLButtonElement).disabled = !can || !this.project?.tests.length;
    const flowDone = this.lastByKind.flow?.status === 'passed' && this.lastByKind.flow.result?.stage === 'finish';
    (this.el['pj-power'] as HTMLButtonElement).disabled = !can || !this.project?.tests.length || !flowDone;
    (this.el['pj-cancel'] as HTMLButtonElement).disabled = !busy;
  }

  async run(kind: JobKind): Promise<void> {
    if (this.file?.dirty && !(await this.save())) return;
    if (kind === 'setup' && !confirm(`Download the tool image ${this.tools?.image} now? It is several GB and only needed once.`)) return;
    const options: Record<string, unknown> = kind === 'flow' ? { stage: (this.el['pj-stage'] as HTMLSelectElement).value } : {};
    try {
      const job = await this.host.submit(this.projectPath, kind, options);
      this.logText = ''; this.tab = 'log'; this.syncTabs();
      this.follow(job);
    } catch (e) {
      const d = (e as { data?: { reason?: string; problems?: string[]; job?: JobInfo } }).data;
      if (d?.job) { this.toast('Another job is still running.'); this.follow(d.job); return; }
      this.toast(d?.reason ? `No tools: ${d.reason}` : d?.problems ? d.problems.join('; ') : (e as Error).message);
    }
  }

  follow(job: JobInfo): void {
    this.job = job; this.logText = job.log ?? ''; this.setBusy(!this.isDone(job));
    this.renderLog(); this.renderStatus();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    let since = job.next ?? 0;
    const tick = async () => {
      if (!this.job || this.job.id !== job.id) return;
      try {
        const j = await this.host.job(job.id, since);
        since = j.next ?? since; this.logText += j.log ?? ''; this.job = j;
        this.renderLog(); this.renderStatus();
        if (this.isDone(j)) { this.finished(j); return; }
      } catch (e) { this.toast(`Lost the job: ${(e as Error).message}`); this.setBusy(false); return; }
      this.pollTimer = window.setTimeout(tick, POLL_MS);
    };
    this.pollTimer = window.setTimeout(tick, POLL_MS);
  }

  finished(j: JobInfo): void {
    if (j.project === this.projectPath) this.lastByKind[j.kind] = j;
    this.setBusy(false);
    this.renderResults();
    const tab: Tab | null = j.kind === 'lint' ? 'problems' : j.kind === 'test' ? 'tests' : (j.kind === 'synth' || j.kind === 'flow' || j.kind === 'power') && j.status === 'passed' ? 'reports' : null;
    if (tab && j.status !== 'error' && (j.kind !== 'test' || j.result.suites)) { this.tab = tab; this.syncTabs(); }
    const verdict = j.status === 'passed' ? 'finished' : j.status;
    this.toast(`${j.title}: ${verdict}${j.error ? ` (${j.error})` : ''}`);
    if (j.kind === 'synth' || j.kind === 'flow' || j.kind === 'power') void this.loadTree();
    if (j.kind === 'setup') void this.loadTools(true);
  }

  async cancel(): Promise<void> { if (this.job && !this.isDone(this.job)) { try { await this.host.cancel(this.job.id); } catch (e) { this.toast((e as Error).message); } } }

  renderStatus(): void {
    const j = this.job; const el = this.el['pj-status'];
    if (!j) { el.textContent = ''; return; }
    const t = `${Math.floor(j.elapsed / 60)}:${String(Math.floor(j.elapsed % 60)).padStart(2, '0')}`;
    el.className = `pj-status ${j.status}`;
    el.textContent = this.isDone(j) ? `${j.title} · ${j.status} · ${t}` : `${j.title} · ${j.step ?? 'starting'} (${j.stepIndex + 1}/${j.steps.length}) · ${t}`;
  }

  renderLog(): void {
    const pre = this.el['pj-log']; const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    const max = 400_000; const text = this.logText.length > max ? '[… earlier output hidden; the full log is in build/jobs …]\n' + this.logText.slice(-max) : this.logText;
    pre.textContent = text;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  // ---------- results ----------
  diagnosticsFor(path: string): LineDiagnostic[] {
    const lint = this.lastByKind.lint?.result?.diagnostics as { file: string | null; line: number | null; col: number | null; severity: 'error' | 'warning'; message: string; code: string }[] | undefined;
    if (!lint) return [];
    const rel = this.unrel(path);
    return lint.filter(d => d.file === rel && d.line).map(d => ({ line: d.line!, col: d.col, severity: d.severity, message: d.code ? `${d.code}: ${d.message}` : d.message }));
  }
  applyDiagnostics(): void { if (this.file) this.editor.diagnostics(this.diagnosticsFor(this.file.path)); }

  renderResults(): void {
    const open = (file: string, line?: number) => void this.openFile(this.rel(file), line);
    renderLintReport(this.el['pj-problems'], this.lastByKind.lint, open);
    renderTestReport(this.el['pj-tests'], this.lastByKind.test, this.project, p => this.host.rawUrl(this.rel(p)), p => this.openWaves(this.rel(p)));
    const flow = [this.lastByKind.flow, this.lastByKind.synth].filter(Boolean).sort((a, b) => (b!.ended ?? 0) - (a!.ended ?? 0))[0];
    renderFlowReport(this.el['pj-reports'], flow, this.lastByKind.power, this.project, p => this.host.rawUrl(this.rel(p)), open);
    this.applyDiagnostics();
  }

  openWaves(path: string): void {
    this.tab = 'waves'; this.syncTabs();
    this.waves.open(path);
    void this.waves.refresh(); // pick up an install that happened elsewhere before this run
  }

  syncTabs(): void {
    this.root.querySelectorAll<HTMLButtonElement>('.pj-out .tabs button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === this.tab));
    for (const t of ['log', 'problems', 'tests', 'waves', 'reports']) this.el[`pj-${t}`].classList.toggle('active', t === this.tab);
  }

  // ---------- events ----------
  bind(): void {
    this.el['pj-select'].addEventListener('change', e => void this.openProject((e.target as HTMLSelectElement).value));
    this.el['pj-tools'].addEventListener('click', () => void this.loadTools(true));
    this.el['pj-newproj'].onclick = () => void this.newProject();
    this.el['pj-lint'].onclick = () => void this.run('lint');
    this.el['pj-test'].onclick = () => void this.run('test');
    this.el['pj-synth'].onclick = () => void this.run('synth');
    this.el['pj-flow'].onclick = () => void this.run('flow');
    this.el['pj-power'].onclick = () => void this.run('power');
    this.el['pj-cancel'].onclick = () => void this.cancel();
    this.el['pj-save'].onclick = () => void this.save();
    this.el['pj-new'].onclick = () => void this.newFile();
    this.el['pj-reload'].onclick = () => void this.loadTree();
    this.el['pj-tree'].addEventListener('click', e => {
      const n = (e.target as HTMLElement).closest<HTMLElement>('.pj-node'); if (!n) return;
      const path = n.dataset.path!;
      if (n.classList.contains('dir')) void this.toggleDir(path); else void this.openFile(path);
    });
    this.root.querySelectorAll<HTMLButtonElement>('.pj-out .tabs button[data-tab]').forEach(b => b.onclick = () => { this.tab = b.dataset.tab as Tab; this.syncTabs(); });
    window.addEventListener('beforeunload', e => { if (this.file?.dirty) { e.preventDefault(); } });
  }
}
