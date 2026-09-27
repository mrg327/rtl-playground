// Two instances of a module that holds a RAM: the motion estimator's shape (a buffer per processing element).
import { emptyDesign } from '../src/model/types';
import type { Design } from '../src/model/types';
import { mod, blk, wire } from './helpers';

export function laneDesign(): Design {
  const d = emptyDesign();
  const lane = mod(); d.modules.lane = lane;
  blk(lane, 'd', 'in', { width: 8 }).label = 'd'; blk(lane, 'wa', 'in', { width: 4 }).label = 'wa';
  blk(lane, 'we', 'in', { width: 1 }).label = 'we'; blk(lane, 'ra', 'in', { width: 4 }).label = 'ra';
  blk(lane, 'ram1', 'ram', { width: 8, depth: 16, readStyle: 'async' });
  blk(lane, 'q', 'out', { width: 8 }).label = 'q';
  wire(lane, 'd.y', 'ram1.d'); wire(lane, 'wa.y', 'ram1.waddr'); wire(lane, 'we.y', 'ram1.we'); wire(lane, 'ra.y', 'ram1.raddr'); wire(lane, 'ram1.q', 'q.a');
  const top = d.modules.top;
  for (const b of ['d', 'wa', 'ra']) blk(top, b, 'in', { width: b === 'd' ? 8 : 4 }).label = b;
  blk(top, 'we0', 'in', { width: 1 }).label = 'we0'; blk(top, 'we1', 'in', { width: 1 }).label = 'we1';
  for (const u of ['u0', 'u1']) {
    blk(top, u, 'instance', { module: 'lane' });
    wire(top, 'd.y', `${u}.d`); wire(top, 'wa.y', `${u}.wa`); wire(top, 'ra.y', `${u}.ra`); wire(top, `we${u.slice(1)}.y`, `${u}.we`);
    blk(top, `q${u.slice(1)}`, 'out', { width: 8 }).label = `q${u.slice(1)}`; wire(top, `${u}.q`, `q${u.slice(1)}.a`);
  }
  d.tests = [{ name: 'lanes keep separate contents', module: 'top', columns: ['d', 'wa', 'we0', 'we1', 'ra', 'q0', 'q1'], rows: [
    ['11', '2', '1', '0', '2', '0', '0'],  // write 11 into lane 0 only (read-before-write: still 0 this cycle)
    ['22', '2', '0', '1', '2', '11', '0'], // lane 0 now holds 11; write 22 into lane 1
    ['0', '0', '0', '0', '2', '11', '22'], // each lane kept its own word
    ['0', '0', '0', '0', '3', '0', '0'],
  ] } as unknown as Design['tests'][number]];
  return d;
}
