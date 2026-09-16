import './waveform.css';
import type { Radix } from '../model/types';
import { fmt } from '../model/values';

// ---------------------------------------------------------------------------
// Public data model
// ---------------------------------------------------------------------------

export interface WaveSignal {
  key: string;
  name: string;
  width: number;
  radix: Radix;
  values: bigint[];
  /** enum labels for value display, optional */
  labels?: Record<string, string>;
}

export interface WaveData {
  /** cycle numbers, one per column; values[i] corresponds to cycles[i] */
  cycles: number[];
  signals: WaveSignal[];
  /** index into cycles */
  cursor: number;
  /** index of the live (last) column */
  live: number;
  /** reset asserted per column, optional */
  rst?: boolean[];
}

export interface WaveCallbacks {
  onCursor(index: number): void;
  onRemove(key: string): void;
  onRadix(key: string, radix: Radix): void;
  onReorder(keys: string[]): void;
  onSelect?(key: string | null): void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Format a value for display, honouring enum labels when present. */
export function fmtValue(v: bigint, width: number, radix: Radix, labels?: Record<string, string>): string {
  if (labels) {
    const lbl = labels[v.toString()];
    if (lbl !== undefined) return lbl;
  }
  return fmt(v, width, radix);
}

interface WaveJsonRow { name: string; wave: string; data?: string[] }

/** WaveDrom-style WaveJSON: {signal:[{name,wave,data}]}. */
export function toWaveJSON(data: WaveData): { signal: WaveJsonRow[] } {
  const n = data.cycles.length;
  const rows: WaveJsonRow[] = [{ name: 'clk', wave: n > 0 ? 'p' + '.'.repeat(Math.max(0, n - 1)) : '' }];
  for (const sig of data.signals) {
    let wave = '';
    const dataVals: string[] = [];
    let prev: bigint | undefined;
    for (let i = 0; i < n; i++) {
      const v = sig.values[i] ?? 0n;
      const changed = prev === undefined || v !== prev;
      if (sig.width === 1) {
        wave += changed ? (v === 0n ? '0' : '1') : '.';
      } else if (changed) {
        wave += '=';
        dataVals.push(fmtValue(v, sig.width, sig.radix, sig.labels));
      } else {
        wave += '.';
      }
      prev = v;
    }
    rows.push(sig.width === 1 ? { name: sig.name, wave } : { name: sig.name, wave, data: dataVals });
  }
  return { signal: rows };
}

/** Bijective base-94 VCD identifier generator (printable ASCII 33..126). */
function vcdId(n: number): string {
  let s = '';
  let k = n + 1;
  while (k > 0) {
    k--;
    s = String.fromCharCode(33 + (k % 94)) + s;
    k = Math.floor(k / 94);
  }
  return s;
}

/** Emit a minimal, valid VCD trace: timescale, one scope, clk + signals, value changes only. */
export function toVCD(data: WaveData, timescale = '1ns'): string {
  const n = data.cycles.length;
  const clkId = vcdId(0);
  const ids = data.signals.map((_, i) => vcdId(i + 1));
  const lines: string[] = [];
  lines.push(`$timescale ${timescale} $end`);
  lines.push('$scope module top $end');
  lines.push(`$var wire 1 ${clkId} clk $end`);
  data.signals.forEach((s, i) => lines.push(`$var wire ${s.width} ${ids[i]} ${s.name} $end`));
  lines.push('$upscope $end');
  lines.push('$enddefinitions $end');

  const valLine = (v: bigint, width: number, id: string): string =>
    width === 1 ? `${v & 1n ? '1' : '0'}${id}` : `b${v.toString(2).padStart(width, '0')} ${id}`;

  const times = new Map<number, string[]>();
  const push = (t: number, line: string): void => {
    const arr = times.get(t);
    if (arr) arr.push(line);
    else times.set(t, [line]);
  };

  for (let i = 0; i < n; i++) {
    push(10 * i, `1${clkId}`);
    push(10 * i + 5, `0${clkId}`);
  }
  data.signals.forEach((s, si) => {
    let prev: bigint | undefined;
    for (let i = 0; i < n; i++) {
      const v = s.values[i] ?? 0n;
      if (prev === undefined || v !== prev) push(10 * i, valLine(v, s.width, ids[si]));
      prev = v;
    }
  });

  lines.push('$dumpvars');
  for (const l of times.get(0) ?? []) lines.push(l);
  lines.push('$end');
  const rest = [...times.keys()].filter((t) => t !== 0).sort((a, b) => a - b);
  for (const t of rest) {
    lines.push(`#${t}`);
    for (const l of times.get(t) ?? []) lines.push(l);
  }
  return lines.join('\n') + '\n';
}

/** A 40-cycle example: clk, a toggling bit, a 4-bit counter, an 8-bit bus. */
export function demoData(): WaveData {
  const n = 40;
  const cycles = Array.from({ length: n }, (_, i) => i);
  const clk: WaveSignal = { key: 'clk', name: 'clk', width: 1, radix: 'bin', values: cycles.map((i) => BigInt(i % 2)) };
  const bit: WaveSignal = {
    key: 'sig',
    name: 'a',
    width: 1,
    radix: 'bin',
    values: cycles.map((i) => BigInt(Math.floor(i / 3) % 2)),
  };
  const counter: WaveSignal = { key: 'cnt', name: 'counter', width: 4, radix: 'hex', values: cycles.map((i) => BigInt(i % 16)) };
  const bus: WaveSignal = { key: 'bus', name: 'data', width: 8, radix: 'hex', values: cycles.map((i) => BigInt((i * 37) % 256)) };
  const rst = cycles.map((i) => i < 2);
  return { cycles, signals: [clk, bit, counter, bus], cursor: 8, live: n - 1, rst };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ROW_H = 28;
const HEADER_H = 28;
const NAMES_W = 150;
const MIN_PX = 6;
const MAX_PX = 120;
const RADIX_OPTS: Radix[] = ['bin', 'hex', 'dec', 'sdec', 'ascii'];

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

interface Theme { bg: string; grid: string; line: string; text: string; cursor: string; live: string; hi: string }

interface RowEls { row: HTMLElement; nameEl: HTMLElement; valEl: HTMLElement; selectEl: HTMLSelectElement }

function sameStructure(a: WaveData, b: WaveData): boolean {
  if (a.signals.length !== b.signals.length || a.cycles.length !== b.cycles.length) return false;
  for (let i = 0; i < a.signals.length; i++) {
    const sa = a.signals[i];
    const sb = b.signals[i];
    if (sa.key !== sb.key || sa.name !== sb.name || sa.width !== sb.width || sa.radix !== sb.radix || sa.labels !== sb.labels) return false;
  }
  return true;
}

export class WaveformView {
  private root: HTMLElement;
  private cb: WaveCallbacks;
  private namesPane: HTMLElement;
  private namesBody: HTMLElement;
  private canvasPane: HTMLElement;
  private inner: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private resizer: HTMLElement;

  private data: WaveData | null = null;
  private pxPerCycle = 24;
  private selectedKey: string | null = null;
  private rows = new Map<string, RowEls>();
  private theme: Theme;
  private dpr = 1;
  private rafPending = false;
  private syncingScroll = false;
  private dragKey: string | null = null;
  private scrubbing = false;
  private resizeObserver: ResizeObserver;
  private mql = window.matchMedia('(prefers-color-scheme: dark)');
  private destroyed = false;

  follow = false;

  constructor(container: HTMLElement, cb: WaveCallbacks) {
    this.root = container;
    this.cb = cb;
    this.root.classList.add('wv-root');
    if (this.root.tabIndex < 0) this.root.tabIndex = 0;
    this.root.innerHTML = '';

    this.namesPane = document.createElement('div');
    this.namesPane.className = 'wv-names';
    this.namesPane.style.width = `${NAMES_W}px`;
    const namesHeader = document.createElement('div');
    namesHeader.className = 'wv-names-header';
    this.namesBody = document.createElement('div');
    this.namesBody.className = 'wv-names-body';
    this.resizer = document.createElement('div');
    this.resizer.className = 'wv-resizer';
    this.namesPane.append(namesHeader, this.namesBody, this.resizer);

    this.canvasPane = document.createElement('div');
    this.canvasPane.className = 'wv-canvas-pane';
    this.inner = document.createElement('div');
    this.inner.className = 'wv-canvas-inner';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wv-canvas';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.inner.append(this.canvas);
    this.canvasPane.append(this.inner);

    this.root.append(this.namesPane, this.canvasPane);

    this.theme = this.computeTheme();

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.canvasPane);

    this.canvasPane.addEventListener('scroll', () => this.onCanvasScroll());
    this.namesBody.addEventListener('scroll', () => this.onNamesScroll());
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.root.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.resizer.addEventListener('pointerdown', (e) => this.onResizerDown(e));
    this.mql.addEventListener('change', () => { this.theme = this.computeTheme(); this.scheduleDraw(); });

    this.onResize();
  }

  // -- public API -----------------------------------------------------------

  update(data: WaveData): void {
    if (data === this.data) return;
    const prev = this.data;
    this.data = data;
    if (!prev || !sameStructure(prev, data)) this.rebuildRows(data);
    else this.refreshRowValues(data);
    this.layoutContent();
    if (this.follow && (!prev || prev.live !== data.live)) this.scrollToCursor();
    this.scheduleDraw();
  }

  setZoom(pxPerCycle: number): void {
    this.pxPerCycle = clamp(pxPerCycle, MIN_PX, MAX_PX);
    this.layoutContent();
    this.scheduleDraw();
  }

  zoomIn(): void { this.setZoom(this.pxPerCycle * 1.25); }
  zoomOut(): void { this.setZoom(this.pxPerCycle / 1.25); }

  zoomFit(): void {
    const n = this.data?.cycles.length ?? 0;
    if (n <= 0) return;
    this.setZoom(this.canvasPane.clientWidth / n);
  }

  scrollToCursor(): void {
    if (!this.data) return;
    const idx = this.follow ? this.data.live : this.data.cursor;
    const x0 = idx * this.pxPerCycle;
    const x1 = x0 + this.pxPerCycle;
    const view = this.canvasPane.clientWidth;
    if (x0 < this.canvasPane.scrollLeft) this.canvasPane.scrollLeft = Math.max(0, x0 - this.pxPerCycle);
    else if (x1 > this.canvasPane.scrollLeft + view) this.canvasPane.scrollLeft = x1 - view + this.pxPerCycle;
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.root.innerHTML = '';
    this.root.classList.remove('wv-root');
  }

  // -- DOM (names column) ----------------------------------------------------

  private rebuildRows(data: WaveData): void {
    this.namesBody.innerHTML = '';
    this.rows.clear();
    for (const sig of data.signals) this.rows.set(sig.key, this.buildRow(sig));
    this.refreshRowValues(data);
  }

  private buildRow(sig: WaveSignal): RowEls {
    const row = document.createElement('div');
    row.className = 'wv-row';
    row.draggable = true;
    row.dataset.key = sig.key;

    const handle = document.createElement('span');
    handle.className = 'wv-drag-handle';
    handle.textContent = '≡';

    const nameEl = document.createElement('span');
    nameEl.className = 'wv-name';
    nameEl.textContent = sig.name;
    nameEl.title = sig.name;

    const valEl = document.createElement('span');
    valEl.className = 'wv-val';

    const selectEl = document.createElement('select');
    selectEl.className = 'wv-radix';
    for (const r of RADIX_OPTS) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      selectEl.append(opt);
    }
    selectEl.value = sig.radix;
    selectEl.addEventListener('click', (e) => e.stopPropagation());
    selectEl.addEventListener('change', () => this.cb.onRadix(sig.key, selectEl.value as Radix));

    const removeEl = document.createElement('button');
    removeEl.type = 'button';
    removeEl.className = 'wv-remove';
    removeEl.textContent = '×';
    removeEl.title = 'Remove';
    removeEl.addEventListener('click', (e) => { e.stopPropagation(); this.cb.onRemove(sig.key); });

    row.append(handle, nameEl, valEl, selectEl, removeEl);

    row.addEventListener('click', () => {
      this.selectedKey = this.selectedKey === sig.key ? null : sig.key;
      this.updateSelectionClasses();
      this.cb.onSelect?.(this.selectedKey);
    });
    row.addEventListener('dragstart', (e) => {
      this.dragKey = sig.key;
      e.dataTransfer?.setData('text/plain', sig.key);
      e.dataTransfer!.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('wv-drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('wv-drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('wv-drag-over');
      this.onDropRow(sig.key);
    });

    this.namesBody.append(row);
    return { row, nameEl, valEl, selectEl };
  }

  private onDropRow(targetKey: string): void {
    if (!this.data || !this.dragKey || this.dragKey === targetKey) return;
    const keys = this.data.signals.map((s) => s.key);
    const from = keys.indexOf(this.dragKey);
    const to = keys.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    keys.splice(to, 0, keys.splice(from, 1)[0]);
    this.dragKey = null;
    this.cb.onReorder(keys);
  }

  private refreshRowValues(data: WaveData): void {
    for (const sig of data.signals) {
      const r = this.rows.get(sig.key);
      if (!r) continue;
      const v = sig.values[data.cursor] ?? 0n;
      r.valEl.textContent = fmtValue(v, sig.width, sig.radix, sig.labels);
      if (r.selectEl.value !== sig.radix) r.selectEl.value = sig.radix;
      if (r.nameEl.textContent !== sig.name) r.nameEl.textContent = sig.name;
    }
    this.updateSelectionClasses();
  }

  private updateSelectionClasses(): void {
    for (const [key, r] of this.rows) r.row.classList.toggle('wv-selected', key === this.selectedKey);
  }

  // -- layout / scroll --------------------------------------------------------

  private layoutContent(): void {
    const n = this.data?.cycles.length ?? 0;
    const rowsN = this.data?.signals.length ?? 0;
    const w = Math.max(this.canvasPane.clientWidth, n * this.pxPerCycle);
    const h = Math.max(this.canvasPane.clientHeight, HEADER_H + rowsN * ROW_H);
    this.inner.style.width = `${w}px`;
    this.inner.style.height = `${h}px`;
  }

  private onResize(): void {
    if (this.destroyed) return;
    const w = Math.max(1, this.canvasPane.clientWidth);
    const h = Math.max(1, this.canvasPane.clientHeight);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.layoutContent();
    this.scheduleDraw();
  }

  private onCanvasScroll(): void {
    if (this.syncingScroll) return;
    this.syncingScroll = true;
    this.namesBody.scrollTop = this.canvasPane.scrollTop;
    this.syncingScroll = false;
    this.scheduleDraw();
  }

  private onNamesScroll(): void {
    if (this.syncingScroll) return;
    this.syncingScroll = true;
    this.canvasPane.scrollTop = this.namesBody.scrollTop;
    this.syncingScroll = false;
    this.scheduleDraw();
  }

  private onResizerDown(e: PointerEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = this.namesPane.getBoundingClientRect().width;
    const move = (ev: PointerEvent): void => {
      const w = clamp(startW + (ev.clientX - startX), 80, 400);
      this.namesPane.style.width = `${w}px`;
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // -- interaction --------------------------------------------------------

  private colAt(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const absX = clientX - rect.left + this.canvasPane.scrollLeft;
    const n = this.data?.cycles.length ?? 1;
    return clamp(Math.floor(absX / this.pxPerCycle), 0, Math.max(0, n - 1));
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.data) return;
    this.scrubbing = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.cb.onCursor(this.colAt(e.clientX));
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.scrubbing || !this.data) return;
    this.cb.onCursor(this.colAt(e.clientX));
  }

  private onPointerUp(e: PointerEvent): void {
    this.scrubbing = false;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.data) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const absX = localX + this.canvasPane.scrollLeft;
      const oldPx = this.pxPerCycle;
      const factor = Math.exp(-e.deltaY * 0.001);
      const newPx = clamp(oldPx * factor, MIN_PX, MAX_PX);
      if (newPx === oldPx) return;
      this.pxPerCycle = newPx;
      this.layoutContent();
      this.canvasPane.scrollLeft = (absX / oldPx) * newPx - localX;
      this.scheduleDraw();
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      this.canvasPane.scrollLeft += e.deltaY;
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.data) return;
    const n = this.data.cycles.length;
    if (n === 0) return;
    let idx = this.data.cursor;
    if (e.key === 'ArrowLeft') idx = Math.max(0, idx - 1);
    else if (e.key === 'ArrowRight') idx = Math.min(n - 1, idx + 1);
    else if (e.key === 'Home') idx = 0;
    else if (e.key === 'End') idx = n - 1;
    else return;
    e.preventDefault();
    this.cb.onCursor(idx);
  }

  // -- theme ----------------------------------------------------------------

  private computeTheme(): Theme {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    this.root.appendChild(probe);
    const get = (name: string, fallback: string, secondary?: string): string => {
      probe.style.color = secondary ? `var(${name}, var(${secondary}, ${fallback}))` : `var(${name}, ${fallback})`;
      return getComputedStyle(probe).color || fallback;
    };
    const theme: Theme = {
      bg: get('--wave-bg', '#ffffff', '--paper'),
      grid: get('--wave-grid', '#e0e0e0', '--grid'),
      line: get('--wave-line', '#1a1a1a', '--ink'),
      text: get('--wave-text', '#444444', '--ink2'),
      cursor: get('--wave-cursor', '#2563eb', '--sel'),
      live: get('--wave-live', 'rgba(37,99,235,0.08)'),
      hi: get('--wave-hi', 'rgba(255,200,0,0.18)', '--hi'),
    };
    probe.remove();
    return theme;
  }

  // -- drawing ----------------------------------------------------------------

  private scheduleDraw(): void {
    if (this.rafPending || this.destroyed) return;
    this.rafPending = true;
    requestAnimationFrame(() => { this.rafPending = false; this.draw(); });
  }

  private draw(): void {
    const { ctx, theme } = this;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);

    const data = this.data;
    if (!data || data.cycles.length === 0) return;
    const n = data.cycles.length;
    const scrollLeft = this.canvasPane.scrollLeft;
    const scrollTop = this.canvasPane.scrollTop;
    const first = clamp(Math.floor(scrollLeft / this.pxPerCycle), 0, n - 1);
    const last = clamp(Math.ceil((scrollLeft + w) / this.pxPerCycle), 0, n - 1);
    const colX = (c: number): number => c * this.pxPerCycle - scrollLeft;

    // column backgrounds: reset hatch, live tint, cursor tint
    for (let c = first; c <= last; c++) {
      const x0 = colX(c);
      const x1 = colX(c + 1);
      if (data.rst?.[c]) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, HEADER_H, x1 - x0, h - HEADER_H);
        ctx.clip();
        ctx.strokeStyle = theme.grid;
        ctx.lineWidth = 1;
        for (let d = x0 - h; d < x1 + h; d += 6) {
          ctx.beginPath();
          ctx.moveTo(d, HEADER_H);
          ctx.lineTo(d + h, h);
          ctx.stroke();
        }
        ctx.restore();
      }
      if (c === data.live) { ctx.fillStyle = theme.live; ctx.fillRect(x0, 0, x1 - x0, h); }
      if (c === data.cursor) { ctx.fillStyle = theme.hi; ctx.fillRect(x0, 0, x1 - x0, h); }
    }

    // grid lines
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, HEADER_H + 0.5);
    ctx.lineTo(w, HEADER_H + 0.5);
    for (let c = first; c <= last + 1; c++) {
      const x = Math.round(colX(c)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();

    // header cycle numbers
    ctx.fillStyle = theme.text;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (this.pxPerCycle >= 14) {
      for (let c = first; c <= last; c++) this.centerText(String(data.cycles[c]), (colX(c) + colX(c + 1)) / 2, HEADER_H / 2, this.pxPerCycle - 4);
    }

    // rows
    const firstRow = clamp(Math.floor(scrollTop / ROW_H), 0, Math.max(0, data.signals.length - 1));
    const lastRow = clamp(Math.ceil((scrollTop + h - HEADER_H) / ROW_H), 0, Math.max(0, data.signals.length - 1));
    for (let ri = firstRow; ri <= lastRow; ri++) {
      const sig = data.signals[ri];
      if (!sig) continue;
      const top = HEADER_H + ri * ROW_H - scrollTop;
      if (top + ROW_H < HEADER_H || top > h) continue;
      if (sig.key === 'clk' || sig.name.toLowerCase() === 'clk') this.drawClock(top, first, last, colX);
      else if (sig.width === 1) this.drawBit(sig, top, first, last, colX, n);
      else this.drawBus(sig, top, first, last, colX, n);
      // row separator
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(0, top + ROW_H + 0.5);
      ctx.lineTo(w, top + ROW_H + 0.5);
      ctx.stroke();
    }

    // cursor line
    const cx = Math.round(colX(data.cursor)) + 0.5;
    ctx.strokeStyle = theme.cursor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
  }

  private centerText(text: string, cx: number, cy: number, maxWidth: number): void {
    if (maxWidth < 8) return;
    const ctx = this.ctx;
    let t = text;
    if (ctx.measureText(t).width > maxWidth) {
      while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
      t = t.length > 0 ? t + '…' : '';
    }
    if (t) ctx.fillText(t, cx, cy);
  }

  private drawClock(top: number, first: number, last: number, colX: (c: number) => number): void {
    const ctx = this.ctx;
    const hi = top + 6;
    const lo = top + ROW_H - 6;
    ctx.strokeStyle = this.theme.line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let c = first; c <= last; c++) {
      const x0 = colX(c);
      const x1 = colX(c + 1);
      const mid = (x0 + x1) / 2;
      ctx.moveTo(x0, lo);
      ctx.lineTo(x0, hi);
      ctx.lineTo(mid, hi);
      ctx.lineTo(mid, lo);
      ctx.lineTo(x1, lo);
    }
    ctx.stroke();
  }

  private drawBit(sig: WaveSignal, top: number, first: number, last: number, colX: (c: number) => number, n: number): void {
    const ctx = this.ctx;
    const hi = top + 6;
    const lo = top + ROW_H - 6;
    ctx.strokeStyle = this.theme.line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let prevY: number | null = null;
    const start = Math.max(0, first);
    for (let c = start; c <= last && c < n; c++) {
      const v = sig.values[c] ?? 0n;
      const y = v === 0n ? lo : hi;
      const x0 = colX(c);
      const x1 = colX(c + 1);
      if (prevY !== null && prevY !== y) { ctx.moveTo(x0, prevY); ctx.lineTo(x0, y); }
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      prevY = y;
    }
    ctx.stroke();
  }

  private drawBus(sig: WaveSignal, top: number, first: number, last: number, colX: (c: number) => number, n: number): void {
    const ctx = this.ctx;
    const boxTop = top + 3;
    const boxBottom = top + ROW_H - 3;
    let c = Math.max(0, first);
    while (c <= last && c < n) {
      const v = sig.values[c] ?? 0n;
      let end = c;
      while (end + 1 <= last && end + 1 < n && (sig.values[end + 1] ?? 0n) === v) end++;
      const leftEdge = c > 0;
      const rightEdge = end < n - 1;
      const x0 = colX(c);
      const x1 = colX(end + 1);
      const notch = Math.min(6, (x1 - x0) / 2);
      ctx.beginPath();
      if (leftEdge) { ctx.moveTo(x0 + notch, boxTop); ctx.lineTo(x0, (boxTop + boxBottom) / 2); ctx.lineTo(x0 + notch, boxBottom); }
      else { ctx.moveTo(x0, boxTop); ctx.lineTo(x0, boxBottom); }
      if (rightEdge) { ctx.lineTo(x1 - notch, boxBottom); ctx.lineTo(x1, (boxTop + boxBottom) / 2); ctx.lineTo(x1 - notch, boxTop); }
      else { ctx.lineTo(x1, boxBottom); ctx.lineTo(x1, boxTop); }
      ctx.closePath();
      ctx.fillStyle = this.theme.bg;
      ctx.fill();
      ctx.strokeStyle = this.theme.line;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.fillStyle = this.theme.text;
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      this.centerText(fmtValue(v, sig.width, sig.radix, sig.labels), (x0 + x1) / 2, (boxTop + boxBottom) / 2, x1 - x0 - 2 * notch - 4);
      c = end + 1;
    }
  }
}
