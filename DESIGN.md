# RTL Playground 2: design

A locally run, single-command tool for teaching masters-level digital design: block-level RTL and gate-level schematics, a graphical FSM editor, cycle-accurate simulation with time travel, a real waveform viewer, test vectors, and a bidirectional bridge to SystemVerilog that drops into Vivado and Quartus.

Decisions here come from the 2026-09-15 interview and the survey in `RESEARCH.md`.

## 1. Goals and non-goals

**Goals**
- Lecture demos, homework and labs, and self-study. One tool for all three, with a presentation mode for the first.
- Topics: FSM plus datapath (FSMD), timing and clocking, memories and buses. Gate-level logic for the fundamentals.
- Same design visible three ways, always in sync: schematic, SystemVerilog, waveform.
- Zero install beyond `uv`. Works offline after the first run. No accounts, no server to maintain.
- Every design is one file a student can email, submit to the LMS, or paste as a link.

**Non-goals for v1**
- Event-driven timing simulation with gate delays and glitches. See section 6 for how timing is taught instead.
- Autograding infrastructure. The file format and test-vector model are designed so a headless runner can be added later.
- Analog, tri-state buses with multiple drivers, or asynchronous design. Buses are modelled with muxes and enables, which is also what synthesis does.
- Replacing Vivado/Quartus/ModelSim. The tool builds intuition and hands off clean HDL.

**Deviations from the interview answers, deliberately**
1. **Lightweight hierarchy is in v1.** You did not pick "hierarchical modules", but the FSM editor needs a container block, imported SystemVerilog is hierarchical, and a register file or FIFO for the memories unit should be one reusable block. The scope is minimal: a module is a sheet, a module instance is a block, and that is all.
2. **Optional X for uninitialized registers.** The simulator stays two-state and synchronous, but a per-design toggle makes registers read X until reset. Off by default. It costs little and it is the single best way to show why reset matters.

## 2. Architecture

```
uvx rtl-playground@latest
      |
      v
Python host (stdlib only, loopback)          Browser (TypeScript + Vite, no framework)
  serve static bundle                          Design model (canonical, JSON)
  /api/files   read/write launch dir  <---->    Schematic editor      FSM editor
  /api/hdl     optional Yosys (yowasp) ---->    SV emitter (TS)       SV importer (Yosys JSON -> model)
  /api/version                                  Simulator (TS, cycle-accurate, in a Worker)
                                                Waveform viewer       Test runner
```

**One canonical model.** Everything derives from the design model: rendering, simulation, the SystemVerilog text, the waveform, the tests. Nothing edits the schematic by parsing HDL, and nothing edits HDL by walking the schematic. This is the lesson from every production tool that survived (Vivado IP Integrator, Quartus BDF, Logisim, Digital): a block model as the source of truth and HDL as generated output with stable names.

**Bidirectional means per module, not per keystroke.** Each module has one source of truth: `schematic`, `fsm`, or `hdl`.
- A schematic or FSM module shows generated SystemVerilog in a read-only tab.
- An HDL module is a text editor. It is elaborated through Yosys into the same block model, so it simulates and draws exactly like a drawn one, with a read-only auto-laid-out schematic.
- "Convert to HDL" freezes the generated text into an editable module. "Convert to schematic" imports the HDL into blocks. Both are explicit, undoable commands. There is no silent two-way sync, because a lossy sync loop is how students lose work.

**Everything is undoable.** The model is a plain JSON tree; every user action is a command producing a new model version. Undo/redo is a stack of versions. This is the top complaint about DigitalJS and a long-standing Logisim bug, and it is cheap to get right from day one.

## 3. The design model

File extension `.rtlp`, JSON, one file per project, human-diffable.

```jsonc
{
  "version": 2,
  "name": "gcd",
  "top": "gcd_top",
  "options": { "resetStyle": "sync_high", "xUntilReset": false, "clockName": "clk" },
  "modules": {
    "gcd_top": {
      "source": "schematic",
      "ports": [{ "name": "start", "dir": "in", "width": 1 }, { "name": "done", "dir": "out", "width": 1 }],
      "blocks": [
        { "id": "r_a", "type": "reg", "params": { "width": 8, "enable": true, "reset": 0 }, "x": 120, "y": 80, "label": "A" },
        { "id": "ctl", "type": "instance", "params": { "module": "gcd_ctl" }, "x": 120, "y": 240 }
      ],
      "nets": [
        { "id": "n1", "name": "a_next", "width": 8, "drivers": ["mux1.y"], "loads": ["r_a.d"], "route": [[220, 96], [260, 96]] }
      ],
      "locked": ["r_a"],
      "notes": [{ "x": 20, "y": 20, "text": "Datapath. Control is in gcd_ctl." }]
    },
    "gcd_ctl": {
      "source": "fsm",
      "ports": [ /* ... */ ],
      "fsm": {
        "reset": "IDLE", "encoding": "binary", "kind": "moore_mealy",
        "states": [{ "name": "IDLE", "x": 100, "y": 100, "outputs": { "done": "0" } }],
        "transitions": [{ "from": "IDLE", "to": "RUN", "cond": "start", "outputs": {} }]
      }
    },
    "adder8": { "source": "hdl", "text": "module adder8(...);\n ...", "elaborated": null }
  },
  "tests": [
    {
      "name": "gcd(12, 18) = 6", "module": "gcd_top",
      "columns": ["start", "a_in", "b_in", "done", "result"],
      "rows": [["1", "12", "18", "X", "X"], ["0", "-", "-", "0", "X"], ["C*8", "", "", "", ""], ["0", "-", "-", "1", "6"]]
    }
  ],
  "views": { "wave": { "signals": ["clk", "gcd_top.ctl.state", "gcd_top.r_a.q"], "radix": { "gcd_top.r_a.q": "dec" } } },
  "history": null
}
```

Design points:
- **Nets, not wires.** A net has one driver and many loads, a width, and an optional name. Two net labels with the same name on a sheet are the same net. This is how real schematics avoid spaghetti, and it maps one-to-one onto a `logic [W-1:0] name;` declaration on export. Routing geometry is cosmetic and lives in `route`.
- **Parametric blocks.** One `reg` type with a `width` parameter replaces `dff` and `reg8`; one `const` with `width` and `value`. The palette shows common presets; the inspector exposes the parameters.
- **Stable ids are the round-trip key.** Block id becomes the instance name in SystemVerilog; net name becomes the signal name. Import reads Yosys `src` attributes and net names back into the same fields.
- **Tests are part of the design**, in Digital's table syntax: `C` clocks once, `C*8` clocks eight times, `X` don't care, `-` hold the previous value. A test row is one cycle. Instructors ship tests in the file; `locked` prevents students from editing the provided parts.
- **`history` is optional saved simulation state** so a lecture can reopen at cycle 37.

## 4. Block library

Every block has typed, width-checked ports. Mismatched widths draw a red badge on the wire and an entry in the problems panel; the simulator still runs with the model's defined truncation/extension so the lecture does not stall.

| Group | Blocks | Notes |
|---|---|---|
| Signals | Input, Output, Constant, Sequence (stimulus list), Clock enable, Reset | Inputs of width 1 toggle on click; wider inputs get an inline radix-aware editor |
| Gates | AND, OR, XOR, NAND, NOR, XNOR (2 to 8 inputs), NOT, Buffer | Gate-level unit. Bitwise on buses |
| Wiring | Splitter (bus to slices), Joiner (concat), Net label, Zero/sign extend, Truncate | The blocks that make buses teachable |
| Combinational | Adder, Subtractor, Multiplier, ALU (op select), Comparator (==, <, <=, signed option), Mux 2:1 and N:1, One-hot mux, Decoder, Encoder, Priority encoder, Shifter, Reduce (AND/OR/XOR) | Semantics are aligned with Yosys cell types so import maps one-to-one |
| Sequential | Register (width, enable, sync/async reset, reset value), Counter (up/down, load, wrap), Shift register, Latch (marked as a warning in the problems panel) | Async reset shown but simulated at the edge, as in real RTL simulators |
| Memory | Register file (parametric ports), Sync RAM (1 or 2 port, `.mem` init), ROM, FIFO (built as a library module) | A memory viewer panel shows contents as a hex table with live read/write highlighting |
| Control | FSM block (opens the FSM editor), Module instance | |
| Annotation | Note, Group frame | Group frames give lecture slides their "datapath" and "control" boxes |

## 5. The FSM editor

An FSM module opens on its own canvas. States are circles with a name and Moore output assignments. Transitions are curves with a condition and optional Mealy outputs. Conditions are boolean expressions over the module's input ports (`start && !busy`, `count == 4'd7`) parsed by a tiny expression grammar that is also the syntax used in the generated SystemVerilog.

Live checks, shown as badges on the diagram and in the problems panel:
- **Determinism**: two outgoing transitions whose conditions can both be true. Checked by enumerating input combinations (inputs are few and narrow) with a cap, falling back to "not checked" above it.
- **Completeness**: a state with no default transition when conditions do not cover all cases. The editor offers "add else transition" and "stay".
- **Unreachable states** and **no path to reset state**.

The four views of Digital and Deeds are all live and linked: diagram, transition table (editable, edits reflect back), generated SystemVerilog, and simulation with the active state highlighted and the taken transition flashed each cycle. Encoding (binary, one-hot, gray) is a switch that only changes the emitted code and the register width in the waveform. The waveform shows state names, never the encoding, unless asked.

For the Moore vs Mealy lecture: "duplicate as Mealy" creates a sibling module so both run side by side on the same stimulus, borrowing the EcrioniX demo.

## 6. Simulation

**Model.** Cycle-accurate synchronous. One global clock in v1. Combinational logic is levelized once per model change into a topological order; a combinational loop is an error with the cycle highlighted on the canvas, not a 24-iteration fixed-point guess as in the current prototype. Values are unsigned integers up to 64 bits (BigInt above 32). Optional X until reset.

**Time travel.** The simulator keeps the register state for every cycle. Stepping back is free, scrubbing the waveform cursor rewinds the schematic to that cycle, and "run to cycle N" is a jump. Register state is small, so ten thousand cycles is a few megabytes. Combinational values are recomputed on demand.

**Controls**: step, step back, run at a speed, run until (cycle, breakpoint on a signal condition, or test row), reset, power-on. Keyboard driven so a lecture is space-bar and arrow keys.

**Visual cues** (from Ripes and DrMIPS): 1-bit nets green or grey; buses show a value label on hover, pinned, or always; any net that changed this cycle flashes; a selected mux marks its chosen input; a "dim inactive" toggle greys nets that did not change this cycle; click a net to trace it across the sheet and into modules.

**Timing and clocking without a delay simulator.** Timing is taught the way industry does it, with static timing analysis over the same netlist:
- Every combinational block carries a nominal delay parameter (defaults provided, editable). Registers carry clock-to-Q, setup and hold.
- The tool computes the longest register-to-register path, shows it in red on the canvas, and reports max clock frequency and slack for a chosen clock period. Changing a block delay or inserting a pipeline register updates it live. That is the pipelining lesson in one interaction.
- Multi-clock and CDC are v2: clocks with integer period ratios on a common tick, synchronizer blocks, and a "metastability window" warning when a net crosses domains without one. Glitches and hold-time races cannot be shown by this engine and the tool says so, with a pointer to running the exported design in ModelSim with SDF.

**Runs in a Web Worker** so a runaway "run" never freezes the editor; the UI receives batched cycle snapshots.

## 7. Waveform viewer

Own implementation on a 2D canvas with virtualized rendering. Surfer is the best viewer available but its EUPL licence and multi-megabyte WASM make embedding awkward, and we need deep integration, not a viewer.

- Signal tree by module hierarchy; drag to reorder; groups; per-signal radix: bin, hex, dec, signed, enum (FSM state names), and ASCII.
- Zoom and pan, two cursors with delta, search for a value or an edge.
- **Cross-probing**: the primary cursor sets the schematic's displayed cycle. Clicking a net on the schematic adds it to the waveform. Hovering a wave highlights the net.
- **Test bands** in HDLBits style: Inputs, Yours, Expected, Mismatch. Clicking a mismatch jumps the schematic to that cycle with the offending output pin marked. Nobody does that link today; it is the most useful thing a student can be shown.
- Export VCD for GTKWave and Surfer, export the visible window as WaveDrom JSON and SVG for handouts and slides, and export PNG.

## 8. SystemVerilog bridge

**Export (blocks to SV)** is a hand-written TypeScript emitter, never Yosys `write_verilog`.
- One `module` per design module, ports in declared order, `logic` everywhere, `always_ff @(posedge clk)` with the chosen reset style, `always_comb` for muxes and ALU ops, named instances equal to block ids, `typedef enum` for FSM states, `case` with `default` for transitions, `// block: r_a` comments so a student can map lines back to boxes.
- Memories emit the inference-friendly pattern each vendor documents, so Vivado and Quartus map them to block RAM.
- Output is formatted for reading, with a header naming the tool version and the source file. Style options: reset polarity and sync/async, `logic` vs `wire/reg` (for a Verilog-2001 course), and lowercase or uppercase state names.
- **Testbench export**: each test table becomes `tb_<module>.sv` that drives the same vectors, compares at each clock edge, and prints pass/fail. Students run the exact same test in ModelSim or Vivado's simulator that they passed in the tool. This is the hand-off that makes the tool a first-class part of an FPGA course.
- **Lint on export**: if the optional Yosys extra is installed, the host runs `read_slang` (or `read_verilog -sv`) then `hierarchy -check; proc; check` on the emitted text and reports any problem before the student sees it in Vivado.

**Import (SV to blocks)** runs in the Python host with the `yowasp-yosys` extra, so students never download 70 MB of WASM into the browser and the page stays framework-free.
- Script: `read_slang` when available, else `read_verilog -sv`; `hierarchy -top`; `proc`; `opt_clean`; `fsm_detect; fsm_extract; fsm_opt` (state machines written as `case` statements come back as FSM blocks with their transition table); `memory -nomap`; `wreduce`; `opt`; `write_json`.
- The mapper is a TypeScript port of the yosys2digitaljs mapping, extended to our block set and with a cleanup pass that folds `$procmux` chains into N:1 muxes, drops `$auto$` names in favour of source-derived labels, and keeps `src` line ranges so "show source" works from any imported block.
- Auto layout with elkjs (layered, fixed port sides, orthogonal edges), which is what netlistsvg and DigitalJS use and why their diagrams look right.
- Diagnostics from slang are shown inline in the HDL editor (CodeMirror 6, the only sizeable dependency in the front end).
- Without the extra installed, the HDL editor still works for viewing and editing; import and lint show a one-line "install with `uvx --with yowasp-yosys rtl-playground`" message.

**Fidelity test in CI**: every example design is exported, re-imported, and simulated against its own test tables. Export text is also compiled by Yosys in CI so a wording change can never break Vivado compatibility silently.

## 9. UX

**Layout.** Left: palette with search and a module tree. Centre: canvas with tabs for each open module and a breadcrumb for hierarchy. Right: inspector (parameters, problems, test results). Bottom: waveform, resizable, in the same window; the "separate waveform tab" of EDA Playground is the stated pain of every tool that copied it. Command palette on Ctrl+K for every action. Dark and light themes.

**Canvas.** Orthogonal wire routing with automatic paths and draggable waypoints, junction dots, bus ticks with widths, net labels, snapping, rubber-band multi-select, copy/paste across sheets and across files (clipboard is the JSON fragment), align and distribute, rotate and flip, group frames, notes. Keyboard nudging. Zoom to fit, zoom to selection. Minimap for large sheets.

**Inline editing.** Double-click any label, constant, or input value to edit in place. Widths and parameters live in the inspector with a live preview of the block symbol.

**Problems panel.** Width mismatches, undriven inputs, multiple drivers, combinational loops, unreachable FSM states, latches inferred, ports unconnected. Click to navigate. Simulation still runs when it can, with the issue flagged, so a demo never dead-ends.

**Presentation mode.** Hides chrome, scales fonts, keeps only step/run/back, shows a large cycle counter, and turns the cursor into a highlighter. Optional "follow" pane that shows the generated SystemVerilog lines for the selected block, for the "this box is this code" moment.

**Sharing without accounts.** Save to the launch folder through the host API. "Copy link" packs small designs into the URL fragment, compressed, so a lecture example is a link on the course page and a TA can send one back. Load-by-URL with startup commands (open module, set cursor, run test) borrowed from Surfer.

**Exercises.** An `.rtlp` with locked instructor parts, a note with the task, and hidden expected columns in a test is a complete assignment. Students see pass/fail, not the expected values, when a test is marked `hidden`. Export "student copy" strips the hidden columns' values and keeps their hashes so the same file can later be checked by a CLI runner.

## 10. Python host and packaging

Stdlib only at runtime. `uvx rtl-playground@latest` or `uv run -m rtl_playground [--dir D] [--port P] [--no-browser] [file.rtlp]`.

- `ThreadingHTTPServer` bound to `127.0.0.1`, port 0 unless given, prints the URL, opens the browser after a short delay (and always prints the URL for WSL).
- A random token generated at startup goes into the URL fragment; write endpoints require it, and `Host`/`Origin` are checked, so another tab cannot write to the student's disk.
- `/api/files` lists, reads and writes `.rtlp`, `.sv`, `.mem` files under the launch directory only; paths are resolved and checked against the root.
- `/api/hdl/elaborate` and `/api/hdl/lint` call `yowasp_yosys.run_yosys` in-process when the extra is present; first run JIT-compiles for a few seconds and the UI shows that.
- `/api/version` and a background check of the PyPI JSON endpoint drive an "update available, rerun with @latest" banner.
- `SimpleHTTPRequestHandler` serves `static/` with an SPA fallback and `Cache-Control: no-store` on `index.html`.

Packaging: hatchling, src layout, Vite builds straight into `src/rtl_playground/static/`, `artifacts` includes it in the wheel, a custom hook runs `npm ci && npm run build` only when `static/` is missing. GitHub Actions builds the front end, runs `uv build`, checks the wheel contains `static/index.html`, and publishes to PyPI with trusted publishing on a tag. The syllabus pins `rtl-playground@~0.N` for the semester. Optional extras: `[hdl]` for Yosys, `[desktop]` for pywebview (unsupported, for the few who want a window).

## 11. Front-end stack

TypeScript, Vite, no UI framework. Rendering is SVG for the schematic and FSM (crisp at any zoom, easy hit testing, exportable) and 2D canvas for the waveform (thousands of cycles). Dependencies kept to: CodeMirror 6 (HDL editor), elkjs (auto layout, loaded lazily in a worker only for import), fflate (link compression). Everything else is in the repo. Tests with Vitest for the model, simulator, emitter and importer; Playwright smoke tests for the editor.

```
frontend/src/
  model/      types, validation, commands, undo, serialization (.rtlp v2, v1 migration)
  sim/        levelize, evaluate, history, STA, worker protocol
  hdl/        emit.ts, testbench.ts, yosys-json-import.ts, cleanup.ts, expr.ts
  fsm/        model, checks, table, layout
  ui/         canvas, palette, inspector, waveform, problems, palette-commands, presentation
  host/       file API client, hdl API client, url-fragment codec
  examples/   shipped designs
```

## 12. Roadmap

Each phase ends in something usable in class.

**Status (2026-09-15): Phase 0 is built.** Model v2 with v1 migration, the parametric block library (27 types), the canvas with undo, orthogonal routing, net labels, multi-select, copy/paste, rotate/flip and notes, the levelised simulator with loop detection and time travel, the canvas waveform viewer with radix, cursor scrubbing, VCD and WaveDrom export, a test-table runner with a Tests tab, presentation mode, a command palette, the stdlib Python host with file API and optional Yosys endpoints, packaging with hatchling, and ten validated examples. One deviation from section 3: the file stores `wires` (pin to pin) and derives nets, because that is what the editor manipulates; net names come from label blocks. Not yet done from Phase 0: locked blocks are honoured but there is no UI to lock them, and the simulator runs on the main thread rather than in a Worker.

**Phase 0, foundation (replaces the prototype).** Model v2 with migration from the current JSON. Parametric block library. New canvas with undo, nets and labels, orthogonal routing, multi-select, copy/paste. Levelized simulator with loop detection and time travel. Python host with file API. Waveform v1 (existing features on the new engine). Presentation mode basics. `uvx` launch works.

**Phase 1, lab-ready.** Waveform v2 with cursors, radix, cross-probing, VCD and WaveDrom export. Test tables with the Inputs/Yours/Expected/Mismatch bands and mismatch-to-schematic jump. SystemVerilog export and testbench export, verified by Yosys in CI. Locked blocks and hidden tests. Ten example designs: counters, register file, ALU, GCD FSMD, multiplier, FIFO, UART transmitter, memory-mapped bus.

**Phase 2, FSMD and memory units.** FSM editor with checks, transition table, encoding switch, Moore/Mealy sibling. Modules and instances. RAM/ROM/register file with the memory viewer and `.mem` loading. STA overlay with critical path and max frequency.

**Phase 3, HDL round trip.** HDL-source modules with CodeMirror. Yosys import through the host, mapper and cleanup pass, elkjs layout, FSM extraction, source-line links, inline diagnostics, lint on export.

**Phase 4, course polish.** URL sharing and load-by-URL commands. Update banner. Optional X-until-reset. Headless test runner for later autograding. Multi-clock and CDC blocks if the timing unit needs them.

## 13. Decisions taken on 2026-09-15

1. **Name.** RTL Playground. Package `rtl-playground`, launch `uvx rtl-playground@latest`.
2. **Reset.** Synchronous, active-high. The emitter and the default register block use `always_ff @(posedge clk) if (rst)`. Other styles stay a per-block parameter, not a design-wide switch, in v1.
3. **HDL dialect.** SystemVerilog only: `logic`, `always_ff`, `always_comb`, `typedef enum`. No Verilog-2001 or VHDL emitter.
4. **First unit in the term: gates and combinational logic.** Phase 0 as written covers it, so the roadmap order stands. Phase 0 should ship with the gate and combinational examples first (adder, mux, decoder, comparator, ALU) and their test tables.
