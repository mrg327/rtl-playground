# sad_pe: starter project

One processing element of a block-matching motion estimator: it streams pixel
pairs and accumulates their sum of absolute differences.

- `rtl/sad_pe.sv` the design. Add more `.sv` files under `rtl/`; the project picks up `rtl/*.sv`.
- `tb/test_sad_pe.py` cocotb tests: directed cases and random 16x16 blocks checked against a Python reference model.
- `rtlp-project.json` the top module, the tests, the timing constraints (520 MHz, 0.5 ns I/O delay, 0.2 ns clock uncertainty) and the flow settings (ASAP7).

In the Project view: **Lint** runs Verilator, **Test** runs the cocotb tests,
**Synthesize** and **Implement** run OpenROAD-flow-scripts and report timing,
area, power and the layout. Generated files land in `build/`.
