import { describe, it, expect } from 'vitest';
import { LIB, defaultParams, defOf } from '../src/model/library';
const ev = (type: string, ins: (bigint | number)[], params: Record<string, unknown> = {}, state?: unknown) => defOf(type).eval(ins.map(BigInt), { ...defaultParams(type), ...params }, state);
describe('library', () => {
  it('every block has consistent defaults', () => { for (const [t, d] of Object.entries(LIB)) { const p = defaultParams(t); expect(d.ports(p).length).toBeGreaterThan(0); expect(d.size(p).w).toBeGreaterThan(0); expect(() => d.body(p, d.size(p))).not.toThrow(); const ins = d.ports(p).filter(x => x.dir === 'in').map(() => 0n); expect(() => d.eval(ins, p, d.init?.(p))).not.toThrow(); } });
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
});
