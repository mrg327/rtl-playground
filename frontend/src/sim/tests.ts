// Test-table runner. A row is one clock cycle: set inputs, check outputs, then clock.
import type { Design, Test, Module } from '../model/types';
import { Simulator } from './engine';
import { toBig, fmt } from '../model/values';
import { defOf } from '../model/library';

export interface RowResult { index: number; cycle: number; ok: boolean; skipped: boolean; actual: Record<string, string>; expected: Record<string, string>; inputs: Record<string, string> }
export interface TestResult { name: string; passed: boolean; rows: RowResult[]; error?: string }

/** Resolve a column name to a block: by id, then by label. */
function findBlock(m: Module, col: string) { return m.blocks.find(b => b.id === col) ?? m.blocks.find(b => b.label === col); }

export function runTest(design: Design, test: Test, moduleOverride?: Module): TestResult {
  const src = moduleOverride ?? design.modules[test.module];
  if (!src) return { name: test.name, passed: false, rows: [], error: `Module ${test.module} not found` };
  // Work on a copy so the editor's simulator is untouched.
  const m: Module = JSON.parse(JSON.stringify(src));
  const sim = new Simulator(m);
  const cols = test.columns.map(c => { const b = findBlock(m, c); return b ? { name: c, block: b, isIn: b.type === 'in', width: Number(b.params.width ?? 1) } : null; });
  const missing = test.columns.filter((_, i) => !cols[i]);
  if (missing.length) return { name: test.name, passed: false, rows: [], error: `Unknown columns: ${missing.join(', ')}` };
  const rows: RowResult[] = [];
  let ok = true;
  for (let r = 0; r < test.rows.length; r++) {
    const cells = test.rows[r];
    const first = String(cells[0] ?? '').trim();
    const clk = /^C(\*(\d+))?$/i.exec(first);
    if (clk) { const n = clk[2] ? parseInt(clk[2], 10) : 1; for (let i = 0; i < n; i++) sim.step(); rows.push({ index: r, cycle: sim.cycle, ok: true, skipped: true, actual: {}, expected: {}, inputs: {} }); continue; }
    if (/^R$/i.test(first)) { sim.rst = true; sim.step(); sim.rst = false; rows.push({ index: r, cycle: sim.cycle, ok: true, skipped: true, actual: {}, expected: {}, inputs: {} }); continue; }
    const inputs: Record<string, string> = {}, expected: Record<string, string> = {}, actual: Record<string, string> = {};
    cols.forEach((c, i) => { if (!c || !c.isIn) return; const cell = String(cells[i] ?? '-').trim(); if (cell === '-' || cell === '') return; c.block.params.value = Number(toBig(cell, c.width)); inputs[c.name] = cell; });
    const vals = sim.values();
    let rowOk = true;
    cols.forEach((c, i) => {
      if (!c || c.isIn) return; const cell = String(cells[i] ?? 'X').trim(); if (cell === 'X' || cell === 'x' || cell === '' || cell === '-') return;
      const d = defOf(c.block.type); const key = d.traceKey ? `${c.block.id}.${d.traceKey}` : `${c.block.id}.${d.ports(c.block.params).find(p => p.dir === 'out')?.name ?? 'y'}`;
      let v: bigint; const pd = d.ports(c.block.params).find(p => `${c.block.id}.${p.name}` === key);
      if (pd?.dir === 'in') { const net = sim.compiled.netlist.byPin.get(key); const drv = net?.drivers[0]; v = drv ? sim.value(`${drv.b}.${drv.p}`) : 0n; } else { const idx = sim.compiled.pinIndex.get(key); v = idx === undefined ? 0n : vals[idx]; }
      v &= (1n << BigInt(c.width)) - 1n;
      const exp = toBig(cell, c.width); expected[c.name] = cell; actual[c.name] = fmt(v, c.width, 'dec');
      if (v !== exp) rowOk = false;
    });
    rows.push({ index: r, cycle: sim.cycle, ok: rowOk, skipped: false, actual, expected, inputs });
    if (!rowOk) ok = false;
    sim.step();
  }
  return { name: test.name, passed: ok, rows };
}

export function runAll(design: Design): TestResult[] { return design.tests.map(t => runTest(design, t)); }
