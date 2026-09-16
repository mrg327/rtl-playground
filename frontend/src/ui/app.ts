import type { Block, Design, Radix, Wire, Note } from '../model/types';
import { defOf, defaultParams, LIB } from '../model/library';
import { snap, bounds, shapeOf } from '../model/geometry';
import { serialize, deserialize } from '../model/serialize';
import { Store, emptySel } from './store';
import { Canvas, isEditable, type ValueMode } from './canvas';
import { renderPalette } from './palette';
import { renderInspector } from './inspector';
import { WaveformView, toVCD, toWaveJSON, type WaveData, type WaveSignal } from './waveform';
import { runAll, type TestResult } from '../sim/tests';
import { Host, download, upload, openFromHash } from '../host/api';
import { pinKey } from '../model/netlist';

const EXAMPLES: Record<string, string> = import.meta.glob('../../../examples/*.rtlp', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

interface Command { id: string; title: string; keys?: string; run: () => void; when?: () => boolean }

export class App {
  store = new Store();
  host = new Host();
  canvas!: Canvas;
  wave!: WaveformView;
  timer: number | null = null;
  speed = 500;
  clipboard: { blocks: Block[]; wires: Wire[]; notes: Note[] } | null = null;
  commands: Command[] = [];
  tab: 'wave' | 'tests' = 'wave';
  testResults: TestResult[] | null = null;
  el: Record<string, HTMLElement> = {};

  constructor(public root: HTMLElement) {
    root.innerHTML = `
      <header>
        <h1>RTL Playground</h1><span class="file" id="file">untitled</span>
        <button id="new" title="New design">New</button><button id="open">Open…</button><button id="save" title="Ctrl+S">Save</button><button id="examples">Examples…</button>
        <span class="sep"></span>
        <button id="undo" title="Ctrl+Z">↶</button><button id="redo" title="Ctrl+Y">↷</button>
        <span class="sep"></span>
        <button id="back" title="Step back (Shift+Space)">◀</button><button class="primary" id="step" title="Clock rising edge (Space)">Clock ↑</button><button id="run" title="Run / pause">Run</button>
        <select id="speed" title="Run speed"><option value="1000">1 Hz</option><option value="500" selected>2 Hz</option><option value="200">5 Hz</option><option value="100">10 Hz</option><option value="33">30 Hz</option></select>
        <button id="rst" title="Hold the global reset high; the next clock edge resets registers">Reset</button><button id="poweron" title="Power on: cycle 0, all state to its reset value, history cleared">Power-on</button>
        <span id="cycle">cycle 0</span>
        <span class="sep"></span>
        <select id="vmode" title="Bus value labels"><option value="all">Values: all</option><option value="hover">Values: hover</option><option value="none">Values: off</option></select>
        <button id="dim" title="Dim wires that did not change this cycle">Changes</button>
        <button id="fit" title="Zoom to fit (Ctrl+0)">Fit</button>
        <button id="present" title="Presentation mode (F11)">Present</button>
        <button id="cmd" title="Command palette (Ctrl+K)">⌘K</button><button id="help" title="Keyboard shortcuts (?)">?</button>
      </header>
      <aside class="left"><h2>Blocks</h2><div class="pal" id="pal"></div></aside>
      <main>
        <div class="canvas" id="canvas"></div>
      </main>
      <aside class="right"><h2>Selected</h2><div class="insp" id="insp"></div><h2>Problems</h2><div class="problems" id="problems"></div></aside>
      <section class="bottom" id="bottom">
        <div class="tabs"><button data-tab="wave" class="active">Waveform</button><button data-tab="tests">Tests</button><span class="spacer"></span>
          <button class="tool" id="wzoomout">−</button><button class="tool" id="wzoomin">+</button><button class="tool" id="wfit">Fit</button><button class="tool" id="wvcd">Export VCD</button><button class="tool" id="wjson">WaveDrom</button><button class="tool" id="wclear">Clear history</button><button class="tool" id="wtog">Hide</button></div>
        <div class="panel active" id="wave"></div>
        <div class="panel tests" id="tests"></div>
      </section>`;
    for (const id of ['file', 'new', 'open', 'save', 'examples', 'undo', 'redo', 'back', 'step', 'run', 'speed', 'rst', 'poweron', 'cycle', 'vmode', 'dim', 'fit', 'present', 'cmd', 'help', 'pal', 'canvas', 'insp', 'problems', 'bottom', 'wave', 'tests', 'wzoomout', 'wzoomin', 'wfit', 'wvcd', 'wjson', 'wclear', 'wtog']) this.el[id] = root.querySelector('#' + id)!;
    const cv = this.el.canvas;
    this.canvas = new Canvas(cv, this.store, { onEditBlock: id => this.inlineEdit(id), onEditNote: id => this.editNote(id) });
    cv.insertAdjacentHTML('beforeend', `<div class="empty-hint">The canvas is empty.<br>Add a block from the list on the left, or open an example.</div><div class="hint">Drag from a pin to wire · click a 1-bit input to toggle · drag empty space to select · right-drag or Space+drag to pan · Ctrl+wheel to zoom · <kbd>Space</kbd> clocks</div>`);
    renderPalette(this.el.pal, t => this.addBlock(t));
    this.wave = new WaveformView(this.el.wave, {
      onCursor: i => { this.store.sim.cur = i; this.store.emit('sim'); },
      onRemove: key => { if (key === 'clk') return; const b = this.store.module.blocks.find(x => key.startsWith(x.id + '.')); if (b) this.store.mutate('Untrace', () => { b.trace = false; }); },
      onRadix: (key, r) => { this.store.design.views.wave.radix[key] = r; this.store.dirty = true; this.refresh('sim'); },
      onReorder: keys => { this.store.design.views.wave.signals = keys; this.refresh('sim'); },
    });
    this.wave.follow = true;
    this.buildCommands();
    this.bindToolbar();
    this.bindKeys();
    this.store.on(what => this.refresh(what));
    this.refresh('load');
    this.boot();
  }

  async boot(): Promise<void> {
    const ok = await this.host.connect();
    if (ok) { const open = openFromHash(); if (open) await this.openPath(open); this.toast(`Connected to local host · ${this.host.info!.root}`); }
    else this.toast('No local host found: files will download to your browser instead.');
  }

  // ---------- rendering ----------
  refresh(what: string): void {
    const s = this.store, sim = s.sim;
    if (what === 'load') { this.canvas.zoomFit(); this.testResults = null; }
    this.canvas.render();
    if (what !== 'sim') renderInspector(this.el.insp, s, { del: () => this.deleteSelection(), rotate: () => this.rotate(), flip: () => this.flip() });
    this.renderProblems();
    this.el.cycle.textContent = `cycle ${sim.cycle}${sim.live ? '' : ` / ${sim.lastCycle}`}`; this.el.cycle.classList.toggle('past', !sim.live);
    this.el.file.textContent = s.file ?? s.design.name; this.el.file.classList.toggle('dirty', s.dirty);
    (this.el.undo as HTMLButtonElement).disabled = !s.canUndo; (this.el.redo as HTMLButtonElement).disabled = !s.canRedo;
    this.el.rst.classList.toggle('on', sim.rst);
    (this.el.back as HTMLButtonElement).disabled = sim.cur === 0;
    this.renderWave();
    if (this.tab === 'tests' && what !== 'sim') this.renderTests();
    document.title = `${s.dirty ? '• ' : ''}${s.file ?? s.design.name} – RTL Playground`;
  }

  traceKeyOf(b: Block): string | null { const d = defOf(b.type); const ports = d.ports(b.params); const p = d.traceKey ? ports.find(x => x.name === d.traceKey) : ports.find(x => x.dir === 'out'); return p ? `${b.id}.${p.name}` : null; }

  waveData(): WaveData {
    const s = this.store, sim = s.sim, c = sim.compiled;
    const traced = s.module.blocks.filter(b => b.trace).map(b => ({ b, key: this.traceKeyOf(b) })).filter(x => x.key) as { b: Block; key: string }[];
    const order = s.design.views.wave.signals; traced.sort((a, b) => { const ia = order.indexOf(a.key), ib = order.indexOf(b.key); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib); });
    const n = sim.frames.length; const cycles = sim.frames.map(f => f.cycle); const rst = sim.frames.map(f => f.rst);
    const frameVals: bigint[][] = []; for (let i = 0; i < n; i++) frameVals.push(sim.values(i));
    const signals: WaveSignal[] = traced.map(({ b, key }) => {
      const port = c.netlist.ports.get(b.id)!.find(p => `${b.id}.${p.name}` === key)!;
      let src = key; if (port.dir === 'in') { const drv = c.netlist.byPin.get(key)?.drivers[0]; src = drv ? pinKey(drv) : ''; }
      const idx = src ? c.pinIndex.get(src) : undefined; const m = (1n << BigInt(port.width)) - 1n;
      const values = frameVals.map(v => (idx === undefined ? 0n : v[idx] & m));
      return { key, name: b.label || b.id, width: port.width, radix: s.design.views.wave.radix[key] ?? (port.width > 16 ? 'hex' : 'dec'), values };
    });
    signals.unshift({ key: 'clk', name: 'clk', width: 1, radix: 'bin', values: cycles.map(() => 0n) });
    return { cycles, signals, cursor: sim.cur, live: n - 1, rst };
  }
  renderWave(): void { if (this.el.bottom.classList.contains('collapsed') || this.tab !== 'wave') return; this.wave.update(this.waveData()); }

  renderProblems(): void {
    const ps = this.store.sim.compiled.problems;
    if (!ps.length) { this.el.problems.innerHTML = `<div class="ok">No problems.</div>`; return; }
    this.el.problems.innerHTML = ps.map((p, i) => `<div class="item ${p.level}" data-i="${i}">${esc(p.message)}</div>`).join('');
    this.el.problems.onclick = e => { const it = (e.target as HTMLElement).closest<HTMLElement>('.item'); if (!it) return; const p = ps[+it.dataset.i!]; const sel = emptySel(); for (const b of p.blocks ?? []) sel.blocks.add(b); for (const w of p.wires ?? []) sel.wires.add(w); this.store.select(sel); };
  }

  renderTests(): void {
    const d = this.store.design; const el = this.el.tests;
    if (!d.tests.length) { el.innerHTML = `<p>This design has no tests. Tests are tables in the design file: one row per clock cycle, input columns give values, output columns give expected values (X = don't care, C*n = clock n times).</p>`; return; }
    const res = this.testResults;
    let h = `<div class="head"><button class="primary" id="runtests">Run all tests</button>${res ? `<span>${res.filter(r => r.passed).length} / ${res.length} passed</span>` : ''}</div>`;
    d.tests.forEach((t, i) => {
      const r = res?.[i];
      h += `<div class="head"><strong>${esc(t.name)}</strong> ${r ? (r.passed ? '<span class="pass-badge">PASS</span>' : `<span class="fail-badge">FAIL</span>`) : ''}${r?.error ? ` <span class="fail-badge">${esc(r.error)}</span>` : ''}</div>`;
      h += `<table><tr><th>#</th><th>cycle</th>${t.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
      t.rows.forEach((row, ri) => { const rr = r?.rows[ri]; const cls = rr ? (rr.skipped ? '' : rr.ok ? 'pass' : 'fail') : '';
        h += `<tr class="${cls}"><td>${ri + 1}</td><td>${rr ? rr.cycle : ''}</td>${t.columns.map((c, ci) => { const cell = esc(String(row[ci] ?? '')); const act = rr && !rr.skipped && rr.actual[c] !== undefined && rr.expected[c] !== undefined && rr.actual[c] !== rr.expected[c] ? ` <span class="fail-badge">→ ${rr.actual[c]}</span>` : ''; return `<td>${cell}${act}</td>`; }).join('')}</tr>`; });
      h += `</table>`;
    });
    el.innerHTML = h;
    el.querySelector<HTMLButtonElement>('#runtests')!.onclick = () => { this.testResults = runAll(this.store.design); this.renderTests(); };
  }

  // ---------- editing ----------
  addBlock(type: string, at?: { x: number; y: number }): void {
    const s = this.store; const d = defOf(type); const c = at ?? this.canvas.center(); const n = s.module.blocks.length % 6;
    const size = d.size(defaultParams(type));
    const b: Block = { id: s.freshId(d.short), type, params: defaultParams(type), x: snap(c.x - size.w / 2 + n * 20), y: snap(c.y - size.h / 2 + n * 20), trace: !!d.trace };
    s.mutate('Add ' + d.name, () => { s.module.blocks.push(b); });
    s.selectBlock(b.id);
    this.canvas.svg.focus();
  }
  addNote(): void { const s = this.store; const c = this.canvas.center(); const n: Note = { id: s.freshNoteId(), x: snap(c.x - 100), y: snap(c.y - 30), w: 200, h: 60, text: 'Double-click to edit this note.' }; s.mutate('Add note', () => { s.module.notes.push(n); }); s.select({ ...emptySel(), notes: new Set([n.id]) }); }
  deleteSelection(): void {
    const s = this.store; const sel = s.sel; if (!sel.blocks.size && !sel.wires.size && !sel.notes.size) return;
    s.mutate('Delete', () => { const m = s.module; const ids = new Set([...sel.blocks].filter(id => !m.locked.includes(id)));
      m.blocks = m.blocks.filter(b => !ids.has(b.id)); m.wires = m.wires.filter(w => !sel.wires.has(w.id) && !ids.has(w.from.b) && !ids.has(w.to.b)); m.notes = m.notes.filter(n => !sel.notes.has(n.id)); });
    s.clearSelection();
  }
  rotate(): void { const s = this.store; if (!s.sel.blocks.size) return; s.mutate('Rotate', () => { for (const b of s.module.blocks) if (s.sel.blocks.has(b.id)) b.rot = (((b.rot ?? 0) + 90) % 360) as Block['rot']; }); }
  flip(): void { const s = this.store; if (!s.sel.blocks.size) return; s.mutate('Flip', () => { for (const b of s.module.blocks) if (s.sel.blocks.has(b.id)) b.flip = !b.flip; }); }
  nudge(dx: number, dy: number): void { const s = this.store; if (!s.sel.blocks.size && !s.sel.notes.size) return; s.mutate('Move', () => { for (const b of s.module.blocks) if (s.sel.blocks.has(b.id) && !s.module.locked.includes(b.id)) { b.x += dx; b.y += dy; } for (const n of s.module.notes) if (s.sel.notes.has(n.id)) { n.x += dx; n.y += dy; } }); }
  selectAll(): void { const s = this.store; s.select({ blocks: new Set(s.module.blocks.map(b => b.id)), wires: new Set(s.module.wires.map(w => w.id)), notes: new Set(s.module.notes.map(n => n.id)) }); }
  copy(): void {
    const s = this.store; const m = s.module; const blocks = m.blocks.filter(b => s.sel.blocks.has(b.id)); const ids = new Set(blocks.map(b => b.id));
    this.clipboard = { blocks: JSON.parse(JSON.stringify(blocks)), wires: JSON.parse(JSON.stringify(m.wires.filter(w => ids.has(w.from.b) && ids.has(w.to.b)))), notes: JSON.parse(JSON.stringify(m.notes.filter(n => s.sel.notes.has(n.id)))) };
    navigator.clipboard?.writeText(JSON.stringify({ rtlp: 2, ...this.clipboard })).catch(() => {});
  }
  paste(offset = 20): void {
    const clip = this.clipboard; if (!clip || (!clip.blocks.length && !clip.notes.length)) return;
    const s = this.store; const map = new Map<string, string>(); const sel = emptySel();
    s.mutate('Paste', () => {
      const m = s.module;
      for (const b of clip.blocks) { const nb: Block = JSON.parse(JSON.stringify(b)); nb.id = s.freshId(defOf(b.type).short); while (map.has(nb.id) || [...map.values()].includes(nb.id)) nb.id += '_'; map.set(b.id, nb.id); nb.x += offset; nb.y += offset; m.blocks.push(nb); sel.blocks.add(nb.id); }
      for (const w of clip.wires) { m.wires.push({ id: s.freshWireId(), from: { b: map.get(w.from.b)!, p: w.from.p }, to: { b: map.get(w.to.b)!, p: w.to.p }, mid: w.mid }); }
      for (const n of clip.notes) { const nn = { ...n, id: s.freshNoteId(), x: n.x + offset, y: n.y + offset }; m.notes.push(nn); sel.notes.add(nn.id); }
    });
    for (const b of clip.blocks) { b.x += offset; b.y += offset; } for (const n of clip.notes) { n.x += offset; n.y += offset; }
    s.select(sel);
  }
  duplicate(): void { this.copy(); this.paste(20); }

  inlineEdit(id: string): void {
    const s = this.store; const b = s.module.blocks.find(x => x.id === id); if (!b || s.module.locked.includes(id)) return;
    const key = b.type === 'in' || b.type === 'const' ? 'value' : b.type === 'label' ? 'name' : b.type === 'seq' ? 'values' : '__label';
    const bb = bounds(b); const r = this.canvas.svg.getBoundingClientRect(); const v = this.canvas.view;
    const input = document.createElement('input'); input.className = 'inline-edit'; input.value = key === '__label' ? (b.label ?? '') : String(b.params[key] ?? '');
    input.style.left = `${(bb.x + bb.w / 2) * v.k + v.x - 40}px`; input.style.top = `${(bb.y + bb.h / 2) * v.k + v.y - 12}px`; input.style.width = '80px';
    this.el.canvas.appendChild(input); input.focus(); input.select();
    let done = false;
    const commit = () => { if (done) return; done = true; const val = input.value; input.remove();
      if (key === '__label') s.mutate('Label', () => { b.label = val || undefined; });
      else if (b.type === 'in') s.stimulus(() => { b.params.value = val; });
      else s.mutate('Edit', () => { b.params[key] = val; }); };
    input.onblur = commit; input.onkeydown = e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { done = true; input.remove(); } e.stopPropagation(); };
    void r; void shapeOf;
  }
  editNote(id: string): void {
    const s = this.store; const n = s.module.notes.find(x => x.id === id); if (!n) return;
    const v = this.canvas.view; const ta = document.createElement('textarea'); ta.className = 'inline-edit'; ta.value = n.text;
    ta.style.left = `${n.x * v.k + v.x}px`; ta.style.top = `${n.y * v.k + v.y}px`; ta.style.width = `${n.w * v.k}px`; ta.style.height = `${n.h * v.k}px`; ta.style.font = '12px var(--font)';
    this.el.canvas.appendChild(ta); ta.focus();
    let done = false; const commit = () => { if (done) return; done = true; const t = ta.value; ta.remove(); s.mutate('Edit note', () => { n.text = t; }); };
    ta.onblur = commit; ta.onkeydown = e => { if (e.key === 'Escape') commit(); e.stopPropagation(); };
  }

  // ---------- simulation ----------
  step(): void { this.store.sim.step(); this.store.emit('sim'); }
  back(): void { this.store.sim.back(); this.store.emit('sim'); }
  toggleRun(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; this.el.run.textContent = 'Run'; this.el.run.classList.remove('on'); }
    else { this.timer = window.setInterval(() => this.step(), this.speed); this.el.run.textContent = 'Pause'; this.el.run.classList.add('on'); }
  }
  powerOn(): void { this.store.sim.powerOn(); this.store.emit('sim'); }

  // ---------- files ----------
  async openPath(path: string): Promise<void> {
    try { const f = await this.host.read(path); this.store.load(deserialize(f.text), path, f.mtime); this.toast(`Opened ${path}`); }
    catch (e) { this.toast(`Could not open ${path}: ${(e as Error).message}`, true); }
  }
  async open(): Promise<void> {
    if (!this.host.available) { const f = await upload('.rtlp,.json'); if (!f) return; try { this.store.load(deserialize(f.text), f.name); } catch (e) { this.toast((e as Error).message, true); } return; }
    let dir = '';
    const show = async () => {
      const { entries } = await this.host.list(dir);
      const items = [...(dir ? [{ name: '..', type: 'dir' as const }] : []), ...entries.filter(e => e.type === 'dir'), ...entries.filter(e => e.type === 'file' && /\.(rtlp|json)$/.test(e.name))];
      const pick = await this.pickList(`Open from ${this.host.info!.root}${dir ? '/' + dir : ''}`, items.map(e => ({ label: (e.type === 'dir' ? '📁 ' : '') + e.name, hint: e.type === 'dir' ? '' : 'mtime' in e ? new Date((e as { mtime: number }).mtime * 1000).toLocaleString() : '', value: e.name, dir: e.type === 'dir' })));
      if (!pick) return;
      if (pick.dir) { dir = pick.value === '..' ? dir.split('/').slice(0, -1).join('/') : (dir ? dir + '/' : '') + pick.value; await show(); return; }
      await this.openPath((dir ? dir + '/' : '') + pick.value);
    };
    await show();
  }
  async save(as = false): Promise<void> {
    const s = this.store; const text = serialize(s.design);
    if (!this.host.available) { download((s.file ?? s.design.name) + (s.file?.endsWith('.rtlp') ? '' : '.rtlp'), text); s.dirty = false; this.refresh('file'); return; }
    let path = s.file;
    if (!path || as) { const name = prompt('Save as (relative to the launch folder):', path ?? `${s.design.name}.rtlp`); if (!name) return; path = name.endsWith('.rtlp') ? name : name + '.rtlp'; }
    try {
      const r = await this.host.write(path, text, as ? null : s.fileMtime);
      s.file = path; s.fileMtime = r.mtime; s.dirty = false; this.refresh('file'); this.toast(`Saved ${path}`);
    } catch (e) {
      const err = e as { status?: number; data?: { mtime?: number } };
      if (err.status === 409) { if (confirm(`${path} changed on disk since you opened it. Overwrite?`)) { const r = await this.host.write(path, text, null); s.file = path; s.fileMtime = r.mtime; s.dirty = false; this.refresh('file'); } }
      else this.toast(`Save failed: ${(e as Error).message}`, true);
    }
  }
  newDesign(): void { if (this.store.dirty && !confirm('Discard unsaved changes?')) return; this.store.newDesign(); }
  async openExample(): Promise<void> {
    const names = Object.keys(EXAMPLES).sort();
    const pick = await this.pickList('Examples', names.map(n => { const d = JSON.parse(EXAMPLES[n]) as Design; return { label: n.split('/').pop()!.replace('.rtlp', ''), hint: d.name, value: n }; }));
    if (!pick) return;
    if (this.store.dirty && !confirm('Discard unsaved changes?')) return;
    this.store.load(deserialize(EXAMPLES[pick.value]), null); this.store.design.name = pick.label;
    this.refresh('load');
  }
  loadDesign(d: Design, file: string | null): void { this.store.load(d, file); }

  // ---------- UI helpers ----------
  toast(msg: string, error = false): void { const t = document.createElement('div'); t.className = 'toast' + (error ? ' error' : ''); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), error ? 5000 : 2500); }
  pickList<T extends { label: string; hint?: string; value: string }>(title: string, items: T[]): Promise<T | null> {
    return new Promise(res => {
      const bg = document.createElement('div'); bg.className = 'modal-bg';
      bg.innerHTML = `<div class="modal"><input class="q" placeholder="${esc(title)}"><div class="list"></div></div>`;
      const q = bg.querySelector<HTMLInputElement>('.q')!, list = bg.querySelector<HTMLElement>('.list')!; let active = 0; let shown: T[] = items;
      const draw = () => { const f = q.value.toLowerCase(); shown = items.filter(i => i.label.toLowerCase().includes(f) || (i.hint ?? '').toLowerCase().includes(f)); active = Math.min(active, Math.max(0, shown.length - 1)); list.innerHTML = shown.map((i, k) => `<div class="it${k === active ? ' active' : ''}" data-k="${k}"><span>${esc(i.label)}</span><small>${esc(i.hint ?? '')}</small></div>`).join('') || `<div class="it"><span style="color:var(--ink2)">Nothing here</span></div>`; };
      const close = (v: T | null) => { bg.remove(); res(v); };
      q.oninput = () => { active = 0; draw(); };
      q.onkeydown = e => { if (e.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); draw(); } else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); } else if (e.key === 'Enter') close(shown[active] ?? null); else if (e.key === 'Escape') close(null); e.stopPropagation(); };
      list.onclick = e => { const it = (e.target as HTMLElement).closest<HTMLElement>('.it'); if (it?.dataset.k) close(shown[+it.dataset.k]); };
      bg.onclick = e => { if (e.target === bg) close(null); };
      document.body.appendChild(bg); draw(); q.focus();
    });
  }
  async commandPalette(): Promise<void> {
    const items = [...this.commands.filter(c => !c.when || c.when()).map(c => ({ label: c.title, hint: c.keys ?? '', value: c.id })), ...Object.values(LIB).map(d => ({ label: `Add ${d.name}`, hint: d.group, value: 'add:' + d.type }))];
    const pick = await this.pickList('Type a command…', items); if (!pick) return;
    if (pick.value.startsWith('add:')) this.addBlock(pick.value.slice(4)); else this.commands.find(c => c.id === pick.value)?.run();
  }
  showHelp(): void {
    const rows: [string, string][] = [['Space', 'Clock rising edge'], ['Shift+Space', 'Step back one cycle'], ['Enter', 'Run / pause'], ['Delete / Backspace', 'Delete selection'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+C / Ctrl+V / Ctrl+D', 'Copy / paste / duplicate'], ['Ctrl+A', 'Select all'], ['R / F', 'Rotate / flip selected blocks'], ['Arrows', 'Nudge selection'], ['Double-click', 'Edit value or label in place'], ['Click a 1-bit input', 'Toggle it'], ['Drag from a pin', 'Wire it'], ['Drag empty space', 'Rubber-band select'], ['Right-drag or Space+drag', 'Pan'], ['Ctrl+wheel / Ctrl+0', 'Zoom / zoom to fit'], ['/', 'Search blocks'], ['Ctrl+K', 'Command palette'], ['Ctrl+S / Ctrl+O', 'Save / open'], ['N', 'Add a note'], ['F11', 'Presentation mode'], ['?', 'This help']];
    const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.innerHTML = `<div class="modal"><h2>Keyboard shortcuts</h2><div class="body"><table class="help">${rows.map(r => `<tr><td><kbd>${r[0]}</kbd></td><td>${r[1]}</td></tr>`).join('')}</table></div><div class="foot"><button class="primary">Close</button></div></div>`;
    bg.querySelector('button')!.onclick = () => bg.remove(); bg.onclick = e => { if (e.target === bg) bg.remove(); }; document.body.appendChild(bg);
  }
  togglePresent(): void { document.body.classList.toggle('present'); this.el.present.classList.toggle('on'); setTimeout(() => this.canvas.zoomFit(), 50); }

  buildCommands(): void {
    const s = this.store;
    this.commands = [
      { id: 'step', title: 'Clock rising edge', keys: 'Space', run: () => this.step() },
      { id: 'back', title: 'Step back', keys: 'Shift+Space', run: () => this.back() },
      { id: 'run', title: 'Run / pause', keys: 'Enter', run: () => this.toggleRun() },
      { id: 'rst', title: 'Toggle reset', run: () => { s.sim.rst = !s.sim.rst; s.emit('sim'); } },
      { id: 'poweron', title: 'Power-on reset', run: () => this.powerOn() },
      { id: 'clearhist', title: 'Clear waveform history', run: () => { s.sim.clearHistory(); s.emit('sim'); } },
      { id: 'undo', title: 'Undo', keys: 'Ctrl+Z', run: () => s.undo() }, { id: 'redo', title: 'Redo', keys: 'Ctrl+Y', run: () => s.redo() },
      { id: 'del', title: 'Delete selection', keys: 'Delete', run: () => this.deleteSelection() },
      { id: 'copy', title: 'Copy', keys: 'Ctrl+C', run: () => this.copy() }, { id: 'paste', title: 'Paste', keys: 'Ctrl+V', run: () => this.paste() }, { id: 'dup', title: 'Duplicate', keys: 'Ctrl+D', run: () => this.duplicate() },
      { id: 'all', title: 'Select all', keys: 'Ctrl+A', run: () => this.selectAll() },
      { id: 'rot', title: 'Rotate', keys: 'R', run: () => this.rotate() }, { id: 'flip', title: 'Flip', keys: 'F', run: () => this.flip() },
      { id: 'note', title: 'Add note', keys: 'N', run: () => this.addNote() },
      { id: 'fit', title: 'Zoom to fit', keys: 'Ctrl+0', run: () => this.canvas.zoomFit() }, { id: 'zin', title: 'Zoom in', keys: 'Ctrl+=', run: () => this.canvas.zoomIn() }, { id: 'zout', title: 'Zoom out', keys: 'Ctrl+-', run: () => this.canvas.zoomOut() },
      { id: 'new', title: 'New design', run: () => this.newDesign() }, { id: 'open', title: 'Open…', keys: 'Ctrl+O', run: () => this.open() }, { id: 'save', title: 'Save', keys: 'Ctrl+S', run: () => this.save() }, { id: 'saveas', title: 'Save as…', keys: 'Ctrl+Shift+S', run: () => this.save(true) },
      { id: 'download', title: 'Download design file', run: () => download((s.file ?? s.design.name).replace(/\.rtlp$/, '') + '.rtlp', serialize(s.design)) },
      { id: 'examples', title: 'Open example…', run: () => this.openExample() },
      { id: 'tests', title: 'Run all tests', run: () => { this.showTab('tests'); this.testResults = runAll(s.design); this.renderTests(); } },
      { id: 'vcd', title: 'Export waveform as VCD', run: () => download((s.design.name || 'wave') + '.vcd', toVCD(this.waveData()), 'text/plain') },
      { id: 'wavejson', title: 'Copy WaveDrom JSON', run: () => { const j = JSON.stringify(toWaveJSON(this.waveData())); navigator.clipboard?.writeText(j); download((s.design.name || 'wave') + '.json', j); } },
      { id: 'present', title: 'Presentation mode', keys: 'F11', run: () => this.togglePresent() },
      { id: 'theme', title: 'Toggle dark / light theme', run: () => { const r = document.documentElement; const cur = r.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); r.dataset.theme = cur === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('rtlp-theme', r.dataset.theme); } catch { /* ignore */ } } },
      { id: 'help', title: 'Keyboard shortcuts', keys: '?', run: () => this.showHelp() },
    ];
  }
  showTab(t: 'wave' | 'tests'): void { this.tab = t; for (const b of this.el.bottom.querySelectorAll<HTMLButtonElement>('[data-tab]')) b.classList.toggle('active', b.dataset.tab === t); this.el.wave.classList.toggle('active', t === 'wave'); this.el.tests.classList.toggle('active', t === 'tests'); if (t === 'tests') this.renderTests(); else this.renderWave(); }

  bindToolbar(): void {
    const s = this.store; const e = this.el;
    e.new.onclick = () => this.newDesign(); e.open.onclick = () => this.open(); e.save.onclick = () => this.save(); e.examples.onclick = () => this.openExample();
    e.undo.onclick = () => s.undo(); e.redo.onclick = () => s.redo();
    e.back.onclick = () => this.back(); e.step.onclick = () => this.step(); e.run.onclick = () => this.toggleRun();
    (e.speed as HTMLSelectElement).onchange = () => { this.speed = +(e.speed as HTMLSelectElement).value; if (this.timer !== null) { this.toggleRun(); this.toggleRun(); } };
    e.rst.onclick = () => { s.sim.rst = !s.sim.rst; s.emit('sim'); }; e.poweron.onclick = () => this.powerOn();
    (e.vmode as HTMLSelectElement).onchange = () => { this.canvas.valueMode = (e.vmode as HTMLSelectElement).value as ValueMode; this.canvas.render(); };
    e.dim.onclick = () => { this.canvas.dimUnchanged = !this.canvas.dimUnchanged; e.dim.classList.toggle('on', this.canvas.dimUnchanged); this.canvas.render(); };
    e.fit.onclick = () => this.canvas.zoomFit(); e.present.onclick = () => this.togglePresent(); e.cmd.onclick = () => this.commandPalette(); e.help.onclick = () => this.showHelp();
    for (const b of e.bottom.querySelectorAll<HTMLButtonElement>('[data-tab]')) b.onclick = () => this.showTab(b.dataset.tab as 'wave' | 'tests');
    e.wzoomin.onclick = () => this.wave.zoomIn(); e.wzoomout.onclick = () => this.wave.zoomOut(); e.wfit.onclick = () => this.wave.zoomFit();
    e.wvcd.onclick = () => this.commands.find(c => c.id === 'vcd')!.run(); e.wjson.onclick = () => this.commands.find(c => c.id === 'wavejson')!.run();
    e.wclear.onclick = () => { s.sim.clearHistory(); s.emit('sim'); };
    e.wtog.onclick = () => { const c = e.bottom.classList.toggle('collapsed'); e.wtog.textContent = c ? 'Show' : 'Hide'; if (!c) this.renderWave(); };
    window.addEventListener('beforeunload', ev => { if (s.dirty) { ev.preventDefault(); } });
    try { const t = localStorage.getItem('rtlp-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
  }
  bindKeys(): void {
    document.addEventListener('keydown', e => {
      if (isEditable(e.target)) return;
      if (document.querySelector('.modal-bg')) return;
      const k = e.key; const ctrl = e.ctrlKey || e.metaKey;
      const run = (id: string) => { e.preventDefault(); this.commands.find(c => c.id === id)!.run(); };
      if (k === ' ' && !ctrl) return run(e.shiftKey ? 'back' : 'step');
      if (k === 'Enter' && !ctrl) return run('run');
      if (k === 'Delete' || k === 'Backspace') return run('del');
      if (ctrl && k.toLowerCase() === 'z') return run(e.shiftKey ? 'redo' : 'undo');
      if (ctrl && k.toLowerCase() === 'y') return run('redo');
      if (ctrl && k.toLowerCase() === 'c') return run('copy');
      if (ctrl && k.toLowerCase() === 'v') return run('paste');
      if (ctrl && k.toLowerCase() === 'x') { run('copy'); return run('del'); }
      if (ctrl && k.toLowerCase() === 'd') return run('dup');
      if (ctrl && k.toLowerCase() === 'a') return run('all');
      if (ctrl && k.toLowerCase() === 's') return run(e.shiftKey ? 'saveas' : 'save');
      if (ctrl && k.toLowerCase() === 'o') return run('open');
      if (ctrl && (k === '0')) return run('fit');
      if (ctrl && (k === '=' || k === '+')) return run('zin');
      if (ctrl && k === '-') return run('zout');
      if (!ctrl && k.toLowerCase() === 'r') return run('rot');
      if (!ctrl && k.toLowerCase() === 'f') return run('flip');
      if (!ctrl && k.toLowerCase() === 'n') return run('note');
      if (k === '?') return run('help');
      if (k === 'F11') return run('present');
      if (k === 'Escape') { this.store.clearSelection(); return; }
      if (k.startsWith('Arrow')) { e.preventDefault(); const d = e.shiftKey ? 50 : 10; this.nudge(k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0); }
    });
    document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); this.commandPalette(); } }, true);
  }
}
