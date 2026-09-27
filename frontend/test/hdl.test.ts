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
  it('emits the inference-friendly memory pattern: declared array, gated write, guarded read', () => {
    const m = mod();
    blk(m, 'd', 'in', { width: 8 }); blk(m, 'waddr', 'in', { width: 4 }); blk(m, 'we', 'in', { width: 1 }); blk(m, 'raddr', 'in', { width: 4 });
    blk(m, 'ram1', 'ram', { width: 8, depth: 12, readStyle: 'sync', contents: '5 6 7' });
    wire(m, 'd.y', 'ram1.d'); wire(m, 'waddr.y', 'ram1.waddr'); wire(m, 'we.y', 'ram1.we'); wire(m, 'raddr.y', 'ram1.raddr');
    blk(m, 'q', 'out', { width: 8 }); wire(m, 'ram1.q', 'q.a');
    const sv = emitModule(emptyDesignFor(m), 'top');
    expect(sv).toMatch(/logic \[7:0\] ram1_mem \[0:11\];/);
    expect(sv).toMatch(/for \(int \S+ = 0; \S+ < 12; \S+\+\+\) ram1_mem\[\S+\] = 8'd0;/);
    expect(sv).toMatch(/ram1_mem\[0\] = 8'd5;\s*\n\s*ram1_mem\[1\] = 8'd6;\s*\n\s*ram1_mem\[2\] = 8'd7;/);
    expect(sv).toMatch(/always_ff @\(posedge clk\) if \(\S+ && \(\S+ < 4'd12\)\) ram1_mem\[\S+\] <= \S+;/);
    expect(sv).toMatch(/always_ff @\(posedge clk\) begin/); // registered (sync) read
    expect(sv).toContain('endmodule');
  });
  it('emits a ROM with no write path and a register file with a hard-wired-zero register', () => {
    const rom = mod(); blk(rom, 'a', 'in', { width: 2 }); blk(rom, 'rom1', 'rom', { width: 8, depth: 3, readStyle: 'async', contents: '1 2 3' }); wire(rom, 'a.y', 'rom1.raddr');
    blk(rom, 'q', 'out', { width: 8 }); wire(rom, 'rom1.q', 'q.a');
    const romSv = emitModule(emptyDesignFor(rom), 'top');
    expect(romSv).toMatch(/assign \S+ = \(\S+ < 2'd3\) \? rom1_mem\[\S+\] : 8'd0;/); // depth (3) doesn't fill the 2-bit address, so the read is bounds-guarded
    expect(romSv).not.toContain('<= '); // read-only: no always_ff at all

    const rf = mod();
    blk(rf, 'd', 'in', { width: 32 }); blk(rf, 'waddr', 'in', { width: 5 }); blk(rf, 'we', 'in', { width: 1 });
    blk(rf, 'ra1', 'in', { width: 5 }); blk(rf, 'ra2', 'in', { width: 5 });
    blk(rf, 'rf1', 'regfile', { width: 32, depth: 30, zeroReg: true }); // 30, not 32: exercises the bounds guard together with the zero-register guard
    wire(rf, 'd.y', 'rf1.d'); wire(rf, 'waddr.y', 'rf1.waddr'); wire(rf, 'we.y', 'rf1.we'); wire(rf, 'ra1.y', 'rf1.raddr1'); wire(rf, 'ra2.y', 'rf1.raddr2');
    blk(rf, 'q1', 'out', { width: 32 }); wire(rf, 'rf1.q1', 'q1.a'); blk(rf, 'q2', 'out', { width: 32 }); wire(rf, 'rf1.q2', 'q2.a');
    const rfSv = emitModule(emptyDesignFor(rf), 'top');
    expect(rfSv).toMatch(/&& \(\S+ < 5'd30\) && \(\S+ != 5'd0\)/); // write is guarded by depth AND register-0-is-hardwired-zero
    expect(rfSv).toMatch(/\(\S+ == 5'd0\) \? 32'd0 :/); // reading register 0 always gives 0
  });
});

function emptyDesignFor(m: ReturnType<typeof mod>) {
  return { version: 2 as const, name: 'x', top: 'top', options: { resetStyle: 'sync_high' as const, xUntilReset: false, clockName: 'clk', resetName: 'rst' }, modules: { top: m }, tests: [], views: { wave: { signals: [], radix: {} } } };
}
