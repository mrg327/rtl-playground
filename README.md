# RTL Playground

RTL Playground is an educational digital-design tool for a masters digital
design course. Students draw gate-level and RTL schematics from a parametric
block library, build finite-state machines in a dedicated editor, run a
cycle simulator with time travel and a waveform viewer, check their work
against test tables, and export clean SystemVerilog for Vivado or Quartus.
Everything runs locally: a stdlib-only Python host serves a static web front
end on loopback and gives it a sandboxed file API rooted in the folder you
launch it from, so designs are ordinary `.rtlp` files on disk.

## Quick start (students)

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) once.
Then, from the folder where you keep your `.rtlp` files:

```sh
uvx rtl-playground@latest
```

That downloads the latest release (and a managed Python if you have none),
starts the host on `127.0.0.1`, prints the URL, and opens your browser. The
first run takes a while; later runs start in about a second. Press Ctrl-C to
stop. If the browser does not open (WSL, remote sessions), paste the printed
URL yourself; it carries a one-time token, so copy the whole line.

```sh
uvx rtl-playground@latest counter.rtlp   # open a design straight away
uvx rtl-playground@latest --dir ~/labs   # serve a different folder
uvx rtl-playground@latest --port 8765    # fixed port (default: any free port)
uvx rtl-playground@latest --no-browser   # just print the URL
```

The syllabus pins `rtl-playground@~0.N` for the semester. Until the first
release is on PyPI, run from a checkout: `uv run rtl-playground` or
`uvx --from . rtl-playground` in the repo root.

### Optional: SystemVerilog import and lint

HDL import and lint use [Yosys](https://yosyshq.net/yosys/) compiled to
WebAssembly, shipped as the `hdl` extra:

```sh
uvx --with yowasp-yosys rtl-playground@latest    # or: uvx "rtl-playground[hdl]@latest"
```

Without it the editor, simulator, and SystemVerilog *export* still work; only
`Import HDL` and `Lint` report that Yosys is not installed. The first Yosys
call compiles the WebAssembly module and takes a few seconds.

## Developer setup

You need Python 3.10+, [uv](https://docs.astral.sh/uv/), and Node 22.

```sh
# Python host: serves /api and, once built, the front end
uv run rtl-playground --no-browser --port 8765

# Front end with hot reload; Vite proxies /api to the host above
cd frontend && npm install && npm run dev
```

Open the Vite URL (usually `http://localhost:5173/`) with the `#token=...`
fragment printed by the host so writes are authorised.

```sh
uv run --dev pytest                         # host tests
cd frontend && npm test                     # Vitest: model, simulator, test runner
cd frontend && npm run build                # type-checks, builds into src/rtl_playground/static/
cd frontend && npx vite-node scripts/gen-examples.ts   # regenerate and validate examples/*.rtlp
node frontend/scripts/smoke.mjs shots "http://127.0.0.1:8765/#token=<token>"  # browser smoke test
uv build --sdist --wheel                    # the wheel must contain static/index.html
```

The smoke test needs `npx playwright install chromium` once. `uv build` runs a
hatchling hook that builds the front end with `npm ci && npm run build` when
`src/rtl_playground/static/index.html` is missing (set `RTL_FORCE_JS_BUILD=1`
to force it; editable installs skip it). CI builds the front end, checks the
wheel, runs the tests, and publishes `v*` tags to PyPI with trusted
publishing. Set `RTLP_DEBUG=1` to log every request the host handles.

Conventions: the design model is the single source of truth (simulation,
rendering, tests and HDL derive from it); block semantics live only in
`frontend/src/model/library.ts` and follow Yosys cell semantics; values are
`bigint`; reset is synchronous active-high; HDL output is SystemVerilog only.
Edit `frontend/scripts/gen-examples.ts`, not the generated JSON in `examples/`.

## Repository layout

```
DESIGN.md              architecture, model, roadmap
RESEARCH.md            survey of prior art and packaging notes
CLAUDE.md              working notes for AI-assisted development
pyproject.toml         hatchling package `rtl-playground` (src layout, no runtime deps)
hatch_build.py         wheel hook: builds the front end when static/ is missing
src/rtl_playground/    Python host: cli.py, server.py; static/ is the built front end
frontend/src/model     design model, block library, netlist, geometry, serialize
frontend/src/sim       simulator and test runner
frontend/src/ui        store, canvas, panels, waveform
frontend/src/host      client for the Python host API
frontend/scripts/      gen-examples.ts, smoke.mjs
examples/              shipped .rtlp designs (generated)
tests/                 pytest suite for the host
legacy/                the single-file prototype this project replaces
.github/workflows/     build, test, and publish
```
