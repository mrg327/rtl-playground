// Module hierarchy (DESIGN.md task 1/2): port derivation, flattening, recursion detection, and simulation
// equivalence between a hierarchical design and a hand-flattened one built directly.
import { describe, it, expect } from 'vitest';
import type { Design, Module } from '../src/model/types';
import { emptyDesign, emptyModule } from '../src/model/types';
import { defOf, setActiveDesign } from '../src/model/library';
import { moduleExternalPorts, findRecursiveModules, flattenModule } from '../src/model/hierarchy';
import { Simulator } from '../src/sim/engine';
import { serialize, deserialize } from '../src/model/serialize';
import { mod, blk, wire } from './helpers';

/** A one-bit full adder module: sum = a^b^cin, cout = ab + cin(a^b) — the same logic as examples/02. */
function fullAdderModule(): Module {
  const m = mod();
  blk(m, 'a', 'in', {}, 0, 0); blk(m, 'b', 'in', {}, 0, 60); blk(m, 'cin', 'in', {}, 0, 120);
  blk(m, 'x1', 'xor', { n: 2 }, 100, 0); wire(m, 'a.y', 'x1.i0'); wire(m, 'b.y', 'x1.i1');
  blk(m, 'x2', 'xor', { n: 2 }, 200, 0); wire(m, 'x1.y', 'x2.i0'); wire(m, 'cin.y', 'x2.i1');
  blk(m, 'a1', 'and', { n: 2 }, 200, 60); wire(m, 'x1.y', 'a1.i0'); wire(m, 'cin.y', 'a1.i1');
  blk(m, 'a2', 'and', { n: 2 }, 100, 60); wire(m, 'a.y', 'a2.i0'); wire(m, 'b.y', 'a2.i1');
  blk(m, 'o1', 'or', { n: 2 }, 300, 60); wire(m, 'a1.y', 'o1.i0'); wire(m, 'a2.y', 'o1.i1');
  blk(m, 'sum', 'out', {}, 400, 0); wire(m, 'x2.y', 'sum.a');
  blk(m, 'cout', 'out', {}, 400, 60); wire(m, 'o1.y', 'cout.a');
  return m;
}

function designWithInstance(): Design {
  const d = emptyDesign('hier');
  d.modules.full_adder = fullAdderModule();
  const top = emptyModule(); d.modules.top = top;
  blk(top, 'a', 'in', {}, 0, 0); blk(top, 'b', 'in', {}, 0, 60); blk(top, 'cin', 'in', {}, 0, 120);
  blk(top, 'u1', 'instance', { module: 'full_adder' }, 200, 0);
  wire(top, 'a.y', 'u1.a'); wire(top, 'b.y', 'u1.b'); wire(top, 'cin.y', 'u1.cin');
  blk(top, 'sum', 'out', {}, 400, 0); wire(top, 'u1.sum', 'sum.a');
  blk(top, 'cout', 'out', {}, 400, 60); wire(top, 'u1.cout', 'cout.a');
  return d;
}

describe('hierarchy: port derivation', () => {
  it('derives ports from in/out blocks, named by label else id, in declared order', () => {
    const m = fullAdderModule();
    expect(moduleExternalPorts(m)).toEqual([
      { name: 'a', dir: 'in', width: 1 }, { name: 'b', dir: 'in', width: 1 }, { name: 'cin', dir: 'in', width: 1 },
      { name: 'sum', dir: 'out', width: 1 }, { name: 'cout', dir: 'out', width: 1 },
    ]);
  });
  it('prefers a block label over its id, and reflects width', () => {
    const m = mod(); const b = blk(m, 'x', 'in', { width: 8 }); b.label = 'data_in';
    expect(moduleExternalPorts(m)).toEqual([{ name: 'data_in', dir: 'in', width: 8 }]);
  });
  it("the instance block's own ports() mirrors moduleExternalPorts of its target, via the active-design pointer", () => {
    const d = designWithInstance(); setActiveDesign(d);
    const u1 = d.modules.top.blocks.find(b => b.id === 'u1')!;
    const ports = defOf('instance').ports(u1.params);
    expect(ports.map(p => ({ name: p.name, dir: p.dir, width: p.width }))).toEqual(moduleExternalPorts(d.modules.full_adder));
    setActiveDesign(null);
    expect(defOf('instance').ports(u1.params)).toEqual([]); // gracefully empty without an active design
  });
});

describe('hierarchy: flattenModule', () => {
  it('a non-hierarchical module flattens to itself unchanged', () => {
    const d = emptyDesign('flat'); d.modules.top = fullAdderModule();
    const { module, problems } = flattenModule(d, 'top');
    expect(problems).toEqual([]);
    expect(module.blocks.map(b => b.id).sort()).toEqual(fullAdderModule().blocks.map(b => b.id).sort());
    expect(module.blocks.every(b => !b.id.includes('/'))).toBe(true);
  });

  it('expands an instance under a hierarchical id and simulates equivalently to a hand-flattened module', () => {
    const d = designWithInstance();
    const { module, problems } = flattenModule(d, 'top');
    expect(problems).toEqual([]);
    expect(module.blocks.some(b => b.id === 'u1/x1' && b.type === 'xor')).toBe(true);
    expect(module.blocks.some(b => b.id === 'u1/a' && b.type === 'buf')).toBe(true); // the child's `in` port, bridged
    expect(module.blocks.some(b => b.id === 'u1/sum' && b.type === 'buf')).toBe(true); // the child's `out` port, bridged
    expect(module.blocks.some(b => b.id === 'a' && b.type === 'in')).toBe(true); // top's own ports stay real in/out

    const hier = new Simulator(module, problems);
    const hand = new Simulator(fullAdderModule()); // the "hand-flattened equivalent" DESIGN.md asks to check against
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let cin = 0; cin < 2; cin++) {
      hier.compiled.netlist.blocks.get('a')!.params.value = a; hier.compiled.netlist.blocks.get('b')!.params.value = b; hier.compiled.netlist.blocks.get('cin')!.params.value = cin;
      hand.compiled.netlist.blocks.get('a')!.params.value = a; hand.compiled.netlist.blocks.get('b')!.params.value = b; hand.compiled.netlist.blocks.get('cin')!.params.value = cin;
      expect(hier.value('u1/sum.a')).toBe(hand.value('sum.a'));
      expect(hier.value('u1/cout.a')).toBe(hand.value('cout.a'));
    }
  });

  it('addresses a traced signal inside an instance with a hierarchical key', () => {
    const d = designWithInstance();
    d.modules.full_adder.blocks.find(b => b.id === 'x1')!.trace = true;
    const { traced } = flattenModule(d, 'top');
    expect(traced.some(t => t.key === 'u1/x1.y')).toBe(true);
  });

  it('reports and stops at recursion instead of looping forever', () => {
    const d = emptyDesign('rec');
    d.modules.top = mod(); blk(d.modules.top, 'u1', 'instance', { module: 'top' });
    const problems = findRecursiveModules(d);
    expect(problems.has('top')).toBe(true);
    const { problems: flatProblems, module } = flattenModule(d, 'top');
    expect(flatProblems.some(p => p.code === 'recursion')).toBe(true);
    expect(module.blocks.length).toBeLessThan(50); // did not expand forever
  });

  it('reports indirect (two-module) recursion', () => {
    const d = emptyDesign('rec2');
    d.modules.a = mod(); blk(d.modules.a, 'u', 'instance', { module: 'b' });
    d.modules.b = mod(); blk(d.modules.b, 'u', 'instance', { module: 'a' });
    d.modules.top = mod();
    const bad = findRecursiveModules(d);
    expect(bad.has('a')).toBe(true); expect(bad.has('b')).toBe(true);
  });

  it('reports a missing target module without crashing', () => {
    const d = emptyDesign('missing'); d.modules.top = mod(); blk(d.modules.top, 'u1', 'instance', { module: 'nope' });
    const { problems, module } = flattenModule(d, 'top');
    expect(problems.some(p => p.code === 'missing-module')).toBe(true);
    expect(module.blocks.length).toBe(0);
  });

  it('drops a wire whose instance port was renamed away, as a dangling problem, instead of crashing', () => {
    const d = designWithInstance();
    d.modules.full_adder.blocks.find(b => b.id === 'sum')!.label = 'renamed_sum'; // 'sum' port no longer exists
    const { problems, module } = flattenModule(d, 'top');
    expect(problems.some(p => p.code === 'dangling')).toBe(true);
    expect(module.blocks.some(b => b.id === 'sum')).toBe(true); // top's own `sum` output block is untouched
    expect(() => new Simulator(module, problems)).not.toThrow();
  });
});

describe('hierarchy: serialization round-trips instance blocks', () => {
  it('round-trips an instance block and its module param', () => {
    const d = designWithInstance();
    const d2 = deserialize(serialize(d));
    const u1 = d2.modules.top.blocks.find(b => b.id === 'u1')!;
    expect(u1.type).toBe('instance');
    expect(u1.params.module).toBe('full_adder');
    expect(Object.keys(d2.modules).sort()).toEqual(['full_adder', 'top']);
  });
});

describe('instance pins on a sheet read the flattened port buffers', () => {
  it('shows each absdiff output on the top sheet (examples/11)', async () => {
    const { readFileSync } = await import('node:fs');
    const { Store } = await import('../src/ui/store');
    const s = new Store(deserialize(readFileSync(new URL('../../examples/11-sad-hierarchy.rtlp', import.meta.url), 'utf8')));
    const val = (pin: string) => { const k = s.hierPin(pin); const i = k === null ? undefined : s.sim.compiled.pinIndex.get(k); return i === undefined ? undefined : s.sim.values(s.sim.cur)[i]; };
    // inputs on the example sheet are a0..a3 = 10..13 and b0..b3 = 3, so each |a-b| is 7..10
    const outs = s.module.blocks.filter(b => b.type === 'instance').map(b => val(`${b.id}.d`));
    expect(outs).toEqual([7n, 8n, 9n, 10n]);
    const inst = s.module.blocks.find(b => b.type === 'instance')!;
    expect(val(`${inst.id}.a`)).toBe(10n);
  });
});

describe('input stimulus after flattening', () => {
  it('reaches the running simulator without a recompile (examples/06 counter enable)', async () => {
    const { readFileSync } = await import('node:fs');
    const { Store } = await import('../src/ui/store');
    const s = new Store(deserialize(readFileSync(new URL('../../examples/06-counter.rtlp', import.meta.url), 'utf8')));
    const en = s.module.blocks.find(b => b.type === 'in')!;
    const counter = s.module.blocks.find(b => b.type === 'counter')!;
    const q = () => (s.sim.frame.states.get(counter.id) as { q: bigint }).q;
    s.stimulus(() => { en.params.value = 1n; }); s.sim.step(); s.sim.step();
    const held = q();
    s.stimulus(() => { en.params.value = 0n; }); s.sim.step(); s.sim.step();
    expect(q()).toBe(held); // disabled: holds
  });
});
