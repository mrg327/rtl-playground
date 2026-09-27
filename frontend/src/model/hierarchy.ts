// Module hierarchy (DESIGN.md section 1: "a module is a sheet, a module instance is a block, and that is
// all") and DESIGN.md section 6: "flatten at compile time" so the existing per-module simulator, netlist and
// levelizer run unchanged over a hierarchical design. `flattenModule` expands every `instance` block into its
// target module's blocks under a hierarchical id (`u1/add1`), recursively, so a trace inside an instance is
// addressable as `u1/add1.y` in the waveform, and register state naturally survives recompiles because
// `Simulator.recompile` looks state up by block id.
import type { Design, Module, Block, Wire, PinRef, Dir } from './types';
import type { Problem } from './netlist';
import { defOf, normalizeParams } from './library';

export interface InstancePort { name: string; dir: Dir; width: number }

/** A module's external ports, derived from its `in`/`out` blocks in the order they appear in `module.blocks`
 * (the same order `hdl/emit.ts` uses for a generated module's port list), named by label if set else block id.
 * This is what an `instance` block's own pins are derived from (DESIGN.md task 1). */
export function moduleExternalPorts(m: Module): InstancePort[] {
  const out: InstancePort[] = [];
  for (const b of m.blocks) {
    if (b.type === 'in') out.push({ name: portNameOf(b), dir: 'in', width: portWidth(b, 'y') });
    else if (b.type === 'out') out.push({ name: portNameOf(b), dir: 'out', width: portWidth(b, 'a') });
  }
  return out;
}

export const portNameOf = (b: Block): string => b.label?.trim() || b.id;
function portWidth(b: Block, pinName: string): number {
  const p = defOf(b.type).ports(b.params).find(x => x.name === pinName);
  return p ? p.width : 1;
}

/** Modules that instantiate themselves, directly or indirectly, anywhere in the design (not just the ones
 * reachable from `top`), so the problem shows up regardless of which sheet is open. Standard white/grey/black
 * DFS cycle detection over the "module instantiates module" graph. */
export function findRecursiveModules(design: Design): Map<string, string> {
  const bad = new Map<string, string>();
  const color = new Map<string, 1 | 2>(); // 1 = in progress (on the current chain), 2 = done
  const chain: string[] = [];
  const visit = (key: string): void => {
    const m = design.modules[key];
    if (!m || color.get(key) === 2) return;
    if (color.get(key) === 1) {
      const from = chain.indexOf(key);
      const cycle = [...chain.slice(from < 0 ? 0 : from), key];
      // Every module on the cycle instantiates itself indirectly, not just the one DFS happened to revisit
      // first, so each gets its own problem regardless of which one is on screen.
      for (const k of new Set(cycle.slice(0, -1))) bad.set(k, `Module "${k}" instantiates itself (directly or indirectly): ${cycle.join(' → ')}.`);
      return;
    }
    color.set(key, 1); chain.push(key);
    for (const b of m.blocks) if (b.type === 'instance') { const ck = String(b.params.module ?? ''); if (ck) visit(ck); }
    chain.pop(); color.set(key, 2);
  };
  for (const key of Object.keys(design.modules)) visit(key);
  return bad;
}

export interface TracedSignal { key: string; label: string; width: number }

export interface FlattenResult {
  module: Module;
  problems: Problem[];
  /** Every `trace`-marked block reachable from the flattened root, with its hierarchical pin key
   * (`u1/add1.y`) and a display label, so the waveform can address signals inside instances. */
  traced: TracedSignal[];
}

/** Flatten `key` and everything it (transitively) instantiates into one module with hierarchical block ids,
 * so `sim/engine.ts`'s existing levelized `compile`/`Simulator` runs unchanged over a hierarchical design. The
 * module named `key` keeps its own block ids and its own `in`/`out` blocks as real primary inputs/outputs
 * (so a non-hierarchical design flattens to itself, unchanged); every module it instantiates has its
 * `in`/`out` blocks turned into plain pass-through buffers spliced onto the instance's own connections one
 * level up. A cycle or a reference to a missing module stops expanding that branch and is reported as an
 * error problem instead of recursing forever or throwing. */
export function flattenModule(design: Design, key: string): FlattenResult {
  const problems: Problem[] = [];
  for (const [, message] of findRecursiveModules(design)) problems.push({ level: 'error', code: 'recursion', message });
  const blocks: Block[] = [];
  const wires: Wire[] = [];
  const traced: TracedSignal[] = [];
  expand(design, key, '', [], blocks, wires, traced, problems);
  const top = design.modules[key];
  if (!top) problems.push({ level: 'error', code: 'missing-module', message: `Module "${key}" does not exist.` });
  return { module: { source: 'schematic', ports: top ? moduleExternalPorts(top) : [], blocks, wires, notes: top?.notes ?? [], locked: top?.locked ?? [] }, problems, traced };
}

const pfx = (prefix: string, id: string): string => (prefix ? `${prefix}/${id}` : id);

function traceKeyFor(b: Block): { pin: string; width: number } | null {
  const d = defOf(b.type);
  const ports = d.ports(b.params);
  const p = d.traceKey ? ports.find(x => x.name === d.traceKey) : ports.find(x => x.dir === 'out');
  return p ? { pin: p.name, width: p.width } : null;
}

/** Expands module `key` at hierarchy `prefix` into `blocks`/`wires`/`traced` (all accumulated by reference)
 * and returns a map from this module's own external port name to the flattened pin the parent should connect
 * to for it: the pass-through buffer's new `a` pin (its destination) for an `in` port, since the parent
 * drives that value in; the buffer's new `y` pin (its source) for an `out` port, since the parent reads that
 * value out. (The buffer's *other* pin — `y` for `in`, `a` for `out` — is the one that already existed on the
 * original block and keeps the child's own internal wires connected, unchanged.) */
function expand(
  design: Design, key: string, prefix: string, chain: string[],
  blocks: Block[], wires: Wire[], traced: TracedSignal[], problems: Problem[],
): Map<string, PinRef> {
  const portMap = new Map<string, PinRef>();
  const m = design.modules[key];
  if (!m || chain.includes(key)) return portMap; // missing/cyclic: already reported, stop expanding this branch
  const nextChain = [...chain, key];
  const isRoot = prefix === '';

  for (const b of m.blocks) {
    if (b.type === 'instance') continue;
    let nb: Block;
    if (!isRoot && (b.type === 'in' || b.type === 'out')) {
      const width = portWidth(b, b.type === 'in' ? 'y' : 'a');
      nb = { ...b, id: pfx(prefix, b.id), type: 'buf', params: normalizeParams('buf', { width }) };
    } else {
      // Share `params` with the design, not a copy: input stimulus (Store.stimulus) edits an `in` block's
      // value in place and the running simulator must see it without a recompile, as before flattening.
      nb = { ...b, id: pfx(prefix, b.id) };
    }
    blocks.push(nb);
    if (b.trace) { const tk = traceKeyFor(nb); if (tk) traced.push({ key: `${nb.id}.${tk.pin}`, label: pfx(prefix, b.label || b.id), width: tk.width }); }
  }
  for (const b of m.blocks) {
    if (b.type !== 'instance') continue;
    const childKey = String(b.params.module ?? '');
    const instId = pfx(prefix, b.id);
    if (!childKey || !design.modules[childKey]) { problems.push({ level: 'error', code: 'missing-module', message: `Instance "${instId}" refers to a module that does not exist.`, blocks: [instId] }); continue; }
    if (nextChain.includes(childKey)) continue; // recursion; already reported by findRecursiveModules
    const childPorts = expand(design, childKey, instId, nextChain, blocks, wires, traced, problems);
    for (const [name, pin] of childPorts) portMap.set(`${b.id}.${name}`, pin);
  }
  const resolve = (r: PinRef): PinRef | undefined => {
    const boundary = portMap.get(`${r.b}.${r.p}`);
    if (boundary) return boundary; // r.b is an instance at this level; r.p is one of its live ports
    const b = m.blocks.find(x => x.id === r.b);
    if (!b || b.type === 'instance') return undefined; // instance with a stale (renamed/removed) port name
    return { b: pfx(prefix, r.b), p: r.p };
  };
  for (const w of m.wires) {
    const from = resolve(w.from), to = resolve(w.to);
    if (!from || !to) { problems.push({ level: 'error', code: 'dangling', message: `A wire in module "${key}" no longer matches an instance's ports (it was renamed or removed) and was left out of the simulation.`, wires: [pfx(prefix, w.id)] }); continue; }
    wires.push({ id: pfx(prefix, w.id), from, to, mid: w.mid });
  }
  // Only meaningful (and only ever consulted) when this module was itself instantiated, i.e. its `in`/`out`
  // blocks were just turned into buffers above; the root's own ports are real primary in/outs, not a
  // boundary anything else connects through, so the map returned for the root is never used.
  if (!isRoot) for (const b of m.blocks) {
    if (b.type === 'in') portMap.set(portNameOf(b), { b: pfx(prefix, b.id), p: 'a' });
    else if (b.type === 'out') portMap.set(portNameOf(b), { b: pfx(prefix, b.id), p: 'y' });
  }
  return portMap;
}
