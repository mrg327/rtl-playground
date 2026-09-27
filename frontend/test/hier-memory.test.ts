// A memory inside a module instance: the motion estimator's shape (a buffer per processing element).
// Hierarchy flattens instances to `u0/ram1`, and memory state is keyed by block id, so two instances
// must keep independent contents, in the simulator and in the exported SystemVerilog.
import { describe, it, expect } from 'vitest';
import { setActiveDesign } from '../src/model/library';
import { runAll } from '../src/sim/tests';
import { emitDesign } from '../src/hdl/emit';
import { laneDesign } from './lane-design';

describe('memories inside module instances', () => {
  it('simulates two instances with independent RAM contents', () => {
    const d = laneDesign(); setActiveDesign(d);
    const [r] = runAll(d);
    expect(r.error ?? null).toBeNull();
    expect(r.rows.filter(x => !x.skipped).map(x => x.ok)).toEqual([true, true, true, true]);
    expect(r.passed).toBe(true);
  });
  it('emits the child module once, with its memory, instantiated twice', () => {
    const d = laneDesign(); setActiveDesign(d);
    const sv = emitDesign(d);
    expect(sv.match(/^module lane\b/gm)?.length).toBe(1);
    expect(sv).toMatch(/logic \[7:0\] \w+ \[0:15\];/);
    expect(sv).toMatch(/lane u0 \(/); expect(sv).toMatch(/lane u1 \(/);
  });
});

describe('instance names in the emitted SystemVerilog', () => {
  it('never lets a net take an instance name', () => {
    const d = laneDesign(); setActiveDesign(d);
    const top = emitDesign(d).split(/^module lane\b/m)[0];
    expect(top).toMatch(/lane u0 \(.*\.q\(u0_q\)\);/);
    expect(top).not.toMatch(/logic \[7:0\] u0;/);
  });
});

describe('memory viewer inside an instance', () => {
  it('reads the flattened instance state, separately per instance', async () => {
    const { Store } = await import('../src/ui/store');
    const { memoryRows } = await import('../src/ui/memview');
    const d = laneDesign(); const s = new Store(d);
    const set = (id: string, v: bigint) => s.stimulus(() => { s.module.blocks.find(b => b.id === id)!.params.value = v; });
    set('d', 11n); set('wa', 2n); set('we0', 1n); s.sim.step();
    set('d', 22n); set('we0', 0n); set('we1', 1n); s.sim.step();
    const ram = d.modules.lane.blocks.find(b => b.id === 'ram1')!;
    expect(memoryRows(s.sim, ram, 'u0/ram1')![2].value).toBe(11n);
    expect(memoryRows(s.sim, ram, 'u1/ram1')![2].value).toBe(22n);
  });
});
