// Fidelity check for the SystemVerilog emitter (DESIGN.md section 8): for every shipped example, write the
// emitted design and its testbenches to a temp directory, lint them with Verilator, compile and run the
// testbench binaries, and check that every test the in-browser simulator passes also passes under Verilator.
// Also runs the design through Yosys to confirm it is synthesizable.
//
// Hierarchical examples (DESIGN.md task 4, e.g. 11-sad-hierarchy.rtlp) need no special-casing here:
// `emitDesign` writes every module of the design into the one file below, so Verilator lints/builds the whole
// hierarchy in one pass and Yosys's `hierarchy -check` walks the same module instantiation tree the schematic
// does, which is exactly the check that would catch a dangling or missing instance reference before a student
// hits it in Vivado/Quartus.
//
// Run with: npx vite-node scripts/verify-sv.ts [example.rtlp ...]   (default: every examples/*.rtlp)
//
// Tools: Verilator 5 and Yosys from the local machine when Verilator is found (on PATH, or under RTLP_EDA_ENV,
// a conda-style prefix whose include/lib the Verilated build needs), otherwise from the app's pinned tools
// image through Docker (the image named in src/rtl_playground/toolchain.py; RTLP_IMAGE overrides it).
// RTLP_VERIFY_TOOLS=native|docker forces one. In Docker mode every command, including running the built
// testbench, happens in the container with the work directory mounted at /work.
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

function onPath(cmd: string): boolean { try { execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 20_000 }); return true; } catch { return false; } }
/** The tools image the app itself uses, so this check and the Project view never drift apart. */
function toolsImage(): string {
  if (process.env.RTLP_IMAGE) return process.env.RTLP_IMAGE;
  const py = readFileSync(resolve(__dirname, '../../src/rtl_playground/toolchain.py'), 'utf8');
  const name = /^TOOLS_IMAGE = "([^"]+)"/m.exec(py)?.[1], tag = /^TOOLS_IMAGE_TAG = "([^"]+)"/m.exec(py)?.[1];
  if (!name || !tag) throw new Error('cannot read TOOLS_IMAGE/TOOLS_IMAGE_TAG from toolchain.py; set RTLP_IMAGE');
  return `${name}:${tag}`;
}
const MODE = process.env.RTLP_VERIFY_TOOLS ?? (existsSync(VERILATOR) || onPath('verilator') ? 'native' : 'docker');
const IMAGE = MODE === 'docker' ? toolsImage() : '';
let WORK_ROOT = ''; // set in main(); mounted at /work in Docker mode
const ENV = {
  ...process.env,
  PATH: `${join(EDA, 'bin')}:${process.env.PATH ?? ''}`,
  CPATH: join(EDA, 'include'),
  LIBRARY_PATH: join(EDA, 'lib'),
  LD_LIBRARY_PATH: [join(EDA, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
};

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  if (MODE === 'docker') {
    const inBox = (p: string) => p.split(WORK_ROOT).join('/work'); // also inside Yosys's -p script text
    const user = process.getuid && process.getgid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    args = ['run', '--rm', ...user, '-e', 'HOME=/tmp', '-v', `${WORK_ROOT}:/work`, '-w', inBox(cwd), IMAGE,
      cmd === VERILATOR ? 'verilator' : cmd === YOSYS ? 'yosys' : inBox(cmd), ...args.map(inBox)];
    cmd = 'docker';
  }
  try { const out = execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }); return { ok: true, out }; }
  catch (e) { const err = e as { stdout?: string; stderr?: string; message: string }; return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message}` }; }
}

interface Report { file: string; module: string; ok: boolean; detail: string }
const reports: Report[] = [];
let anyFail = false;

function verifyExample(file: string, dir: string): void {
  const design: Design = deserialize(readFileSync(file, 'utf8'));
  const name = file.replace(/^.*\//, '').replace(/\.rtlp$/, '');
  // Named after the top module (not the example file), matching the emitter's own DECLFILENAME suppression:
  // a single-module design's one module then matches the filename with nothing to suppress; a hierarchical
  // one's other modules don't, which `hdl/emit.ts`'s `moduleText()` already accounts for.
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

  console.log(MODE === 'docker' ? `Tools: Docker image ${IMAGE}` : `Tools: ${VERILATOR} and ${YOSYS}`);

  const tmp = mkdtempSync(join(tmpdir(), 'rtlp-sv-'));
  WORK_ROOT = tmp;
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
