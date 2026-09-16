# Landscape research: digital design teaching tools (September 2026)

Condensed from four web surveys run on 2026-09-15. Sources are linked inline.
Companion to `DESIGN.md`.

## 1. Schematic editors and simulators

| Tool | Level | Sim model | HDL in / out | FSM | Waves | Tests | Runs locally |
|---|---|---|---|---|---|---|---|
| [Logisim-evolution 5](https://github.com/logisim-evolution/logisim-evolution) (Java, GPL-3, active) | gates, buses, subcircuits | event-driven, unit delay, E/U values | no / VHDL+Verilog generation | no | chronogram | test vectors | JAR |
| [Digital](https://github.com/hneemann/Digital) (Java, GPL-3, one release/yr) | gates, subcircuits | event-driven, uniform delay, Z | HDL components via ghdl/iverilog / VHDL+Verilog export | **yes**, diagram to table to circuit | measurement graph | **test-case table component** | JAR |
| [CircuitVerse](https://github.com/CircuitVerse/CircuitVerse) (Rails+Vue, MIT) | gates, subcircuits | JS event sim | Yosys server / gate-level Verilog | no | basic | testbench + LMS grading | self-host or Tauri |
| [DigitalJS](https://github.com/tilk/digitaljs) (JS, BSD-2, active Feb 2026) | **Yosys RTL cells** (mux, alu, dff, memory, fsm) | tick-based event, 3-valued | **SV via Yosys** / none | view only | per-wire mini waveform | no | needs Node + Yosys |
| [Falstad CircuitJS](https://github.com/pfalstad/circuitjs1) | analog + gates | transient | no | no | scope | no | Electron |
| [EDA Playground](https://eda-playground.readthedocs.io/), [HDLBits](https://hdlbits.01xz.net/) | HDL text | 4-state | native | no | EPWave / Inputs-Yours-Ref | HDLBits autogrades | no |
| 2025-26 newcomers: [RTL Studio](https://rtlstudio.dev/), [VeriSim](https://github.com/senolgulgonul/verisim), [ChipVerify Lab](https://lab.chipverify.com/), [EcrioniX](https://ecrionix.org/tools/) | HDL text with viewers | Icarus/Verilator WASM | native | extracted view | Surfer or own | some autograde | RTL Studio and VeriSim need an HTTP server |

**Closest to our target** (block-level RTL, cycle sim, SV round trip, FSM editor, waveforms): DigitalJS (import side only), Digital (FSM and tests, but gate-centric Java desktop), Logisim-evolution (mature but no FSM, no import), CircuitVerse (browser, classroom features, weak waves).

**Gaps nobody fills**
- True round trip: no tool imports SV into an editable block schematic and re-emits clean SV. DigitalJS is one-way; CircuitVerse export is gate soup.
- Cycle-based RTL semantics in a schematic tool. Schematic tools are all event/gate level.
- A graphical FSM editor tied to SV `enum` / `always_ff` output and to the waveform.
- Waveform quality inside schematic tools, and cursor-to-schematic cross-probing.
- Test mismatches that point back at the schematic or state diagram. Every tool shows mismatches only as waves or tables.
- Browser plus offline without a server-side toolchain.

**Complaints in the wild**: Logisim HiDPI and slowness ([#524](https://github.com/logisim-evolution/logisim-evolution/issues/524), [#216](https://github.com/logisim-evolution/logisim-evolution/issues/216)); Logisim power-on and oscillation debugging (the reason Digital exists); DigitalJS has no undo, no save with layout, no export; wire-level tools stop scaling and people want drag-and-drop blocks that map to HDL modules ([HN](https://news.ycombinator.com/item?id=20269293)); web waveform viewers choke on big VCDs ([MIT 6.205](https://fpga.mit.edu/6205/F24/documentation/waveform_viewers)).

## 2. HDL parsing, elaboration, simulation

| Option | Fit for SV subset to blocks | Fit for blocks to clean SV | Notes |
|---|---|---|---|
| [YoWASP Yosys](https://github.com/YoWASP/yosys) (`@yowasp/yosys` npm, [`yowasp-yosys`](https://pypi.org/project/yowasp-yosys/) PyPI, ISC) | **excellent**: `read_slang` (Yosys 0.67+ ships [yosys-slang](https://github.com/povik/yosys-slang)) elaborates real SV with slang diagnostics; `prep; write_json` gives word-level `$add/$mux/$dff/$mem_v2/$fsm` cells with `src` line attributes | poor: `write_verilog` output is unreadable | browser bundle is 67 MB WASM + 10 MB resources; the PyPI wheel is 15.6 MB and runs under wasmtime in the Python host with a few-second first-run JIT |
| [yosys2digitaljs](https://github.com/tilk/yosys2digitaljs) (BSD-2) | good: maps Yosys JSON to typed devices, preserves hierarchy and source positions | none | small; adaptable to feed Yosys JSON in directly |
| [slang](https://github.com/MikePopoloski/slang) / [pyslang 11](https://pypi.org/project/pyslang/) (MIT) | AST only; you write the always_ff/comb lowering yourself | n/a | best diagnostics, but no published WASM; yosys-slang already does the lowering |
| [tree-sitter-systemverilog](https://github.com/gmlarumbe/tree-sitter-systemverilog) | CST, no widths or types | n/a | fine for editor highlighting only |
| Pure JS parsers, pyverilog, hdlConvertor, Surelog | stale, Verilog-2005 only, or far too heavy | | avoid |
| Verilator WASM | does not exist ([#1402](https://github.com/verilator/verilator/issues/1402)); Icarus WASM exists only inside VeriSim (GPL) | | not needed for a cycle simulator |
| Layout: [netlistsvg](https://github.com/nturley/netlistsvg), [elkjs](https://github.com/kieler/elkjs) (EPL-2) | ELK layered with port constraints is what makes RTL diagrams look right | | dagre is unmaintained and has no ports |
| Waves: [WaveDrom](https://github.com/wavedrom/wavedrom) (MIT), [Surfer](https://surfer-project.org/) (EUPL, Rust/WASM), [wellen](https://github.com/ekiwi/wellen) | WaveDrom for snippets and handouts; Surfer too heavy and EUPL to embed; VCD export is trivial text | | |

**Lesson from Vivado IP Integrator, Quartus BDF, Logisim, Digital**: every production tool keeps a canonical block model and treats HDL as generated output with a stable naming scheme. None re-import edited HDL into the same diagram.

**Recommendation from the survey**: own block IR as canonical model; SV to blocks through Yosys (run in the Python host, so students never download the WASM); blocks to SV through a hand-written TypeScript emitter; own simulator over the IR; VCD export.

## 3. Pedagogy and UX ideas worth borrowing

| Idea | Source |
|---|---|
| Green/grey wire state plus flash-on-change; selected mux input marked; click a wire to trace its net | [Ripes](https://github.com/mortbopet/Ripes) |
| Grey out irrelevant wires, colour the control path, critical path in red | [DrMIPS](https://brunonova.github.io/drmips/) |
| Reverse one cycle. Every good tool has it | Ripes, Venus, DrMIPS |
| Diagram, transition table, circuit and simulation all live and linked, with the active state highlighted | [Digital](https://github.com/hneemann/Digital), [Deeds](https://www.digitalelectronicsdeeds.com/deeds.html) |
| State encoding as a switch (binary/one-hot/gray) at export time, not a redraw; Moore outputs on states, Mealy outputs on transitions | [Fizzim](https://fizzim.com/) |
| Transition conditions as boolean expressions with a determinism check | [Logisim-evolution FSM fork](https://github.com/sderrien/logisim-evolution) |
| FSM plus datapath registers as one first-class object (HLSM) | zyBooks Vahid, the only mainstream tool that does this |
| Side-by-side Moore vs Mealy stepping of the same spec | [EcrioniX](https://ecrionix.org/tools/) |
| Waveform cursor annotates the schematic at that cycle; per-wire mini waveform | DigitalJS, Surfer WCP, Verdi cross-probing |
| Inputs / Yours / Ref / Mismatch waveform bands with a mismatch count | [HDLBits](https://hdlbits.01xz.net/wiki/Step_one) |
| Test-case table as a component of the design, with `C` clock and `X` don't-care | Digital |
| Translators: show enum state names, signed values, not `3'b010` | Surfer |
| Load-by-URL with startup commands; share links for assignments and TA help | Surfer, EDA Playground |
| Many small scaffolded exercises with a hint, not one big project | HDLBits, Turing Complete |
| Lockable instructor-provided parts of a circuit | [Logisim-evolution #1814](https://github.com/logisim-evolution/logisim-evolution/issues/1814) |
| Single-gate step mode for oscillation debugging; test tables in the design file | Digital |
| Fuzzy command palette | Logisim-evolution 5, Surfer |

**Textbook reality**: Harris & Harris, Brown & Vranesic and Wakerly courses use Quartus/Vivado plus ModelSim and bolt Logisim or Digital on for intuition. Only Vahid ships purpose-built FSM/HLSM/datapath simulators (zyBooks, commercial).

## 4. Shipping a Vite app as a uv-launched Python package

- **Layout**: `frontend/` Vite project building into `src/rtl_playground/static/`; hatchling with `artifacts = ["src/rtl_playground/static/**"]` (the folder is gitignored, so plain `include` is filtered) and a custom build hook that runs `npm ci && npm run build` when `static/index.html` is missing. See [hatch build hooks](https://hatch.pypa.io/latest/plugins/build-hook/custom/), [hatch-jupyter-builder](https://hatch-jupyter-builder.readthedocs.io/).
- **Distribution**: publish wheels to PyPI from GitHub Actions with `uv build` and trusted publishing. This is the only path that avoids Node on student machines. A git URL install builds on the student's laptop.
- **Launch**: `uvx rtl-playground@latest` (refreshes each run) or `uv run -m rtl_playground`. Students install only [uv](https://docs.astral.sh/uv/getting-started/installation/); it fetches a managed CPython. Cold start 10-60 s once, then about 1 s.
- **Server**: stdlib `http.server` on `127.0.0.1` with port 0, a startup token in the URL fragment required on write endpoints, `Host`/`Origin` check, SPA fallback, `Cache-Control: no-store` on `index.html`. Streamlit moved to Starlette+uvicorn in 1.57, marimo and Datasette use Starlette, but none of that is needed without WebSockets.
- **Files**: the server owns the launch directory and exposes a sandboxed file API, exactly as Jupyter's Contents API and marimo do. Skip the File System Access API (Chromium only). Keep download/upload as a fallback.
- **Native window**: pywebview needs apt/WebView2/pyobjc per platform and is a known support sink ([issue 1211](https://github.com/r0x0r/pywebview/issues/1211)). Optional `[desktop]` extra at most.
- **Yosys from Python**: `yowasp-yosys` as an optional `[hdl]` extra, run in-process via `yowasp_yosys.run_yosys([...])`; cache under `~/.cache/YoWASP`. Verilator has a PyPI wheel but still needs a C++ compiler, so it stays "if found on PATH".
- **Pitfalls**: wheel missing `static/`; Vite `base` must be `'./'`; never bind `0.0.0.0` (campus Wi-Fi exposure and Windows firewall prompts); `uvx name` without `@latest` never upgrades; Windows antivirus and cmd.exe progress-bar hangs; `webbrowser.open` fails under WSL, so always print the URL.
