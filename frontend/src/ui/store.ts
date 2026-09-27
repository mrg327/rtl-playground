// Application state: the design, selection, simulator, and undo/redo by snapshot.
import type { Block, Design, Module } from '../model/types';
import { emptyDesign, emptyModule } from '../model/types';
import { serialize, deserialize } from '../model/serialize';
import { Simulator } from '../sim/engine';
import { setActiveDesign } from '../model/library';
import { flattenModule, type TracedSignal } from '../model/hierarchy';
import { pinKey, parsePin } from '../model/netlist';

export interface Selection { blocks: Set<string>; wires: Set<string>; notes: Set<string> }
export const emptySel = (): Selection => ({ blocks: new Set(), wires: new Set(), notes: new Set() });

/** One step of the breadcrumb trail (DESIGN.md task 3): the module shown, and the instance path from
 * `design.top` to reach it, or `null` if it was opened directly (from the module list) rather than by
 * drilling into an instance — in which case it isn't on the simulated tree unless it's `top` itself. */
export interface ViewStep { module: string; path: string[] | null }

export class Store {
  design: Design;
  /** Module currently shown on the canvas. */
  viewModule: string;
  /** Instance-id path from `design.top` down to `viewModule`, or `null` if this sheet isn't reachable
   * through the current navigation (opened directly, and not `top`) — see `simActive`. */
  viewPath: string[] | null;
  breadcrumb: ViewStep[];
  sim: Simulator;
  /** Every `trace`-marked block reachable from `design.top`, hierarchical id included, for the waveform. */
  tracedSignals: TracedSignal[] = [];
  sel: Selection = emptySel();
  file: string | null = null;
  fileMtime: number | null = null;
  dirty = false;
  private undoStack: { label: string; snap: string }[] = [];
  private redoStack: { label: string; snap: string }[] = [];
  private listeners = new Set<(what: string) => void>();
  private inTx = false;

  constructor(design = emptyDesign()) {
    this.design = design; this.viewModule = design.top; this.viewPath = [];
    this.breadcrumb = [{ module: design.top, path: [] }];
    setActiveDesign(this.design);
    this.sim = this.buildSim();
  }
  get module(): Module { return this.design.modules[this.viewModule] ?? this.design.modules[this.design.top]; }
  /** Whether the sheet currently shown is on the live, simulated instance tree under `design.top` (always
   * true for `top` itself). DESIGN.md task 3: viewing a module directly shows it is not being simulated
   * unless it is top. */
  get simActive(): boolean { return this.viewPath !== null; }

  on(fn: (what: string) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what = 'change'): void { for (const l of this.listeners) l(what); }

  /** Run a structural or parameter change as one undo step. */
  mutate(label: string, fn: () => void): void {
    if (!this.inTx) this.pushUndo(label);
    fn();
    this.afterChange();
  }
  /** Start a coalesced undo step (e.g. a drag); call `touch()` for intermediate updates and `end()` when done. */
  begin(label: string): void { if (!this.inTx) { this.pushUndo(label); this.inTx = true; } }
  touch(): void { this.afterChange(); }
  end(): void { this.inTx = false; }
  /** Change that is not part of the undo history (input stimulus). */
  stimulus(fn: () => void): void { this.sim.branch(); fn(); this.dirty = true; this.emit('sim'); }

  private pushUndo(label: string): void { this.undoStack.push({ label, snap: serialize(this.design) }); if (this.undoStack.length > 200) this.undoStack.shift(); this.redoStack = []; }
  private buildSim(): Simulator {
    setActiveDesign(this.design);
    const { module, problems, traced } = flattenModule(this.design, this.design.top);
    this.tracedSignals = traced;
    return new Simulator(module, problems);
  }
  private afterChange(): void {
    this.dirty = true;
    setActiveDesign(this.design);
    const { module, problems, traced } = flattenModule(this.design, this.design.top);
    this.tracedSignals = traced;
    this.sim.recompile(module, problems);
    this.pruneSelection();
    this.reconcileView();
    this.emit('change');
  }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  undo(): void { const u = this.undoStack.pop(); if (!u) return; this.redoStack.push({ label: u.label, snap: serialize(this.design) }); this.restore(u.snap); }
  redo(): void { const r = this.redoStack.pop(); if (!r) return; this.undoStack.push({ label: r.label, snap: serialize(this.design) }); this.restore(r.snap); }
  private restore(snap: string): void { this.design = deserialize(snap); this.afterChange(); }

  load(design: Design, file: string | null, mtime: number | null = null): void {
    this.design = design; this.viewModule = design.top; this.viewPath = [];
    this.breadcrumb = [{ module: design.top, path: [] }];
    this.file = file; this.fileMtime = mtime; this.dirty = false;
    this.undoStack = []; this.redoStack = []; this.sel = emptySel();
    this.sim = this.buildSim(); this.emit('load');
  }
  newDesign(): void { this.load(emptyDesign(), null); }

  // ---------- hierarchy navigation (DESIGN.md task 3) ----------
  /** Open a module from the module list: reachable (and simulated) only if it is `top`. */
  openModule(key: string): void {
    if (!this.design.modules[key]) return;
    this.viewModule = key; this.viewPath = key === this.design.top ? [] : null;
    this.breadcrumb = [{ module: key, path: this.viewPath }];
    this.sel = emptySel(); this.emit('view');
  }
  /** Double-click an instance block: open the module it instantiates, keeping the live path if we have one. */
  enterInstance(instanceId: string): void {
    const b = this.module.blocks.find(x => x.id === instanceId && x.type === 'instance'); if (!b) return;
    const childKey = String(b.params.module ?? ''); if (!this.design.modules[childKey]) return;
    const path = this.viewPath === null ? null : [...this.viewPath, instanceId];
    this.viewModule = childKey; this.viewPath = path;
    this.breadcrumb.push({ module: childKey, path });
    this.sel = emptySel(); this.emit('view');
  }
  goToBreadcrumb(i: number): void {
    const step = this.breadcrumb[i]; if (!step) return;
    this.breadcrumb.length = i + 1; this.viewModule = step.module; this.viewPath = step.path;
    this.sel = emptySel(); this.emit('view');
  }
  /** If the module or instance path currently shown no longer resolves (a rename or delete elsewhere),
   * fall back to a safe view instead of pointing at something gone. Doesn't try to repair a breadcrumb whose
   * middle got invalidated — it's only ever wrong for a moment, until the next navigation. */
  private reconcileView(): void {
    while (this.breadcrumb.length > 1 && !this.design.modules[this.breadcrumb[this.breadcrumb.length - 1].module]) this.breadcrumb.pop();
    const last = this.breadcrumb[this.breadcrumb.length - 1];
    if (!this.design.modules[last?.module]) { this.openModule(this.design.top); return; }
    if (last.path !== null) {
      let m: Module | undefined = this.design.modules[this.design.top];
      for (const instId of last.path) { const inst: Block | undefined = m?.blocks.find(b => b.id === instId && b.type === 'instance'); m = inst ? this.design.modules[String(inst.params.module ?? '')] : undefined; if (!m) { last.path = null; break; } }
    }
    this.viewModule = last.module; this.viewPath = last.path;
  }

  /** The flattened pin key (`u1/reg1.q`) for a pin (`reg1.q`) on the currently viewed sheet, or `null` if
   * this sheet isn't on the simulated tree (`!simActive`). */
  hierPin(localPin: string): string | null {
    if (this.viewPath === null) return null;
    if (!this.viewPath.length) return localPin;
    const { b, p } = parsePin(localPin);
    return pinKey({ b: `${this.viewPath.join('/')}/${b}`, p });
  }
  hierBlock(localId: string): string | null {
    if (this.viewPath === null) return null;
    return this.viewPath.length ? `${this.viewPath.join('/')}/${localId}` : localId;
  }
  /** Clear the trace flag on a block addressed by its hierarchical pin key from the waveform (which may be
   * nested inside instances), by walking the instance path back down to the module that actually owns it. */
  untraceHierKey(hierKey: string): void {
    const path = hierKey.slice(0, hierKey.lastIndexOf('.'));
    const segs = path.split('/');
    let m: Module | undefined = this.design.modules[this.design.top];
    for (let i = 0; i < segs.length - 1; i++) {
      const inst: Block | undefined = m?.blocks.find(b => b.id === segs[i] && b.type === 'instance'); if (!inst) return;
      m = this.design.modules[String(inst.params.module ?? '')]; if (!m) return;
    }
    const b = m?.blocks.find(x => x.id === segs[segs.length - 1]); if (!b) return;
    this.mutate('Untrace', () => { b.trace = false; });
  }

  // ---------- module management (DESIGN.md task 3) ----------
  addModule(name: string): string {
    const key = this.freshModuleKey(name);
    this.mutate('Add module', () => { this.design.modules[key] = emptyModule(); });
    return key;
  }
  renameModule(oldKey: string, newKeyRaw: string): void {
    const newKey = newKeyRaw.trim();
    if (!newKey || newKey === oldKey || !this.design.modules[oldKey] || this.design.modules[newKey]) return;
    this.mutate('Rename module', () => {
      const d = this.design;
      const modules: Record<string, Module> = {};
      for (const [k, v] of Object.entries(d.modules)) modules[k === oldKey ? newKey : k] = v;
      d.modules = modules;
      if (d.top === oldKey) d.top = newKey;
      for (const m of Object.values(d.modules)) for (const b of m.blocks) if (b.type === 'instance' && b.params.module === oldKey) b.params.module = newKey;
      for (const t of d.tests) if (t.module === oldKey) t.module = newKey;
      if (this.viewModule === oldKey) this.viewModule = newKey;
      for (const step of this.breadcrumb) if (step.module === oldKey) step.module = newKey;
    });
  }
  /** Refuses to delete `top`, the last remaining module, or a module still instantiated somewhere. */
  deleteModule(key: string): boolean {
    const d = this.design;
    if (key === d.top || Object.keys(d.modules).length <= 1 || !d.modules[key]) return false;
    for (const [k, m] of Object.entries(d.modules)) if (k !== key) for (const b of m.blocks) if (b.type === 'instance' && b.params.module === key) return false;
    this.mutate('Delete module', () => {
      delete d.modules[key];
      d.tests = d.tests.filter(t => t.module !== key);
    });
    if (!this.design.modules[this.viewModule]) this.openModule(this.design.top);
    return true;
  }
  setTop(key: string): void { if (!this.design.modules[key] || key === this.design.top) return; this.mutate('Set top module', () => { this.design.top = key; }); }
  private freshModuleKey(base: string): string {
    const clean = base.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_') || 'module';
    if (!this.design.modules[clean]) return clean;
    let i = 2; while (this.design.modules[`${clean}${i}`]) i++; return `${clean}${i}`;
  }

  select(sel: Selection): void { this.sel = sel; this.emit('select'); }
  selectBlock(id: string, add = false): void { const s = add ? this.sel : emptySel(); if (add && s.blocks.has(id)) s.blocks.delete(id); else s.blocks.add(id); this.select(s); }
  clearSelection(): void { this.select(emptySel()); }
  private pruneSelection(): void {
    const m = this.module; const ids = new Set(m.blocks.map(b => b.id)), wids = new Set(m.wires.map(w => w.id)), nids = new Set(m.notes.map(n => n.id));
    for (const b of [...this.sel.blocks]) if (!ids.has(b)) this.sel.blocks.delete(b);
    for (const w of [...this.sel.wires]) if (!wids.has(w)) this.sel.wires.delete(w);
    for (const n of [...this.sel.notes]) if (!nids.has(n)) this.sel.notes.delete(n);
  }

  /** Unique block id from a prefix. */
  freshId(prefix: string): string { const ids = new Set(this.module.blocks.map(b => b.id)); let i = 1; while (ids.has(`${prefix}${i}`)) i++; return `${prefix}${i}`; }
  freshWireId(): string { const ids = new Set(this.module.wires.map(w => w.id)); let i = 1; while (ids.has(`w${i}`)) i++; return `w${i}`; }
  freshNoteId(): string { const ids = new Set(this.module.notes.map(n => n.id)); let i = 1; while (ids.has(`note${i}`)) i++; return `note${i}`; }
}
