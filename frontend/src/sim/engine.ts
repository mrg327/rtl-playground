// Cycle-accurate synchronous simulator over a single module, with a full frame history for time travel.
import type { Module, Block } from '../model/types';
import { defOf, type BlockDef } from '../model/library';
import { buildNetlist, pinKey, type Netlist, type Problem } from '../model/netlist';
import { trunc } from '../model/values';

export interface Compiled {
  module: Module;
  netlist: Netlist;
  /** Evaluation order for levelised blocks. */
  order: Block[];
  /** Blocks that are part of a combinational loop; evaluated by iteration after `order`. */
  loop: Block[];
  pinIndex: Map<string, number>;
  pinKeys: string[];
  problems: Problem[];
}

export interface Frame {
  cycle: number;
  states: Map<string, unknown>;
  /** Sampled primary input values (block id -> value) for this cycle. */
  inputs: Map<string, bigint>;
  rst: boolean;
}

export function compile(m: Module): Compiled {
  const netlist = buildNetlist(m);
  const problems = [...netlist.problems];
  const pinKeys: string[] = [];
  const pinIndex = new Map<string, number>();
  for (const b of m.blocks) for (const p of netlist.ports.get(b.id)!) { pinIndex.set(`${b.id}.${p.name}`, pinKeys.length); pinKeys.push(`${b.id}.${p.name}`); }

  // Dependency graph among blocks whose outputs depend on inputs.
  const dependsOnInputs = (b: Block) => { const k = defOf(b.type).kind; return k === 'comb' || k === 'mixed' || k === 'alias'; };
  const indeg = new Map<string, number>(); const succ = new Map<string, string[]>();
  for (const b of m.blocks) { indeg.set(b.id, 0); succ.set(b.id, []); }
  for (const net of netlist.nets) {
    const drv = net.drivers[0]; if (!drv) continue;
    for (const l of net.loads) { const lb = netlist.blocks.get(l.b)!; if (!dependsOnInputs(lb) || l.b === drv.b && !dependsOnInputs(lb)) continue; if (l.b === drv.b) { indeg.set(l.b, indeg.get(l.b)! + 1); succ.get(drv.b)!.push(l.b); continue; } succ.get(drv.b)!.push(l.b); indeg.set(l.b, indeg.get(l.b)! + 1); }
    // label pins: labels are alias blocks, treat driver -> label as dependency too (handled: label loads are in net.pins not loads)
    for (const p of net.pins) { const pb = netlist.blocks.get(p.b)!; if (pb.type === 'label' && p.b !== drv.b) { succ.get(drv.b)!.push(p.b); indeg.set(p.b, indeg.get(p.b)! + 1); } }
  }
  const order: Block[] = []; const q: string[] = [];
  for (const b of m.blocks) if (indeg.get(b.id) === 0) q.push(b.id);
  while (q.length) { const id = q.shift()!; order.push(netlist.blocks.get(id)!); for (const s of succ.get(id)!) { const d = indeg.get(s)! - 1; indeg.set(s, d); if (d === 0) q.push(s); } }
  const placed = new Set(order.map(b => b.id));
  const loop = m.blocks.filter(b => !placed.has(b.id));
  if (loop.length) problems.push({ level: 'error', code: 'loop', message: `Combinational loop through ${loop.map(b => b.id).join(', ')}. Insert a register to break it.`, blocks: loop.map(b => b.id) });
  return { module: m, netlist, order, loop, pinIndex, pinKeys, problems };
}

export function initState(b: Block): unknown { const d = defOf(b.type); return d.init ? d.init(b.params) : undefined; }

/** Evaluate all pin values for a frame. `liveInputs` reads input block values from params instead of the frame. */
export function evaluate(c: Compiled, f: Frame, liveInputs: boolean): bigint[] {
  const vals = new Array<bigint>(c.pinKeys.length).fill(0n);
  const inputOf = (b: Block, port: string, width: number): bigint => {
    const net = c.netlist.byPin.get(`${b.id}.${port}`); const drv = net?.drivers[0];
    if (!drv) return 0n;
    return trunc(vals[c.pinIndex.get(pinKey(drv))!], width);
  };
  const evalBlock = (b: Block) => {
    const d: BlockDef = defOf(b.type);
    const ports = c.netlist.ports.get(b.id)!;
    const ins = ports.filter(p => p.dir === 'in').map(p => inputOf(b, p.name, p.width));
    let state = f.states.get(b.id);
    if (b.type === 'rst') state = { on: f.rst };
    let outs: bigint[];
    if (b.type === 'in') { const v = liveInputs ? d.eval(ins, b.params, state)[0] : (f.inputs.get(b.id) ?? d.eval(ins, b.params, state)[0]); outs = [v]; }
    else outs = d.eval(ins, b.params, state);
    const outPorts = ports.filter(p => p.dir === 'out');
    outPorts.forEach((p, i) => { vals[c.pinIndex.get(`${b.id}.${p.name}`)!] = trunc(outs[i] ?? 0n, p.width); });
  };
  for (const b of c.order) evalBlock(b);
  if (c.loop.length) for (let it = 0; it < 16; it++) { const before = vals.slice(); for (const b of c.loop) evalBlock(b); if (before.every((v, i) => v === vals[i])) break; }
  return vals;
}

export class Simulator {
  compiled: Compiled;
  frames: Frame[] = [];
  /** Index of the frame being viewed. The last frame is the live one. */
  cur = 0;
  maxFrames = 20000;
  private cache = new Map<number, bigint[]>();

  constructor(m: Module) { this.compiled = compile(m); this.powerOn(); }

  get module(): Module { return this.compiled.module; }
  get live(): boolean { return this.cur === this.frames.length - 1; }
  get frame(): Frame { return this.frames[this.cur]; }
  get cycle(): number { return this.frame.cycle; }
  get lastCycle(): number { return this.frames[this.frames.length - 1].cycle; }
  get rst(): boolean { return this.frames[this.frames.length - 1].rst; }
  set rst(v: boolean) { this.frames[this.frames.length - 1].rst = v; this.cache.delete(this.frames.length - 1); }

  /** Rebuild after the module changed. Keeps history; new blocks get fresh state. */
  recompile(m: Module): void {
    this.compiled = compile(m);
    this.cache.clear();
    for (const f of this.frames) for (const b of m.blocks) if (!f.states.has(b.id)) f.states.set(b.id, initState(b));
  }

  powerOn(): void {
    const states = new Map<string, unknown>();
    for (const b of this.module.blocks) states.set(b.id, initState(b));
    this.frames = [{ cycle: 0, states, inputs: new Map(), rst: false }];
    this.cur = 0; this.cache.clear();
  }

  /** Pin values for a frame index (cached for past frames). */
  values(i = this.cur): bigint[] {
    const isLive = i === this.frames.length - 1;
    if (isLive) return evaluate(this.compiled, this.frames[i], true);
    let v = this.cache.get(i);
    if (!v) { v = evaluate(this.compiled, this.frames[i], false); this.cache.set(i, v); }
    return v;
  }
  value(pin: string, i = this.cur): bigint { const idx = this.compiled.pinIndex.get(pin); return idx === undefined ? 0n : this.values(i)[idx]; }

  /** Drop frames after the viewed one, making it live (a new timeline). */
  branch(): void { if (!this.live) { this.frames.length = this.cur + 1; this.cache.delete(this.cur); const f = this.frame; for (const [id, v] of f.inputs) { const b = this.compiled.netlist.blocks.get(id); if (b) b.params.value = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString(); } } }

  /** Rising clock edge. */
  step(): void {
    this.branch();
    const f = this.frame;
    const vals = evaluate(this.compiled, f, true);
    // Sample the inputs into the frame so it can be replayed.
    for (const b of this.module.blocks) if (b.type === 'in') f.inputs.set(b.id, vals[this.compiled.pinIndex.get(`${b.id}.y`)!]);
    this.cache.set(this.cur, vals);
    const states = new Map<string, unknown>();
    for (const b of this.module.blocks) {
      const d = defOf(b.type);
      if (d.next) {
        const ports = this.compiled.netlist.ports.get(b.id)!;
        const ins = ports.filter(p => p.dir === 'in').map(p => { const net = this.compiled.netlist.byPin.get(`${b.id}.${p.name}`); const drv = net?.drivers[0]; return drv ? trunc(vals[this.compiled.pinIndex.get(pinKey(drv))!], p.width) : 0n; });
        states.set(b.id, d.next(ins, b.params, f.states.get(b.id), f.rst));
      } else states.set(b.id, f.states.get(b.id));
    }
    this.frames.push({ cycle: f.cycle + 1, states, inputs: new Map(), rst: f.rst });
    if (this.frames.length > this.maxFrames) { this.frames.shift(); this.cache.clear(); }
    this.cur = this.frames.length - 1;
  }

  back(): void { if (this.cur > 0) this.cur--; }
  goto(cycle: number): void { const i = this.frames.findIndex(f => f.cycle === cycle); if (i >= 0) this.cur = i; }
  /** Clear history but keep the current state as cycle 0. */
  clearHistory(): void { const f = this.frames[this.frames.length - 1]; this.frames = [{ ...f, cycle: 0 }]; this.cur = 0; this.cache.clear(); }
}
