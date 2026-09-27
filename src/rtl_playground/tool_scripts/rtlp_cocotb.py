"""Run one cocotb test suite on Verilator. Executed by the tools' Python, not the host's.

Usage: python rtlp_cocotb.py SPEC.json

SPEC holds paths as the tools see them:
  {"sources": [...], "includes": [...], "toplevel": "top", "module": "test_top",
   "testDir": "<folder holding the test module>", "runDir": "<working folder; waves land here>",
   "buildDir": "...", "resultsXml": "...", "waves": true, "wavesFormat": "fst", "parameters": {}}

``wavesFormat`` is "fst" (default, small, needs Surfer/GTKWave) or "vcd" (OpenSTA's
``read_vcd`` only reads VCD, so the power job asks for this one).

Copied into the project's build/ folder by the RTL Playground host so the
same file works natively and inside the tool image.
"""

from __future__ import annotations

import json
import sys


def main() -> int:
    with open(sys.argv[1], encoding="utf-8") as fh:
        spec = json.load(fh)
    # The runner hands sys.path to the simulator's Python as PYTHONPATH, which is how it finds the test module.
    sys.path.insert(0, spec["testDir"])
    from cocotb_tools.runner import get_runner

    runner = get_runner("verilator")
    build_args = ["-Wno-fatal", "-Wno-WIDTH"]
    if spec.get("waves"):
        build_args += ["--trace", "--trace-structs"] if spec.get("wavesFormat") == "vcd" else ["--trace-fst", "--trace-structs"]
    runner.build(
        sources=spec["sources"],
        includes=spec.get("includes") or [],
        hdl_toplevel=spec["toplevel"],
        build_dir=spec["buildDir"],
        parameters=spec.get("parameters") or {},
        build_args=build_args,
        waves=bool(spec.get("waves")),
        timescale=("1ns", "1ps"),
        always=True,
    )
    runner.test(
        hdl_toplevel=spec["toplevel"],
        test_module=spec["module"],
        test_dir=spec["runDir"],
        build_dir=spec["buildDir"],
        results_xml=spec["resultsXml"],
        waves=bool(spec.get("waves")),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
