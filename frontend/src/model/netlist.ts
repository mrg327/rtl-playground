// Derived netlist: nets from wires and labels, plus design-rule problems.
import type { Module, Block, PinRef, Wire } from './types';
import { defOf, type PortDef } from './library';
import { portsOf } from './geometry';

export const pinKey = (r: PinRef): string => `${r.b}.${r.p}`;
export const parsePin = (k: string): PinRef => { const i = k.lastIndexOf('.'); return { b: k.slice(0, i), p: k.slice(i + 1) }; };

export interface Net {
  id: string;
  name: string;
  width: number;
  /** Real driving output pins (label pins excluded). Exactly one in a valid net. */
  drivers: PinRef[];
  /** Real input pins fed by this net. */
  loads: PinRef[];
  /** Every pin in the net including label pins. */
  pins: PinRef[];
  wires: Wire[];
}

export interface Problem {
  level: 'error' | 'warning';
  code: string;
  message: string;
  blocks?: string[];
  wires?: string[];
}

export interface Netlist {
  nets: Net[];
  /** pin key -> net */
  byPin: Map<string, Net>;
  problems: Problem[];
  blocks: Map<string, Block>;
  ports: Map<string, PortDef[]>;
}

class UF { p = new Map<string, string>(); find(x: string): string { let r = this.p.get(x); if (r === undefined) { this.p.set(x, x); return x; } if (r !== x) { r = this.find(r); this.p.set(x, r); } return r; } union(a: string, b: string) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); } }

export function buildNetlist(m: Module): Netlist {
  const blocks = new Map(m.blocks.map(b => [b.id, b]));
  const ports = new Map(m.blocks.map(b => [b.id, portsOf(b)]));
  const problems: Problem[] = [];
  const uf = new UF();
  const validWires: Wire[] = [];
  const portDef = (r: PinRef): PortDef | undefined => ports.get(r.b)?.find(p => p.name === r.p);

  for (const w of m.wires) {
    const f = portDef(w.from), t = portDef(w.to);
    if (!f || !t || f.dir !== 'out' || t.dir !== 'in') { problems.push({ level: 'error', code: 'dangling', message: `Wire ${w.id} is connected to a pin that no longer exists.`, wires: [w.id] }); continue; }
    validWires.push(w);
    uf.union(pinKey(w.from), pinKey(w.to));
  }
  // labels: all pins of every label with the same name are one net
  const labelGroups = new Map<string, string[]>();
  for (const b of m.blocks) {
    if (b.type === 'label') { const n = String(b.params.name ?? ''); const g = labelGroups.get(n) ?? []; g.push(`${b.id}.i`, `${b.id}.o`); labelGroups.set(n, g); }
  }
  for (const [, g] of labelGroups) for (let i = 1; i < g.length; i++) uf.union(g[0], g[i]);
  for (const b of m.blocks) if (b.type === 'label') uf.union(`${b.id}.i`, `${b.id}.o`);

  const groups = new Map<string, PinRef[]>();
  for (const b of m.blocks) for (const p of ports.get(b.id)!) { const k = `${b.id}.${p.name}`; const r = uf.find(k); const g = groups.get(r) ?? []; g.push({ b: b.id, p: p.name }); groups.set(r, g); }

  const nets: Net[] = [];
  const byPin = new Map<string, Net>();
  let n = 0;
  for (const [, pins] of groups) {
    const real = pins.filter(r => blocks.get(r.b)!.type !== 'label');
    const drivers = real.filter(r => portDef(r)!.dir === 'out');
    const loads = real.filter(r => portDef(r)!.dir === 'in');
    if (real.length === 0 && pins.length === 0) continue;
    const labelName = pins.map(r => blocks.get(r.b)!).find(b => b.type === 'label')?.params.name;
    const width = drivers.length ? portDef(drivers[0])!.width : (real[0] ? portDef(real[0])!.width : 1);
    const wires = validWires.filter(w => pins.some(r => r.b === w.from.b && r.p === w.from.p));
    const net: Net = { id: `n${n++}`, name: labelName ? String(labelName) : (drivers[0] ? autoName(blocks.get(drivers[0].b)!, drivers[0].p) : ''), width, drivers, loads, pins, wires };
    nets.push(net);
    for (const r of pins) byPin.set(pinKey(r), net);
    if (wires.length === 0 && pins.length <= 1 && !labelName) continue; // unconnected single pin: not a net
    if (drivers.length > 1) problems.push({ level: 'error', code: 'multi-driver', message: `Net "${net.name}" has ${drivers.length} drivers: ${drivers.map(pinKey).join(', ')}.`, blocks: drivers.map(d => d.b), wires: wires.map(w => w.id) });
    for (const l of loads) { const w = portDef(l)!.width; if (w !== width) problems.push({ level: 'error', code: 'width', message: `${pinKey(l)} is ${w}-bit but net "${net.name}" is ${width}-bit.`, blocks: [l.b], wires: wires.filter(x => x.to.b === l.b && x.to.p === l.p).map(x => x.id) }); }
    if (drivers.length === 0 && (loads.length > 0 || labelName)) problems.push({ level: 'warning', code: 'undriven', message: `Net "${net.name || pinKey(loads[0])}" has no driver; it reads as 0.`, blocks: loads.map(l => l.b) });
  }
  // unconnected inputs
  for (const b of m.blocks) for (const p of ports.get(b.id)!) {
    if (p.dir !== 'in') continue;
    const net = byPin.get(`${b.id}.${p.name}`);
    if (!net || net.drivers.length === 0 && net.pins.length === 1) problems.push({ level: 'warning', code: 'unconnected', message: `${b.id}.${p.name} is not connected; it reads as 0.`, blocks: [b.id] });
  }
  return { nets, byPin, problems, blocks, ports };
}

function autoName(b: Block, port: string): string {
  const base = b.label?.trim() ? sanitize(b.label) : b.id;
  const d = defOf(b.type);
  const outs = d.ports(b.params).filter(p => p.dir === 'out');
  return outs.length > 1 ? `${base}_${port}` : base;
}
export const sanitize = (s: string): string => { let t = s.replace(/[^A-Za-z0-9_]/g, '_'); if (!/^[A-Za-z_]/.test(t)) t = '_' + t; return t; };
