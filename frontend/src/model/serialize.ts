import type { Design, Module, Block, Wire } from './types';
import { emptyDesign, emptyModule } from './types';
import { LIB, normalizeParams } from './library';

export function serialize(d: Design): string { return JSON.stringify(d, null, 1); }

export function deserialize(text: string): Design {
  const raw = JSON.parse(text);
  if (raw && typeof raw === 'object' && Array.isArray(raw.blocks) && raw.version === undefined) return migrateV1(raw);
  if (raw?.version !== 2) throw new Error('Not an RTL Playground design file.');
  const d: Design = { ...emptyDesign(raw.name ?? 'untitled'), ...raw };
  d.modules = {};
  for (const [name, m] of Object.entries(raw.modules ?? {})) d.modules[name] = normalizeModule(m as Partial<Module>);
  if (!d.modules[d.top]) { const first = Object.keys(d.modules)[0]; if (first) d.top = first; else d.modules[d.top] = emptyModule(); }
  d.tests = Array.isArray(raw.tests) ? raw.tests : [];
  d.views = raw.views?.wave ? raw.views : emptyDesign().views;
  d.options = { ...emptyDesign().options, ...(raw.options ?? {}) };
  return d;
}

export function normalizeModule(m: Partial<Module>): Module {
  const out = emptyModule();
  out.source = m.source ?? 'schematic';
  out.ports = m.ports ?? [];
  out.blocks = (m.blocks ?? []).filter(b => LIB[b.type]).map(b => ({ ...b, params: normalizeParams(b.type, b.params ?? {}), trace: b.trace ?? LIB[b.type].trace ?? false }));
  const ids = new Set(out.blocks.map(b => b.id));
  out.wires = (m.wires ?? []).filter(w => ids.has(w.from.b) && ids.has(w.to.b));
  out.notes = m.notes ?? [];
  out.locked = m.locked ?? [];
  if (m.text !== undefined) out.text = m.text;
  return out;
}

// ---- v1 (the single-file prototype) ----
interface V1Block { id: number; t: string; x: number; y: number; l?: string; tr?: boolean; s?: Record<string, unknown> }
interface V1Wire { id: number; from: number; fi: number; to: number; ti: number }
const V1_INS: Record<string, string[]> = { out1: ['a'], out8: ['a'], dff: ['d'], reg: ['d'], add: ['a', 'b'], mux: ['i0', 'i1', 's'], eq: ['a', 'b'], ext: ['a'], and: ['i0', 'i1'], or: ['i0', 'i1'], not: ['a'] };
const V1_OUTS: Record<string, string[]> = { in1: ['y'], in4: ['y'], seq1: ['y'], seq4: ['y'], c4: ['y'], c8: ['y'], dff: ['q'], reg: ['q'], add: ['s', 'co'], mux: ['y'], eq: ['y'], ext: ['y'], and: ['y'], or: ['y'], not: ['y'] };

function migrateV1(raw: { blocks: V1Block[]; wires: V1Wire[] }): Design {
  const d = emptyDesign('imported');
  const m = d.modules.top;
  const idOf = (b: V1Block) => `b${b.id}`;
  for (const b of raw.blocks) {
    const s = b.s ?? {};
    const conv = (type: string, params: Record<string, unknown>): Block => ({ id: idOf(b), type, params: normalizeParams(type, params), x: b.x, y: b.y, label: b.l || undefined, trace: b.tr });
    let nb: Block | null = null;
    switch (b.t) {
      case 'in1': nb = conv('in', { width: 1, value: s.val ?? 0 }); break;
      case 'in4': nb = conv('in', { width: 4, value: s.val ?? 0 }); break;
      case 'seq1': nb = conv('seq', { width: 1, values: ((s.list as number[]) ?? []).join(''), repeat: !!s.rep }); break;
      case 'seq4': nb = conv('seq', { width: 4, values: ((s.list as number[]) ?? []).join(' '), repeat: !!s.rep }); break;
      case 'c4': nb = conv('const', { width: 4, value: s.val ?? 0 }); break;
      case 'c8': nb = conv('const', { width: 8, value: s.val ?? 0 }); break;
      case 'out1': nb = conv('out', { width: 1 }); break;
      case 'out8': nb = conv('out', { width: 8 }); break;
      case 'dff': nb = conv('reg', { width: 1 }); break;
      case 'reg': nb = conv('reg', { width: 8 }); break;
      case 'add': nb = conv('add', { width: 8, cout: true }); break;
      case 'mux': nb = conv('mux', { n: 2, width: 8 }); break;
      case 'eq': nb = conv('cmp', { width: 4, op: 'eq' }); break;
      case 'ext': nb = conv('ext', { inw: 1, outw: 8 }); break;
      case 'and': nb = conv('and', { n: 2, width: 1 }); break;
      case 'or': nb = conv('or', { n: 2, width: 1 }); break;
      case 'not': nb = conv('not', { width: 1 }); break;
    }
    if (nb) m.blocks.push(nb);
  }
  const byId = new Map(raw.blocks.map(b => [b.id, b]));
  for (const w of raw.wires) {
    const f = byId.get(w.from), t = byId.get(w.to); if (!f || !t) continue;
    const fp = V1_OUTS[f.t]?.[w.fi], tp = V1_INS[t.t]?.[w.ti]; if (!fp || !tp) continue;
    const nw: Wire = { id: `w${w.id}`, from: { b: idOf(f), p: fp }, to: { b: idOf(t), p: tp } };
    m.wires.push(nw);
  }
  return d;
}
