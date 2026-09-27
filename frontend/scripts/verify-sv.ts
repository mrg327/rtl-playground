// Fidelity check for the SystemVerilog emitter (DESIGN.md section 8): for every shipped example, write the
// emitted design and its testbenches to a temp directory, lint them with Verilator, compile and run the
// testbench binaries, and check that every test the in-browser simulator passes also passes under Verilator.
// Also runs the design through Yosys to confirm it is synthesizable.
//
// Run with: npx vite-node scripts/verify-sv.ts [example.rtlp ...]   (default: every examples/*.rtlp)
//
// Needs Verilator 5 and Yosys on PATH, or under ~/eda/env/bin (this machine's install). If a compiler isn't
// found next to Verilator (CPATH/LIBRARY_PATH/LD_LIBRARY_PATH), set RTLP_EDA_ENV to the toolchain's prefix.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { deserialize } from '../src/model/serialize';
import type { Design } from '../src/model/types';
import { sanitize } from '../src/model/netlist';
import { emitDesign } from '../src/hdl/emit';
import { emitTestbench, testableModules } from '../src/hdl/testbench';

const EDA = process.env.RTLP_EDA_ENV ?? join(homedir(), 'eda', 'env');
const VERILATOR = existsSync(join(EDA, 'bin', 'verilator')) ? join(EDA, 'bin', 'verilator') : 'verilator';
const YOSYS = existsSync(join(EDA, 'bin', 'yosys')) ? join(EDA, 'bin', 'yosys') : 'yosys';
const ENV = {
  ...process.env,
  PATH: `${join(EDA, 'bin')}:${process.env.PATH ?? ''}`,
  CPATH: join(EDA, 'include'),
  LIBRARY_PATH: join(EDA, 'lib'),
  LD_LIBRARY_PATH: [join(EDA, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
};

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  try { const out = execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }); return { ok: true, out }; }
  catch (e) { const err = e as { stdout?: string; stderr?: string; message: string }; return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message}` }; }
}

interface Report { file: string; module: string; ok: boolean; detail: string }
const reports: Report[] = [];
let anyFail = false;

function verifyExample(file: string, dir: string): void {
  const design: Design = deserialize(readFileSync(file, 'utf8'));
  const name = file.replace(/^.*\//, '').replace(/\.rtlp$/, '');
  // Named after the SV module itself (not the example file) so Verilator's DECLFILENAME check has nothing to say.
  const svPath = join(dir, `${sanitize(design.top)}.sv`);
  let svText: string;
  try { svText = emitDesign(design, { sourceFile: `${name}.rtlp` }); }
  catch (e) { reports.push({ file: name, module: design.top, ok: false, detail: `emit failed: ${(e as Error).message}` }); anyFail = true; return; }
  writeFileSync(svPath, svText);

  // Yosys: read + check that the top module elaborates and synthesizes without inferring anything unexpected.
  const yosysScript = `read_verilog -sv ${JSON.stringify(svPath)}; hierarchy -check -top ${design.top}; proc; check -assert`;
  const y = run(YOSYS, ['-p', yosysScript], dir);
  if (!y.ok) { reports.push({ file: name, module: design.top, ok: false, detail: `yosys failed:\n${y.out}` }); anyFail = true; }

  const modules = testableModules(design);
  if (!modules.length) { reports.push({ file: name, module: design.top, ok: y.ok, detail: y.ok ? 'no tests to run under Verilator (yosys check ok)' : 'yosys failed, no tests' }); return; }

  for (const mkey of modules) {
    let tbText: string;
    try { tbText = emitTestbench(design, mkey, { sourceFile: `${name}.rtlp` }); }
    catch (e) { reports.push({ file: name, module: mkey, ok: false, detail: `testbench emit failed: ${(e as Error).message}` }); anyFail = true; continue; }
    const tbPath = join(dir, `tb_${mkey}.sv`);
    writeFileSync(tbPath, tbText);

    const lint = run(VERILATOR, ['--lint-only', '-Wall', svPath, tbPath, '--top-module', `tb_${mkey}`], dir);
    if (!lint.ok) { reports.push({ file: name, module: mkey, ok: false, detail: `verilator --lint-only failed:\n${lint.out}` }); anyFail = true; continue; }

    const build = run(VERILATOR, ['--binary', '--timing', svPath, tbPath, '--top-module', `tb_${mkey}`, '-o', `tb_${mkey}`, '-Wno-fatal'], dir);
    if (!build.ok) { reports.push({ file: name, module: mkey, ok: false, detail: `verilator --binary failed:\n${build.out}` }); anyFail = true; continue; }

    const bin = run(join(dir, 'obj_dir', `tb_${mkey}`), [], dir);
    const passed = bin.ok && /RESULT: PASS/.test(bin.out) && !/RESULT: FAIL/.test(bin.out);
    if (!passed) anyFail = true;
    reports.push({ file: name, module: mkey, ok: passed, detail: passed ? 'PASS' : `Verilator run did not report RESULT: PASS:\n${bin.out}` });
  }
}

function main(): void {
  const examplesDir = resolve(__dirname, '../../examples');
  const argFiles = process.argv.slice(2);
  const files = (argFiles.length ? argFiles : readdirSync(examplesDir).filter(f => f.endsWith('.rtlp')))
    .map(f => (f.includes('/') ? resolve(f) : join(examplesDir, f)));

  if (!existsSync(join(EDA, 'bin', 'verilator')) && VERILATOR === 'verilator') console.log(`(RTLP_EDA_ENV toolchain not found at ${EDA}; relying on PATH)`);

  const tmp = mkdtempSync(join(tmpdir(), 'rtlp-sv-'));
  console.log(`Working directory: ${tmp}`);
  for (const f of files) {
    const dir = join(tmp, f.replace(/^.*\//, '').replace(/\.rtlp$/, ''));
    mkdirSync(dir, { recursive: true });
    console.log(`\n== ${f.replace(/^.*\//, '')} ==`);
    verifyExample(f, dir);
  }

  console.log('\n---- summary ----');
  for (const r of reports) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.file}  ${r.module}  ${r.ok ? '' : '(' + r.detail.split('\n')[0] + ')'}`);
  const failed = reports.filter(r => !r.ok);
  if (failed.length) {
    console.log(`\n${failed.length} failure(s):`);
    for (const r of failed) console.log(`\n--- ${r.file} / ${r.module} ---\n${r.detail}`);
  }
  console.log(`\n${reports.length - failed.length}/${reports.length} checks passed.`);
  if (anyFail) process.exitCode = 1;
}

main();
