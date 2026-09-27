import { describe, it, expect } from 'vitest';
import { LIB, defaultParams, defOf } from '../src/model/library';
const ev = (type: string, ins: (bigint | number)[], params: Record<string, unknown> = {}, state?: unknown) => defOf(type).eval(ins.map(BigInt), { ...defaultParams(type), ...params }, state);
describe('library', () => {
  it('every block has consistent defaults', () => { for (const [t, d] of Object.entries(LIB)) { const p = defaultParams(t); if (t !== 'instance') expect(d.ports(p).length).toBeGreaterThan(0); expect(d.size(p).w).toBeGreaterThan(0); expect(() => d.body(p, d.size(p))).not.toThrow(); const ins = d.ports(p).filter(x => x.dir === 'in').map(() => 0n); expect(() => d.eval(ins, p, d.init?.(p))).not.toThrow(); } });
  it('gates', () => {
    expect(ev('and', [1, 1])).toEqual([1n]); expect(ev('and', [1, 0])).toEqual([0n]); expect(ev('and', [1, 1, 0], { n: 3 })).toEqual([0n]);
    expect(ev('or', [0, 0])).toEqual([0n]); expect(ev('or', [0, 1])).toEqual([1n]); expect(ev('xor', [1, 1])).toEqual([0n]); expect(ev('xor', [1, 0])).toEqual([1n]);
    expect(ev('nand', [1, 1])).toEqual([0n]); expect(ev('nor', [0, 0])).toEqual([1n]); expect(ev('xnor', [1, 1])).toEqual([1n]);
    expect(ev('and', [0b1100, 0b1010], { width: 4 })).toEqual([0b1000n]); expect(ev('not', [0b1010], { width: 4 })).toEqual([0b0101n]); expect(ev('not', [1])).toEqual([0n]); expect(ev('buf', [1])).toEqual([1n]);
  });
  it('wiring', () => {
    expect(ev('split', [0xa5], { widths: '4 4' })).toEqual([5n, 10n]); expect(ev('join', [5, 10], { widths: '4 4' })).toEqual([0xa5n]);
    expect(ev('split', [0b110], { widths: '1 1 6' })).toEqual([0n, 1n, 1n]);
    expect(ev('ext', [1], { inw: 1, outw: 8 })).toEqual([1n]); expect(ev('ext', [0b1010], { inw: 4, outw: 8, signed: true })).toEqual([0xfan]); expect(ev('ext', [0b0110], { inw: 4, outw: 8, signed: true })).toEqual([6n]);
    expect(ev('slice', [0xa5], { width: 8, hi: 7, lo: 4 })).toEqual([0xan]); expect(ev('slice', [0xa5], { width: 8, hi: 0, lo: 0 })).toEqual([1n]);
  });
  it('arithmetic', () => {
    expect(ev('add', [200, 100], { width: 8, cout: true })).toEqual([44n, 1n]); expect(ev('add', [1, 2], { width: 8, cout: false })).toEqual([3n]); expect(ev('add', [1, 2, 1], { width: 8, cin: true, cout: true })).toEqual([4n, 0n]);
    expect(ev('sub', [5, 7], { width: 8 })).toEqual([254n, 1n]); expect(ev('sub', [7, 5], { width: 8 })).toEqual([2n, 0n]);
    expect(ev('mul', [200, 2], { width: 8 })).toEqual([400n]); expect(ev('mul', [255, 2], { width: 8, signed: true })).toEqual([(1n << 16n) - 2n]);
    for (const [op, a, b, r] of [['eq', 3, 3, 1], ['ne', 3, 3, 0], ['lt', 2, 3, 1], ['le', 3, 3, 1], ['gt', 4, 3, 1], ['ge', 2, 3, 0]] as [string, number, number, number][]) expect(ev('cmp', [a, b], { width: 8, op })).toEqual([BigInt(r)]);
    expect(ev('cmp', [255, 1], { width: 8, op: 'lt', signed: true })).toEqual([1n]); expect(ev('cmp', [255, 1], { width: 8, op: 'lt' })).toEqual([0n]);
    expect(ev('mux', [3, 5, 1], { n: 2, width: 8 })).toEqual([5n]); expect(ev('mux', [3, 5, 9, 12, 2], { n: 4, width: 8 })).toEqual([9n]); expect(ev('mux', [3, 5, 9, 3], { n: 3, width: 8 })).toEqual([0n]);
    const alu = (a: number, b: number, op: number) => ev('alu', [a, b, op], { width: 8 });
    expect(alu(12, 5, 0)).toEqual([17n, 0n]); expect(alu(12, 5, 1)).toEqual([7n, 0n]); expect(alu(12, 5, 2)).toEqual([4n, 0n]); expect(alu(12, 5, 3)).toEqual([13n, 0n]); expect(alu(12, 5, 4)).toEqual([9n, 0n]); expect(alu(12, 5, 5)).toEqual([0n, 1n]); expect(alu(250, 5, 5)).toEqual([1n, 0n]); expect(alu(12, 2, 6)).toEqual([48n, 0n]); expect(alu(12, 2, 7)).toEqual([3n, 0n]);
    expect(ev('dec', [2], { bits: 2 })).toEqual([0n, 0n, 1n, 0n]); expect(ev('dec', [2, 0], { bits: 2, en: true })).toEqual([0n, 0n, 0n, 0n]);
    expect(ev('enc', [0b0110], { bits: 2 })).toEqual([2n, 1n]); expect(ev('enc', [0], { bits: 2 })).toEqual([0n, 0n]);
    expect(ev('shift', [3], { width: 8, dir: 'left', by: '2' })).toEqual([12n]); expect(ev('shift', [0x80], { width: 8, dir: 'sra', by: '1' })).toEqual([0xc0n]); expect(ev('shift', [0x80, 3], { width: 8, dir: 'right', by: '' })).toEqual([0x10n]);
    expect(ev('reduce', [0xff], { width: 8, op: 'and' })).toEqual([1n]); expect(ev('reduce', [0x7f], { width: 8, op: 'and' })).toEqual([0n]); expect(ev('reduce', [0], { width: 8, op: 'or' })).toEqual([0n]); expect(ev('reduce', [0b0111], { width: 4, op: 'xor' })).toEqual([1n]);
  });
  it('sequential', () => {
    const reg = defOf('reg'); const p = { ...defaultParams('reg'), width: 8, en: true, init: 7 };
    expect(reg.init!(p)).toEqual({ q: 7n }); expect(reg.next!([42n, 1n], p, { q: 7n }, false)).toEqual({ q: 42n }); expect(reg.next!([42n, 0n], p, { q: 7n }, false)).toEqual({ q: 7n }); expect(reg.next!([42n, 1n], p, { q: 9n }, true)).toEqual({ q: 7n });
    expect(reg.next!([42n], { ...p, en: false, rst: 'none' }, { q: 9n }, true)).toEqual({ q: 42n });
    const cnt = defOf('counter'); const cp = { ...defaultParams('counter'), width: 2, en: true };
    expect(cnt.next!([1n], cp, { q: 3n }, false)).toEqual({ q: 0n }); expect(cnt.next!([0n], cp, { q: 3n }, false)).toEqual({ q: 3n }); expect(cnt.eval([1n], cp, { q: 3n })).toEqual([3n, 1n]); expect(cnt.eval([0n], cp, { q: 3n })).toEqual([3n, 0n]);
    expect(cnt.next!([1n], { ...cp, down: true }, { q: 0n }, false)).toEqual({ q: 3n }); expect(cnt.next!([1n, 1n, 2n], { ...cp, load: true }, { q: 0n }, false)).toEqual({ q: 2n });
    const sr = defOf('shreg'); const sp = { ...defaultParams('shreg'), len: 4 };
    expect(sr.next!([1n], sp, { q: 0b0101n }, false)).toEqual({ q: 0b1011n }); expect(sr.eval([0n], sp, { q: 0b1011n })).toEqual([0b1011n, 1n]);
    const seq = defOf('seq'); const qp = { ...defaultParams('seq'), width: 1, values: '0110', repeat: false };
    expect(seq.eval([], qp, { idx: 1 })).toEqual([1n]); expect(seq.eval([], qp, { idx: 4 })).toEqual([0n]); expect(seq.eval([], { ...qp, repeat: true }, { idx: 5 })).toEqual([1n]); expect(seq.next!([], qp, { idx: 2 }, false)).toEqual({ idx: 3 }); expect(seq.next!([], qp, { idx: 2 }, true)).toEqual({ idx: 0 });
    expect(ev('in', [], { width: 4, value: '9' })).toEqual([9n]); expect(ev('const', [], { width: 8, value: "8'hF0" })).toEqual([240n]);
  });
  it('memory: ram async/sync read, write-then-read (read-before-write), COW, reset leaves contents', () => {
    const ram = defOf('ram');
    const pAsync = { ...defaultParams('ram'), width: 8, depth: 4, readStyle: 'async', contents: '10 20 30 40' };
    const s0 = ram.init!(pAsync) as { mem: bigint[] };
    expect(s0.mem).toEqual([10n, 20n, 30n, 40n]);
    // async read is purely combinational on raddr, ignoring d/waddr/we
    expect(ram.eval([0n, 0n, 0n, 2n], pAsync, s0)).toEqual([30n]);
    // write address 2 while reading address 2 in the same cycle: eval() (this cycle's output) still sees the OLD value
    const ins = [99n, 2n, 1n, 2n]; // d, waddr, we, raddr
    expect(ram.eval(ins, pAsync, s0)).toEqual([30n]);
    const s1 = ram.next!(ins, pAsync, s0, false) as { mem: bigint[] };
    expect(s1.mem).toEqual([10n, 20n, 99n, 40n]); // now written
    expect(s0.mem).toEqual([10n, 20n, 30n, 40n]); // old snapshot untouched (copy-on-write)
    expect(ram.eval([0n, 0n, 0n, 2n], pAsync, s1)).toEqual([99n]); // next cycle's read sees the new value
    // a cycle with no write shares the same mem array reference (no copy)
    const s2 = ram.next!([0n, 0n, 0n, 0n], pAsync, s1, false) as { mem: bigint[] };
    expect(s2.mem).toBe(s1.mem);
    // reset does not clear memory contents
    const s3 = ram.next!([0n, 0n, 0n, 0n], pAsync, s1, true) as { mem: bigint[] };
    expect(s3.mem).toBe(s1.mem);

    const pSync = { ...pAsync, readStyle: 'sync' };
    const t0 = ram.init!(pSync) as { mem: bigint[]; rq: bigint };
    expect(t0.rq).toBe(0n);
    expect(ram.eval([0n, 0n, 0n, 2n], pSync, t0)).toEqual([0n]); // registered read: nothing latched yet
    const t1 = ram.next!([0n, 0n, 0n, 2n], pSync, t0, false) as { mem: bigint[]; rq: bigint };
    expect(t1.rq).toBe(30n); // latched this edge from the old contents
    expect(ram.eval([0n, 0n, 0n, 0n], pSync, t1)).toEqual([30n]);
    const t2 = ram.next!([0n, 0n, 0n, 0n], pSync, t1, true) as { mem: bigint[]; rq: bigint };
    expect(t2.rq).toBe(0n); // the registered read output resets...
    expect(t2.mem).toBe(t1.mem); // ...but the memory array itself does not
    // out-of-range addresses (depth is not a power of two of every addr width) read as 0 and never write
    const pOdd = { ...defaultParams('ram'), width: 8, depth: 3, readStyle: 'async', contents: '1 2 3' };
    const u0 = ram.init!(pOdd) as { mem: bigint[] };
    expect(ram.eval([0n, 0n, 0n, 3n], pOdd, u0)).toEqual([0n]);
    const u1 = ram.next!([9n, 3n, 1n, 0n], pOdd, u0, false) as { mem: bigint[] };
    expect(u1.mem).toBe(u0.mem); // write to an out-of-range address is a no-op, so no copy either
  });
  it('memory: rom is read-only and never changes, sync adds one cycle of latency', () => {
    const rom = defOf('rom');
    const p = { ...defaultParams('rom'), width: 4, depth: 4, readStyle: 'sync', contents: '5 6 7 8' };
    const s0 = rom.init!(p) as { mem: bigint[]; rq: bigint };
    const s1 = rom.next!([1n], p, s0, false) as { mem: bigint[]; rq: bigint };
    expect(s1.mem).toBe(s0.mem); // a ROM's contents never copy: there is no write path at all
    expect(ev('rom', [1n], { width: 4, depth: 4, readStyle: 'sync', contents: '5 6 7 8' })).toEqual([0n]); // nothing latched yet
    expect(rom.eval([1n], p, s1)).toEqual([6n]);
  });
  it('memory: register file has two async read ports, reg0-hardwired-to-zero is optional', () => {
    const rf = defOf('regfile');
    const p = { ...defaultParams('regfile'), width: 32, depth: 4, zeroReg: true, contents: '0 11 22 33' };
    const s0 = rf.init!(p) as { mem: bigint[] };
    expect(s0.mem[0]).toBe(0n); // forced to zero even though contents said otherwise
    expect(rf.eval([0n, 0n, 0n, 2n, 3n], p, s0)).toEqual([22n, 33n]);
    expect(rf.eval([0n, 0n, 0n, 0n, 0n], p, s0)).toEqual([0n, 0n]);
    const s1 = rf.next!([99n, 0n, 1n, 0n, 0n], p, s0, false) as { mem: bigint[] };
    expect(s1.mem).toBe(s0.mem); // write to the hard-wired-zero register is dropped, so no copy
    const s2 = rf.next!([99n, 2n, 1n, 0n, 0n], p, s0, false) as { mem: bigint[] };
    expect(s2.mem[2]).toBe(99n);
    expect(rf.eval([0n, 0n, 0n, 2n, 0n], p, s0)).toEqual([22n, 0n]); // same-cycle write-then-read sees the OLD value
  });
});
