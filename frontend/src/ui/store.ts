// Application state: the design, selection, simulator, and undo/redo by snapshot.
import type { Design, Module } from '../model/types';
import { emptyDesign } from '../model/types';
import { serialize, deserialize } from '../model/serialize';
import { Simulator } from '../sim/engine';

export interface Selection { blocks: Set<string>; wires: Set<string>; notes: Set<string> }
export const emptySel = (): Selection => ({ blocks: new Set(), wires: new Set(), notes: new Set() });

export class Store {
  design: Design;
  moduleName: string;
  sim: Simulator;
  sel: Selection = emptySel();
  file: string | null = null;
  fileMtime: number | null = null;
  dirty = false;
  private undoStack: { label: string; snap: string }[] = [];
  private redoStack: { label: string; snap: string }[] = [];
  private listeners = new Set<(what: string) => void>();
  private inTx = false;

  constructor(design = emptyDesign()) {
    this.design = design; this.moduleName = design.top; this.sim = new Simulator(this.module);
  }
  get module(): Module { return this.design.modules[this.moduleName]; }

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
  private afterChange(): void { this.dirty = true; this.sim.recompile(this.module); this.pruneSelection(); this.emit('change'); }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  undo(): void { const u = this.undoStack.pop(); if (!u) return; this.redoStack.push({ label: u.label, snap: serialize(this.design) }); this.restore(u.snap); }
  redo(): void { const r = this.redoStack.pop(); if (!r) return; this.undoStack.push({ label: r.label, snap: serialize(this.design) }); this.restore(r.snap); }
  private restore(snap: string): void { this.design = deserialize(snap); if (!this.design.modules[this.moduleName]) this.moduleName = this.design.top; this.afterChange(); }

  load(design: Design, file: string | null, mtime: number | null = null): void {
    this.design = design; this.moduleName = design.top; this.file = file; this.fileMtime = mtime; this.dirty = false;
    this.undoStack = []; this.redoStack = []; this.sel = emptySel();
    this.sim = new Simulator(this.module); this.emit('load');
  }
  newDesign(): void { this.load(emptyDesign(), null); }

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
