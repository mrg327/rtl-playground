"""Job recipes for a project: lint, cocotb tests, ORFS synthesis and the full flow.

Each recipe returns the steps of a :class:`~rtl_playground.jobs.Job`. Host
steps generate inputs before a tool runs and parse its outputs afterwards,
so the browser receives structured results (diagnostics, test cases,
metrics) rather than having to scrape logs.
"""

from __future__ import annotations

import importlib.resources
import json
import re
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from rtl_playground import reports
from rtl_playground.jobs import Command, HostStep, Job, JobFailed, Step
from rtl_playground.project import BUILD_DIR, Project, generate_orfs_config, generate_sdc, write_if_changed
from rtl_playground.toolchain import Toolchain

JOB_KINDS = ("lint", "test", "synth", "flow", "power")
# ORFS make targets in flow order; "flow" runs to the last one.
FLOW_STAGES = ("synth", "floorplan", "place", "cts", "route", "finish")


def build_steps(kind: str, project: Project, tc: Toolchain, root: Path, options: dict[str, Any]) -> tuple[str, list[Step]]:
    if kind == "lint":
        return f"Lint {project.top}", lint_steps(project, tc, root)
    if kind == "test":
        return test_steps(project, tc, root, options.get("tests"))
    if kind == "synth":
        return f"Synthesize {project.top} ({project.platform.name})", flow_steps(project, tc, root, "synth")
    if kind == "flow":
        stage = options.get("stage", "finish")
        if stage not in FLOW_STAGES:
            raise ValueError(f"stage must be one of {', '.join(FLOW_STAGES)}")
        return f"Implement {project.top} to {stage} ({project.platform.name})", flow_steps(project, tc, root, stage)
    if kind == "power":
        return power_steps(project, tc, root, options)
    raise ValueError(f"unknown job kind {kind!r}; expected one of {', '.join(JOB_KINDS)}")


def _require_sources(project: Project) -> list[Path]:
    files = project.source_files()
    if not files:
        raise JobFailed(f"no source files match {', '.join(project.sources)}")
    return files


# --------------------------------------------------------------------------- #
# Lint
# --------------------------------------------------------------------------- #

_VERILATOR_DIAG = re.compile(
    r"^%(?P<sev>Warning|Error)(?:-(?P<code>[A-Z0-9_]+))?:\s*(?:(?P<file>[^:\s][^:]*):(?P<line>\d+):(?:(?P<col>\d+):)?)?\s*(?P<msg>.*)$"
)


def parse_verilator_diagnostics(log: str, to_project_rel) -> list[dict[str, Any]]:  # noqa: ANN001
    out: list[dict[str, Any]] = []
    for line in log.splitlines():
        m = _VERILATOR_DIAG.match(line.strip())
        if not m:
            continue
        sev = "error" if m.group("sev") == "Error" else "warning"
        f = m.group("file")
        out.append({
            "severity": sev,
            "code": m.group("code") or "",
            "file": to_project_rel(f) if f else None,
            "line": int(m.group("line")) if m.group("line") else None,
            "col": int(m.group("col")) if m.group("col") else None,
            "message": m.group("msg"),
        })
    return out


def _rel_mapper(project: Project, tc: Toolchain, root: Path):  # noqa: ANN202
    """Map a path printed by a tool back to a path relative to the project folder."""
    prefix = tc.tool_path(project.root, root).rstrip("/") + "/"

    def to_rel(p: str) -> str:
        if p.startswith(prefix):
            return p[len(prefix):]
        return p

    return to_rel


def lint_steps(project: Project, tc: Toolchain, root: Path) -> list[Step]:
    files = _require_sources(project)
    argv = ["verilator", "--lint-only", "-Wall", "-Wno-DECLFILENAME", "-Wno-UNUSEDSIGNAL",
            "--top-module", project.top]
    argv += [f"-I{tc.tool_path(project.root / d, root)}" for d in project.include_dirs]
    argv += [tc.tool_path(f, root) for f in files]
    start: dict[str, int] = {}

    def mark(job: Job) -> None:
        start["offset"] = job.read_log(0)[1]

    def collect(job: Job) -> None:
        text, _ = job.read_log(start.get("offset", 0))
        diags = parse_verilator_diagnostics(text, _rel_mapper(project, tc, root))
        errors = sum(1 for d in diags if d["severity"] == "error")
        job.result = {"diagnostics": diags, "errors": errors,
                      "warnings": len(diags) - errors, "failed": errors > 0}

    return [
        HostStep("Collect sources", mark),
        # -Wall makes Verilator exit 1 on warnings; the parsed diagnostics decide pass or fail.
        Command("Verilator lint", argv, project.root, ok_codes=(0, 1)),
        HostStep("Read diagnostics", collect),
    ]


# --------------------------------------------------------------------------- #
# cocotb tests
# --------------------------------------------------------------------------- #


def _install_runner_script(build: Path) -> Path:
    src = importlib.resources.files("rtl_playground") / "tool_scripts" / "rtlp_cocotb.py"
    dst = build / "rtlp_cocotb.py"
    write_if_changed(dst, src.read_text(encoding="utf-8"))
    return dst


def test_steps(project: Project, tc: Toolchain, root: Path, only: Any) -> tuple[str, list[Step]]:
    tests = project.tests
    if isinstance(only, list) and only:
        tests = [t for t in tests if t["name"] in only]
    if not tests:
        raise JobFailed(f"no tests defined in {project.root.name}/rtlp-project.json" if not project.tests
                        else "none of the requested tests exist")
    build = project.build
    steps: list[Step] = []
    runs: list[dict[str, Any]] = []

    def prepare(job: Job) -> None:
        files = _require_sources(project)
        script = _install_runner_script(build)
        for t in tests:
            tdir = build / "tests" / t["name"]
            tdir.mkdir(parents=True, exist_ok=True)
            results = tdir / "results.xml"
            for stale in (results, *tdir.glob("dump.*")):
                stale.unlink(missing_ok=True)
            spec = {
                "sources": [tc.tool_path(f, root) for f in files],
                "includes": [tc.tool_path(project.root / d, root) for d in project.include_dirs],
                "toplevel": t["toplevel"],
                "module": t["module"],
                "testDir": tc.tool_path(project.root / t["dir"], root),
                "runDir": tc.tool_path(tdir, root),
                "buildDir": tc.tool_path(tdir / "sim_build", root),
                "resultsXml": tc.tool_path(results, root),
                "waves": t["waves"],
                "parameters": t["parameters"],
            }
            write_if_changed(tdir / "spec.json", json.dumps(spec, indent=2) + "\n")
            runs.append({"test": t, "dir": tdir, "script": script})

    def collect(job: Job) -> None:
        suites = []
        failed = 0
        total = 0
        for r in runs:
            suite = parse_cocotb_results(r["dir"] / "results.xml")
            suite["name"] = r["test"]["name"]
            waves = _find_waves(r["dir"])
            suite["waves"] = waves.relative_to(project.root).as_posix() if waves else None
            suites.append(suite)
            total += len(suite["cases"])
            failed += sum(1 for c in suite["cases"] if c["status"] != "passed")
            if suite.get("missing"):
                failed += 1
        job.result = {"suites": suites, "total": total, "failed": failed}

    steps.append(HostStep("Prepare testbenches", prepare))
    for t in tests:
        tdir = build / "tests" / t["name"]
        # A failing test is a result, not a crash: keep going and let results.xml decide.
        steps.append(Command(
            f"Test {t['name']} ({t['module']} on {t['toplevel']})",
            [tc.python, tc.tool_path(build / "rtlp_cocotb.py", root), tc.tool_path(tdir / "spec.json", root)],
            project.root,
            env=_test_env(project),
            ok_codes=None,
        ))
    steps.append(HostStep("Read results", collect))
    title = f"Test {tests[0]['name']}" if len(tests) == 1 else f"Run {len(tests)} test suites"
    return title, steps


def _test_env(project: Project) -> dict[str, str]:
    # Testbenches read the clock period from here so simulated activity matches the constraint;
    # OpenSTA does not rescale VCD activity recorded at another clock (power roughly halves at 10 ns vs 1.923 ns).
    clk = project.constraints["clock"]
    return {"PYTHONDONTWRITEBYTECODE": "1", "RTLP_CLOCK_PERIOD_NS": f"{clk['periodNs']:g}", "RTLP_CLOCK_PORT": clk["port"]}


def _find_waves(run_dir: Path) -> Path | None:
    # cocotb writes dump.fst (Verilator --trace-fst) into the test's working folder.
    for name in ("dump.fst", "dump.vcd"):
        if (run_dir / name).is_file():
            return run_dir / name
    return None


def parse_cocotb_results(path: Path) -> dict[str, Any]:
    """JUnit-style results.xml written by cocotb into per-case status and messages."""
    if not path.is_file():
        return {"cases": [], "missing": True,
                "message": "no results.xml: the testbench did not build or crashed before running (see the log)"}
    try:
        tree = ET.parse(path)
    except ET.ParseError as exc:
        return {"cases": [], "missing": True, "message": f"cannot parse results.xml: {exc}"}
    cases = []
    for tc in tree.iter("testcase"):
        status = "passed"
        message = ""
        for tag in ("failure", "error"):
            el = tc.find(tag)
            if el is not None:
                status = "failed"
                message = (el.get("message") or el.text or "").strip()
        if tc.find("skipped") is not None:
            status = "skipped"
        props = {p.get("name"): p.get("value") for p in tc.iter("property")}
        sim_ns = _to_ns(_float(props.get("sim_time_duration")), props.get("sim_time_unit") or "ns")
        cases.append({
            "name": tc.get("name", "?"),
            "module": tc.get("classname", ""),
            "status": status,
            "message": message,
            "time": _float(tc.get("time")),
            "simTimeNs": sim_ns,
        })
    return {"cases": cases, "missing": False}


_TIME_SCALE = {"fs": 1e-6, "ps": 1e-3, "ns": 1.0, "us": 1e3, "ms": 1e6, "s": 1e9, "sec": 1e9}


def _to_ns(value: float | None, unit: str) -> float | None:
    if value is None or unit not in _TIME_SCALE:
        return None
    return value * _TIME_SCALE[unit]


def _float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# ORFS
# --------------------------------------------------------------------------- #


def orfs_paths(project: Project) -> dict[str, Path]:
    work = project.build / "orfs"
    return {"work": work, "config": work / "config.mk", "sdc": work / "constraint.sdc"}


def flow_steps(project: Project, tc: Toolchain, root: Path, stage: str) -> list[Step]:
    paths = orfs_paths(project)

    def generate(job: Job) -> None:
        _require_sources(project)
        if project.constraints["sdc"]:
            src = project.root / project.constraints["sdc"]
            if not src.is_file():
                raise JobFailed(f"constraints.sdc names {project.constraints['sdc']}, which does not exist")
            write_if_changed(paths["sdc"], src.read_text(encoding="utf-8"))
        else:
            write_if_changed(paths["sdc"], generate_sdc(project))
        cfg = generate_orfs_config(project, lambda p: tc.tool_path(p, root), paths["sdc"])
        write_if_changed(paths["config"], cfg)
        job.log(f"wrote {BUILD_DIR}/orfs/config.mk and {BUILD_DIR}/orfs/constraint.sdc\n")

    def collect(job: Job) -> None:
        job.result = reports.collect(project, paths["work"], stage)

    make = [
        "make", "-C", tc.flow_home,
        f"DESIGN_CONFIG={tc.tool_path(paths['config'], root)}",
        f"WORK_HOME={tc.tool_path(paths['work'], root)}",
        stage,
    ]
    return [
        HostStep("Generate config.mk and constraints", generate),
        Command(f"OpenROAD flow: {stage}", make, project.root),
        HostStep("Read reports", collect, always=True),
    ]


def clean_flow(project: Project) -> None:
    work = orfs_paths(project)["work"]
    for sub in ("results", "logs", "reports", "objects"):
        shutil.rmtree(work / sub, ignore_errors=True)


# --------------------------------------------------------------------------- #
# Power from simulation activity
# --------------------------------------------------------------------------- #

_FINAL_OUTPUTS = ("6_final.odb", "6_final.sdc", "6_final.spef")


def _require_finished_flow(project: Project, work: Path) -> None:
    results = reports.orfs_dirs(project, work)["results"]
    missing = [n for n in _FINAL_OUTPUTS if not (results / n).is_file()]
    if missing:
        raise JobFailed(f"the flow has not produced {', '.join(missing)} yet; run Implement first")


def power_steps(project: Project, tc: Toolchain, root: Path, options: dict[str, Any]) -> tuple[str, list[Step]]:
    """Simulate one test with a VCD dump, then feed its switching activity to OpenROAD's
    report_power on the finished flow's final design (DESIGN.md section 13)."""
    paths = orfs_paths(project)
    _require_finished_flow(project, paths["work"])
    if not project.tests:
        raise JobFailed(f"no tests defined in {project.root.name}/rtlp-project.json; "
                        "power needs a cocotb test to drive the design")
    wanted = options.get("test")
    test = next((t for t in project.tests if t["name"] == wanted), None) if wanted else project.tests[0]
    if test is None:
        raise JobFailed(f"no test named {wanted!r}")
    pdir = project.build / "power" / test["name"]
    power_script = project.build / "power" / "rtlp_power.tcl"

    def prepare(job: Job) -> None:
        files = _require_sources(project)
        _install_runner_script(project.build)
        pdir.mkdir(parents=True, exist_ok=True)
        results = pdir / "results.xml"
        for stale in (results, *pdir.glob("dump.*")):
            stale.unlink(missing_ok=True)
        spec = {
            "sources": [tc.tool_path(f, root) for f in files],
            "includes": [tc.tool_path(project.root / d, root) for d in project.include_dirs],
            "toplevel": test["toplevel"],
            "module": test["module"],
            "testDir": tc.tool_path(project.root / test["dir"], root),
            "runDir": tc.tool_path(pdir, root),
            "buildDir": tc.tool_path(pdir / "sim_build", root),
            "resultsXml": tc.tool_path(results, root),
            "waves": True,
            "wavesFormat": "vcd",  # OpenSTA's read_vcd reads VCD, not the FST the test job dumps
            "parameters": test["parameters"],
        }
        write_if_changed(pdir / "spec.json", json.dumps(spec, indent=2) + "\n")

    def after_test(job: Job) -> None:
        suite = parse_cocotb_results(pdir / "results.xml")
        job.result = {"suite": suite}
        if not (pdir / "dump.vcd").is_file():
            raise JobFailed(f"{test['name']} produced no VCD; the simulation likely crashed before finishing (see the log)")

    def generate(job: Job) -> None:
        # config.mk/constraint.sdc from the finished Implement job, rewritten in case the
        # project changed since (write_if_changed leaves the mtime alone when it did not).
        if project.constraints["sdc"]:
            src = project.root / project.constraints["sdc"]
            write_if_changed(paths["sdc"], src.read_text(encoding="utf-8"))
        else:
            write_if_changed(paths["sdc"], generate_sdc(project))
        write_if_changed(paths["config"], generate_orfs_config(project, lambda p: tc.tool_path(p, root), paths["sdc"]))
        script = importlib.resources.files("rtl_playground") / "tool_scripts" / "rtlp_power.tcl"
        write_if_changed(power_script, script.read_text(encoding="utf-8"))

    def collect_result(job: Job) -> None:
        text, _ = job.read_log(0)
        r = reports.collect_power(project, paths["work"], test["name"], _suite_sim_ns(job.result.get("suite")), text)
        suite = job.result.get("suite") or {}
        failed_cases = [c for c in suite.get("cases", []) if c["status"] != "passed"]
        if failed_cases:
            r["warnings"] = [*r["warnings"], f"{test['name']} failed {len(failed_cases)} of "
                             f"{len(suite['cases'])} checks; the activity above still reflects what ran."]
        r["suite"] = suite
        vcd = pdir / "dump.vcd"
        r["waves"] = vcd.relative_to(project.root).as_posix() if vcd.is_file() else None
        job.result = r

    make = [
        "make", "-C", tc.flow_home,
        f"DESIGN_CONFIG={tc.tool_path(paths['config'], root)}",
        f"WORK_HOME={tc.tool_path(paths['work'], root)}",
        f"RUN_SCRIPT={tc.tool_path(power_script, root)}",
        "run",
    ]
    steps: list[Step] = [
        HostStep("Prepare the test bench", prepare),
        Command(f"Test {test['name']} with a VCD dump", [
            tc.python, tc.tool_path(project.build / "rtlp_cocotb.py", root), tc.tool_path(pdir / "spec.json", root),
        ], project.root, env=_test_env(project), ok_codes=None),
        HostStep("Read the test result", after_test),
        HostStep("Generate config.mk, constraints and the power script", generate),
        Command("OpenROAD: report_power from simulated activity", make, project.root, env={
            "RTLP_VCD": tc.tool_path(pdir / "dump.vcd", root),
            "RTLP_VCD_SCOPE": test["toplevel"],
        }),
        HostStep("Read the power report", collect_result, always=True),
    ]
    return f"Power for {test['name']} ({project.platform.name})", steps


def _suite_sim_ns(suite: dict[str, Any] | None) -> float | None:
    """Total simulated time over the run: cocotb reports each case's own duration, and all
    cases in a suite run back to back in the one VCD dump the power job takes activity from."""
    if not suite or not suite.get("cases"):
        return None
    times = [c["simTimeNs"] for c in suite["cases"] if c["simTimeNs"] is not None]
    return sum(times) if times else None


__all__ = ["FLOW_STAGES", "JOB_KINDS", "build_steps", "clean_flow", "parse_cocotb_results",
           "parse_verilator_diagnostics", "power_steps"]
