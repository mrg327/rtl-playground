// Structural fidelity: every shipped example emits well-formed SystemVerilog and testbenches (DESIGN.md
// section 8). This is the fast, tool-free half of the check; frontend/scripts/verify-sv.ts is the slow half
// that actually compiles and runs the output under Verilator and Yosys.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deserialize } from '../src/model/serialize';
import { emitDesign, emitModule, planModule } from '../src/hdl/emit';
import { emitTestbench, testableModules } from '../src/hdl/testbench';
import { mod, blk, wire } from './helpers';

const dir = resolve(__dirname, '../../examples');
const files = readdirSync(dir).filter(f => f.endsWith('.rtlp'));

describe('hdl/emit: examples', () => {
  for (const f of files) {
    it(f, () => {
      const d = deserialize(readFileSync(resolve(dir, f), 'utf8'));
      const sv = emitDesign(d, { sourceFile: f });
      expect(sv).toContain(`module ${d.top}`);
      expect(sv).toContain('endmodule');
      expect(sv).toContain('input  logic clk');
      expect(sv).toContain('input  logic rst');
      // balanced begin/end and module/endmodule
      expect((sv.match(/\bbegin\b/g) ?? []).length).toBe((sv.match(/\bend\b/g) ?? []).length);
      expect((sv.match(/\bmodule\b/g) ?? []).length).toBe((sv.match(/\bendmodule\b/g) ?? []).length);
      // every block contributes a traceable comment
      const m = d.modules[d.top];
      for (const b of m.blocks) if (!['in', 'out', 'label', 'rst'].includes(b.type)) expect(sv).toContain(`// block: ${b.id}`);

      for (const key of testableModules(d)) {
        const tb = emitTestbench(d, key, { sourceFile: f });
        expect(tb).toContain(`module tb_${key}`);
        expect(tb).toContain('$finish');
        expect(tb).toContain('RESULT: PASS');
        expect(tb).toContain('RESULT: FAIL');
        expect((tb.match(/\bbegin\b/g) ?? []).length).toBe((tb.match(/\bend\b/g) ?? []).length);
        for (const t of d.tests.filter(x => x.module === key)) expect(tb).toContain(t.name);
      }
    });
  }
});

describe('hdl/emit: semantics', () => {
  it('sanitizes and de-duplicates port names, avoiding SV keywords', () => {
    const m = mod();
    const a = blk(m, 'and1', 'in'); a.label = 'and';
    const b = blk(m, 'b', 'in'); b.label = 'and';
    blk(m, 'o', 'out'); wire(m, 'and1.y', 'o.a');
    const plan = planModule(emptyDesignFor(m), 'top');
    const names = plan.ports.map(p => p.name);
    expect(new Set(names).size).toBe(names.length); // unique
    expect(names).not.toContain('and'); // SV/Verilog keyword
  });
  it('mux reads out of range as 0, matching library.ts', () => {
    const m = mod(); blk(m, 'a', 'in', { width: 4 }); blk(m, 'b', 'in', { width: 4 }); blk(m, 's', 'in', { width: 2 });
    blk(m, 'mx', 'mux', { n: 3, width: 4 }); wire(m, 'a.y', 'mx.i0'); wire(m, 'b.y', 'mx.i1'); blk(m, 'o', 'out', { width: 4 }); wire(m, 'mx.y', 'o.a'); wire(m, 's.y', 'mx.s');
    const sv = emitModule(emptyDesignFor(m), 'top');
    expect(sv).toMatch(/default:\s*\S+\s*=\s*4'd0;/);
  });
  it('rejects a module with an unresolved netlist error', () => {
    const m = mod(); blk(m, 'a', 'in'); blk(m, 'b', 'in'); blk(m, 'l1', 'label', { name: 'x' }); blk(m, 'l2', 'label', { name: 'x' }); wire(m, 'a.y', 'l1.i'); wire(m, 'b.y', 'l2.i');
    expect(() => emitModule(emptyDesignFor(m), 'top')).toThrow();
  });
});

function emptyDesignFor(m: ReturnType<typeof mod>) {
  return { version: 2 as const, name: 'x', top: 'top', options: { resetStyle: 'sync_high' as const, xUntilReset: false, clockName: 'clk', resetName: 'rst' }, modules: { top: m }, tests: [], views: { wave: { signals: [], radix: {} } } };
}
