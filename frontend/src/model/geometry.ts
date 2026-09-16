import type { Block, Point, Side, Rot } from './types';
import { defOf, type PortDef, type Shape } from './library';

export const LEAD = 12; // pin lead length outside the body
export const GRID = 10;
export const snap = (v: number): number => Math.round(v / GRID) * GRID;

export interface PinGeom { def: PortDef; /** world position of the pin end */ x: number; y: number; /** world position where the lead meets the body */ bx: number; by: number; side: Side }

/** Local (unrotated) pin position relative to the block origin. */
function localPin(def: PortDef, s: Shape): { x: number; y: number; bx: number; by: number } {
  switch (def.side) {
    case 'l': return { x: -LEAD, y: def.at * s.h, bx: 0, by: def.at * s.h };
    case 'r': return { x: s.w + LEAD, y: def.at * s.h, bx: s.w, by: def.at * s.h };
    case 't': return { x: def.at * s.w, y: -LEAD, bx: def.at * s.w, by: 0 };
    default: return { x: def.at * s.w, y: s.h + LEAD, bx: def.at * s.w, by: s.h };
  }
}

const SIDES: Side[] = ['r', 'b', 'l', 't'];
export function rotateSide(side: Side, rot: Rot, flip: boolean): Side {
  let s = side;
  if (flip) s = s === 'l' ? 'r' : s === 'r' ? 'l' : s;
  const i = SIDES.indexOf(s);
  return SIDES[(i + rot / 90) % 4];
}

/** Transform a local point through the block's flip and rotation about its centre. */
export function xform(b: Block, s: Shape, x: number, y: number): Point {
  const cx = s.w / 2, cy = s.h / 2;
  let dx = x - cx, dy = y - cy;
  if (b.flip) dx = -dx;
  const r = b.rot ?? 0;
  if (r === 90) [dx, dy] = [-dy, dx]; else if (r === 180) [dx, dy] = [-dx, -dy]; else if (r === 270) [dx, dy] = [dy, -dx];
  return { x: b.x + cx + dx, y: b.y + cy + dy };
}

export function shapeOf(b: Block): Shape { return defOf(b.type).size(b.params); }
export function portsOf(b: Block): PortDef[] { return defOf(b.type).ports(b.params); }

export function pinGeoms(b: Block): PinGeom[] {
  const s = shapeOf(b);
  return portsOf(b).map(def => {
    const l = localPin(def, s);
    const p = xform(b, s, l.x, l.y), q = xform(b, s, l.bx, l.by);
    return { def, x: snap(p.x), y: snap(p.y), bx: q.x, by: q.y, side: rotateSide(def.side, b.rot ?? 0, !!b.flip) };
  });
}

export function pinGeom(b: Block, port: string): PinGeom | undefined { return pinGeoms(b).find(g => g.def.name === port); }

/** Axis-aligned bounds of the rotated body. */
export function bounds(b: Block): { x: number; y: number; w: number; h: number } {
  const s = shapeOf(b);
  const pts = [xform(b, s, 0, 0), xform(b, s, s.w, 0), xform(b, s, 0, s.h), xform(b, s, s.w, s.h)];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** SVG transform attribute for the block group. */
export function transformOf(b: Block): string {
  const s = shapeOf(b); const cx = b.x + s.w / 2, cy = b.y + s.h / 2;
  let t = `translate(${b.x} ${b.y})`;
  const r = b.rot ?? 0;
  if (r || b.flip) t = `translate(${cx} ${cy}) rotate(${r}) scale(${b.flip ? -1 : 1} 1) translate(${-s.w / 2} ${-s.h / 2})`;
  return t;
}

/** Orthogonal path from an output pin to an input pin. */
export function routeWire(from: PinGeom, to: PinGeom, mid?: number): Point[] {
  const out = dirOf(from.side), inn = dirOf(to.side);
  const a = { x: from.x, y: from.y }, b = { x: to.x, y: to.y };
  // Points just outside each pin along its direction.
  const a1 = { x: a.x + out.x * 10, y: a.y + out.y * 10 };
  const b1 = { x: b.x + inn.x * 10, y: b.y + inn.y * 10 };
  const pts: Point[] = [a, a1];
  if (out.x !== 0 && inn.x !== 0) {
    // horizontal out, horizontal in
    const forward = out.x > 0 ? b1.x - a1.x >= 0 : a1.x - b1.x >= 0;
    if (forward) { const mx = mid ?? snap((a1.x + b1.x) / 2); pts.push({ x: mx, y: a1.y }, { x: mx, y: b1.y }); }
    else { const my = mid ?? snap((a1.y + b1.y) / 2); pts.push({ x: a1.x, y: my }, { x: b1.x, y: my }); }
  } else if (out.x !== 0 && inn.y !== 0) {
    // horizontal out, vertical in: go to b1.x then down/up
    if ((b1.x - a1.x) * out.x >= 0 && (a1.y - b1.y) * inn.y <= 0) pts.push({ x: b1.x, y: a1.y });
    else { const my = mid ?? snap((a1.y + b1.y) / 2); pts.push({ x: a1.x, y: my }, { x: b1.x, y: my }); }
  } else if (out.y !== 0 && inn.x !== 0) {
    if ((b1.y - a1.y) * out.y >= 0 && (a1.x - b1.x) * inn.x <= 0) pts.push({ x: a1.x, y: b1.y });
    else { const mx = mid ?? snap((a1.x + b1.x) / 2); pts.push({ x: mx, y: a1.y }, { x: mx, y: b1.y }); }
  } else {
    const my = mid ?? snap((a1.y + b1.y) / 2); pts.push({ x: a1.x, y: my }, { x: b1.x, y: my });
  }
  pts.push(b1, b);
  return dedupe(pts);
}

const dirOf = (s: Side): Point => (s === 'l' ? { x: -1, y: 0 } : s === 'r' ? { x: 1, y: 0 } : s === 't' ? { x: 0, y: -1 } : { x: 0, y: 1 });
function dedupe(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) { const l = out[out.length - 1]; if (!l || l.x !== p.x || l.y !== p.y) out.push(p); }
  // remove collinear middles
  for (let i = 1; i < out.length - 1;) { const a = out[i - 1], b = out[i], c = out[i + 1]; if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i, 1); else i++; }
  return out;
}

export const pathD = (pts: Point[]): string => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');

/** Distance from point to a polyline. */
export function distToPath(pts: Point[], p: Point): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}
