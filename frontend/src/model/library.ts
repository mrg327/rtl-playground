// Parametric block library. Each definition declares its parameters, ports, symbol and semantics.
import type { Design, Dir, Side } from './types';
import { mask, trunc, bit, signed, toBig, parseList } from './values';

// The `instance` block below is the one block whose ports depend on another module, not just its own
// params (DESIGN.md section 1: "a module is a sheet, a module instance is a block"). `BlockDef.ports()` only
// ever receives the block's own `params`, and threading a `Design` through geometry.ts/netlist.ts's whole
// call surface (used for every block on a sheet, not just instances) would be a much bigger change than this
// task's scope allows, so the app (ui/store.ts) and any script that builds a `Design` directly (gen-examples,
// hdl/emit.ts's `planModule`, sim/tests.ts) point this at the design currently being worked on before touching
// netlist/geometry for a module that might contain an `instance` block. Unset (or a missing target module)
// degrades gracefully to zero ports, never a crash.
let ACTIVE_DESIGN: Design | null = null;
export const setActiveDesign = (d: Design | null): void => { ACTIVE_DESIGN = d; };
export const getActiveDesign = (): Design | null => ACTIVE_DESIGN;

export interface ParamDef {
  key: string;
  label: string;
  kind: 'int' | 'bool' | 'enum' | 'text' | 'value' | 'list';
  default: unknown;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  /** For 'value' and 'list': the key of the width parameter (or a fixed width). */
  widthOf?: string | number;
  help?: string;
}

export interface PortDef {
  name: string;
  dir: Dir;
  width: number;
  side: Side;
  /** Position along the side as a fraction 0..1. */
  at: number;
  label?: string;
}

export interface Shape { w: number; h: number }
export type Params = Record<string, unknown>;

export interface BlockDef {
  type: string;
  name: string;
  group: string;
  /** Short prefix used for default ids/names. */
  short: string;
  /** comb: outputs depend on inputs only. seq: outputs depend on state only. mixed: both. alias: net label. */
  kind: 'comb' | 'seq' | 'mixed' | 'alias';
  params: ParamDef[];
  ports(p: Params): PortDef[];
  size(p: Params): Shape;
  body(p: Params, s: Shape): string;
  /** Text drawn inside the body (value, symbol). */
  inner?(p: Params, s: Shape, state: unknown, ins: bigint[], outs: bigint[]): string;
  /** For a 'mixed' block only: which input port names actually feed eval()'s output this cycle (e.g. a
   * memory's read address). Ports left out (e.g. write data/address, which only ever affect next()'s state)
   * get no dependency-ordering edge, the same as any input on a 'seq' block — see src/sim/engine.ts compile().
   * Omit for "every input" (the default for every other comb/mixed block). */
  depPorts?(p: Params): string[];
  eval(ins: bigint[], p: Params, state: unknown): bigint[];
  init?(p: Params): unknown;
  /** State after a rising clock edge. `rst` is the global synchronous reset. */
  next?(ins: bigint[], p: Params, state: unknown, rst: boolean): unknown;
  help?: string;
  /** Traced in the waveform by default. */
  trace?: boolean;
  /** Which output is shown in the waveform / which input for sinks. */
  traceKey?: string;
}

const P = {
  width: (def = 8, label = 'Width'): ParamDef => ({ key: 'width', label, kind: 'int', default: def, min: 1, max: 64 }),
  n: (def = 2, min = 2, max = 8, label = 'Inputs'): ParamDef => ({ key: 'n', label, kind: 'int', default: def, min, max }),
};
export const num = (p: Params, k: string, d = 1): number => { const v = p[k]; const n = typeof v === 'number' ? v : parseInt(String(v ?? d), 10); return Number.isFinite(n) ? n : d; };
export const bool = (p: Params, k: string): boolean => p[k] === true || p[k] === 'true' || p[k] === 1;
export const str = (p: Params, k: string, d = ''): string => (p[k] === undefined || p[k] === null ? d : String(p[k]));
export const log2 = (n: number): number => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));

const rect = (s: Shape, rx = 2) => `<rect class="body" x="0" y="0" width="${s.w}" height="${s.h}" rx="${rx}"/>`;
const pill = (s: Shape) => `<rect class="body" x="0" y="0" width="${s.w}" height="${s.h}" rx="${s.h / 2}"/>`;
const flagIn = (s: Shape) => `<path class="body" d="M0,0 H${s.w - 10} L${s.w},${s.h / 2} L${s.w - 10},${s.h} H0 z"/>`;
const flagOut = (s: Shape) => `<path class="body" d="M10,0 H${s.w} V${s.h} H10 L0,${s.h / 2} z"/>`;
const sym = (t: string, s: Shape, size = 20, dy = 0) => `<text class="sym" style="font-size:${size}px" x="${s.w / 2}" y="${s.h / 2 + size * 0.36 + dy}" text-anchor="middle">${t}</text>`;
const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const val = (t: string, s: Shape, dy = 0, cls = 'v') => `<text class="${cls}" x="${s.w / 2}" y="${s.h / 2 + 4 + dy}" text-anchor="middle">${esc(t)}</text>`;

/** Evenly spaced inputs on the left. */
const leftPorts = (names: string[], width: number, labels?: string[]): PortDef[] =>
  names.map((name, i) => ({ name, dir: 'in', width, side: 'l', at: (i + 1) / (names.length + 1), label: labels?.[i] }));
const gateH = (n: number) => Math.max(44, 16 * n + 12);

function gate(type: string, name: string, op: (a: bigint, b: bigint) => bigint, invert: boolean, body: (s: Shape) => string, identity: bigint): BlockDef {
  return {
    type, name, group: 'Gates', short: type, kind: 'comb',
    params: [P.n(2), P.width(1)],
    ports: p => [...leftPorts(Array.from({ length: num(p, 'n', 2) }, (_, i) => `i${i}`), num(p, 'width', 1)), { name: 'y', dir: 'out', width: num(p, 'width', 1), side: 'r', at: 0.5 }],
    size: p => ({ w: 56, h: gateH(num(p, 'n', 2)) }),
    body: (_p, s) => body(s) + (invert ? `<circle class="body" cx="${s.w + 5}" cy="${s.h / 2}" r="5"/>` : ''),
    eval: (ins, p) => { const w = num(p, 'width', 1); let r = ins.length ? ins[0] : identity; for (let i = 1; i < ins.length; i++) r = op(r, ins[i]); if (invert) r = ~r; return [trunc(r, w)]; },
  };
}
const andBody = (s: Shape) => `<path class="body" d="M0,0 H${s.w - s.h / 2} A${s.h / 2},${s.h / 2} 0 0 1 ${s.w - s.h / 2},${s.h} H0 z"/>`;
const orBody = (s: Shape) => `<path class="body" d="M0,0 Q${s.w * 0.25},${s.h / 2} 0,${s.h} Q${s.w * 0.55},${s.h} ${s.w},${s.h / 2} Q${s.w * 0.55},0 0,0 z"/>`;
const xorBody = (s: Shape) => `<path class="body" d="M6,0 Q${s.w * 0.3},${s.h / 2} 6,${s.h} Q${s.w * 0.58},${s.h} ${s.w},${s.h / 2} Q${s.w * 0.58},0 6,0 z"/><path class="body" fill="none" d="M0,0 Q${s.w * 0.22},${s.h / 2} 0,${s.h}"/>`;

const ioWidth = (p: Params) => num(p, 'width', 1);

export const LIB: Record<string, BlockDef> = {};
const def = (d: BlockDef) => { LIB[d.type] = d; };

// ---------- Signals ----------
def({
  type: 'in', name: 'Input', group: 'Signals', short: 'in', kind: 'seq', trace: true,
  params: [P.width(1), { key: 'value', label: 'Value', kind: 'value', default: 0, widthOf: 'width' }],
  ports: p => [{ name: 'y', dir: 'out', width: ioWidth(p), side: 'r', at: 0.5 }],
  size: () => ({ w: 64, h: 30 }),
  body: (_p, s) => flagIn(s),
  inner: (p, s, _st, _i, outs) => val(fmtShort(outs[0] ?? 0n, ioWidth(p)), { w: s.w - 6, h: s.h }),
  eval: (_i, p) => [toBig(p.value, ioWidth(p))],
  help: 'A primary input. Click a 1-bit input to toggle it; edit wider values in the inspector or by double-clicking.',
});
def({
  type: 'seq', name: 'Sequence', group: 'Signals', short: 'seq', kind: 'seq', trace: true,
  params: [P.width(1), { key: 'values', label: 'Values, one per cycle', kind: 'list', default: '0 1 1 0', widthOf: 'width' }, { key: 'repeat', label: 'Repeat when the sequence ends', kind: 'bool', default: false }],
  ports: p => [{ name: 'y', dir: 'out', width: ioWidth(p), side: 'r', at: 0.5 }],
  size: () => ({ w: 84, h: 40 }),
  body: (_p, s) => flagIn(s),
  inner: (p, s, st, _i, outs) => { const list = seqList(p); const idx = (st as SeqState)?.idx ?? 0; const n = list.length; const pos = n ? (bool(p, 'repeat') ? (idx % n) + 1 : Math.min(idx, n) + 1) : 0;
    return val(fmtShort(outs[0] ?? 0n, ioWidth(p)), { w: s.w - 8, h: s.h }, -5) + val(pos > n ? 'end' : `${pos}/${n}`, { w: s.w - 8, h: s.h }, 9, 's'); },
  init: () => ({ idx: 0 }),
  eval: (_i, p, st) => { const list = seqList(p); const idx = (st as SeqState)?.idx ?? 0; const n = list.length; if (!n) return [0n]; if (idx < n) return [list[idx]]; return [bool(p, 'repeat') ? list[idx % n] : 0n]; },
  next: (_i, _p, st, rst) => ({ idx: rst ? 0 : ((st as SeqState)?.idx ?? 0) + 1 }),
  help: 'Outputs one value per clock cycle. After the end it outputs 0 unless repeat is on. Reset restarts it.',
});
interface SeqState { idx: number }
const seqList = (p: Params): bigint[] => parseList(str(p, 'values'), ioWidth(p));
def({
  type: 'const', name: 'Constant', group: 'Signals', short: 'k', kind: 'comb',
  params: [P.width(8), { key: 'value', label: 'Value', kind: 'value', default: 0, widthOf: 'width' }],
  ports: p => [{ name: 'y', dir: 'out', width: ioWidth(p), side: 'r', at: 0.5 }],
  size: () => ({ w: 70, h: 28 }),
  body: (_p, s) => pill(s),
  inner: (p, s, _st, _i, outs) => val(`${ioWidth(p)}'d${outs[0] ?? 0n}`, s),
  eval: (_i, p) => [toBig(p.value, ioWidth(p))],
});
def({
  type: 'out', name: 'Output', group: 'Signals', short: 'out', kind: 'comb', trace: true, traceKey: 'a',
  params: [P.width(1)],
  ports: p => [{ name: 'a', dir: 'in', width: ioWidth(p), side: 'l', at: 0.5 }],
  size: () => ({ w: 64, h: 30 }),
  body: (_p, s) => flagOut(s),
  inner: (p, s, _st, ins) => val(fmtShort(ins[0] ?? 0n, ioWidth(p)), { w: s.w + 8, h: s.h }),
  eval: () => [],
});
def({
  type: 'rst', name: 'Reset (global)', group: 'Signals', short: 'rst', kind: 'seq',
  params: [],
  ports: () => [{ name: 'y', dir: 'out', width: 1, side: 'r', at: 0.5 }],
  size: () => ({ w: 64, h: 30 }),
  body: (_p, s) => flagIn(s),
  inner: (_p, s) => val('rst', { w: s.w - 6, h: s.h }),
  eval: (_i, _p, st) => [(st as { on: boolean })?.on ? 1n : 0n],
  init: () => ({ on: false }),
  help: 'The global synchronous reset, as a signal you can use in logic. Assert it with the Reset button in the toolbar.',
});
def({
  type: 'label', name: 'Net label', group: 'Signals', short: 'n', kind: 'alias',
  params: [{ key: 'name', label: 'Net name', kind: 'text', default: 'net' }, P.width(1)],
  ports: p => [{ name: 'i', dir: 'in', width: ioWidth(p), side: 'l', at: 0.5 }, { name: 'o', dir: 'out', width: ioWidth(p), side: 'r', at: 0.5 }],
  size: p => ({ w: Math.max(50, 8 + 7.5 * str(p, 'name', 'net').length), h: 22 }),
  body: (_p, s) => `<path class="body label" d="M0,0 H${s.w - 6} L${s.w},${s.h / 2} L${s.w - 6},${s.h} H0 z"/>`,
  inner: (p, s) => val(str(p, 'name', 'net'), { w: s.w - 4, h: s.h }, 0, 'lbl'),
  eval: ins => [ins[0] ?? 0n],
  help: 'All labels with the same name on a sheet are the same net. Drive it once, read it anywhere.',
});

// ---------- Gates ----------
def(gate('and', 'AND', (a, b) => a & b, false, andBody, mask(64)));
def(gate('nand', 'NAND', (a, b) => a & b, true, andBody, mask(64)));
def(gate('or', 'OR', (a, b) => a | b, false, orBody, 0n));
def(gate('nor', 'NOR', (a, b) => a | b, true, orBody, 0n));
def(gate('xor', 'XOR', (a, b) => a ^ b, false, xorBody, 0n));
def(gate('xnor', 'XNOR', (a, b) => a ^ b, true, xorBody, 0n));
def({
  type: 'not', name: 'NOT', group: 'Gates', short: 'not', kind: 'comb',
  params: [P.width(1)],
  ports: p => [{ name: 'a', dir: 'in', width: ioWidth(p), side: 'l', at: 0.5 }, { name: 'y', dir: 'out', width: ioWidth(p), side: 'r', at: 0.5 }],
  size: () => ({ w: 44, h: 36 }),
  body: (_p, s) => `<path class="body" d="M0,0 L${s.w - 10},${s.h / 2} L0,${s.h} z"/><circle class="body" cx="${s.w - 5}" cy="${s.h / 2}" r="5"/>`,
  eval: (ins, p) => [trunc(~ins[0], ioWidth(p))],
});
def({
  type: 'buf', name: 'Buffer', group: 'Gates', short: 'buf', kind: 'comb',
  params: [P.width(1)],
  ports: p => [{ name: 'a', dir: 'in', width: ioWidth(p), side: 'l', at: 0.5 }, { name: 'y', dir: 'out', width: ioWidth(p), side: 'r', at: 0.5 }],
  size: () => ({ w: 40, h: 36 }),
  body: (_p, s) => `<path class="body" d="M0,0 L${s.w},${s.h / 2} L0,${s.h} z"/>`,
  eval: ins => [ins[0]],
});

// ---------- Wiring ----------
const widthsOf = (p: Params, key: string, d: string): number[] => str(p, key, d).split(/[\s,;]+/).filter(Boolean).map(x => Math.max(1, Math.min(64, parseInt(x, 10) || 1)));
const ranges = (ws: number[]): string[] => { let lo = 0; return ws.map(w => { const r = w === 1 ? `[${lo}]` : `[${lo + w - 1}:${lo}]`; lo += w; return r; }); };
def({
  type: 'split', name: 'Split bus', group: 'Wiring', short: 'sp', kind: 'comb',
  params: [{ key: 'widths', label: 'Slice widths, LSB first', kind: 'text', default: '4 4', help: 'Example: "1 1 6" makes bit 0, bit 1 and bits 7:2.' }],
  ports: p => { const ws = widthsOf(p, 'widths', '4 4'); const total = ws.reduce((a, b) => a + b, 0); const r = ranges(ws);
    return [{ name: 'i', dir: 'in', width: total, side: 'l', at: 0.5 }, ...ws.map((w, k) => ({ name: `o${k}`, dir: 'out' as Dir, width: w, side: 'r' as Side, at: (k + 1) / (ws.length + 1), label: r[k] }))]; },
  size: p => ({ w: 40, h: Math.max(40, 18 * widthsOf(p, 'widths', '4 4').length + 10) }),
  body: (_p, s) => `<path class="body thick" d="M${s.w / 2},0 V${s.h}"/><path class="lead" d="M0,${s.h / 2} H${s.w / 2}"/>`,
  eval: (ins, p) => { const ws = widthsOf(p, 'widths', '4 4'); let lo = 0; return ws.map(w => { const v = trunc(ins[0] >> BigInt(lo), w); lo += w; return v; }); },
});
def({
  type: 'join', name: 'Join bus', group: 'Wiring', short: 'jn', kind: 'comb',
  params: [{ key: 'widths', label: 'Part widths, LSB first', kind: 'text', default: '4 4' }],
  ports: p => { const ws = widthsOf(p, 'widths', '4 4'); const total = ws.reduce((a, b) => a + b, 0); const r = ranges(ws);
    return [...ws.map((w, k) => ({ name: `i${k}`, dir: 'in' as Dir, width: w, side: 'l' as Side, at: (k + 1) / (ws.length + 1), label: r[k] })), { name: 'o', dir: 'out', width: total, side: 'r', at: 0.5 }]; },
  size: p => ({ w: 40, h: Math.max(40, 18 * widthsOf(p, 'widths', '4 4').length + 10) }),
  body: (_p, s) => `<path class="body thick" d="M${s.w / 2},0 V${s.h}"/><path class="lead" d="M${s.w / 2},${s.h / 2} H${s.w}"/>`,
  eval: (ins, p) => { const ws = widthsOf(p, 'widths', '4 4'); let v = 0n, lo = 0; ws.forEach((w, k) => { v |= trunc(ins[k] ?? 0n, w) << BigInt(lo); lo += w; }); return [v]; },
});
def({
  type: 'ext', name: 'Extend', group: 'Wiring', short: 'ext', kind: 'comb',
  params: [{ key: 'inw', label: 'Input width', kind: 'int', default: 1, min: 1, max: 64 }, { key: 'outw', label: 'Output width', kind: 'int', default: 8, min: 1, max: 64 }, { key: 'signed', label: 'Sign-extend', kind: 'bool', default: false }],
  ports: p => [{ name: 'a', dir: 'in', width: num(p, 'inw', 1), side: 'l', at: 0.5 }, { name: 'y', dir: 'out', width: num(p, 'outw', 8), side: 'r', at: 0.5 }],
  size: () => ({ w: 60, h: 36 }),
  body: (_p, s) => rect(s),
  inner: (p, s) => sym(bool(p, 'signed') ? 'sext' : 'zext', s, 13),
  eval: (ins, p) => { const iw = num(p, 'inw', 1), ow = num(p, 'outw', 8); const v = trunc(ins[0], iw); return [bool(p, 'signed') ? trunc(signed(v, iw), ow) : trunc(v, ow)]; },
});
def({
  type: 'slice', name: 'Bit slice', group: 'Wiring', short: 'sl', kind: 'comb',
  params: [P.width(8, 'Input width'), { key: 'hi', label: 'High bit', kind: 'int', default: 7, min: 0, max: 63 }, { key: 'lo', label: 'Low bit', kind: 'int', default: 0, min: 0, max: 63 }],
  ports: p => { const hi = num(p, 'hi', 7), lo = num(p, 'lo', 0); return [{ name: 'a', dir: 'in', width: ioWidth(p), side: 'l', at: 0.5 }, { name: 'y', dir: 'out', width: Math.max(1, hi - lo + 1), side: 'r', at: 0.5 }]; },
  size: () => ({ w: 60, h: 32 }),
  body: (_p, s) => rect(s),
  inner: (p, s) => sym(num(p, 'hi', 7) === num(p, 'lo', 0) ? `[${num(p, 'lo', 0)}]` : `[${num(p, 'hi', 7)}:${num(p, 'lo', 0)}]`, s, 12),
  eval: (ins, p) => { const hi = num(p, 'hi', 7), lo = num(p, 'lo', 0); return [trunc(ins[0] >> BigInt(lo), Math.max(1, hi - lo + 1))]; },
});

// ---------- Combinational ----------
const ab = (p: Params, wOut = ioWidth(p)): PortDef[] => [{ name: 'a', dir: 'in', width: ioWidth(p), side: 'l', at: 0.3 }, { name: 'b', dir: 'in', width: ioWidth(p), side: 'l', at: 0.7 }, { name: 'y', dir: 'out', width: wOut, side: 'r', at: 0.5 }];
def({
  type: 'add', name: 'Adder', group: 'Arithmetic', short: 'add', kind: 'comb',
  params: [P.width(8), { key: 'cin', label: 'Carry-in port', kind: 'bool', default: false }, { key: 'cout', label: 'Carry-out port', kind: 'bool', default: true }],
  ports: p => { const w = ioWidth(p); const ps: PortDef[] = [{ name: 'a', dir: 'in', width: w, side: 'l', at: 0.3 }, { name: 'b', dir: 'in', width: w, side: 'l', at: 0.7 }];
    if (bool(p, 'cin')) ps.push({ name: 'ci', dir: 'in', width: 1, side: 'b', at: 0.5 });
    ps.push({ name: 's', dir: 'out', width: w, side: 'r', at: bool(p, 'cout') ? 0.35 : 0.5 }); if (bool(p, 'cout')) ps.push({ name: 'co', dir: 'out', width: 1, side: 'r', at: 0.72 }); return ps; },
  size: () => ({ w: 60, h: 64 }),
  body: (_p, s) => rect(s),
  inner: (_p, s) => sym('+', s, 24),
  eval: (ins, p) => { const w = ioWidth(p); const ci = bool(p, 'cin') ? (ins[2] & 1n) : 0n; const r = ins[0] + ins[1] + ci; const out = [trunc(r, w)]; if (bool(p, 'cout')) out.push(bit(r, w)); return out; },
  help: 'S = (A + B) mod 2^width. Co is the carry out of the top bit.',
});
def({
  type: 'sub', name: 'Subtractor', group: 'Arithmetic', short: 'sub', kind: 'comb',
  params: [P.width(8)],
  ports: p => { const w = ioWidth(p); return [{ name: 'a', dir: 'in', width: w, side: 'l', at: 0.3 }, { name: 'b', dir: 'in', width: w, side: 'l', at: 0.7 }, { name: 'd', dir: 'out', width: w, side: 'r', at: 0.35 }, { name: 'bo', dir: 'out', width: 1, side: 'r', at: 0.72 }]; },
  size: () => ({ w: 60, h: 64 }),
  body: (_p, s) => rect(s),
  inner: (_p, s) => sym('−', s, 24),
  eval: (ins, p) => { const w = ioWidth(p); const r = ins[0] - ins[1]; return [trunc(r, w), r < 0n ? 1n : 0n]; },
  help: 'D = (A − B) mod 2^width. Bo is 1 when A < B (borrow).',
});
def({
  type: 'mul', name: 'Multiplier', group: 'Arithmetic', short: 'mul', kind: 'comb',
  params: [P.width(8), { key: 'signed', label: 'Signed', kind: 'bool', default: false }],
  ports: p => ab(p, ioWidth(p) * 2),
  size: () => ({ w: 60, h: 64 }),
  body: (_p, s) => rect(s),
  inner: (_p, s) => sym('×', s, 24),
  eval: (ins, p) => { const w = ioWidth(p); const a = bool(p, 'signed') ? signed(ins[0], w) : ins[0], b = bool(p, 'signed') ? signed(ins[1], w) : ins[1]; return [trunc(a * b, 2 * w)]; },
});
const CMP_OPS = [['eq', '='], ['ne', '≠'], ['lt', '<'], ['le', '≤'], ['gt', '>'], ['ge', '≥']];
def({
  type: 'cmp', name: 'Comparator', group: 'Arithmetic', short: 'cmp', kind: 'comb',
  params: [P.width(8), { key: 'op', label: 'Operation', kind: 'enum', default: 'eq', options: CMP_OPS.map(([v, l]) => ({ value: v, label: `A ${l} B` })) }, { key: 'signed', label: 'Signed', kind: 'bool', default: false }],
  ports: p => ab(p, 1),
  size: () => ({ w: 56, h: 52 }),
  body: (_p, s) => rect(s),
  inner: (p, s) => sym(CMP_OPS.find(o => o[0] === str(p, 'op', 'eq'))?.[1] ?? '=', s, 22),
  eval: (ins, p) => { const w = ioWidth(p); const sg = bool(p, 'signed'); const a = sg ? signed(ins[0], w) : ins[0], b = sg ? signed(ins[1], w) : ins[1];
    const r = ({ eq: a === b, ne: a !== b, lt: a < b, le: a <= b, gt: a > b, ge: a >= b } as Record<string, boolean>)[str(p, 'op', 'eq')]; return [r ? 1n : 0n]; },
});
def({
  type: 'mux', name: 'Mux', group: 'Arithmetic', short: 'mux', kind: 'comb',
  params: [P.n(2, 2, 16), P.width(8)],
  ports: p => { const n = num(p, 'n', 2), w = ioWidth(p); return [...Array.from({ length: n }, (_, i) => ({ name: `i${i}`, dir: 'in' as Dir, width: w, side: 'l' as Side, at: (i + 1) / (n + 1), label: String(i) })), { name: 's', dir: 'in', width: log2(n), side: 'b', at: 0.5, label: 'S' }, { name: 'y', dir: 'out', width: w, side: 'r', at: 0.5 }]; },
  size: p => ({ w: 44, h: Math.max(60, 18 * num(p, 'n', 2) + 24) }),
  body: (_p, s) => `<path class="body" d="M0,0 L${s.w},14 L${s.w},${s.h - 14} L0,${s.h} z"/>`,
  eval: (ins, p) => { const n = num(p, 'n', 2); const sel = Number(ins[n] ?? 0n); return [sel < n ? ins[sel] : 0n]; },
  help: 'Output is input S. Selecting a non-existent input yields 0.',
});
const ALU_OPS = [['add', 'A + B'], ['sub', 'A − B'], ['and', 'A & B'], ['or', 'A | B'], ['xor', 'A ^ B'], ['slt', 'A < B (signed)'], ['sll', 'A << B'], ['srl', 'A >> B']];
def({
  type: 'alu', name: 'ALU', group: 'Arithmetic', short: 'alu', kind: 'comb',
  params: [P.width(8)],
  ports: p => { const w = ioWidth(p); return [{ name: 'a', dir: 'in', width: w, side: 'l', at: 0.28 }, { name: 'b', dir: 'in', width: w, side: 'l', at: 0.72 }, { name: 'op', dir: 'in', width: 3, side: 'b', at: 0.5, label: 'op' }, { name: 'y', dir: 'out', width: w, side: 'r', at: 0.4 }, { name: 'z', dir: 'out', width: 1, side: 'r', at: 0.75, label: 'zero' }]; },
  size: () => ({ w: 64, h: 80 }),
  body: (_p, s) => `<path class="body" d="M0,0 L${s.w},16 L${s.w},${s.h - 16} L0,${s.h} L0,${s.h / 2 + 10} L12,${s.h / 2} L0,${s.h / 2 - 10} z"/>`,
  inner: (_p, s) => sym('ALU', s, 13),
  eval: (ins, p) => { const w = ioWidth(p); const [a, b] = ins; const op = Number(ins[2] ?? 0n); let r: bigint;
    switch (ALU_OPS[op]?.[0]) { case 'sub': r = a - b; break; case 'and': r = a & b; break; case 'or': r = a | b; break; case 'xor': r = a ^ b; break; case 'slt': r = signed(a, w) < signed(b, w) ? 1n : 0n; break; case 'sll': r = a << (b & 63n); break; case 'srl': r = a >> (b & 63n); break; default: r = a + b; }
    r = trunc(r, w); return [r, r === 0n ? 1n : 0n]; },
  help: 'op: 0 add, 1 sub, 2 and, 3 or, 4 xor, 5 slt, 6 sll, 7 srl. zero = 1 when the result is 0.',
});
def({
  type: 'dec', name: 'Decoder', group: 'Arithmetic', short: 'dec', kind: 'comb',
  params: [{ key: 'bits', label: 'Select bits', kind: 'int', default: 2, min: 1, max: 4 }, { key: 'en', label: 'Enable port', kind: 'bool', default: false }],
  ports: p => { const b = num(p, 'bits', 2), n = 1 << b; const ps: PortDef[] = [{ name: 'a', dir: 'in', width: b, side: 'l', at: 0.5 }]; if (bool(p, 'en')) ps.push({ name: 'en', dir: 'in', width: 1, side: 'b', at: 0.5, label: 'en' });
    for (let i = 0; i < n; i++) ps.push({ name: `y${i}`, dir: 'out', width: 1, side: 'r', at: (i + 1) / (n + 1), label: String(i) }); return ps; },
  size: p => ({ w: 56, h: Math.max(48, 16 * (1 << num(p, 'bits', 2)) + 12) }),
  body: (_p, s) => rect(s),
  inner: (_p, s) => sym('dec', s, 13),
  eval: (ins, p) => { const b = num(p, 'bits', 2), n = 1 << b; const en = bool(p, 'en') ? (ins[1] & 1n) : 1n; const a = Number(ins[0]); return Array.from({ length: n }, (_, i) => (en && i === a ? 1n : 0n)); },
});
def({
  type: 'enc', name: 'Priority encoder', group: 'Arithmetic', short: 'enc', kind: 'comb',
  params: [{ key: 'bits', label: 'Output bits', kind: 'int', default: 2, min: 1, max: 4 }],
  ports: p => { const b = num(p, 'bits', 2), n = 1 << b; return [{ name: 'a', dir: 'in', width: n, side: 'l', at: 0.5 }, { name: 'y', dir: 'out', width: b, side: 'r', at: 0.35 }, { name: 'v', dir: 'out', width: 1, side: 'r', at: 0.7, label: 'valid' }]; },
  size: () => ({ w: 56, h: 52 }),
  body: (_p, s) => rect(s),
  inner: (_p, s) => sym('enc', s, 13),
  eval: (ins, p) => { const b = num(p, 'bits', 2), n = 1 << b; for (let i = n - 1; i >= 0; i--) if (bit(ins[0], i)) return [BigInt(i), 1n]; return [0n, 0n]; },
  help: 'Outputs the index of the highest set input bit, and valid = 1 if any bit is set.',
});
def({
  type: 'shift', name: 'Shifter', group: 'Arithmetic', short: 'sh', kind: 'comb',
  params: [P.width(8), { key: 'dir', label: 'Direction', kind: 'enum', default: 'left', options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right (logical)' }, { value: 'sra', label: 'Right (arithmetic)' }] }, { key: 'by', label: 'Fixed amount (blank = port)', kind: 'text', default: '1' }],
  ports: p => { const w = ioWidth(p); const ps: PortDef[] = [{ name: 'a', dir: 'in', width: w, side: 'l', at: 0.5 }]; if (!str(p, 'by', '1').trim()) ps.push({ name: 'n', dir: 'in', width: log2(w + 1), side: 'b', at: 0.5, label: 'n' }); ps.push({ name: 'y', dir: 'out', width: w, side: 'r', at: 0.5 }); return ps; },
  size: () => ({ w: 56, h: 40 }),
  body: (_p, s) => rect(s),
  inner: (p, s) => sym((str(p, 'dir', 'left') === 'left' ? '<<' : '>>') + (str(p, 'by', '1').trim() || 'n'), s, 14),
  eval: (ins, p) => { const w = ioWidth(p); const fixed = str(p, 'by', '1').trim(); const n = fixed ? BigInt(parseInt(fixed, 10) || 0) : (ins[1] ?? 0n); const d = str(p, 'dir', 'left');
    if (d === 'left') return [trunc(ins[0] << n, w)]; if (d === 'sra') return [trunc(signed(ins[0], w) >> n, w)]; return [ins[0] >> n]; },
});
def({
  type: 'reduce', name: 'Reduce', group: 'Arithmetic', short: 'red', kind: 'comb',
  params: [P.width(8), { key: 'op', label: 'Operation', kind: 'enum', default: 'or', options: [{ value: 'and', label: 'AND all bits' }, { value: 'or', label: 'OR all bits' }, { value: 'xor', label: 'XOR all bits (parity)' }] }],
  ports: p => [{ name: 'a', dir: 'in', width: ioWidth(p), side: 'l', at: 0.5 }, { name: 'y', dir: 'out', width: 1, side: 'r', at: 0.5 }],
  size: () => ({ w: 52, h: 36 }),
  body: (_p, s) => rect(s),
  inner: (p, s) => sym(({ and: '&', or: '|', xor: '^' } as Record<string, string>)[str(p, 'op', 'or')], s, 18),
  eval: (ins, p) => { const w = ioWidth(p); const v = trunc(ins[0], w); const op = str(p, 'op', 'or'); if (op === 'and') return [v === mask(w) ? 1n : 0n]; if (op === 'or') return [v ? 1n : 0n]; let x = 0n; for (let i = 0; i < w; i++) x ^= bit(v, i); return [x]; },
});

// ---------- Sequential ----------
interface RegState { q: bigint }
const clkMark = (s: Shape) => `<path class="clkmark" d="M0,${s.h - 16} l7 5 l-7 5"/>`;
def({
  type: 'reg', name: 'Register', group: 'Sequential', short: 'r', kind: 'seq', trace: true,
  params: [P.width(1), { key: 'en', label: 'Enable port', kind: 'bool', default: false }, { key: 'rst', label: 'Reset', kind: 'enum', default: 'sync', options: [{ value: 'sync', label: 'Synchronous (global rst)' }, { value: 'none', label: 'None' }] }, { key: 'init', label: 'Reset value', kind: 'value', default: 0, widthOf: 'width' }],
  ports: p => { const w = ioWidth(p); const ps: PortDef[] = [{ name: 'd', dir: 'in', width: w, side: 'l', at: 0.3, label: 'D' }]; if (bool(p, 'en')) ps.push({ name: 'en', dir: 'in', width: 1, side: 'l', at: 0.62, label: 'en' }); ps.push({ name: 'q', dir: 'out', width: w, side: 'r', at: 0.3, label: 'Q' }); return ps; },
  size: () => ({ w: 64, h: 60 }),
  body: (_p, s) => rect(s) + clkMark(s),
  inner: (p, s, st) => val(fmtShort((st as RegState)?.q ?? 0n, ioWidth(p)), s, 8),
  init: p => ({ q: toBig(p.init, ioWidth(p)) }),
  eval: (_i, p, st) => [trunc((st as RegState)?.q ?? 0n, ioWidth(p))],
  next: (ins, p, st, rst) => { const w = ioWidth(p); if (rst && str(p, 'rst', 'sync') !== 'none') return { q: toBig(p.init, w) }; const en = bool(p, 'en') ? (ins[1] & 1n) === 1n : true; return { q: en ? trunc(ins[0], w) : ((st as RegState)?.q ?? 0n) }; },
  help: 'Q takes D on the rising clock edge (when en = 1, if it has an enable). Width 1 is a D flip-flop.',
});
def({
  type: 'counter', name: 'Counter', group: 'Sequential', short: 'cnt', kind: 'seq', trace: true,
  params: [P.width(4), { key: 'en', label: 'Enable port', kind: 'bool', default: true }, { key: 'load', label: 'Load port', kind: 'bool', default: false }, { key: 'down', label: 'Count down', kind: 'bool', default: false }, { key: 'init', label: 'Reset value', kind: 'value', default: 0, widthOf: 'width' }],
  ports: p => { const w = ioWidth(p); const ps: PortDef[] = []; if (bool(p, 'en')) ps.push({ name: 'en', dir: 'in', width: 1, side: 'l', at: 0.3, label: 'en' }); if (bool(p, 'load')) { ps.push({ name: 'ld', dir: 'in', width: 1, side: 'l', at: 0.55, label: 'ld' }); ps.push({ name: 'd', dir: 'in', width: w, side: 'l', at: 0.8, label: 'D' }); }
    ps.push({ name: 'q', dir: 'out', width: w, side: 'r', at: 0.3, label: 'Q' }); ps.push({ name: 'co', dir: 'out', width: 1, side: 'r', at: 0.7, label: 'wrap' }); return ps; },
  size: () => ({ w: 70, h: 64 }),
  body: (_p, s) => rect(s) + clkMark(s),
  inner: (p, s, st) => val(fmtShort((st as RegState)?.q ?? 0n, ioWidth(p)), s, 8),
  init: p => ({ q: toBig(p.init, ioWidth(p)) }),
  eval: (ins, p, st) => { const w = ioWidth(p); const q = (st as RegState)?.q ?? 0n; const en = bool(p, 'en') ? (ins[0] & 1n) === 1n : true; const wrap = en && (bool(p, 'down') ? q === 0n : q === mask(w)); return [trunc(q, w), wrap ? 1n : 0n]; },
  next: (ins, p, st, rst) => { const w = ioWidth(p); if (rst) return { q: toBig(p.init, w) }; let i = 0; const en = bool(p, 'en') ? (ins[i++] & 1n) === 1n : true; const q = (st as RegState)?.q ?? 0n;
    if (bool(p, 'load')) { const ld = (ins[i++] & 1n) === 1n; const d = ins[i++]; if (ld) return { q: trunc(d, w) }; } if (!en) return { q }; return { q: trunc(bool(p, 'down') ? q - 1n : q + 1n, w) }; },
  help: 'Counts on every enabled clock edge and wraps. Load has priority over counting. wrap = 1 in the cycle before it wraps.',
});
def({
  type: 'shreg', name: 'Shift register', group: 'Sequential', short: 'sr', kind: 'seq', trace: true,
  params: [{ key: 'len', label: 'Stages', kind: 'int', default: 4, min: 1, max: 64 }, { key: 'en', label: 'Enable port', kind: 'bool', default: false }],
  ports: p => { const n = num(p, 'len', 4); const ps: PortDef[] = [{ name: 'd', dir: 'in', width: 1, side: 'l', at: 0.3, label: 'in' }]; if (bool(p, 'en')) ps.push({ name: 'en', dir: 'in', width: 1, side: 'l', at: 0.62, label: 'en' }); ps.push({ name: 'q', dir: 'out', width: n, side: 'r', at: 0.3, label: 'Q' }, { name: 'so', dir: 'out', width: 1, side: 'r', at: 0.62, label: 'out' }); return ps; },
  size: () => ({ w: 72, h: 60 }),
  body: (_p, s) => rect(s) + clkMark(s),
  inner: (p, s, st) => val(((st as RegState)?.q ?? 0n).toString(2).padStart(num(p, 'len', 4), '0'), s, 8),
  init: () => ({ q: 0n }),
  eval: (_i, p, st) => { const n = num(p, 'len', 4); const q = trunc((st as RegState)?.q ?? 0n, n); return [q, bit(q, n - 1)]; },
  next: (ins, p, st, rst) => { const n = num(p, 'len', 4); if (rst) return { q: 0n }; const en = bool(p, 'en') ? (ins[1] & 1n) === 1n : true; const q = (st as RegState)?.q ?? 0n; return { q: en ? trunc((q << 1n) | (ins[0] & 1n), n) : q }; },
  help: 'Shifts in one bit per clock; bit 0 is the newest. out is the oldest bit.',
});

// ---------- Control ----------
// The target module's ports, derived from its `in`/`out` blocks (name from label or id, width from that
// block's own port). Kept in step with `src/model/hierarchy.ts`'s `moduleExternalPorts` (same rule, same
// order) without importing it: that module imports `defOf`/`normalizeParams` from this one, so importing it
// back here would be circular.
function instanceTargetPorts(p: Params): { name: string; dir: Dir; width: number }[] {
  const key = str(p, 'module', '');
  const target = key ? ACTIVE_DESIGN?.modules[key] : undefined;
  if (!target) return [];
  const out: { name: string; dir: Dir; width: number }[] = [];
  for (const b of target.blocks) {
    if (b.type === 'in') out.push({ name: b.label?.trim() || b.id, dir: 'in', width: defOf('in').ports(b.params).find(x => x.name === 'y')?.width ?? 1 });
    else if (b.type === 'out') out.push({ name: b.label?.trim() || b.id, dir: 'out', width: defOf('out').ports(b.params).find(x => x.name === 'a')?.width ?? 1 });
  }
  return out;
}
def({
  type: 'instance', name: 'Module instance', group: 'Control', short: 'u', kind: 'mixed',
  params: [{ key: 'module', label: 'Module', kind: 'enum', default: '', options: [] }],
  ports: p => {
    const ports = instanceTargetPorts(p); const ins = ports.filter(x => x.dir === 'in'), outs = ports.filter(x => x.dir === 'out');
    return [
      ...ins.map((x, i): PortDef => ({ name: x.name, dir: x.dir, width: x.width, side: 'l', at: (i + 1) / (ins.length + 1), label: x.name })),
      ...outs.map((x, i): PortDef => ({ name: x.name, dir: x.dir, width: x.width, side: 'r', at: (i + 1) / (outs.length + 1), label: x.name })),
    ];
  },
  size: p => { const ports = instanceTargetPorts(p); const n = Math.max(ports.filter(x => x.dir === 'in').length, ports.filter(x => x.dir === 'out').length, 1); return { w: 110, h: Math.max(50, 20 * n + 20) }; },
  body: (_p, s) => rect(s, 3) + `<rect class="inst-frame" x="4" y="4" width="${s.w - 8}" height="${s.h - 8}" rx="2" fill="none"/>`,
  inner: (p, s) => sym(str(p, 'module', '') || '?', s, 13),
  // Never actually called: sim/hierarchy.ts's flattenModule expands every instance into its target module's
  // own blocks before the design reaches the levelized simulator, so this block type is never evaluated.
  eval: () => [],
  help: "An instance of another module in this design (DESIGN.md section 1: a module is a sheet, a module instance is a block). Its pins mirror the target module's Input/Output blocks. Double-click to open the instantiated module.",
});
// ---------- Memory ----------
// Semantics mirror Yosys $mem_v2: a synchronous write port (write-enable gated), and either a combinational
// (async) or one-cycle-registered (sync) read. Both read and write are driven by the same rising edge, so a
// read of the address just written in the same cycle sees the OLD value (read-before-write) — the eval()/next()
// split below gives this for free: eval() always reads from the state carried over from the previous edge, and
// next() computes the post-write state for the frame that starts at the next edge. Reset does NOT clear memory
// contents (like a real SRAM); only a sync read's own registered output resets, because that output is a
// genuine flip-flop. State is `{ mem, rq, rq2 }`: `mem` is a copy-on-write bigint array — next() returns the
// SAME array reference when no write happens this cycle (the common case) and only allocates a new array (an
// O(depth) copy) on a cycle that actually writes, so the simulator's per-cycle frame history stays cheap even
// at max depth (4096) and max history (20000 frames) unless the design writes almost every cycle.
export interface MemState { mem: bigint[]; rq?: bigint; rq2?: bigint }
export function memDepth(p: Params, max = 4096): number { return Math.max(1, Math.min(max, num(p, 'depth', 256))); }
export function memAddrWidth(depth: number): number { return log2(depth); }
function memContents(p: Params, w: number, depth: number): bigint[] {
  const vals = parseList(str(p, 'contents', ''), w);
  const out = new Array<bigint>(depth).fill(0n);
  for (let i = 0; i < Math.min(vals.length, depth); i++) out[i] = vals[i];
  return out;
}
const memSym = (t: string, p: Params, s: Shape, depth: number): string => sym(t, s, 16, -10) + val(`${depth}×${ioWidth(p)}`, s, 14, 's');

def({
  type: 'ram', name: 'Sync RAM', group: 'Memory', short: 'ram', kind: 'mixed', trace: true, traceKey: 'q',
  params: [
    P.width(8),
    { key: 'depth', label: 'Depth (words)', kind: 'int', default: 256, min: 1, max: 4096 },
    { key: 'readStyle', label: 'Read', kind: 'enum', default: 'sync', options: [{ value: 'sync', label: 'Synchronous (registered)' }, { value: 'async', label: 'Asynchronous (combinational)' }] },
    { key: 'port2', label: 'Second read port', kind: 'bool', default: false },
    { key: 'contents', label: 'Initial contents, space-separated (blank = zero)', kind: 'list', default: '', widthOf: 'width', help: 'A list of values (e.g. "0 1 2 3" or "8\'hA5 8\'h00"), or use "Load .mem file…" below.' },
  ],
  ports: p => {
    const w = ioWidth(p), depth = memDepth(p), aw = memAddrWidth(depth), p2 = bool(p, 'port2');
    const ps: PortDef[] = [
      { name: 'd', dir: 'in', width: w, side: 'l', at: 0.15, label: 'D' },
      { name: 'waddr', dir: 'in', width: aw, side: 'l', at: 0.35, label: 'WA' },
      { name: 'we', dir: 'in', width: 1, side: 'l', at: 0.55, label: 'WE' },
      { name: 'raddr', dir: 'in', width: aw, side: 'l', at: p2 ? 0.72 : 0.8, label: 'RA' },
    ];
    if (p2) ps.push({ name: 'raddr2', dir: 'in', width: aw, side: 'l', at: 0.92, label: 'RA2' });
    ps.push({ name: 'q', dir: 'out', width: w, side: 'r', at: p2 ? 0.35 : 0.5, label: 'Q' });
    if (p2) ps.push({ name: 'q2', dir: 'out', width: w, side: 'r', at: 0.7, label: 'Q2' });
    return ps;
  },
  size: () => ({ w: 90, h: 110 }),
  body: (_p, s) => rect(s) + clkMark(s),
  depPorts: p => bool(p, 'port2') ? ['raddr', 'raddr2'] : ['raddr'],
  inner: (p, s) => memSym('RAM', p, s, memDepth(p)),
  init: p => { const w = ioWidth(p), depth = memDepth(p); return { mem: memContents(p, w, depth), rq: 0n, rq2: bool(p, 'port2') ? 0n : undefined }; },
  eval: (ins, p, st) => {
    const w = ioWidth(p), depth = memDepth(p), aw = memAddrWidth(depth);
    const s = (st as MemState) ?? { mem: memContents(p, w, depth) };
    const sync = str(p, 'readStyle', 'sync') === 'sync';
    const raddr = Number(ins[3] & mask(aw));
    const q = sync ? (s.rq ?? 0n) : (raddr < depth ? (s.mem[raddr] ?? 0n) : 0n);
    const outs = [trunc(q, w)];
    if (bool(p, 'port2')) { const raddr2 = Number(ins[4] & mask(aw)); const q2 = sync ? (s.rq2 ?? 0n) : (raddr2 < depth ? (s.mem[raddr2] ?? 0n) : 0n); outs.push(trunc(q2, w)); }
    return outs;
  },
  next: (ins, p, st, rst) => {
    const w = ioWidth(p), depth = memDepth(p), aw = memAddrWidth(depth);
    const s = (st as MemState) ?? { mem: memContents(p, w, depth) };
    let mem = s.mem;
    const d = ins[0], waddr = Number(ins[1] & mask(aw)), we = (ins[2] & 1n) === 1n;
    const raddr = Number(ins[3] & mask(aw));
    const sync = str(p, 'readStyle', 'sync') === 'sync';
    const rq = sync ? (rst ? 0n : (raddr < depth ? (mem[raddr] ?? 0n) : 0n)) : undefined;
    let rq2: bigint | undefined;
    if (bool(p, 'port2')) { const raddr2 = Number(ins[4] & mask(aw)); rq2 = sync ? (rst ? 0n : (raddr2 < depth ? (mem[raddr2] ?? 0n) : 0n)) : undefined; }
    if (we && waddr < depth) { const nm = mem.slice(); nm[waddr] = trunc(d, w); mem = nm; }
    return { mem, rq, rq2 };
  },
  help: 'Synchronous write, gated by WE. Read is combinational (async) or registered one cycle (sync); either way, writing and reading the same address in the same cycle reads the OLD value. Reset does not clear memory contents, like a real SRAM. Depth up to 4096, width up to 64.',
});
def({
  type: 'rom', name: 'ROM', group: 'Memory', short: 'rom', kind: 'mixed', trace: true, traceKey: 'q',
  params: [
    P.width(8),
    { key: 'depth', label: 'Depth (words)', kind: 'int', default: 256, min: 1, max: 4096 },
    { key: 'readStyle', label: 'Read', kind: 'enum', default: 'async', options: [{ value: 'async', label: 'Asynchronous (combinational)' }, { value: 'sync', label: 'Synchronous (registered)' }] },
    { key: 'contents', label: 'Contents, space-separated (blank = zero)', kind: 'list', default: '', widthOf: 'width', help: 'A list of values, or use "Load .mem file…" below.' },
  ],
  ports: p => { const w = ioWidth(p), depth = memDepth(p), aw = memAddrWidth(depth); return [{ name: 'raddr', dir: 'in', width: aw, side: 'l', at: 0.5, label: 'A' }, { name: 'q', dir: 'out', width: w, side: 'r', at: 0.5, label: 'Q' }]; },
  size: () => ({ w: 74, h: 60 }),
  body: (_p, s) => rect(s) + clkMark(s),
  depPorts: () => ['raddr'],
  inner: (p, s) => memSym('ROM', p, s, memDepth(p)),
  init: p => { const w = ioWidth(p), depth = memDepth(p); return { mem: memContents(p, w, depth), rq: 0n }; },
  eval: (ins, p, st) => {
    const w = ioWidth(p), depth = memDepth(p), aw = memAddrWidth(depth);
    const s = (st as MemState) ?? { mem: memContents(p, w, depth) };
    const sync = str(p, 'readStyle', 'async') === 'sync';
    const raddr = Number(ins[0] & mask(aw));
    const q = sync ? (s.rq ?? 0n) : (raddr < depth ? (s.mem[raddr] ?? 0n) : 0n);
    return [trunc(q, w)];
  },
  next: (ins, p, st, rst) => {
    const w = ioWidth(p), depth = memDepth(p), aw = memAddrWidth(depth);
    const s = (st as MemState) ?? { mem: memContents(p, w, depth) };
    const sync = str(p, 'readStyle', 'async') === 'sync';
    const raddr = Number(ins[0] & mask(aw));
    const rq = sync ? (rst ? 0n : (raddr < depth ? (s.mem[raddr] ?? 0n) : 0n)) : s.rq;
    return { mem: s.mem, rq };
  },
  help: 'Read-only; contents come only from the "Contents" parameter (or a loaded .mem file) and never change during simulation, including on reset. Registered (sync) read adds one cycle of latency; combinational (async) read is immediate.',
});
def({
  type: 'regfile', name: 'Register file', group: 'Memory', short: 'rf', kind: 'mixed', trace: true, traceKey: 'q1',
  params: [
    P.width(32),
    { key: 'depth', label: 'Registers', kind: 'int', default: 32, min: 2, max: 128 },
    { key: 'zeroReg', label: 'Register 0 hard-wired to zero', kind: 'bool', default: false },
    { key: 'contents', label: 'Initial contents, space-separated (blank = zero)', kind: 'list', default: '', widthOf: 'width' },
  ],
  ports: p => {
    const w = ioWidth(p), depth = memDepth(p, 128), aw = memAddrWidth(depth);
    return [
      { name: 'd', dir: 'in', width: w, side: 'l', at: 0.18, label: 'D' },
      { name: 'waddr', dir: 'in', width: aw, side: 'l', at: 0.38, label: 'WA' },
      { name: 'we', dir: 'in', width: 1, side: 'l', at: 0.58, label: 'WE' },
      { name: 'raddr1', dir: 'in', width: aw, side: 'l', at: 0.76, label: 'RA1' },
      { name: 'raddr2', dir: 'in', width: aw, side: 'l', at: 0.92, label: 'RA2' },
      { name: 'q1', dir: 'out', width: w, side: 'r', at: 0.35, label: 'Q1' },
      { name: 'q2', dir: 'out', width: w, side: 'r', at: 0.7, label: 'Q2' },
    ];
  },
  size: () => ({ w: 90, h: 110 }),
  body: (_p, s) => rect(s) + clkMark(s),
  depPorts: () => ['raddr1', 'raddr2'],
  inner: (p, s) => memSym('RF', p, s, memDepth(p, 128)),
  init: p => { const w = ioWidth(p), depth = memDepth(p, 128); const mem = memContents(p, w, depth); if (bool(p, 'zeroReg')) mem[0] = 0n; return { mem } as MemState; },
  eval: (ins, p, st) => {
    const w = ioWidth(p), depth = memDepth(p, 128), aw = memAddrWidth(depth);
    const s = (st as MemState) ?? { mem: memContents(p, w, depth) };
    const zero = bool(p, 'zeroReg');
    const rd = (a: number) => (zero && a === 0) ? 0n : (a < depth ? (s.mem[a] ?? 0n) : 0n);
    const r1 = Number(ins[3] & mask(aw)), r2 = Number(ins[4] & mask(aw));
    return [trunc(rd(r1), w), trunc(rd(r2), w)];
  },
  next: (ins, p, st) => {
    const w = ioWidth(p), depth = memDepth(p, 128), aw = memAddrWidth(depth);
    const s = (st as MemState) ?? { mem: memContents(p, w, depth) };
    const zero = bool(p, 'zeroReg');
    let mem = s.mem;
    const d = ins[0], waddr = Number(ins[1] & mask(aw)), we = (ins[2] & 1n) === 1n;
    if (we && waddr < depth && !(zero && waddr === 0)) { const nm = mem.slice(); nm[waddr] = trunc(d, w); mem = nm; }
    return { mem } as MemState;
  },
  help: 'Two asynchronous read ports, one synchronous write port (gated by WE). Writing and reading the same address in the same cycle reads the OLD value (read-before-write), like a real register file. If "register 0 hard-wired to zero" is on, writes to address 0 are dropped and it always reads 0.',
});

function fmtShort(v: bigint, w: number): string { return w <= 10 ? v.toString() : (w <= 32 ? v.toString() : '0x' + v.toString(16)); }

export const GROUPS = ['Signals', 'Gates', 'Wiring', 'Arithmetic', 'Sequential', 'Memory', 'Control'];
export const defOf = (type: string): BlockDef => { const d = LIB[type]; if (!d) throw new Error(`Unknown block type ${type}`); return d; };
export function defaultParams(type: string): Params { const p: Params = {}; for (const d of defOf(type).params) p[d.key] = d.default; return p; }
export function normalizeParams(type: string, p: Params): Params { const out = defaultParams(type); for (const d of defOf(type).params) if (p[d.key] !== undefined) out[d.key] = p[d.key]; return out; }
