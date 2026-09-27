"""Project workspaces: ``rtlp-project.json`` loading, validation and flow file generation.

A project is a folder of SystemVerilog sources, cocotb testbenches and one
``rtlp-project.json`` describing the top module, the tests, the timing
constraints and the physical-design flow settings (DESIGN.md section 13).
Everything this module generates goes under ``build/`` in the project so a
student can open the same files in the real tools.
"""

from __future__ import annotations

import glob
import json
import math
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

PROJECT_FILE = "rtlp-project.json"
BUILD_DIR = "build"
PROJECT_SCAN_DEPTH = 3


@dataclass(frozen=True)
class Platform:
    name: str
    title: str
    time_unit: str  # the Liberty time unit, which SDC numbers are read in
    predictive: bool
    note: str


PLATFORMS: dict[str, Platform] = {
    p.name: p
    for p in (
        Platform("asap7", "ASAP7 7nm FinFET (predictive)", "ps", True,
                 "Predictive academic kit, no silicon behind it: use the numbers to compare designs, not as a 7nm prediction."),
        Platform("sky130hd", "SkyWater 130nm, high density", "ns", False,
                 "Real, open, manufacturable 130nm process."),
        Platform("sky130hs", "SkyWater 130nm, high speed", "ns", False,
                 "Real, open, manufacturable 130nm process, faster and larger cells."),
        Platform("nangate45", "Nangate 45nm open cell library (FreePDK45)", "ns", True,
                 "Academic 45nm library on a predictive kit."),
        Platform("gf180", "GlobalFoundries 180nm MCU", "ns", False,
                 "Real, open, manufacturable 180nm process."),
        Platform("ihp-sg13g2", "IHP SG13G2 130nm BiCMOS", "ns", False,
                 "Real, open, manufacturable 130nm process."),
    )
}

DEFAULT_PLATFORM = "asap7"
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
_EXTRA_KEY = re.compile(r"^[A-Z][A-Z0-9_]*$")


class ProjectError(Exception):
    """A project file that cannot be used; ``problems`` lists every issue found."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


@dataclass
class Project:
    root: Path  # the folder holding rtlp-project.json
    name: str
    top: str
    sources: list[str]
    include_dirs: list[str]
    tests: list[dict[str, Any]]
    constraints: dict[str, Any]
    flow: dict[str, Any]
    raw: dict[str, Any] = field(repr=False)

    @property
    def platform(self) -> Platform:
        return PLATFORMS[self.flow["platform"]]

    @property
    def build(self) -> Path:
        return self.root / BUILD_DIR

    def source_files(self) -> list[Path]:
        """Expand the ``sources`` globs in order, without duplicates."""
        seen: set[Path] = set()
        out: list[Path] = []
        for pattern in self.sources:
            matches = sorted(glob.glob(str(self.root / pattern), recursive=True))
            for m in matches:
                p = Path(m).resolve()
                if p.is_file() and p not in seen and _inside(p, self.root):
                    seen.add(p)
                    out.append(p)
        return out

    def summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "top": self.top,
            "sources": [p.relative_to(self.root).as_posix() for p in self.source_files()],
            "tests": self.tests,
            "constraints": self.constraints,
            "flow": self.flow,
            "platform": {
                "name": self.platform.name,
                "title": self.platform.title,
                "timeUnit": self.platform.time_unit,
                "predictive": self.platform.predictive,
                "note": self.platform.note,
            },
        }


def _inside(path: Path, root: Path) -> bool:
    root = root.resolve()
    return path == root or root in path.parents


def _num(value: Any, name: str, problems: list[str], *, positive: bool = False, minimum: float | None = None,
         maximum: float | None = None) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        problems.append(f"{name} must be a number")
        return None
    if positive and value <= 0:
        problems.append(f"{name} must be greater than 0")
    if minimum is not None and value < minimum:
        problems.append(f"{name} must be at least {minimum}")
    if maximum is not None and value > maximum:
        problems.append(f"{name} must be at most {maximum}")
    return float(value)


def _rel_path(value: Any, name: str, problems: list[str]) -> str | None:
    if not isinstance(value, str) or not value:
        problems.append(f"{name} must be a non-empty relative path")
        return None
    v = value.replace("\\", "/")
    if v.startswith("/") or (len(v) > 1 and v[1] == ":") or ".." in v.split("/") or "\x00" in v:
        problems.append(f"{name} must stay inside the project folder: {value!r}")
        return None
    return v


def parse_project(root: Path, data: Any) -> Project:
    """Validate a decoded project file and fill in defaults. Raises ProjectError."""
    problems: list[str] = []
    if not isinstance(data, dict):
        raise ProjectError([f"{PROJECT_FILE} must hold a JSON object"])
    if data.get("version", 1) != 1:
        problems.append(f"unsupported project version {data.get('version')!r}; this host reads version 1")

    top = data.get("top")
    if not isinstance(top, str) or not _IDENT.match(top):
        problems.append("top must name the top-level module (a SystemVerilog identifier)")
        top = ""
    name = data.get("name") if isinstance(data.get("name"), str) and data.get("name") else (top or root.name)

    sources_in = data.get("sources", ["rtl/*.sv", "rtl/*.v"])
    sources: list[str] = []
    if not isinstance(sources_in, list) or not sources_in:
        problems.append("sources must be a non-empty list of file globs")
    else:
        for i, s in enumerate(sources_in):
            v = _rel_path(s, f"sources[{i}]", problems)
            if v:
                sources.append(v)

    include_dirs: list[str] = []
    for i, s in enumerate(data.get("includeDirs", []) or []):
        v = _rel_path(s, f"includeDirs[{i}]", problems)
        if v:
            include_dirs.append(v)

    tests: list[dict[str, Any]] = []
    tests_in = data.get("tests", [])
    if not isinstance(tests_in, list):
        problems.append("tests must be a list")
        tests_in = []
    for i, t in enumerate(tests_in):
        if not isinstance(t, dict):
            problems.append(f"tests[{i}] must be an object")
            continue
        module = t.get("module")
        if not isinstance(module, str) or not re.match(r"^[A-Za-z_][A-Za-z0-9_.]*$", module):
            problems.append(f"tests[{i}].module must name a Python test module, e.g. \"test_top\"")
            continue
        toplevel = t.get("toplevel", top)
        if not isinstance(toplevel, str) or not _IDENT.match(toplevel):
            problems.append(f"tests[{i}].toplevel must be a module name")
            continue
        tdir = _rel_path(t.get("dir", "tb"), f"tests[{i}].dir", problems) or "tb"
        tname = t.get("name") if isinstance(t.get("name"), str) and t.get("name") else module
        if not re.match(r"^[A-Za-z0-9_.-]+$", tname):
            problems.append(f"tests[{i}].name may only use letters, digits, '_', '.', '-'")
            continue
        params = t.get("parameters", {})
        if not isinstance(params, dict):
            problems.append(f"tests[{i}].parameters must be an object")
            params = {}
        tests.append({"name": tname, "module": module, "toplevel": toplevel, "dir": tdir,
                      "parameters": params, "waves": bool(t.get("waves", True))})
    names = [t["name"] for t in tests]
    if len(set(names)) != len(names):
        problems.append("test names must be unique")

    c_in = data.get("constraints", {})
    if not isinstance(c_in, dict):
        problems.append("constraints must be an object")
        c_in = {}
    clk_in = c_in.get("clock", {})
    if not isinstance(clk_in, dict):
        problems.append("constraints.clock must be an object")
        clk_in = {}
    clk_port = clk_in.get("port", "clk")
    if not isinstance(clk_port, str) or not _IDENT.match(clk_port):
        problems.append("constraints.clock.port must be a port name")
        clk_port = "clk"
    period = _num(clk_in.get("periodNs", 10.0), "constraints.clock.periodNs", problems, positive=True)
    uncertainty = _num(clk_in.get("uncertaintyNs", 0.0), "constraints.clock.uncertaintyNs", problems, minimum=0)
    # Setup and hold margins differ in practice; a setup-sized hold margin buries a fast library in hold buffers.
    hold_unc = _num(clk_in.get("holdUncertaintyNs", 0.0), "constraints.clock.holdUncertaintyNs", problems, minimum=0)
    in_delay = _num(c_in.get("inputDelayNs", 0.0), "constraints.inputDelayNs", problems, minimum=0)
    out_delay = _num(c_in.get("outputDelayNs", 0.0), "constraints.outputDelayNs", problems, minimum=0)
    sdc = c_in.get("sdc")
    if sdc is not None:
        sdc = _rel_path(sdc, "constraints.sdc", problems)
    constraints = {
        "clock": {"port": clk_port, "periodNs": period, "uncertaintyNs": uncertainty, "holdUncertaintyNs": hold_unc},
        "inputDelayNs": in_delay,
        "outputDelayNs": out_delay,
        "sdc": sdc,
    }
    if period and in_delay is not None and out_delay is not None and period > 0:
        if in_delay >= period or out_delay >= period:
            problems.append("input and output delays must be shorter than the clock period")

    f_in = data.get("flow", {})
    if not isinstance(f_in, dict):
        problems.append("flow must be an object")
        f_in = {}
    platform = f_in.get("platform", DEFAULT_PLATFORM)
    if platform not in PLATFORMS:
        problems.append(f"flow.platform must be one of {', '.join(PLATFORMS)}")
        platform = DEFAULT_PLATFORM
    util = _num(f_in.get("coreUtilization", 40), "flow.coreUtilization", problems, minimum=5, maximum=90)
    density = _num(f_in.get("placeDensity", 0.6), "flow.placeDensity", problems, minimum=0.1, maximum=1.0)
    extra_in = f_in.get("extra", {})
    extra: dict[str, str] = {}
    if not isinstance(extra_in, dict):
        problems.append("flow.extra must map ORFS variable names to values")
    else:
        for k, v in extra_in.items():
            if not isinstance(k, str) or not _EXTRA_KEY.match(k):
                problems.append(f"flow.extra key {k!r} is not an ORFS variable name")
            elif isinstance(v, bool) or not isinstance(v, (str, int, float)) or "\n" in str(v):
                problems.append(f"flow.extra.{k} must be a single-line string or number")
            else:
                extra[k] = str(v)
    flow = {"platform": platform, "coreUtilization": util, "placeDensity": density, "extra": extra}

    if problems:
        raise ProjectError(problems)
    return Project(root=root, name=name, top=top, sources=sources, include_dirs=include_dirs,
                   tests=tests, constraints=constraints, flow=flow, raw=data)


def load_project(folder: Path) -> Project:
    path = folder / PROJECT_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ProjectError([f"no {PROJECT_FILE} in {folder}"]) from exc
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise ProjectError([f"cannot read {PROJECT_FILE}: {exc}"]) from exc
    return parse_project(folder.resolve(), data)


def find_projects(root: Path, depth: int = PROJECT_SCAN_DEPTH) -> list[Path]:
    """Folders under ``root`` (inclusive) that hold a project file, skipping build and hidden dirs."""
    found: list[Path] = []

    def walk(d: Path, level: int) -> None:
        if (d / PROJECT_FILE).is_file():
            found.append(d)
        if level >= depth:
            return
        try:
            children = sorted(p for p in d.iterdir() if p.is_dir())
        except OSError:
            return
        for c in children:
            if c.name.startswith(".") or c.name in {BUILD_DIR, "node_modules", "__pycache__", ".venv"}:
                continue
            walk(c, level + 1)

    walk(root, 0)
    return found


# --------------------------------------------------------------------------- #
# Generated flow files
# --------------------------------------------------------------------------- #


def _fmt_time(ns: float, unit: str) -> str:
    value = ns * 1000.0 if unit == "ps" else ns
    text = f"{value:.4f}".rstrip("0").rstrip(".")
    return text or "0"


def generate_sdc(project: Project) -> str:
    """SDC for the project's constraints, in the platform's Liberty time unit."""
    c = project.constraints
    unit = project.platform.time_unit
    clk = c["clock"]
    lines = [
        f"# Generated by RTL Playground from {PROJECT_FILE}; edit the project file, not this.",
        f"# Times are in {unit}, the time unit of the {project.platform.name} libraries.",
        f"current_design {project.top}",
        "",
        "set clk_name core_clock",
        f"set clk_port_name {clk['port']}",
        f"set clk_period {_fmt_time(clk['periodNs'], unit)}",
        f"set setup_uncertainty {_fmt_time(clk['uncertaintyNs'], unit)}",
        f"set hold_uncertainty {_fmt_time(clk['holdUncertaintyNs'], unit)}",
        f"set input_delay {_fmt_time(c['inputDelayNs'], unit)}",
        f"set output_delay {_fmt_time(c['outputDelayNs'], unit)}",
        "",
        "set clk_port [get_ports $clk_port_name]",
        "create_clock -name $clk_name -period $clk_period $clk_port",
        "set_clock_uncertainty -setup $setup_uncertainty [get_clocks $clk_name]",
        "set_clock_uncertainty -hold $hold_uncertainty [get_clocks $clk_name]",
        "",
        "set non_clock_inputs [lsearch -inline -all -not -exact [all_inputs] $clk_port]",
        "set_input_delay $input_delay -clock $clk_name $non_clock_inputs",
        "set_output_delay $output_delay -clock $clk_name [all_outputs]",
        "",
    ]
    return "\n".join(lines)


def generate_orfs_config(project: Project, to_tool_path: Callable[[Path], str], sdc_path: Path) -> str:
    """ORFS ``config.mk`` for the project. ``to_tool_path`` maps host paths to what the tools see."""
    f = project.flow
    sources = project.source_files()
    lines = [
        f"# Generated by RTL Playground from {PROJECT_FILE}; edit the project file, not this.",
        f"export PLATFORM = {f['platform']}",
        f"export DESIGN_NAME = {project.top}",
        f"export DESIGN_NICKNAME = {_nickname(project.name)}",
        "export VERILOG_FILES = " + " ".join(to_tool_path(p) for p in sources),
        f"export SDC_FILE = {to_tool_path(sdc_path)}",
        f"export CORE_UTILIZATION = {_fmt_num(f['coreUtilization'])}",
        f"export PLACE_DENSITY = {_fmt_num(f['placeDensity'])}",
    ]
    if project.include_dirs:
        lines.append("export VERILOG_INCLUDE_DIRS = " + " ".join(to_tool_path(project.root / d) for d in project.include_dirs))
    for k, v in f["extra"].items():
        lines.append(f"export {k} = {v}")
    return "\n".join(lines) + "\n"


def _fmt_num(v: float) -> str:
    return f"{v:.4f}".rstrip("0").rstrip(".")


def _nickname(name: str) -> str:
    nick = re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_")
    return nick or "design"


def write_if_changed(path: Path, text: str) -> None:
    """Write generated text, leaving the mtime alone when nothing changed (make depends on it)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.read_text(encoding="utf-8") == text:
            return
    except OSError:
        pass
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# Starter templates
# --------------------------------------------------------------------------- #


def templates() -> dict[str, str]:
    """Template name -> first line of its README."""
    import importlib.resources

    base = importlib.resources.files("rtl_playground") / "templates"
    out: dict[str, str] = {}
    for entry in sorted(base.iterdir(), key=lambda e: e.name):
        if entry.is_dir() and (entry / PROJECT_FILE).is_file():
            readme = entry / "README.md"
            title = readme.read_text(encoding="utf-8").splitlines()[0].lstrip("# ").strip() if readme.is_file() else entry.name
            out[entry.name] = title
    return out


def create_from_template(dest: Path, template: str) -> list[Path]:
    """Copy a starter template into ``dest``, which must not exist or be empty."""
    import importlib.resources

    if template not in templates():
        raise ProjectError([f"unknown template {template!r}"])
    if dest.exists() and (not dest.is_dir() or any(dest.iterdir())):
        raise ProjectError([f"{dest.name} already exists and is not empty"])
    src = importlib.resources.files("rtl_playground") / "templates" / template
    written: list[Path] = []

    def copy(node, target: Path) -> None:  # noqa: ANN001
        target.mkdir(parents=True, exist_ok=True)
        for child in node.iterdir():
            if child.name.startswith(".") or child.name == "__pycache__":
                continue
            if child.is_dir():
                copy(child, target / child.name)
            else:
                (target / child.name).write_bytes(child.read_bytes())
                written.append(target / child.name)

    copy(src, dest)
    return written


__all__ = [
    "BUILD_DIR",
    "DEFAULT_PLATFORM",
    "PLATFORMS",
    "PROJECT_FILE",
    "create_from_template",
    "templates",
    "Platform",
    "Project",
    "ProjectError",
    "find_projects",
    "generate_orfs_config",
    "generate_sdc",
    "load_project",
    "parse_project",
    "write_if_changed",
]
