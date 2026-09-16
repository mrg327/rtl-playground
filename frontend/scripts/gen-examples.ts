// Generates the shipped example designs, validates them in the simulator, and writes examples/*.rtlp.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Design, Module, Block, Note, Test } from '../src/model/types';
import { emptyDesign } from '../src/model/types';
import { normalizeParams, defOf } from '../src/model/library';
import { Simulator } from '../src/sim/engine';
import { runAll } from '../src/sim/tests';
import { serialize } from '../src/model/serialize';

const OUT = resolve(__dirname, '../../examples');
mkdirSync(OUT, { recursive: true });

function design(name: string): Design { const d = emptyDesign(name); return d; }
function add(m: Module, id: string, type: string, x: number, y: number, params: Record<string, unknown> = {}, extra: Partial<Block> = {}): Block {
  const b: Block = { id, type, params: normalizeParams(type, params), x, y, trace: extra.trace ?? !!defOf(type).trace, ...extra }; m.blocks.push(b); return b;
}
let wid = 0;
function wire(m: Module, from: string, to: string, mid?: number): void { const [fb, fp] = from.split('.'), [tb, tp] = to.split('.'); m.wires.push({ id: `w${++wid}`, from: { b: fb, p: fp }, to: { b: tb, p: tp }, ...(mid !== undefined ? { mid } : {}) }); }
function note(m: Module, x: number, y: number, w: number, h: number, text: string): void { const n: Note = { id: `note${m.notes.length + 1}`, x, y, w, h, text }; m.notes.push(n); }
function test(d: Design, name: string, columns: string[], rows: string[][]): void { const t: Test = { name, module: 'top', columns, rows }; d.tests.push(t); }
function emit(file: string, d: Design): void {
  wid = 0;
  const sim = new Simulator(d.modules.top);
  const errs = sim.compiled.problems.filter(p => p.level === 'error');
  if (errs.length) throw new Error(`${file}: ${errs.map(e => e.message).join('; ')}`);
  const res = runAll(d);
  for (const r of res) if (!r.passed) throw new Error(`${file}: test "${r.name}" failed: ${r.error ?? JSON.stringify(r.rows.filter(x => !x.ok))}`);
  writeFileSync(resolve(OUT, file), serialize(d));
  console.log(`ok  ${file}  (${d.modules.top.blocks.length} blocks, ${d.modules.top.wires.length} wires, ${res.length} tests)`);
}

// 01 gates
{
  const d = design('Basic gates'); const m = d.modules.top;
  note(m, 40, 20, 520, 50, 'Click the inputs a and b to toggle them and watch each gate. Fill in the truth table for every output, then check it with the Tests tab.');
  add(m, 'a', 'in', 40, 110, { width: 1, value: 0 }, { label: 'a' }); add(m, 'b', 'in', 40, 330, { width: 1, value: 0 }, { label: 'b' });
  const gates = [['and1', 'and'], ['or1', 'or'], ['xor1', 'xor'], ['nand1', 'nand']];
  gates.forEach(([id, t], i) => { add(m, id, t, 260, 90 + i * 80, { n: 2, width: 1 }); wire(m, 'a.y', `${id}.i0`); wire(m, 'b.y', `${id}.i1`); add(m, `${t}_out`, 'out', 420, 97 + i * 80, { width: 1 }, { label: `a ${t} b` }); wire(m, `${id}.y`, `${t}_out.a`); });
  add(m, 'not1', 'not', 260, 420, { width: 1 }); wire(m, 'a.y', 'not1.a'); add(m, 'not_out', 'out', 420, 420, { width: 1 }, { label: 'not a' }); wire(m, 'not1.y', 'not_out.a');
  test(d, 'Truth table', ['a', 'b', 'and_out', 'or_out', 'xor_out', 'nand_out', 'not_out'], [['0', '0', '0', '0', '0', '1', '1'], ['0', '1', '0', '1', '1', '1', '1'], ['1', '0', '0', '1', '1', '1', '0'], ['1', '1', '1', '1', '0', '0', '0']]);
  emit('01-gates.rtlp', d);
}
// 02 full adder
{
  const d = design('Full adder from gates'); const m = d.modules.top;
  note(m, 40, 20, 560, 50, 'A full adder built from two XOR gates, two AND gates and an OR gate. sum = a xor b xor cin, cout = ab + cin(a xor b). Toggle the inputs and compare with the tests.');
  add(m, 'a', 'in', 40, 110, { width: 1 }, { label: 'a' }); add(m, 'b', 'in', 40, 180, { width: 1 }, { label: 'b' }); add(m, 'cin', 'in', 40, 300, { width: 1 }, { label: 'cin' });
  add(m, 'x1', 'xor', 220, 120, { n: 2 }); wire(m, 'a.y', 'x1.i0'); wire(m, 'b.y', 'x1.i1');
  add(m, 'x2', 'xor', 400, 140, { n: 2 }); wire(m, 'x1.y', 'x2.i0'); wire(m, 'cin.y', 'x2.i1');
  add(m, 'a1', 'and', 400, 250, { n: 2 }); wire(m, 'x1.y', 'a1.i0'); wire(m, 'cin.y', 'a1.i1');
  add(m, 'a2', 'and', 400, 340, { n: 2 }); wire(m, 'a.y', 'a2.i0'); wire(m, 'b.y', 'a2.i1');
  add(m, 'o1', 'or', 560, 290, { n: 2 }); wire(m, 'a1.y', 'o1.i0'); wire(m, 'a2.y', 'o1.i1');
  add(m, 'sum', 'out', 720, 147, { width: 1 }, { label: 'sum' }); wire(m, 'x2.y', 'sum.a');
  add(m, 'cout', 'out', 720, 297, { width: 1 }, { label: 'cout' }); wire(m, 'o1.y', 'cout.a');
  test(d, 'All eight input combinations', ['a', 'b', 'cin', 'sum', 'cout'], [['0', '0', '0', '0', '0'], ['0', '0', '1', '1', '0'], ['0', '1', '0', '1', '0'], ['0', '1', '1', '0', '1'], ['1', '0', '0', '1', '0'], ['1', '0', '1', '0', '1'], ['1', '1', '0', '0', '1'], ['1', '1', '1', '1', '1']]);
  emit('02-full-adder.rtlp', d);
}
// 03 mux + decoder
{
  const d = design('Mux and decoder'); const m = d.modules.top;
  note(m, 40, 20, 560, 50, 'A 4:1 multiplexer selects one of four 4-bit inputs with the 2-bit select. Below it, a 2-to-4 decoder with an enable turns a 2-bit code into a one-hot output.');
  ['3', '5', '9', '12'].forEach((v, i) => add(m, `d${i}`, 'in', 40, 100 + i * 50, { width: 4, value: v }, { label: `d${i}` }));
  add(m, 'sel', 'in', 40, 330, { width: 2, value: 0 }, { label: 'sel' });
  add(m, 'mux1', 'mux', 260, 130, { n: 4, width: 4 }); for (let i = 0; i < 4; i++) wire(m, `d${i}.y`, `mux1.i${i}`); wire(m, 'sel.y', 'mux1.s');
  add(m, 'y', 'out', 420, 165, { width: 4 }, { label: 'y' }); wire(m, 'mux1.y', 'y.a');
  add(m, 'code', 'in', 40, 460, { width: 2, value: 2 }, { label: 'code' }); add(m, 'en', 'in', 40, 560, { width: 1, value: 1 }, { label: 'en' });
  add(m, 'dec1', 'dec', 260, 440, { bits: 2, en: true }); wire(m, 'code.y', 'dec1.a'); wire(m, 'en.y', 'dec1.en');
  for (let i = 0; i < 4; i++) { add(m, `q${i}`, 'out', 420, 420 + i * 40, { width: 1 }, { label: `q${i}` }); wire(m, `dec1.y${i}`, `q${i}.a`); }
  test(d, 'Mux selects', ['sel', 'y'], [['0', '3'], ['1', '5'], ['2', '9'], ['3', '12']]);
  test(d, 'Decoder one-hot', ['code', 'en', 'q0', 'q1', 'q2', 'q3'], [['0', '1', '1', '0', '0', '0'], ['1', '1', '0', '1', '0', '0'], ['2', '1', '0', '0', '1', '0'], ['3', '1', '0', '0', '0', '1'], ['3', '0', '0', '0', '0', '0']]);
  emit('03-mux-decoder.rtlp', d);
}
// 04 adder + comparator
{
  const d = design('8-bit adder and comparator'); const m = d.modules.top;
  note(m, 40, 20, 560, 50, 'An 8-bit adder with carry-out and an equality comparator. Try a + b > 255 to see the carry. Hover a bus to read its value in binary and hex.');
  add(m, 'a', 'in', 40, 110, { width: 8, value: 200 }, { label: 'a' }); add(m, 'b', 'in', 40, 190, { width: 8, value: 100 }, { label: 'b' });
  add(m, 'add1', 'add', 260, 120, { width: 8, cout: true }); wire(m, 'a.y', 'add1.a'); wire(m, 'b.y', 'add1.b');
  add(m, 's', 'out', 420, 127, { width: 8 }, { label: 'sum' }); wire(m, 'add1.s', 's.a');
  add(m, 'co', 'out', 420, 151, { width: 1 }, { label: 'carry' }); wire(m, 'add1.co', 'co.a');
  add(m, 'cmp1', 'cmp', 260, 260, { width: 8, op: 'eq' }); wire(m, 'a.y', 'cmp1.a'); wire(m, 'b.y', 'cmp1.b');
  add(m, 'eq', 'out', 420, 271, { width: 1 }, { label: 'a == b' }); wire(m, 'cmp1.y', 'eq.a');
  test(d, 'Sums and carries', ['a', 'b', 's', 'co', 'eq'], [['1', '2', '3', '0', '0'], ['200', '100', '44', '1', '0'], ['255', '1', '0', '1', '0'], ["8'hF0", "8'hF0", '224', '1', '1'], ['0', '0', '0', '0', '1']]);
  emit('04-adder-comparator.rtlp', d);
}
// 05 ALU
{
  const d = design('8-bit ALU'); const m = d.modules.top;
  note(m, 40, 20, 560, 50, 'op selects the operation: 0 add, 1 sub, 2 and, 3 or, 4 xor, 5 set-less-than (signed), 6 shift left, 7 shift right. zero is 1 when the result is 0.');
  add(m, 'a', 'in', 40, 110, { width: 8, value: 12 }, { label: 'a' }); add(m, 'b', 'in', 40, 190, { width: 8, value: 5 }, { label: 'b' }); add(m, 'op', 'in', 40, 320, { width: 3, value: 0 }, { label: 'op' });
  add(m, 'alu1', 'alu', 260, 110, { width: 8 }); wire(m, 'a.y', 'alu1.a'); wire(m, 'b.y', 'alu1.b'); wire(m, 'op.y', 'alu1.op');
  add(m, 'y', 'out', 420, 127, { width: 8 }, { label: 'result' }); wire(m, 'alu1.y', 'y.a');
  add(m, 'z', 'out', 420, 155, { width: 1 }, { label: 'zero' }); wire(m, 'alu1.z', 'z.a');
  test(d, 'Every operation', ['a', 'b', 'op', 'y', 'z'], [['12', '5', '0', '17', '0'], ['12', '5', '1', '7', '0'], ['12', '5', '2', '4', '0'], ['12', '5', '3', '13', '0'], ['12', '5', '4', '9', '0'], ['12', '5', '5', '0', '1'], ['250', '5', '5', '1', '0'], ['12', '2', '6', '48', '0'], ['12', '2', '7', '3', '0'], ['5', '5', '1', '0', '1']]);
  emit('05-alu.rtlp', d);
}
// 06 counter
{
  const d = design('Counters'); const m = d.modules.top;
  note(m, 40, 20, 600, 50, 'The top counter only counts while en = 1; wrap goes high in the cycle before it rolls over. The bottom counter is free-running. Press Space to clock, Shift+Space to go back, and watch the waveform.');
  add(m, 'en', 'in', 40, 110, { width: 1, value: 1 }, { label: 'en' });
  add(m, 'cnt', 'counter', 260, 100, { width: 4, en: true }, { label: 'count' }); wire(m, 'en.y', 'cnt.en');
  add(m, 'q', 'out', 440, 104, { width: 4 }, { label: 'q' }); wire(m, 'cnt.q', 'q.a');
  add(m, 'wrap', 'out', 440, 130, { width: 1 }, { label: 'wrap' }); wire(m, 'cnt.co', 'wrap.a');
  add(m, 'free', 'counter', 260, 260, { width: 3, en: false }, { label: 'free-running' });
  add(m, 'q2', 'out', 440, 264, { width: 3 }, { label: 'q2' }); wire(m, 'free.q', 'q2.a');
  test(d, 'Count, hold, wrap', ['en', 'q', 'wrap', 'q2'], [['1', '0', '0', '0'], ['1', '1', '0', '1'], ['0', '2', '0', '2'], ['0', '2', '0', '3'], ['1', '2', '0', '4'], ['C*12', '', '', ''], ['1', '15', '1', '1'], ['1', '0', '0', '2']]);
  emit('06-counter.rtlp', d);
}
// 07 shift register
{
  const d = design('Shift register'); const m = d.modules.top;
  note(m, 40, 20, 600, 50, 'The sequence block feeds one bit per cycle into a 4-stage shift register. Bit 0 of Q is the newest bit; out is the oldest. Clock four times and read the pattern in Q.');
  add(m, 'din', 'seq', 40, 110, { width: 1, values: '1011', repeat: true }, { label: 'din' });
  add(m, 'sr', 'shreg', 260, 100, { len: 4 }, { label: 'shift' }); wire(m, 'din.y', 'sr.d');
  add(m, 'q', 'out', 440, 104, { width: 4 }, { label: 'q' }); wire(m, 'sr.q', 'q.a');
  add(m, 'so', 'out', 440, 130, { width: 1 }, { label: 'out' }); wire(m, 'sr.so', 'so.a');
  test(d, 'Shifts in 1011', ['q', 'so'], [['0', '0'], ['1', '0'], ['2', '0'], ['5', '0'], ['11', '1'], ['7', '0']]);
  emit('07-shift-register.rtlp', d);
}
// 08 accumulator
{
  const d = design('Accumulator'); const m = d.modules.top;
  note(m, 40, 20, 620, 50, 'acc <= acc + x on every enabled clock. The net label "acc" carries Q back to the adder without a long wire. Hold Reset and clock once to clear it.');
  add(m, 'x', 'in', 40, 110, { width: 8, value: 3 }, { label: 'x' }); add(m, 'en', 'in', 40, 250, { width: 1, value: 1 }, { label: 'en' });
  add(m, 'add1', 'add', 240, 100, { width: 8, cout: false }); wire(m, 'x.y', 'add1.a');
  add(m, 'lbl_in', 'label', 120, 152, { name: 'acc', width: 8 }); wire(m, 'lbl_in.o', 'add1.b');
  add(m, 'reg1', 'reg', 400, 110, { width: 8, en: true }, { label: 'acc' }); wire(m, 'add1.s', 'reg1.d'); wire(m, 'en.y', 'reg1.en');
  add(m, 'lbl_out', 'label', 560, 117, { name: 'acc', width: 8 }); wire(m, 'reg1.q', 'lbl_out.i');
  add(m, 'y', 'out', 560, 170, { width: 8 }, { label: 'acc' }); wire(m, 'reg1.q', 'y.a', 530);
  test(d, 'Accumulate 3s then reset', ['x', 'en', 'y'], [['3', '1', '0'], ['3', '1', '3'], ['3', '1', '6'], ['3', '0', '9'], ['3', '0', '9'], ['R', '', ''], ['3', '1', '0']]);
  emit('08-accumulator.rtlp', d);
}
// 09 bus slicing
{
  const d = design('Bus slicing and extension'); const m = d.modules.top;
  note(m, 40, 20, 620, 50, 'Split breaks an 8-bit bus into two nibbles; Join puts them back in the other order (a nibble swap). Below, zero-extension and sign-extension of narrow values into 8 bits.');
  add(m, 'x', 'in', 40, 110, { width: 8, value: "8'hA5" }, { label: 'x' });
  add(m, 'sp', 'split', 220, 100, { widths: '4 4' }); wire(m, 'x.y', 'sp.i');
  add(m, 'jn', 'join', 360, 100, { widths: '4 4' }); wire(m, 'sp.o0', 'jn.i1'); wire(m, 'sp.o1', 'jn.i0');
  add(m, 'swapped', 'out', 500, 107, { width: 8 }, { label: 'swapped' }); wire(m, 'jn.o', 'swapped.a');
  add(m, 'bit', 'in', 40, 250, { width: 1, value: 1 }, { label: 'bit' }); add(m, 'z', 'ext', 220, 247, { inw: 1, outw: 8, signed: false }); wire(m, 'bit.y', 'z.a');
  add(m, 'zext', 'out', 500, 250, { width: 8 }, { label: 'zero-ext' }); wire(m, 'z.y', 'zext.a');
  add(m, 'k', 'const', 40, 340, { width: 4, value: "4'b1010" }); add(m, 's', 'ext', 220, 340, { inw: 4, outw: 8, signed: true }); wire(m, 'k.y', 's.a');
  add(m, 'sext', 'out', 500, 343, { width: 8 }, { label: 'sign-ext' }); wire(m, 's.y', 'sext.a');
  test(d, 'Swap and extend', ['x', 'bit', 'swapped', 'zext', 'sext'], [["8'hA5", '1', "8'h5A", '1', "8'hFA"], ["8'h12", '0', "8'h21", '0', "8'hFA"]]);
  emit('09-bus-slicing.rtlp', d);
}
// 10 sequence detector datapath
{
  const d = design('Pattern detector (datapath only)'); const m = d.modules.top;
  note(m, 40, 20, 640, 50, 'Detects the bit pattern 1011 in a serial stream using a shift register and a comparator, with no state machine. found goes high in the cycle after the last bit arrives. Which cycle does that correspond to in the waveform?');
  add(m, 'din', 'seq', 40, 110, { width: 1, values: '0 1 0 1 1 1 0 1 1 0', repeat: false }, { label: 'din' });
  add(m, 'sr', 'shreg', 240, 100, { len: 4 }); wire(m, 'din.y', 'sr.d');
  add(m, 'k', 'const', 240, 210, { width: 4, value: "4'b1011" }, { label: 'pattern 1011' });
  add(m, 'cmp1', 'cmp', 420, 130, { width: 4, op: 'eq' }); wire(m, 'sr.q', 'cmp1.a'); wire(m, 'k.y', 'cmp1.b');
  add(m, 'found', 'out', 580, 141, { width: 1 }, { label: 'found' }); wire(m, 'cmp1.y', 'found.a');
  test(d, 'Stream 0101110110', ['found'], [['0'], ['0'], ['0'], ['0'], ['0'], ['1'], ['0'], ['0'], ['0'], ['1'], ['0']]);
  emit('10-pattern-detector.rtlp', d);
}
