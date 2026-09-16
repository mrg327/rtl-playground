import type { Module, Block } from '../src/model/types';
import { emptyModule } from '../src/model/types';
import { normalizeParams } from '../src/model/library';

export function mod(): Module { return emptyModule(); }
export function blk(m: Module, id: string, type: string, params: Record<string, unknown> = {}, x = 0, y = 0): Block { const b: Block = { id, type, params: normalizeParams(type, params), x, y }; m.blocks.push(b); return b; }
let n = 0;
export function wire(m: Module, from: string, to: string): void { const [fb, fp] = from.split('.'), [tb, tp] = to.split('.'); m.wires.push({ id: `w${++n}`, from: { b: fb, p: fp }, to: { b: tb, p: tp } }); }
