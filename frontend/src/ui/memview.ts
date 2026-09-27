// Memory viewer: read-only hex table of a RAM/ROM/register-file block's contents, with the address read and
// the address written this cycle highlighted, following the time-travel cursor (DESIGN.md section 4). Rendered
// inline in the inspector when such a block is selected (src/ui/inspector.ts).
import type { Block } from '../model/types';
import { memDepth } from '../model/library';
import { pinKey } from '../model/netlist';
import type { Simulator } from '../sim/engine';

export interface MemRow { addr: number; value: bigint; read: boolean; write: boolean }
export interface MemInfo { width: number; depth: number }

const MEM_TYPES = ['ram', 'rom', 'regfile'];

export function memoryInfo(block: Block): MemInfo | null {
  if (!MEM_TYPES.includes(block.type)) return null;
  const width = Math.max(1, Math.min(64, Number(block.params.width ?? 8)));
  const depth = memDepth(block.params, block.type === 'regfile' ? 128 : 4096);
  return { width, depth };
}

/** The block's read-address port names (both, for a two-port RAM or a register file). */
function readPortsOf(type: string): string[] {
  if (type === 'regfile') return ['raddr1', 'raddr2'];
  if (type === 'rom') return ['raddr'];
  return ['raddr', 'raddr2']; // ram; raddr2 only exists when the "second read port" param is on
}

/** An input pin's *effective* value at a frame: `Simulator.value()` only ever populates a block's OUTPUT pin
 * slots in its per-frame value array (see evaluate() in sim/engine.ts), so reading an input pin directly by
 * name always comes back 0, regardless of what actually drives it. The rest of the UI (src/ui/canvas.ts,
 * src/ui/waveform.ts via App.waveData) resolves an input through its net's driver instead; this does the same,
 * falling back to 0n for an unconnected input, matching how the simulator itself treats one (netlist.ts). */
function inputValue(sim: Simulator, blockId: string, port: string, frame: number): bigint {
  const net = sim.compiled.netlist.byPin.get(`${blockId}.${port}`);
  const drv = net?.drivers[0];
  return drv ? sim.value(pinKey(drv), frame) : 0n;
}

/** Rows for the block's current contents at the simulator's viewed frame (`sim.cur`), each flagged with
 * whether it is the address read this cycle or the address written getting here. Returns null for a
 * non-memory block. */
export function memoryRows(sim: Simulator, block: Block, simId: string = block.id): MemRow[] | null {
  // `simId` is the block's id in the flattened simulation (`u0/ram1` when viewed inside an instance).
  const info = memoryInfo(block);
  if (!info) return null;
  const state = sim.frame.states.get(simId) as { mem?: bigint[] } | undefined;
  const mem = state?.mem ?? [];
  const cur = sim.cur;
  const reads = new Set<number>();
  for (const port of readPortsOf(block.type)) {
    if (sim.compiled.pinIndex.has(`${simId}.${port}`)) reads.add(Number(inputValue(sim, simId, port, cur)));
  }
  let write: number | null = null;
  if (block.type !== 'rom' && cur > 0) {
    if (inputValue(sim, simId, 'we', cur - 1) === 1n) write = Number(inputValue(sim, simId, 'waddr', cur - 1));
  }
  const rows: MemRow[] = [];
  for (let addr = 0; addr < info.depth; addr++) rows.push({ addr, value: mem[addr] ?? 0n, read: reads.has(addr), write: write === addr });
  return rows;
}
