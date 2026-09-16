import { describe, it, expect } from 'vitest';
import { pinGeoms, rotateSide, routeWire, GRID } from '../src/model/geometry';
import { normalizeParams } from '../src/model/library';
import type { Block } from '../src/model/types';
const reg = (rot: Block['rot'] = 0, flip = false): Block => ({ id: 'r', type: 'reg', params: normalizeParams('reg', { width: 8 }), x: 100, y: 100, rot, flip });
describe('geometry', () => {
  it('pins land on the grid for every rotation', () => { for (const rot of [0, 90, 180, 270] as const) for (const flip of [false, true]) for (const g of pinGeoms(reg(rot, flip))) { expect(g.x % GRID).toBe(0); expect(g.y % GRID).toBe(0); } });
  it('rotates sides', () => { expect(rotateSide('l', 90, false)).toBe('t'); expect(rotateSide('r', 180, false)).toBe('l'); expect(rotateSide('l', 0, true)).toBe('r'); expect(pinGeoms(reg(0, true)).find(g => g.def.name === 'd')!.side).toBe('r'); });
  it('routes orthogonally between pins', () => {
    const a = reg(); const b: Block = { ...reg(), id: 'b', x: 400, y: 260 };
    const pts = routeWire(pinGeoms(a).find(g => g.def.name === 'q')!, pinGeoms(b).find(g => g.def.name === 'd')!);
    for (let i = 1; i < pts.length; i++) expect(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y).toBe(true);
    expect(pts[0]).toEqual({ x: pinGeoms(a).find(g => g.def.name === 'q')!.x, y: pinGeoms(a).find(g => g.def.name === 'q')!.y });
    const back = routeWire(pinGeoms(b).find(g => g.def.name === 'q')!, pinGeoms(a).find(g => g.def.name === 'd')!); expect(back.length).toBeGreaterThan(3);
  });
});
