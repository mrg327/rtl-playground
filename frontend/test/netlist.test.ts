import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../src/model/netlist';
import { mod, blk, wire } from './helpers';
describe('netlist', () => {
  it('builds nets from wires', () => { const m = mod(); blk(m, 'a', 'in'); blk(m, 'n', 'not'); wire(m, 'a.y', 'n.a'); const nl = buildNetlist(m); const net = nl.byPin.get('a.y')!; expect(net.drivers).toEqual([{ b: 'a', p: 'y' }]); expect(net.loads).toEqual([{ b: 'n', p: 'a' }]); expect(net.name).toBe('a'); expect(nl.problems.filter(p => p.level === 'error')).toEqual([]); });
  it('merges labels by name', () => { const m = mod(); blk(m, 'a', 'in'); blk(m, 'l1', 'label', { name: 'x' }); blk(m, 'l2', 'label', { name: 'x' }); blk(m, 'o', 'out'); wire(m, 'a.y', 'l1.i'); wire(m, 'l2.o', 'o.a'); const nl = buildNetlist(m); expect(nl.byPin.get('o.a')).toBe(nl.byPin.get('a.y')); expect(nl.byPin.get('a.y')!.name).toBe('x'); expect(nl.problems).toEqual([]); });
  it('reports multiple drivers, width mismatch, undriven and unconnected', () => {
    const m = mod(); blk(m, 'a', 'in'); blk(m, 'b', 'in'); blk(m, 'l1', 'label', { name: 'x' }); blk(m, 'l2', 'label', { name: 'x' }); wire(m, 'a.y', 'l1.i'); wire(m, 'b.y', 'l2.i');
    blk(m, 'w', 'in', { width: 4 }); blk(m, 'n', 'not', { width: 1 }); wire(m, 'w.y', 'n.a');
    blk(m, 'l3', 'label', { name: 'lonely' }); blk(m, 'o', 'out'); wire(m, 'l3.o', 'o.a');
    blk(m, 'g', 'and');
    const codes = buildNetlist(m).problems.map(p => p.code);
    expect(codes).toContain('multi-driver'); expect(codes).toContain('width'); expect(codes).toContain('undriven'); expect(codes).toContain('unconnected');
  });
  it('ignores dangling wires', () => { const m = mod(); blk(m, 'a', 'in'); blk(m, 'n', 'not'); wire(m, 'a.nope', 'n.a'); const nl = buildNetlist(m); expect(nl.problems.some(p => p.code === 'dangling')).toBe(true); });
});
