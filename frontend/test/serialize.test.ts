import { describe, it, expect } from 'vitest';
import { serialize, deserialize } from '../src/model/serialize';
import { emptyDesign } from '../src/model/types';
import { LIB, defaultParams } from '../src/model/library';
describe('serialize', () => {
  it('round-trips all block types', () => { const d = emptyDesign('rt'); let x = 0; for (const t of Object.keys(LIB)) d.modules.top.blocks.push({ id: t + '1', type: t, params: defaultParams(t), x: x += 100, y: 0 }); const d2 = deserialize(serialize(d)); expect(d2.modules.top.blocks.map(b => b.type)).toEqual(Object.keys(LIB)); expect(d2.name).toBe('rt'); });
  it('rejects garbage and drops unknown types', () => { expect(() => deserialize('{"version":7}')).toThrow(); expect(() => deserialize('[]')).toThrow(); const d = deserialize(JSON.stringify({ version: 2, name: 'x', top: 'top', modules: { top: { blocks: [{ id: 'z', type: 'nope', params: {}, x: 0, y: 0 }], wires: [] } } })); expect(d.modules.top.blocks).toEqual([]); });
  it('migrates v1 prototype files', () => {
    const v1 = { blocks: [{ id: 1, t: 'seq1', x: 0, y: 0, l: '', tr: true, s: { list: [0, 1, 1, 0], idx: 0, rep: true } }, { id: 2, t: 'dff', x: 100, y: 0, l: 'q', s: { q: 0 } }, { id: 3, t: 'out1', x: 200, y: 0, tr: true }, { id: 4, t: 'mux', x: 0, y: 100 }, { id: 5, t: 'in4', x: 0, y: 200, s: { val: 9 } }, { id: 6, t: 'c8', x: 0, y: 300, s: { val: 42 } }, { id: 7, t: 'eq', x: 0, y: 400 }], wires: [{ id: 1, from: 1, fi: 0, to: 2, ti: 0 }, { id: 2, from: 2, fi: 0, to: 3, ti: 0 }, { id: 3, from: 5, fi: 0, to: 7, ti: 1 }] };
    const d = deserialize(JSON.stringify(v1)); const b = Object.fromEntries(d.modules.top.blocks.map(x => [x.id, x]));
    expect(b.b1.type).toBe('seq'); expect(b.b1.params.values).toBe('0110'); expect(b.b1.params.repeat).toBe(true);
    expect(b.b2.type).toBe('reg'); expect(b.b2.params.width).toBe(1); expect(b.b2.label).toBe('q');
    expect(b.b4.type).toBe('mux'); expect(b.b4.params.n).toBe(2); expect(b.b4.params.width).toBe(8);
    expect(b.b5.params).toMatchObject({ width: 4, value: 9 }); expect(b.b6.params).toMatchObject({ width: 8, value: 42 }); expect(b.b7.type).toBe('cmp');
    expect(d.modules.top.wires).toEqual([{ id: 'w1', from: { b: 'b1', p: 'y' }, to: { b: 'b2', p: 'd' } }, { id: 'w2', from: { b: 'b2', p: 'q' }, to: { b: 'b3', p: 'a' } }, { id: 'w3', from: { b: 'b5', p: 'y' }, to: { b: 'b7', p: 'b' } }]);
  });
});
