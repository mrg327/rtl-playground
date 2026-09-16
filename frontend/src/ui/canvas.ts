// SVG schematic canvas: rendering plus pointer interaction (select, move, wire, pan, zoom).
import type { Block, Wire, Point, Note, PinRef } from '../model/types';
import { defOf } from '../model/library';
import { pinGeoms, pinGeom, bounds, transformOf, routeWire, pathD, distToPath, snap, shapeOf, type PinGeom } from '../model/geometry';
import { pinKey } from '../model/netlist';
import { fmt } from '../model/values';
import type { Store } from './store';
import { emptySel } from './store';

export type ValueMode = 'all' | 'hover' | 'none';

export interface CanvasCallbacks {
  onEditBlock(id: string): void;
  onEditNote(id: string): void;
  onContext?(e: PointerEvent, target: { block?: string; wire?: string }): void;
}

type Drag =
  | { type: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { type: 'block'; start: Point; orig: Map<string, Point>; moved: boolean; clickId: string }
  | { type: 'wire'; from: PinRef | null; to: PinRef | null; x: number; y: number }
  | { type: 'band'; start: Point; x: number; y: number; add: boolean }
  | { type: 'note'; id: string; ox: number; oy: number; moved: boolean }
  | { type: 'noteResize'; id: string; }
  | { type: 'wiremid'; id: string; moved: boolean };

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class Canvas {
  svg: SVGSVGElement;
  world: SVGGElement;
  layer: SVGGElement;
  tip: HTMLDivElement;
  view = { x: 60, y: 60, k: 1 };
  valueMode: ValueMode = 'all';
  dimUnchanged = false;
  private drag: Drag | null = null;
  private hoverPin: string | null = null;
  private hoverWire: string | null = null;
  private space = false;

  constructor(public container: HTMLElement, public store: Store, public cb: CanvasCallbacks) {
    container.innerHTML = `<svg class="schem" xmlns="http://www.w3.org/2000/svg" tabindex="0">
      <defs><pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" class="gridline"/></pattern></defs>
      <g class="world"><rect x="-100000" y="-100000" width="200000" height="200000" fill="url(#grid)"/><g class="layer"></g><g class="overlay"></g></g></svg>
      <div class="tip" hidden></div>`;
    this.svg = container.querySelector('svg')!; this.world = this.svg.querySelector('.world')!; this.layer = this.svg.querySelector('.layer')!;
    this.tip = container.querySelector('.tip')!;
    this.bind();
  }

  // ---------- coordinates ----------
  toWorld(e: { clientX: number; clientY: number }): Point { const r = this.svg.getBoundingClientRect(); return { x: (e.clientX - r.left - this.view.x) / this.view.k, y: (e.clientY - r.top - this.view.y) / this.view.k }; }
  center(): Point { const r = this.svg.getBoundingClientRect(); return { x: (r.width / 2 - this.view.x) / this.view.k, y: (r.height / 2 - this.view.y) / this.view.k }; }
  zoomAt(k2: number, cx?: number, cy?: number): void {
    const r = this.svg.getBoundingClientRect(); const mx = cx ?? r.width / 2, my = cy ?? r.height / 2;
    k2 = Math.max(0.2, Math.min(4, k2));
    this.view.x = mx - (mx - this.view.x) * k2 / this.view.k; this.view.y = my - (my - this.view.y) * k2 / this.view.k; this.view.k = k2; this.render();
  }
  zoomIn(): void { this.zoomAt(this.view.k * 1.2); }
  zoomOut(): void { this.zoomAt(this.view.k / 1.2); }
  zoomFit(): void {
    const m = this.store.module; const r = this.svg.getBoundingClientRect();
    const items = [...m.blocks.map(b => bounds(b)), ...m.notes];
    if (!items.length) { this.view = { x: 60, y: 60, k: 1 }; this.render(); return; }
    const x0 = Math.min(...items.map(i => i.x)) - 40, y0 = Math.min(...items.map(i => i.y)) - 40, x1 = Math.max(...items.map(i => i.x + i.w)) + 40, y1 = Math.max(...items.map(i => i.y + i.h)) + 40;
    const k = Math.max(0.2, Math.min(2, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
    this.view = { k, x: (r.width - (x1 - x0) * k) / 2 - x0 * k, y: (r.height - (y1 - y0) * k) / 2 - y0 * k }; this.render();
  }

  // ---------- rendering ----------
  render(): void {
    const { store } = this; const m = store.module; const sim = store.sim; const c = sim.compiled;
    const vals = sim.values(); const prev = sim.cur > 0 ? sim.values(sim.cur - 1) : null;
    const pv = (pin: string): bigint => { const i = c.pinIndex.get(pin); return i === undefined ? 0n : vals[i]; };
    const changed = (pin: string): boolean => { if (!prev) return false; const i = c.pinIndex.get(pin); return i !== undefined && prev[i] !== vals[i]; };
    const sel = store.sel;
    let h = '';
    const geomCache = new Map<string, PinGeom[]>();
    const geoms = (b: Block) => { let g = geomCache.get(b.id); if (!g) { g = pinGeoms(b); geomCache.set(b.id, g); } return g; };
    const byId = c.netlist.blocks;

    // wires
    for (const w of m.wires) {
      const fb = byId.get(w.from.b), tb = byId.get(w.to.b); if (!fb || !tb) continue;
      const fg = geoms(fb).find(g => g.def.name === w.from.p), tg = geoms(tb).find(g => g.def.name === w.to.p); if (!fg || !tg) continue;
      const pts = routeWire(fg, tg, w.mid); const d = pathD(pts);
      const key = pinKey(w.from); const v = pv(key); const bus = fg.def.width > 1; const net = c.netlist.byPin.get(key);
      const bad = c.problems.some(p => p.wires?.includes(w.id) && p.level === 'error');
      const chg = changed(key);
      const cls = `wire${bus ? ' bus' : ''}${!bus && v ? ' hi' : ''}${sel.wires.has(w.id) ? ' sel' : ''}${bad ? ' bad' : ''}${chg ? ' chg' : ''}${this.dimUnchanged && !chg ? ' dim' : ''}${this.hoverWire === w.id ? ' hover' : ''}`;
      h += `<path class="wire-hit" d="${d}" data-w="${w.id}"/><path class="${cls}" d="${d}"/>`;
      if (bus && (this.valueMode === 'all' || (this.valueMode === 'hover' && this.hoverWire === w.id))) {
        const seg = longestSeg(pts); h += `<text class="wv" x="${(seg[0].x + seg[1].x) / 2}" y="${(seg[0].y + seg[1].y) / 2 - 5}" text-anchor="middle">${fmt(v, fg.def.width, radixFor(fg.def.width))}</text>`;
      }
      if (net && net.wires.length > 1 && net.wires[0] !== w) { /* junction dot at fan-out point */ h += `<circle class="junction" cx="${pts[1].x}" cy="${pts[1].y}" r="3"/>`; }
    }
    // temporary wire
    if (this.drag?.type === 'wire') {
      const d = this.drag; const src = d.from ?? d.to; const b = src ? byId.get(src.b) : null; const g = b ? pinGeom(b, src!.p) : null;
      if (g) h += `<path class="tmp" d="M${g.x} ${g.y} L${d.x} ${d.y}"/>`;
    }
    // blocks (selected ones drawn last so they sit on top)
    const drawOrder = [...m.blocks.filter(b => !sel.blocks.has(b.id)), ...m.blocks.filter(b => sel.blocks.has(b.id))];
    for (const b of drawOrder) {
      const d = defOf(b.type); const s = shapeOf(b); const bb = bounds(b);
      const locked = m.locked.includes(b.id); const inLoop = c.loop.some(x => x.id === b.id);
      const err = c.problems.some(p => p.level === 'error' && p.blocks?.includes(b.id));
      h += `<g class="blk${sel.blocks.has(b.id) ? ' sel' : ''}${locked ? ' locked' : ''}${inLoop || err ? ' bad' : ''}" data-b="${b.id}">`;
      h += `<g transform="${transformOf(b)}">${d.body(b.params, s)}</g>`;
      const pg = geoms(b); const ins: bigint[] = [], outs: bigint[] = [];
      const ports = c.netlist.ports.get(b.id)!;
      for (const p of ports) { const key = `${b.id}.${p.name}`; if (p.dir === 'in') { const net = c.netlist.byPin.get(key); const drv = net?.drivers[0]; ins.push(drv ? pv(pinKey(drv)) & ((1n << BigInt(p.width)) - 1n) : 0n); } else outs.push(pv(key)); }
      for (const g of pg) {
        const key = `${b.id}.${g.def.name}`; const isIn = g.def.dir === 'in';
        const net = c.netlist.byPin.get(key); const drv = net?.drivers[0]; const v = isIn ? (drv ? pv(pinKey(drv)) : 0n) : pv(key);
        h += `<line class="lead" x1="${g.x}" y1="${g.y}" x2="${g.bx}" y2="${g.by}"/>`;
        if (g.def.width > 1) { const mx = (g.x + g.bx) / 2, my = (g.y + g.by) / 2; const vert = g.side === 't' || g.side === 'b';
          h += vert ? `<line class="tick" x1="${mx - 4}" y1="${my + 3}" x2="${mx + 4}" y2="${my - 3}"/><text class="tk" x="${mx + 6}" y="${my + 3}">${g.def.width}</text>` : `<line class="tick" x1="${mx - 3}" y1="${my + 4}" x2="${mx + 3}" y2="${my - 4}"/><text class="tk" x="${mx}" y="${my - 5}" text-anchor="middle">${g.def.width}</text>`; }
        const hot = g.def.width === 1 && (v & 1n) === 1n;
        h += `<circle class="port${hot ? ' hi' : ''}${this.hoverPin === key ? ' hover' : ''}" cx="${g.x}" cy="${g.y}" r="4.5" data-b="${b.id}" data-p="${g.def.name}" data-dir="${g.def.dir}"/>`;
        if (g.def.label) { const lx = g.side === 'l' ? g.bx + 4 : g.side === 'r' ? g.bx - 4 : g.bx; const ly = g.side === 't' ? g.by + 11 : g.side === 'b' ? g.by - 4 : g.by + 4; h += `<text class="p" x="${lx}" y="${ly}" text-anchor="${g.side === 'l' ? 'start' : g.side === 'r' ? 'end' : 'middle'}">${esc(g.def.label)}</text>`; }
      }
      if (d.inner) { const inner = d.inner(b.params, s, sim.frame.states.get(b.id), ins, outs); h += `<g transform="translate(${bb.x + bb.w / 2 - s.w / 2} ${bb.y + bb.h / 2 - s.h / 2})">${inner}</g>`; }
      if (b.label) h += `<text class="l" x="${bb.x + bb.w / 2}" y="${bb.y + bb.h + 14 + (pg.some(g => g.side === 'b') ? 12 : 0)}" text-anchor="middle">${esc(b.label)}</text>`;
      if (locked) h += `<text class="lock" x="${bb.x + bb.w - 2}" y="${bb.y - 3}" text-anchor="end">🔒</text>`;
      h += `</g>`;
    }
    // notes
    for (const n of m.notes) {
      h += `<g class="note${sel.notes.has(n.id) ? ' sel' : ''}" data-n="${n.id}"><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="3"/><foreignObject x="${n.x + 6}" y="${n.y + 4}" width="${n.w - 12}" height="${n.h - 8}"><div xmlns="http://www.w3.org/1999/xhtml" class="notetext">${esc(n.text).replace(/\n/g, '<br/>')}</div></foreignObject><rect class="grip" x="${n.x + n.w - 10}" y="${n.y + n.h - 10}" width="10" height="10"/></g>`;
    }
    // rubber band
    if (this.drag?.type === 'band') { const d = this.drag; const x = Math.min(d.start.x, d.x), y = Math.min(d.start.y, d.y); h += `<rect class="band" x="${x}" y="${y}" width="${Math.abs(d.x - d.start.x)}" height="${Math.abs(d.y - d.start.y)}"/>`; }
    this.layer.innerHTML = h;
    this.world.setAttribute('transform', `translate(${this.view.x} ${this.view.y}) scale(${this.view.k})`);
    this.container.classList.toggle('empty', m.blocks.length === 0 && m.notes.length === 0);
  }

  // ---------- interaction ----------
  private bind(): void {
    const sv = this.svg;
    sv.addEventListener('pointerdown', e => this.down(e));
    sv.addEventListener('pointermove', e => this.move(e));
    sv.addEventListener('pointerup', e => this.up(e));
    sv.addEventListener('pointercancel', () => { this.drag = null; this.render(); });
    sv.addEventListener('dblclick', e => this.dbl(e));
    sv.addEventListener('contextmenu', e => e.preventDefault());
    sv.addEventListener('wheel', e => {
      e.preventDefault(); const r = sv.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) this.zoomAt(this.view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
      else { this.view.x -= e.shiftKey ? e.deltaY : e.deltaX; this.view.y -= e.shiftKey ? 0 : e.deltaY; this.render(); }
    }, { passive: false });
    document.addEventListener('keydown', e => { if (e.code === 'Space' && !isEditable(e.target)) { this.space = true; sv.classList.add('pannable'); } });
    document.addEventListener('keyup', e => { if (e.code === 'Space') { this.space = false; sv.classList.remove('pannable'); } });
  }

  private target(e: PointerEvent): { port?: SVGElement; blk?: string; wire?: string; note?: string; grip?: boolean } {
    const t = e.target as Element;
    const port = t.closest('.port') as SVGElement | null;
    return { port: port ?? undefined, blk: (t.closest('.blk') as SVGElement | null)?.dataset.b, wire: (t.closest('[data-w]') as SVGElement | null)?.dataset.w, note: (t.closest('.note') as SVGElement | null)?.dataset.n, grip: !!t.closest('.grip') };
  }

  private down(e: PointerEvent): void {
    const w = this.toWorld(e); const { store } = this; const m = store.module;
    this.svg.focus({ preventScroll: true });
    const tg = this.target(e);
    const pan = e.button === 1 || e.button === 2 || this.space;
    if (pan) { this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y }; this.svg.classList.add('dragging'); }
    else if (tg.port) {
      const b = tg.port.dataset.b!, p = tg.port.dataset.p!, dir = tg.port.dataset.dir;
      if (dir === 'out') this.drag = { type: 'wire', from: { b, p }, to: null, x: w.x, y: w.y };
      else { const ex = m.wires.find(x => x.to.b === b && x.to.p === p);
        if (ex) { store.begin('Rewire'); m.wires.splice(m.wires.indexOf(ex), 1); store.touch(); this.drag = { type: 'wire', from: ex.from, to: null, x: w.x, y: w.y }; }
        else this.drag = { type: 'wire', from: null, to: { b, p }, x: w.x, y: w.y }; }
    } else if (tg.blk) {
      const id = tg.blk;
      if (e.shiftKey) store.selectBlock(id, true); else if (!store.sel.blocks.has(id)) store.selectBlock(id);
      const orig = new Map<string, Point>(); for (const b of m.blocks) if (store.sel.blocks.has(b.id) && !m.locked.includes(b.id)) orig.set(b.id, { x: b.x, y: b.y });
      this.drag = { type: 'block', start: w, orig, moved: false, clickId: id };
    } else if (tg.wire) {
      const s = e.shiftKey ? store.sel : emptySel(); if (e.shiftKey && s.wires.has(tg.wire)) s.wires.delete(tg.wire); else s.wires.add(tg.wire); store.select(s);
      this.drag = { type: 'wiremid', id: tg.wire, moved: false };
    } else if (tg.note) {
      const n = m.notes.find(x => x.id === tg.note)!; const s = e.shiftKey ? store.sel : emptySel(); s.notes.add(n.id); store.select(s);
      this.drag = tg.grip ? { type: 'noteResize', id: n.id } : { type: 'note', id: n.id, ox: w.x - n.x, oy: w.y - n.y, moved: false };
    } else {
      if (!e.shiftKey) store.clearSelection();
      this.drag = { type: 'band', start: w, x: w.x, y: w.y, add: e.shiftKey };
    }
    this.svg.setPointerCapture(e.pointerId); this.render();
  }

  private move(e: PointerEvent): void {
    const w = this.toWorld(e);
    if (!this.drag) { this.hover(e, w); return; }
    const d = this.drag; const m = this.store.module;
    if (d.type === 'pan') { this.view.x = d.vx + e.clientX - d.sx; this.view.y = d.vy + e.clientY - d.sy; }
    else if (d.type === 'block') {
      const dx = snap(w.x - d.start.x), dy = snap(w.y - d.start.y);
      if ((dx || dy) && !d.moved) { d.moved = true; this.store.begin('Move'); }
      if (d.moved) { for (const b of m.blocks) { const o = d.orig.get(b.id); if (o) { b.x = o.x + dx; b.y = o.y + dy; } } this.store.touch(); return; }
    }
    else if (d.type === 'wire') { d.x = w.x; d.y = w.y; this.hoverPin = this.nearestPin(w, d.from ? 'in' : 'out')?.key ?? null; }
    else if (d.type === 'band') { d.x = w.x; d.y = w.y; }
    else if (d.type === 'note') { const n = m.notes.find(x => x.id === d.id)!; if (!d.moved) { d.moved = true; this.store.begin('Move note'); } n.x = snap(w.x - d.ox); n.y = snap(w.y - d.oy); this.store.touch(); return; }
    else if (d.type === 'noteResize') { const n = m.notes.find(x => x.id === d.id)!; this.store.begin('Resize note'); n.w = Math.max(60, snap(w.x - n.x)); n.h = Math.max(30, snap(w.y - n.y)); this.store.touch(); return; }
    else if (d.type === 'wiremid') { const wr = m.wires.find(x => x.id === d.id)!; if (!d.moved) { d.moved = true; this.store.begin('Route wire'); } const fb = m.blocks.find(b => b.id === wr.from.b)!, tb = m.blocks.find(b => b.id === wr.to.b)!; const fg = pinGeom(fb, wr.from.p)!, tg = pinGeom(tb, wr.to.p)!;
      const horizontal = (fg.side === 'l' || fg.side === 'r') && (tg.side === 'l' || tg.side === 'r'); const forward = fg.side === 'r' ? tg.x - fg.x >= 20 : fg.x - tg.x >= 20;
      wr.mid = snap(horizontal && forward ? w.x : w.y); this.store.touch(); return; }
    this.render();
  }

  private up(e: PointerEvent): void {
    const d = this.drag; if (!d) return; const w = this.toWorld(e); const { store } = this; const m = store.module;
    this.drag = null; this.svg.classList.remove('dragging'); this.hoverPin = null;
    if (d.type === 'wire') {
      const hit = this.nearestPin(w, d.from ? 'in' : 'out');
      if (hit) { const from = d.from ?? { b: hit.b, p: hit.p }; const to = d.to ?? { b: hit.b, p: hit.p };
        store.begin('Connect'); m.wires = m.wires.filter(x => !(x.to.b === to.b && x.to.p === to.p)); m.wires.push({ id: store.freshWireId(), from, to }); store.touch(); }
      else store.touch();
      store.end();
    } else if (d.type === 'block') {
      if (d.moved) store.end();
      else { const b = m.blocks.find(x => x.id === d.clickId)!; if (b.type === 'in' && Number(b.params.width ?? 1) === 1 && !m.locked.includes(b.id)) store.stimulus(() => { b.params.value = Number(b.params.value) ? 0 : 1; }); }
    } else if (d.type === 'band') {
      const x0 = Math.min(d.start.x, d.x), y0 = Math.min(d.start.y, d.y), x1 = Math.max(d.start.x, d.x), y1 = Math.max(d.start.y, d.y);
      if (x1 - x0 > 3 || y1 - y0 > 3) {
        const s = d.add ? store.sel : emptySel();
        for (const b of m.blocks) { const bb = bounds(b); if (bb.x < x1 && bb.x + bb.w > x0 && bb.y < y1 && bb.y + bb.h > y0) s.blocks.add(b.id); }
        for (const wr of m.wires) if (s.blocks.has(wr.from.b) && s.blocks.has(wr.to.b)) s.wires.add(wr.id);
        for (const n of m.notes) if (n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0) s.notes.add(n.id);
        store.select(s);
      }
    } else if (d.type === 'note' || d.type === 'wiremid') { if (d.moved) store.end(); }
    else if (d.type === 'noteResize') store.end();
    this.render();
  }

  private dbl(e: MouseEvent): void {
    const t = e.target as Element; const blk = (t.closest('.blk') as SVGElement | null)?.dataset.b; const note = (t.closest('.note') as SVGElement | null)?.dataset.n;
    if (blk) this.cb.onEditBlock(blk); else if (note) this.cb.onEditNote(note);
  }

  private nearestPin(w: Point, dir: 'in' | 'out'): { b: string; p: string; key: string } | null {
    let best: { b: string; p: string; key: string } | null = null, bd = 18 / this.view.k;
    for (const b of this.store.module.blocks) for (const g of pinGeoms(b)) { if (g.def.dir !== dir) continue; const dist = Math.hypot(g.x - w.x, g.y - w.y); if (dist < bd) { bd = dist; best = { b: b.id, p: g.def.name, key: `${b.id}.${g.def.name}` }; } }
    return best;
  }

  private hover(e: PointerEvent, w: Point): void {
    const tg = this.target(e); const c = this.store.sim.compiled;
    let pin: string | null = null, wire: string | null = null, text = '';
    if (tg.port) { pin = `${tg.port.dataset.b}.${tg.port.dataset.p}`; }
    else if (tg.wire) { wire = tg.wire; const wr = this.store.module.wires.find(x => x.id === wire); if (wr) pin = pinKey(wr.from); }
    if (pin) {
      const net = c.netlist.byPin.get(pin); const drv = net?.drivers[0]; const key = drv ? pinKey(drv) : pin; const v = this.store.sim.value(key); const wdt = net?.width ?? 1;
      text = `<b>${esc(net?.name || pin)}</b> · ${wdt} bit${wdt > 1 ? 's' : ''}<br>${wdt > 1 ? `dec ${v} · hex ${fmt(v, wdt, 'hex')} · bin ${fmt(v, wdt, 'bin')}` : `value ${v}`}${net && net.drivers.length === 0 ? '<br><i>undriven</i>' : ''}`;
    }
    if (pin !== this.hoverPin || wire !== this.hoverWire) { this.hoverPin = pin; this.hoverWire = wire; this.render(); }
    if (text) { this.tip.innerHTML = text; this.tip.hidden = false; const r = this.container.getBoundingClientRect(); this.tip.style.left = `${e.clientX - r.left + 14}px`; this.tip.style.top = `${e.clientY - r.top + 14}px`; }
    else this.tip.hidden = true;
    void w;
  }
}

function longestSeg(pts: Point[]): [Point, Point] {
  let best: [Point, Point] = [pts[0], pts[1] ?? pts[0]], bl = -1;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); if (l > bl) { bl = l; best = [pts[i - 1], pts[i]]; } }
  return best;
}
const radixFor = (w: number): 'dec' | 'hex' => (w > 16 ? 'hex' : 'dec');
export const isEditable = (t: EventTarget | null): boolean => { const el = t as HTMLElement | null; return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable); };
void distToPath;
