// SystemVerilog emitter: design model (schematic blocks) -> `.sv` text (DESIGN.md section 8).
// Hand-written, never Yosys `write_verilog`. Semantics mirror src/model/library.ts exactly: same widths,
// truncation, signedness, mux/decoder out-of-range behaviour, ALU op codes (including the 6-bit shift-amount
// mask on sll/srl), and counter/shift-register timing. Port widths and port presence are read from each
// block's own `ports()` function rather than re-derived from params, so this file cannot silently drift from
// the simulator: if library.ts changes a port name or width, the emitter follows automatically.
import type { Design, Module, Block, Dir, PinRef } from '../model/types';
import { defOf, num, bool, str, setActiveDesign, type PortDef } from '../model/library';
import { buildNetlist, pinKey, sanitize, type Netlist, type Net } from '../model/netlist';
import { toBig, parseList, mask } from '../model/values';
import { findRecursiveModules } from '../model/hierarchy';

// Kept in step with pyproject.toml by hand; only used in the emitted header comment.
export const TOOL_VERSION = '0.1.0a2';

// ---------- identifiers ----------
// IEEE 1800-2017 Annex B reserved words (the practically-relevant subset: a student's block label or id could
// collide with any of these, especially the primitive gate names `and`/`or`/`not`/`nand`/`nor`/`xor`/`xnor`/`buf`,
// which are also this library's gate block types).
const SV_KEYWORDS = new Set([
  'accept_on', 'alias', 'always', 'always_comb', 'always_ff', 'always_latch', 'and', 'assert', 'assign', 'assume',
  'automatic', 'before', 'begin', 'bind', 'bins', 'binsof', 'bit', 'break', 'buf', 'bufif0', 'bufif1', 'byte',
  'case', 'casex', 'casez', 'cell', 'chandle', 'checker', 'class', 'clocking', 'cmos', 'config', 'const', 'constraint',
  'context', 'continue', 'cover', 'covergroup', 'coverpoint', 'cross', 'deassign', 'default', 'defparam', 'design',
  'disable', 'dist', 'do', 'edge', 'else', 'end', 'endcase', 'endchecker', 'endclass', 'endclocking', 'endconfig',
  'endfunction', 'endgenerate', 'endgroup', 'endinterface', 'endmodule', 'endpackage', 'endprimitive', 'endprogram',
  'endproperty', 'endspecify', 'endsequence', 'endtable', 'endtask', 'enum', 'event', 'eventually', 'expect', 'export',
  'extends', 'extern', 'final', 'first_match', 'for', 'force', 'foreach', 'forever', 'fork', 'forkjoin', 'function',
  'generate', 'genvar', 'global', 'highz0', 'highz1', 'if', 'iff', 'ifnone', 'ignore_bins', 'ignore_bins', 'illegal_bins',
  'implements', 'implies', 'import', 'incdir', 'include', 'initial', 'inout', 'input', 'inside', 'instance', 'int',
  'integer', 'interconnect', 'interface', 'intersect', 'join', 'join_any', 'join_none', 'large', 'let', 'liblist',
  'library', 'local', 'localparam', 'logic', 'longint', 'macromodule', 'matches', 'medium', 'modport', 'module',
  'nand', 'negedge', 'nettype', 'new', 'nexttime', 'nmos', 'nor', 'noshowcancelled', 'not', 'notif0', 'notif1', 'null',
  'or', 'output', 'package', 'packed', 'parameter', 'pmos', 'posedge', 'primitive', 'priority', 'program', 'property',
  'protected', 'pull0', 'pull1', 'pulldown', 'pullup', 'pulsestyle_ondetect', 'pulsestyle_onevent', 'pure', 'rand',
  'randc', 'randcase', 'randsequence', 'rcmos', 'real', 'realtime', 'ref', 'reg', 'reject_on', 'release', 'repeat',
  'restrict', 'return', 'rnmos', 'rpmos', 'rtran', 'rtranif0', 'rtranif1', 's_always', 's_eventually', 's_nexttime',
  's_until', 's_until_with', 'scalared', 'sequence', 'shortint', 'shortreal', 'showcancelled', 'signed', 'small',
  'soft', 'solve', 'specify', 'specparam', 'static', 'string', 'strong', 'strong0', 'strong1', 'struct', 'super',
  'supply0', 'supply1', 'sync_accept_on', 'sync_reject_on', 'table', 'tagged', 'task', 'this', 'throughout', 'time',
  'timeprecision', 'timeunit', 'tran', 'tranif0', 'tranif1', 'tri', 'tri0', 'tri1', 'triand', 'trior', 'trireg',
  'type', 'typedef', 'union', 'unique', 'unique0', 'unsigned', 'until', 'until_with', 'untyped', 'use', 'uwire', 'var',
  'vectored', 'virtual', 'void', 'wait', 'wait_order', 'wand', 'weak', 'weak0', 'weak1', 'while', 'wildcard', 'wire',
  'with', 'within', 'wor', 'xnor', 'xor',
]);

export class NameAllocator {
  private used = new Set<string>();
  alloc(wanted: string): string {
    const base = sanitize(wanted && wanted.length ? wanted : 'net');
    let name = base, i = 2;
    while (this.used.has(name) || SV_KEYWORDS.has(name)) name = `${base}_${i++}`;
    this.used.add(name);
    return name;
  }
}

// ---------- formatting ----------
export const declType = (w: number): string => (w > 1 ? `logic [${w - 1}:0]` : 'logic');
export const lit = (v: bigint, w: number): string => `${w}'d${(v & mask(w)).toString()}`;
/** library.ts masks the ALU's shift-by amount to its low 6 bits (`b & 63n`) before shifting. */
const maskShiftAmount = (w: number, expr: string): string => (w > 6 ? `${expr}[5:0]` : expr);
const escStr = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// ---------- port/width helpers (read from the block's own ports(), never re-derived from params) ----------
const portsOfBlock = (b: Block): PortDef[] => defOf(b.type).ports(b.params);
const hasPort = (b: Block, name: string): boolean => portsOfBlock(b).some(p => p.name === name);
function portWidthOf(b: Block, name: string): number {
  const p = portsOfBlock(b).find(x => x.name === name);
  if (!p) throw new Error(`Block "${b.id}" (${b.type}) has no port "${name}".`);
  return p.width;
}

// ---------- plan: one design module -> declarations, statements, ports, net names ----------
export interface Port { name: string; dir: Dir; width: number; blockId: string }
export interface NetInfo { svName: string; width: number; declare: boolean; initValue: bigint | null }

export interface ModulePlan {
  key: string;
  svName: string;
  clk: string;
  rst: string;
  ports: Port[]; // clk/rst not included; in declared (block) order
  netlist: Netlist;
  nets: Map<string, NetInfo>; // Net.id -> info
  body: string; // declarations + statements, one leading two-space indent, ready to place inside the module
}

interface Ctx {
  b: Block;
  clk: string;
  rst: string;
  read: (port: string) => string; // resolves an input pin to an expression (a literal 0 if unconnected)
  out: (port: string) => string; // this block's own declared net name for an output pin
  alloc: NameAllocator; // for extra internal state (e.g. the Sequence block's ROM index)
  design: Design; // only used by the `instance` generator, to name and check the target module
  instName: string; // this block's instance name, reserved before nets so no net can take it
}
type Gen = (c: Ctx) => string[];

/** A register's power-on value on its own `q` net, so the emitted `logic` starts exactly where the TS
 * simulator's `powerOn()` does, without needing a reset pulse in a testbench. Only `q` is an actual register;
 * a counter's `co` (and any other output) is purely combinational and must not get an initial value of its
 * own, or Verilator's CONTASSINIT rightly complains about a continuously-assigned net with one. */
function initValueOf(b: Block, port: string): bigint | null {
  if (port === 'q' && (b.type === 'reg' || b.type === 'counter')) return toBig(b.params.init, portWidthOf(b, 'q'));
  if (port === 'q' && b.type === 'shreg') return 0n;
  // A memory's own read output is a real register only in sync (registered) read mode; in async mode it is a
  // continuously-assigned wire (see GENERATORS.ram/rom below), and giving that an initial value would trip
  // Verilator's CONTASSINIT the same way a counter's `co` would.
  if ((port === 'q' || port === 'q2') && (b.type === 'ram' || b.type === 'rom') && str(b.params, 'readStyle', 'sync') === 'sync') return 0n;
  return null;
}

export function planModule(design: Design, key: string): ModulePlan {
  // The `instance` block's own ports() reads this (see model/library.ts): set before building the netlist,
  // since an instance's connectivity (dangling-pin checks included) depends on the target module's current
  // in/out blocks, not just this block's own params.
  setActiveDesign(design);
  const m = design.modules[key];
  if (!m) throw new Error(`Module "${key}" not found.`);
  if (m.source === 'hdl') throw new Error(`Module "${key}" is HDL-source; use its own text instead of the block emitter.`);
  const recursive = findRecursiveModules(design);
  if (recursive.has(key)) throw new Error(recursive.get(key)!);
  const netlist = buildNetlist(m);
  const errors = netlist.problems.filter(p => p.level === 'error');
  if (errors.length) throw new Error(`Cannot emit SystemVerilog for module "${key}": ${errors.map(e => e.message).join('; ')}`);

  const alloc = new NameAllocator();
  const clk = alloc.alloc(design.options.clockName || 'clk');
  const rst = alloc.alloc(design.options.resetName || 'rst');

  const ports: Port[] = [];
  const portNameOf = new Map<string, string>(); // in/out block id -> its port name
  for (const b of m.blocks) {
    if (b.type !== 'in' && b.type !== 'out') continue;
    const name = alloc.alloc(b.label?.trim() || b.id);
    portNameOf.set(b.id, name);
    ports.push({ name, dir: b.type === 'in' ? 'in' : 'out', width: portWidthOf(b, b.type === 'in' ? 'y' : 'a'), blockId: b.id });
  }

  // Instance names share the module's namespace with nets; reserve them first (a net named after its
  // driving block, e.g. `u0`, would otherwise collide with the instance `u0` and fail to elaborate).
  const instNames = new Map<string, string>();
  for (const b of m.blocks) if (b.type === 'instance') instNames.set(b.id, alloc.alloc(b.id));

  const nets = new Map<string, NetInfo>();
  for (const net of netlist.nets) {
    const drv = net.drivers[0];
    const drvBlock = drv ? netlist.blocks.get(drv.b)! : undefined;
    if (drvBlock?.type === 'in') { nets.set(net.id, { svName: portNameOf.get(drvBlock.id)!, width: net.width, declare: false, initValue: null }); continue; }
    if (drvBlock?.type === 'rst') { nets.set(net.id, { svName: rst, width: net.width, declare: false, initValue: null }); continue; }
    if (!drv || !drvBlock) continue; // undriven: every use site falls back to a literal 0, no declaration needed
    const svName = alloc.alloc(net.name || `${drvBlock.id}_${drv.p}`);
    nets.set(net.id, { svName, width: net.width, declare: true, initValue: initValueOf(drvBlock, drv.p) });
  }

  const netFor = (p: PinRef): Net | undefined => netlist.byPin.get(pinKey(p));

  const decls: string[] = [];
  for (const info of nets.values()) if (info.declare) decls.push(`  ${declType(info.width)} ${info.svName}${info.initValue !== null ? ` = ${lit(info.initValue, info.width)}` : ''};`);

  const stmts: string[] = [];
  for (const b of m.blocks) {
    if (b.type === 'in' || b.type === 'out' || b.type === 'label' || b.type === 'rst') continue;
    const gen = GENERATORS[b.type];
    if (!gen) throw new Error(`No SystemVerilog emitter for block type "${b.type}" (block "${b.id}").`);
    const ctx: Ctx = {
      b, clk, rst,
      read: port => { const w = portWidthOf(b, port); const net = netFor({ b: b.id, p: port }); const info = net && nets.get(net.id); return info ? info.svName : lit(0n, w); },
      out: port => { const net = netFor({ b: b.id, p: port }); if (!net) throw new Error(`Block "${b.id}" has no net for output "${port}".`); return nets.get(net.id)!.svName; },
      alloc, design, instName: instNames.get(b.id) ?? b.id,
    };
    const lines = gen(ctx);
    if (!lines.length) continue;
    stmts.push(`  // block: ${b.id}${b.label ? ` (${b.label})` : ''}`);
    for (const l of lines) stmts.push(l ? `  ${l}` : '');
    stmts.push('');
  }
  for (const b of m.blocks) {
    if (b.type !== 'out') continue;
    const w = portWidthOf(b, 'a');
    const net = netFor({ b: b.id, p: 'a' }); const info = net && nets.get(net.id);
    const src = info ? info.svName : lit(0n, w);
    stmts.push(`  // block: ${b.id}${b.label ? ` (${b.label})` : ''}`, `  assign ${portNameOf.get(b.id)} = ${src};`, '');
  }

  const body = [...decls, decls.length ? '' : '', ...stmts].join('\n');
  return { key, svName: sanitize(key), clk, rst, ports, netlist, nets, body };
}

/** For a block id, the pin actually holding its "observed" value: its trace pin, or its first output, following
 * through to the true source when that pin is itself an input (e.g. an Output block's own `a` pin). Mirrors the
 * resolution in src/sim/tests.ts exactly, so testbench checks compare the same value the in-browser test runner does. */
export function observePin(m: Module, netlist: Netlist, blockId: string): PinRef | null {
  const block = netlist.blocks.get(blockId); if (!block) return null;
  const d = defOf(block.type);
  const ports = d.ports(block.params);
  const pinName = d.traceKey ?? ports.find(p => p.dir === 'out')?.name ?? 'y';
  const pd = ports.find(p => p.name === pinName);
  if (!pd) return null;
  if (pd.dir === 'in') { const net = netlist.byPin.get(`${blockId}.${pinName}`); return net?.drivers[0] ?? null; }
  return { b: blockId, p: pinName };
}

/** Whether an already-resolved net name is one of the module's own clk/rst/port signals (as opposed to an
 * internal net that a testbench must reach through the instance, e.g. `dut.<name>`). */
export function isModulePort(plan: ModulePlan, svName: string): boolean {
  return svName === plan.clk || svName === plan.rst || plan.ports.some(p => p.name === svName);
}

// ---------- per-block-type generators ----------
const GENERATORS: Record<string, Gen> = {};

function gateGen(op: '&' | '|' | '^', invert: boolean): Gen {
  return ({ b, read, out }) => {
    const ins = portsOfBlock(b).filter(p => p.dir === 'in');
    const expr = ins.map(p => read(p.name)).join(` ${op} `);
    return [`assign ${out('y')} = ${invert ? `~(${expr})` : expr};`];
  };
}
GENERATORS.and = gateGen('&', false);
GENERATORS.nand = gateGen('&', true);
GENERATORS.or = gateGen('|', false);
GENERATORS.nor = gateGen('|', true);
GENERATORS.xor = gateGen('^', false);
GENERATORS.xnor = gateGen('^', true);
GENERATORS.not = ({ read, out }) => [`assign ${out('y')} = ~${read('a')};`];
GENERATORS.buf = ({ read, out }) => [`assign ${out('y')} = ${read('a')};`];

GENERATORS.const = ({ b, out }) => { const w = portWidthOf(b, 'y'); return [`assign ${out('y')} = ${lit(toBig(b.params.value, w), w)};`]; };

GENERATORS.split = ({ b, read, out }) => {
  const outs = portsOfBlock(b).filter(p => p.dir === 'out');
  const i = read('i');
  const lines: string[] = []; let lo = 0;
  for (const p of outs) { const hi = lo + p.width - 1; lines.push(`assign ${out(p.name)} = ${p.width === 1 ? `${i}[${lo}]` : `${i}[${hi}:${lo}]`};`); lo += p.width; }
  return lines;
};
GENERATORS.join = ({ b, read, out }) => {
  const ins = portsOfBlock(b).filter(p => p.dir === 'in'); // i0 (LSB) .. i(k-1) (MSB)
  const parts = ins.map(p => read(p.name)).reverse(); // SV `{}` concatenation lists MSB first
  return [`assign ${out('o')} = {${parts.join(', ')}};`];
};
GENERATORS.ext = ({ b, read, out }) => {
  const iw = portWidthOf(b, 'a'), ow = portWidthOf(b, 'y'), signed = bool(b.params, 'signed');
  const a = read('a');
  let expr: string;
  if (ow > iw) expr = signed ? `{ {${ow - iw}{${a}[${iw - 1}]}}, ${a} }` : `{ {${ow - iw}{1'b0}}, ${a} }`;
  else if (ow === iw) expr = a;
  else expr = `${a}[${ow - 1}:0]`;
  return [`assign ${out('y')} = ${expr};`];
};
GENERATORS.slice = ({ b, read, out }) => {
  const hi = num(b.params, 'hi', 7), lo = num(b.params, 'lo', 0);
  const a = read('a');
  return [`assign ${out('y')} = ${hi === lo ? `${a}[${lo}]` : `${a}[${hi}:${lo}]`};`];
};

GENERATORS.add = ({ b, read, out }) => {
  const hasCin = hasPort(b, 'ci'), hasCout = hasPort(b, 'co');
  const sum = `${read('a')} + ${read('b')}${hasCin ? ` + ${read('ci')}` : ''}`;
  return hasCout ? [`assign {${out('co')}, ${out('s')}} = ${sum};`] : [`assign ${out('s')} = ${sum};`];
};
GENERATORS.sub = ({ read, out }) => {
  const a = read('a'), b = read('b');
  return [`assign ${out('d')} = ${a} - ${b};`, `assign ${out('bo')} = (${a} < ${b});`];
};
GENERATORS.mul = ({ b, read, out }) => {
  const signed = bool(b.params, 'signed'); const a = read('a'), bb = read('b');
  return [`assign ${out('y')} = ${signed ? `$signed(${a}) * $signed(${bb})` : `${a} * ${bb}`};`];
};
const CMP_SV: Record<string, string> = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };
GENERATORS.cmp = ({ b, read, out }) => {
  const signed = bool(b.params, 'signed'); const op = CMP_SV[str(b.params, 'op', 'eq')] ?? '==';
  const sg = (x: string) => (signed ? `$signed(${x})` : x);
  return [`assign ${out('y')} = ${sg(read('a'))} ${op} ${sg(read('b'))};`];
};
GENERATORS.mux = ({ b, read, out }) => {
  const ports = portsOfBlock(b);
  const n = ports.filter(p => p.dir === 'in' && p.name !== 's').length;
  const w = ports.find(p => p.name === 'i0')!.width;
  const lines = [`always_comb begin`, `  case (${read('s')})`];
  for (let i = 0; i < n; i++) lines.push(`    ${i}: ${out('y')} = ${read('i' + i)};`);
  lines.push(`    default: ${out('y')} = ${lit(0n, w)};`, `  endcase`, `end`);
  return lines;
};
GENERATORS.alu = ({ b, read, out }) => {
  const w = portWidthOf(b, 'a'); const a = read('a'), bb = read('b'), op = read('op');
  const shamt = maskShiftAmount(w, bb);
  const y = out('y');
  return [
    `always_comb begin`,
    `  case (${op})`,
    `    3'd0: ${y} = ${a} + ${bb};`,
    `    3'd1: ${y} = ${a} - ${bb};`,
    `    3'd2: ${y} = ${a} & ${bb};`,
    `    3'd3: ${y} = ${a} | ${bb};`,
    `    3'd4: ${y} = ${a} ^ ${bb};`,
    `    3'd5: ${y} = ${w}'($signed(${a}) < $signed(${bb}));`,
    `    3'd6: ${y} = ${a} << ${shamt};`,
    `    3'd7: ${y} = ${a} >> ${shamt};`,
    `    default: ${y} = ${a} + ${bb};`,
    `  endcase`,
    `end`,
    `assign ${out('z')} = ~|${y};`,
  ];
};
GENERATORS.dec = ({ b, read, out }) => {
  const a = read('a'); const bits = portWidthOf(b, 'a'); const en = hasPort(b, 'en') ? read('en') : `1'b1`;
  return portsOfBlock(b).filter(p => p.dir === 'out').map((p, i) => `assign ${out(p.name)} = ${en} && (${a} == ${bits}'d${i});`);
};
GENERATORS.enc = ({ b, read, out }) => {
  const n = portWidthOf(b, 'a'); const bits = portWidthOf(b, 'y');
  const a = read('a'); const y = out('y'), v = out('v');
  return [
    `always_comb begin`,
    `  ${y} = ${lit(0n, bits)};`,
    `  ${v} = 1'b0;`,
    `  for (int i = 0; i < ${n}; i++) if (${a}[i]) begin`,
    `    ${y} = i[${bits - 1}:0];`,
    `    ${v} = 1'b1;`,
    `  end`,
    `end`,
  ];
};
GENERATORS.shift = ({ b, read, out }) => {
  const dir = str(b.params, 'dir', 'left');
  const fixed = str(b.params, 'by', '1').trim();
  const nExpr = fixed ? String(parseInt(fixed, 10) || 0) : read('n');
  const a = read('a');
  const expr = dir === 'left' ? `${a} << ${nExpr}` : dir === 'sra' ? `$signed(${a}) >>> ${nExpr}` : `${a} >> ${nExpr}`;
  return [`assign ${out('y')} = ${expr};`];
};
GENERATORS.reduce = ({ b, read, out }) => {
  const op = str(b.params, 'op', 'or'); const sym = op === 'and' ? '&' : op === 'xor' ? '^' : '|';
  return [`assign ${out('y')} = ${sym}${read('a')};`];
};

GENERATORS.reg = ({ b, read, out, clk, rst }) => {
  const w = portWidthOf(b, 'q'); const hasEn = hasPort(b, 'en'); const rstMode = str(b.params, 'rst', 'sync');
  const d = read('d'); const en = hasEn ? read('en') : null; const q = out('q');
  const lines = [`always_ff @(posedge ${clk}) begin`];
  if (rstMode === 'none') lines.push(en ? `  if (${en}) ${q} <= ${d};` : `  ${q} <= ${d};`);
  else {
    lines.push(`  if (${rst}) ${q} <= ${lit(toBig(b.params.init, w), w)};`);
    lines.push(en ? `  else if (${en}) ${q} <= ${d};` : `  else ${q} <= ${d};`);
  }
  lines.push(`end`);
  return lines;
};
GENERATORS.counter = ({ b, read, out, clk, rst }) => {
  const w = portWidthOf(b, 'q'); const hasEn = hasPort(b, 'en'); const hasLoad = hasPort(b, 'ld'); const down = bool(b.params, 'down');
  const q = out('q'), co = out('co');
  const step = `${q} ${down ? '-' : '+'} 1'b1`;
  const lines = [`always_ff @(posedge ${clk}) begin`, `  if (${rst}) ${q} <= ${lit(toBig(b.params.init, w), w)};`];
  if (hasLoad) lines.push(`  else if (${read('ld')}) ${q} <= ${read('d')};`);
  lines.push(hasEn ? `  else if (${read('en')}) ${q} <= ${step};` : `  else ${q} <= ${step};`);
  lines.push(`end`);
  const enExpr = hasEn ? read('en') : `1'b1`;
  const boundary = down ? `(${q} == ${lit(0n, w)})` : `(${q} == ${lit(mask(w), w)})`;
  lines.push('', `assign ${co} = ${enExpr} && ${boundary};`);
  return lines;
};
GENERATORS.shreg = ({ b, read, out, clk, rst }) => {
  const n = portWidthOf(b, 'q'); const hasEn = hasPort(b, 'en');
  const d = read('d'); const q = out('q'), so = out('so');
  const shiftExpr = n === 1 ? d : `{${q}[${n - 2}:0], ${d}}`;
  const lines = [`always_ff @(posedge ${clk}) begin`, `  if (${rst}) ${q} <= ${lit(0n, n)};`];
  lines.push(hasEn ? `  else if (${read('en')}) ${q} <= ${shiftExpr};` : `  else ${q} <= ${shiftExpr};`);
  lines.push(`end`, '', `assign ${so} = ${q}[${n - 1}];`);
  return lines;
};

// ---------- Memory (DESIGN.md section 4): the inference-friendly pattern vendor tools map to block RAM ----------
// `logic [W-1:0] mem [0:D-1]` + `always_ff @(posedge clk) if (we) mem[waddr] <= wdata;` + a registered or
// combinational read, matching src/model/library.ts's ram/rom/regfile eval()/next() bit for bit: writing and
// reading the same address in the same cycle reads the OLD value (read-before-write), because the write and
// any registered read are both driven off the same edge's pre-edge values, exactly as Verilog NBA semantics
// give for two `always_ff` blocks triggered by the same posedge.
//
// Contents are loaded in an `initial` block (a zeroing `for` loop, then the given values), not a `'{..}'`
// assignment-pattern declaration initializer: Yosys's `read_verilog -sv` (its Verilog-2005-based frontend, even
// with `-sv`) does not parse that syntax. Depth need not be a power of two, so every index into `mem` is
// bounds-guarded against `depth` — except when `depth` exactly fills the address width (the common case, e.g.
// depth 256 with an 8-bit address), where every representable address is already in range and the guard would
// be dead code; `boundsOf` returns null then, and every call site below drops the guard entirely rather than
// compare against a literal that can't itself be represented in the address width (2^addrWidth overflows it).
function memInit(b: Block, w: number, depth: number, mem: string): string[] {
  const vals = parseList(str(b.params, 'contents', ''), w);
  const lines = [`initial begin`, `  for (int rtlp_i = 0; rtlp_i < ${depth}; rtlp_i++) ${mem}[rtlp_i] = ${lit(0n, w)};`];
  vals.slice(0, depth).forEach((v, i) => { if (v !== 0n) lines.push(`  ${mem}[${i}] = ${lit(v, w)};`); });
  lines.push(`end`);
  return lines;
}
/** Null when `depth` exactly fills `addrWidth` (every representable address is in range; no guard needed),
 * else a same-width literal so the comparison never triggers Verilator WIDTHEXPAND against an addr operand
 * narrower than a default (32-bit) unsized literal. */
function boundsOf(depth: number, addrWidth: number): string | null { return depth >= (1 << addrWidth) ? null : lit(BigInt(depth), addrWidth); }
function memRead(mem: string, addr: string, bound: string | null, w: number): string { return bound ? `(${addr} < ${bound}) ? ${mem}[${addr}] : ${lit(0n, w)}` : `${mem}[${addr}]`; }
GENERATORS.ram = ({ b, read, out, clk, rst, alloc }) => {
  const w = portWidthOf(b, 'q'); const depth = num(b.params, 'depth', 256); const aw = portWidthOf(b, 'waddr'); const bound = boundsOf(depth, aw);
  const sync = str(b.params, 'readStyle', 'sync') === 'sync'; const port2 = hasPort(b, 'raddr2');
  const mem = alloc.alloc(`${b.id}_mem`);
  const d = read('d'), waddr = read('waddr'), we = read('we'), raddr = read('raddr'), q = out('q');
  const writeGuard = bound ? `${we} && (${waddr} < ${bound})` : we;
  const lines = [`${declType(w)} ${mem} [0:${depth - 1}];`, ...memInit(b, w, depth, mem), '', `always_ff @(posedge ${clk}) if (${writeGuard}) ${mem}[${waddr}] <= ${d};`, ''];
  const readGen = (addr: string, qq: string): void => {
    if (sync) lines.push(`always_ff @(posedge ${clk}) begin`, `  if (${rst}) ${qq} <= ${lit(0n, w)};`, `  else ${qq} <= ${memRead(mem, addr, bound, w)};`, `end`, '');
    else lines.push(`assign ${qq} = ${memRead(mem, addr, bound, w)};`, '');
  };
  readGen(raddr, q);
  if (port2) readGen(read('raddr2'), out('q2'));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};
GENERATORS.rom = ({ b, read, out, clk, rst, alloc }) => {
  const w = portWidthOf(b, 'q'); const depth = num(b.params, 'depth', 256); const aw = portWidthOf(b, 'raddr'); const bound = boundsOf(depth, aw);
  const sync = str(b.params, 'readStyle', 'async') === 'sync';
  const mem = alloc.alloc(`${b.id}_mem`);
  const raddr = read('raddr'), q = out('q');
  const lines = [`${declType(w)} ${mem} [0:${depth - 1}];`, ...memInit(b, w, depth, mem), ''];
  if (sync) lines.push(`always_ff @(posedge ${clk}) begin`, `  if (${rst}) ${q} <= ${lit(0n, w)};`, `  else ${q} <= ${memRead(mem, raddr, bound, w)};`, `end`);
  else lines.push(`assign ${q} = ${memRead(mem, raddr, bound, w)};`);
  return lines;
};
GENERATORS.regfile = ({ b, read, out, clk, alloc }) => {
  const w = portWidthOf(b, 'q1'); const depth = num(b.params, 'depth', 32); const aw = portWidthOf(b, 'waddr'); const bound = boundsOf(depth, aw);
  const zero = bool(b.params, 'zeroReg');
  const mem = alloc.alloc(`${b.id}_mem`);
  const d = read('d'), waddr = read('waddr'), we = read('we');
  const writeGuard = [we, bound ? `(${waddr} < ${bound})` : null, zero ? `(${waddr} != ${lit(0n, aw)})` : null].filter((x): x is string => !!x).join(' && ');
  const readExpr = (addr: string): string => zero ? `(${addr} == ${lit(0n, aw)}) ? ${lit(0n, w)} : (${memRead(mem, addr, bound, w)})` : memRead(mem, addr, bound, w);
  return [
    `${declType(w)} ${mem} [0:${depth - 1}];`, ...memInit(b, w, depth, mem), '',
    `always_ff @(posedge ${clk}) if (${writeGuard}) ${mem}[${waddr}] <= ${d};`, '',
    `assign ${out('q1')} = ${readExpr(read('raddr1'))};`,
    `assign ${out('q2')} = ${readExpr(read('raddr2'))};`,
  ];
};

// The Sequence block is stimulus for interactive simulation, but it is fully deterministic (a fixed list plus
// an index that only ever counts up), so it emits as ordinary synthesizable hardware: an index register plus a
// combinational ROM lookup, exactly reproducing eval()/next() in library.ts (including the "hold at 0 once past
// the end" behaviour when `repeat` is off). DESIGN.md section 8 records this decision.
function bitsFor(maxInclusive: number): number { return Math.max(1, Math.ceil(Math.log2(maxInclusive + 1))); }
GENERATORS.seq = ({ b, out, clk, rst, alloc }) => {
  const w = portWidthOf(b, 'y'); const repeat = bool(b.params, 'repeat');
  const list = parseList(str(b.params, 'values'), w);
  const y = out('y');
  if (list.length === 0) return [`assign ${y} = ${lit(0n, w)};`];
  const n = list.length;
  const idxW = repeat ? bitsFor(n - 1) : bitsFor(n);
  const idx = alloc.alloc(`${b.id}_idx`);
  return [
    `${declType(idxW)} ${idx} = ${lit(0n, idxW)};`,
    '',
    `always_ff @(posedge ${clk}) begin`,
    `  if (${rst}) ${idx} <= ${lit(0n, idxW)};`,
    repeat
      ? `  else ${idx} <= (${idx} == ${lit(BigInt(n - 1), idxW)}) ? ${lit(0n, idxW)} : ${idx} + 1'b1;`
      : `  else if (${idx} < ${lit(BigInt(n), idxW)}) ${idx} <= ${idx} + 1'b1;`,
    `end`,
    '',
    `always_comb begin`,
    `  case (${idx})`,
    ...list.map((v, i) => `    ${i}: ${y} = ${lit(v, w)};`),
    `    default: ${y} = ${lit(0n, w)};`,
    `  endcase`,
    `end`,
  ];
};

// A module instance (DESIGN.md task 1/4): a named instantiation of another design module, with `clk`/`rst`
// wired through like every generated module's own ports and every other pin connected by name. The port list
// comes from `read`/`out`, which resolve through the block's own `ports()` (design/library.ts's `instance`
// definition), so it is always exactly the ports the target module currently has — a stale connection to a
// renamed/removed port would already have been rejected as a "dangling" netlist error before emission runs.
GENERATORS.instance = ({ b, read, out, clk, rst, design, instName }) => {
  const childKey = str(b.params, 'module', '');
  if (!childKey || !design.modules[childKey]) throw new Error(`Instance "${b.id}" refers to a module that does not exist.`);
  const ports = portsOfBlock(b);
  const conn = [`.${clk}(${clk})`, `.${rst}(${rst})`, ...ports.map(p => `.${p.name}(${p.dir === 'in' ? read(p.name) : out(p.name)})`)];
  return [`${sanitize(childKey)} ${instName} (${conn.join(', ')});`];
};

// ---------- module/design text ----------
export interface EmitOptions { sourceFile?: string }

export function header(design: Design, opts: EmitOptions = {}): string {
  return [
    `// Generated by RTL Playground ${TOOL_VERSION} — do not edit by hand.`,
    `// Source: ${opts.sourceFile ?? `${design.name}.rtlp`}`,
    `// Hand-written emitter (DESIGN.md section 8): synchronous active-high reset, SystemVerilog only.`,
    '`timescale 1ns/1ps',
    '',
  ].join('\n');
}

function moduleText(plan: ModulePlan): string {
  const portLines = [`input  logic ${plan.clk}`, `input  logic ${plan.rst}`,
    ...plan.ports.map(p => `${p.dir === 'in' ? 'input ' : 'output'} ${declType(p.width)} ${p.name}`)];
  const ports = portLines.map(l => '  ' + l).join(',\n');
  // A register's `logic q = INIT;` is both given an initial value and driven by its own always_ff — deliberate,
  // so a testbench sees the exact power-on state without a reset pulse — which Verilator's PROCASSINIT flags by
  // default; suppressed for the rest of the file rather than disabling the initial value. A block whose output
  // the schematic never wires anywhere (e.g. an unused counter wrap flag), or a purely combinational module's
  // unused clk/rst ports, are legitimate designs, not bugs, so UNUSEDSIGNAL is suppressed too. A hierarchical
  // design (DESIGN.md task 4) emits every module into one file named after `design.top`, so any other module
  // in it (an instantiated child) legitimately doesn't match the filename — DECLFILENAME is suppressed for the
  // same "not a bug" reason. All three must come before the port list itself to cover it, so they sit above
  // `module`, not inside its body.
  const pragmas = ['/* verilator lint_off PROCASSINIT */', '/* verilator lint_off UNUSEDSIGNAL */', '/* verilator lint_off DECLFILENAME */'];
  return [...pragmas, `module ${plan.svName} (`, ports, `);`, '', plan.body, `endmodule`, ''].join('\n');
}

/** One module's text, no header: the module itself for a schematic/fsm module, or the raw text for an
 * HDL-source module (DESIGN.md section 2: an HDL module's text is its own source of truth). */
function bodyTextOf(design: Design, key: string): string {
  const m = design.modules[key];
  if (!m) throw new Error(`Module "${key}" not found.`);
  if (m.source === 'hdl') {
    if (m.text === undefined) throw new Error(`Module "${key}" is HDL-source but has no text.`);
    return `// module "${key}" is hand-written HDL, passed through unchanged:\n${m.text.trimEnd()}\n`;
  }
  return moduleText(planModule(design, key));
}

export function emitModule(design: Design, key: string, opts: EmitOptions = {}): string {
  return header(design, opts) + bodyTextOf(design, key);
}

export function emitDesign(design: Design, opts: EmitOptions = {}): string {
  const keys = Object.keys(design.modules);
  if (!keys.length) throw new Error('The design has no modules.');
  return header(design, opts) + keys.map(k => bodyTextOf(design, k)).join('\n\n');
}
