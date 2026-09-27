import { describe, it, expect } from 'vitest';
import { Simulator } from '../src/sim/engine';
import { mod, blk, wire } from './helpers';
describe('engine', () => {
  it('evaluates regardless of block order and detects loops', () => {
    const m = mod(); blk(m, 'o', 'out'); blk(m, 'n', 'not'); const a = blk(m, 'a', 'in', { value: 1 }); wire(m, 'a.y', 'n.a'); wire(m, 'n.y', 'o.a');
    const sim = new Simulator(m); expect(sim.value('n.y')).toBe(0n); a.params.value = 0; expect(sim.value('n.y')).toBe(1n);
    const l = mod(); blk(l, 'g', 'and'); blk(l, 'n', 'not'); wire(l, 'g.y', 'n.a'); wire(l, 'n.y', 'g.i0'); const s2 = new Simulator(l); expect(s2.compiled.problems.some(p => p.code === 'loop')).toBe(true); expect(() => s2.values()).not.toThrow();
  });
  it('pipelines through registers and honours enable and reset', () => {
    const m = mod(); const a = blk(m, 'a', 'in', { width: 8, value: 5 }); blk(m, 'r1', 'reg', { width: 8 }); blk(m, 'r2', 'reg', { width: 8 }); wire(m, 'a.y', 'r1.d'); wire(m, 'r1.q', 'r2.d');
    const sim = new Simulator(m); expect(sim.value('r2.q')).toBe(0n); sim.step(); expect(sim.value('r1.q')).toBe(5n); expect(sim.value('r2.q')).toBe(0n); sim.step(); expect(sim.value('r2.q')).toBe(5n);
    a.params.value = 9; sim.rst = true; sim.step(); expect(sim.value('r1.q')).toBe(0n); sim.rst = false; sim.step(); expect(sim.value('r1.q')).toBe(9n);
  });
  it('time travel: back, goto, branch, sampled inputs', () => {
    const m = mod(); const a = blk(m, 'a', 'in', { width: 4, value: 1 }); blk(m, 'c', 'counter', { width: 4, en: true }); wire(m, 'a.y', 'c.en');
    const sim = new Simulator(m); for (let i = 0; i < 5; i++) sim.step(); expect(sim.cycle).toBe(5); expect(sim.value('c.q')).toBe(5n);
    sim.back(); sim.back(); expect(sim.cycle).toBe(3); expect(sim.value('c.q')).toBe(3n); expect(sim.live).toBe(false);
    a.params.value = 0; expect(sim.value('a.y')).toBe(1n); // past frames replay the sampled input
    sim.goto(1); expect(sim.cycle).toBe(1);
    sim.step(); expect(sim.frames.length).toBe(3); expect(sim.cycle).toBe(2); expect(sim.live).toBe(true);
    sim.powerOn(); expect(sim.frames.length).toBe(1); expect(sim.cycle).toBe(0);
  });
  it('recompile keeps history and initialises new blocks', () => {
    const m = mod(); blk(m, 'c', 'counter', { width: 4, en: false }); const sim = new Simulator(m); sim.step(); sim.step();
    blk(m, 'r', 'reg', { width: 4, init: 3 }); wire(m, 'c.q', 'r.d'); sim.recompile(m); expect(sim.frames.length).toBe(3); expect(sim.value('r.q')).toBe(3n); expect(sim.value('c.q')).toBe(2n);
  });
  it('memory: back-stepping and scrubbing across writes replays contents correctly', () => {
    const m = mod();
    const d = blk(m, 'd', 'in', { width: 8, value: 0 }); const waddr = blk(m, 'waddr', 'in', { width: 2, value: 0 });
    const we = blk(m, 'we', 'in', { width: 1, value: 0 }); const raddr = blk(m, 'raddr', 'in', { width: 2, value: 0 });
    blk(m, 'ram1', 'ram', { width: 8, depth: 4, readStyle: 'async' });
    wire(m, 'd.y', 'ram1.d'); wire(m, 'waddr.y', 'ram1.waddr'); wire(m, 'we.y', 'ram1.we'); wire(m, 'raddr.y', 'ram1.raddr');
    const sim = new Simulator(m);
    const seen: bigint[] = []; const record = () => seen.push(sim.value('ram1.q'));

    record(); // cycle 0, addr 0 = 0
    sim.step(); // -> cycle 1, no write (we was 0)
    d.params.value = 5; waddr.params.value = 1; we.params.value = 1; raddr.params.value = 1;
    record(); // cycle 1 (live), reading addr 1 before the write lands = 0
    sim.step(); // -> cycle 2: mem[1] = 5
    record(); // cycle 2, addr 1 = 5
    we.params.value = 0; d.params.value = 9; waddr.params.value = 2;
    sim.step(); // -> cycle 3: no write (we = 0); addr still 1
    record(); // cycle 3, addr 1 = 5 (unchanged)
    we.params.value = 1;
    sim.step(); // -> cycle 4: mem[2] = 9
    raddr.params.value = 2;
    record(); // cycle 4, addr now 2 = 9
    expect(seen).toEqual([0n, 0n, 5n, 5n, 9n]);
    expect(sim.cycle).toBe(4);

    // Stepping back one cycle at a time must replay exactly what was live at each cycle, not the final contents.
    sim.back(); expect(sim.cycle).toBe(3); expect(sim.value('ram1.q')).toBe(5n);
    sim.back(); expect(sim.cycle).toBe(2); expect(sim.value('ram1.q')).toBe(5n);
    sim.back(); expect(sim.cycle).toBe(1); expect(sim.value('ram1.q')).toBe(0n);
    sim.back(); expect(sim.cycle).toBe(0); expect(sim.value('ram1.q')).toBe(0n);

    // Scrubbing to an arbitrary frame (not just single-stepping back) and jumping with goto() also read correctly.
    expect(sim.value('ram1.q', 4)).toBe(9n);
    expect(sim.value('ram1.q', 2)).toBe(5n);
    sim.goto(4); expect(sim.cycle).toBe(4); expect(sim.value('ram1.q')).toBe(9n);
    sim.goto(0); expect(sim.value('ram1.q')).toBe(0n);
    sim.goto(2); expect(sim.value('ram1.q')).toBe(5n);
  });
  it('sequence stimulus advances and resets', () => {
    const m = mod(); blk(m, 's', 'seq', { width: 1, values: '0110' }); const sim = new Simulator(m); const seen: bigint[] = []; for (let i = 0; i < 5; i++) { seen.push(sim.value('s.y')); sim.step(); }
    expect(seen).toEqual([0n, 1n, 1n, 0n, 0n]); sim.rst = true; sim.step(); sim.rst = false; expect(sim.value('s.y')).toBe(0n); sim.step(); expect(sim.value('s.y')).toBe(1n);
  });
});
