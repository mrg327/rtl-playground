// Regression coverage for a real bug found while screenshotting the memory viewer: Simulator.value() only
// ever populates a block's OUTPUT pin slots (see evaluate() in sim/engine.ts), so reading a memory's own
// *input* pin (its read/write address, its write-enable) directly by name always comes back 0 regardless of
// what actually drives it. memoryRows() must resolve those through the driving net instead, the same way
// src/ui/canvas.ts already does for rendering. Using an 'in' block whose value differs from 0 as the driver
// makes a regression to the naive (always-0) behaviour fail loudly instead of accidentally passing.
import { describe, it, expect } from 'vitest';
import { Simulator } from '../src/sim/engine';
import { memoryRows, memoryInfo } from '../src/ui/memview';
import { mod, blk, wire } from './helpers';

describe('memview', () => {
  it('highlights the address actually driven onto raddr/waddr, not pin index 0', () => {
    const m = mod();
    const d = blk(m, 'd', 'in', { width: 8, value: 9 }); const waddr = blk(m, 'waddr', 'in', { width: 2, value: 2 });
    const we = blk(m, 'we', 'in', { width: 1, value: 1 }); const raddr = blk(m, 'raddr', 'in', { width: 2, value: 3 });
    const ram = blk(m, 'ram1', 'ram', { width: 8, depth: 4, readStyle: 'async' });
    wire(m, 'd.y', 'ram1.d'); wire(m, 'waddr.y', 'ram1.waddr'); wire(m, 'we.y', 'ram1.we'); wire(m, 'raddr.y', 'ram1.raddr');
    const sim = new Simulator(m);
    expect(memoryInfo(ram)).toEqual({ width: 8, depth: 4 });

    // Cycle 0, live: raddr=3 should be flagged read, nothing flagged write yet (no edge has happened).
    let rows = memoryRows(sim, ram)!;
    expect(rows.find(r => r.read)?.addr).toBe(3);
    expect(rows.some(r => r.write)).toBe(false);

    // Step: writes d=9 into waddr=2. The new (live) frame's read address is still 3 (unchanged), and address 2
    // is now flagged as written getting here.
    sim.step();
    rows = memoryRows(sim, ram)!;
    expect(rows.find(r => r.write)?.addr).toBe(2);
    expect(rows.find(r => r.write)?.value).toBe(9n);
    expect(rows.find(r => r.read)?.addr).toBe(3);

    // Change raddr and we before the next step; the write moves with waddr, and a we=0 cycle flags no write.
    raddr.params.value = 1; we.params.value = 0; waddr.params.value = 0; d.params.value = 5;
    sim.step();
    rows = memoryRows(sim, ram)!;
    expect(rows.some(r => r.write)).toBe(false); // we was 0 this edge
    expect(rows.find(r => r.read)?.addr).toBe(1);

    // Stepping back replays the earlier frame's own write/read flags, not the latest live ones.
    sim.back();
    rows = memoryRows(sim, ram)!;
    expect(rows.find(r => r.write)?.addr).toBe(2);
  });
  it('rom never flags a write, even if its block id happens to share a "we"-shaped net elsewhere', () => {
    const m = mod();
    const a = blk(m, 'a', 'in', { width: 2, value: 1 });
    const rom = blk(m, 'rom1', 'rom', { width: 8, depth: 4, readStyle: 'async', contents: '10 20 30 40' });
    wire(m, 'a.y', 'rom1.raddr');
    const sim = new Simulator(m); sim.step(); sim.step();
    const rows = memoryRows(sim, rom)!;
    expect(rows.some(r => r.write)).toBe(false);
    expect(rows.find(r => r.read)?.addr).toBe(1);
    expect(rows.find(r => r.read)?.value).toBe(20n);
  });
  it('returns null for a non-memory block', () => {
    const m = mod(); const r = blk(m, 'r', 'reg', { width: 4 });
    const sim = new Simulator(m);
    expect(memoryRows(sim, r)).toBeNull();
    expect(memoryInfo(r)).toBeNull();
  });
});
