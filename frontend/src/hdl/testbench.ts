// Testbench emitter: each design module's test tables -> `tb_<module>.sv` (DESIGN.md section 8). Drives the
// same vectors and checks them with the same semantics as src/sim/tests.ts (C / C*n / R rows, X/-/empty
// don't-care, `-`/empty holds the previous stimulus), so a design that passes in the browser passes the same
// rows under Verilator. Runs with `verilator --binary --timing`.
import type { Design, Module, Test } from '../model/types';
import { defOf } from '../model/library';
import { pinKey } from '../model/netlist';
import { toBig } from '../model/values';
import { planModule, observePin, lit, declType, isModulePort, header, TOOL_VERSION, type ModulePlan, type EmitOptions } from './emit';

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const INSTANCE = 'dut';

interface Col { width: number; isIn: boolean; expr: string }

/** Resolves a test column to a block by id or label, then to the SV expression that carries its value: the
 * matching testbench-local port variable for an input, or `dut.<net>` for anything observed internally.
 * Mirrors src/sim/tests.ts's `findBlock`/column resolution exactly, including its width quirk: a column's
 * comparison width is `Number(block.params.width ?? 1)` regardless of block type, so a block with no `width`
 * param (e.g. a shift register) compares only its low bit. Replicated here on purpose for fidelity. */
function resolveCol(m: Module, plan: ModulePlan, colName: string): Col | null {
  const b = m.blocks.find(x => x.id === colName) ?? m.blocks.find(x => x.label === colName);
  if (!b) return null;
  const width = Number(b.params.width ?? 1);
  if (b.type === 'in') { const p = plan.ports.find(x => x.blockId === b.id)!; return { width, isIn: true, expr: p.name }; }
  const pin = observePin(m, plan.netlist, b.id);
  if (!pin) return { width, isIn: false, expr: lit(0n, width) };
  const net = plan.netlist.byPin.get(pinKey(pin));
  const info = net && plan.nets.get(net.id);
  const svName = info ? info.svName : lit(0n, width);
  const expr = /^\d+'/.test(svName) || isModulePort(plan, svName) ? svName : `${INSTANCE}.${svName}`;
  return { width, isIn: false, expr };
}

export interface TbOptions extends EmitOptions { periodNs?: number }

export function emitTestbench(design: Design, moduleKey: string, opts: TbOptions = {}): string {
  const m = design.modules[moduleKey];
  if (!m) throw new Error(`Module "${moduleKey}" not found.`);
  const tests = design.tests.filter(t => t.module === moduleKey);
  if (!tests.length) throw new Error(`Module "${moduleKey}" has no tests to export.`);
  const plan = planModule(design, moduleKey);
  const period = opts.periodNs ?? 10;
  const tbName = `tb_${plan.svName}`;

  // An input port that no test row ever sets keeps the Input block's own configured value throughout — exactly
  // what the TS simulator does (it only overrides `params.value` for columns a test row actually mentions) — so
  // the testbench-local variable must start there too, not at 0.
  const portDecl = plan.ports.map(p => {
    if (p.dir !== 'in') return `  ${declType(p.width)} ${p.name};`;
    const b = m.blocks.find(x => x.id === p.blockId)!;
    return `  ${declType(p.width)} ${p.name} = ${lit(toBig(b.params.value, p.width), p.width)};`;
  });
  const conn = [`.${plan.clk}(${plan.clk})`, `.${plan.rst}(${plan.rst})`, ...plan.ports.map(p => `.${p.name}(${p.name})`)].join(', ');

  const body: string[] = [];
  for (const test of tests) {
    const cols = test.columns.map(c => resolveCol(m, plan, c));
    const missing = test.columns.filter((_, i) => !cols[i]);
    if (missing.length) throw new Error(`Test "${test.name}": unknown columns: ${missing.join(', ')}`);
    body.push(`    $display("TEST %s", "${esc(test.name)}");`, `    test_fail = 1'b0;`);
    test.rows.forEach((row, r) => {
      const first = String(row[0] ?? '').trim();
      const clkMatch = /^C(\*(\d+))?$/i.exec(first);
      if (clkMatch) { const n = clkMatch[2] ? parseInt(clkMatch[2], 10) : 1; body.push(`    repeat (${n}) @(posedge ${plan.clk});`); return; }
      // Non-blocking assignment, not `=`: a blocking assignment made the instant a previous `@(posedge clk)`
      // resumes races the DUT's own always_ff for that same edge (simulator-ordering dependent, and Verilator
      // resolved it the "wrong" way here). `<=` schedules the change into this edge's NBA region, after the
      // DUT has already sampled the old value, which is what "set stimulus, then the *next* edge sees it" means.
      if (/^R$/i.test(first)) { body.push(`    ${plan.rst} <= 1'b1;`, `    @(posedge ${plan.clk});`, `    ${plan.rst} <= 1'b0;`); return; }
      cols.forEach((c, ci) => {
        if (!c || !c.isIn) return;
        const cell = String(row[ci] ?? '-').trim(); if (cell === '-' || cell === '') return;
        body.push(`    ${c.expr} <= ${lit(toBig(cell, c.width), c.width)};`);
      });
      body.push(`    #1;`);
      cols.forEach((c, ci) => {
        if (!c || c.isIn) return;
        const cell = String(row[ci] ?? 'X').trim(); if (/^x$/i.test(cell) || cell === '' || cell === '-') return;
        const v = toBig(cell, c.width);
        const label = `${esc(test.name)} row ${r + 1} ${esc(test.columns[ci])}`;
        const got = c.width === 1 ? c.expr : `${c.expr}[${c.width - 1}:0]`;
        body.push(`    if (${got} != ${lit(v, c.width)}) begin fail_rows++; test_fail = 1'b1; $display("FAIL %s: got %0d expected %0d", "${label}", ${got}, ${lit(v, c.width)}); end else pass_rows++;`);
      });
      body.push(`    @(posedge ${plan.clk});`);
    });
    body.push(`    if (test_fail) begin fail_tests++; $display("  -> FAIL"); end else begin pass_tests++; $display("  -> PASS"); end`, '');
  }

  return [
    header(design, opts).trimEnd(),
    `// Testbench for module ${plan.svName} (RTL Playground ${TOOL_VERSION}).`,
    // Not "// verilator ...": Verilator treats a comment starting with that word right after // as a pragma.
    `// Run: verilator --binary --timing ${tbName}.sv ${plan.svName}.sv --top-module ${tbName} -o ${tbName} && ./obj_dir/${tbName}`,
    '',
    `module ${tbName};`,
    // Every input port is given a readable default and then driven procedurally row by row, and some outputs
    // are only ever read through the DUT's internals — both idiomatic for a generated testbench, so the two
    // matching Verilator warning classes are suppressed for the rest of this file.
    '  /* verilator lint_off PROCASSINIT */',
    '  /* verilator lint_off UNUSEDSIGNAL */',
    `  logic ${plan.clk} = 1'b0;`,
    `  logic ${plan.rst} = 1'b0;`,
    ...portDecl,
    `  int pass_rows = 0, fail_rows = 0, pass_tests = 0, fail_tests = 0;`,
    `  bit test_fail;`,
    '',
    `  ${plan.svName} ${INSTANCE} (${conn});`,
    '',
    `  always #${period / 2} ${plan.clk} = ~${plan.clk};`,
    '',
    `  initial begin`,
    ...body,
    `    $display("SUMMARY: %0d/%0d rows, %0d/%0d tests passed", pass_rows, pass_rows + fail_rows, pass_tests, pass_tests + fail_tests);`,
    `    if (fail_tests == 0) $display("RESULT: PASS"); else $display("RESULT: FAIL");`,
    `    $finish;`,
    `  end`,
    `endmodule`,
    '',
  ].join('\n');
}

/** The modules that have at least one test, i.e. the ones `emitTestbench` can produce a `tb_<module>.sv` for. */
export function testableModules(design: Design): string[] {
  return [...new Set(design.tests.map(t => t.module))].filter(k => design.modules[k]);
}
