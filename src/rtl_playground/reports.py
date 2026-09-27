"""Turn OpenROAD-flow-scripts outputs into the numbers the report dashboard shows.

ORFS runs each OpenROAD step with ``-metrics logs/<platform>/<nick>/base/<step>.json``;
those files hold METRICS2.1-style keys such as ``timing__setup__ws`` or
``power__total``, sometimes prefixed with the stage that reported them
(``finish__timing__setup__ws``). Yosys writes ``synth_stat.txt`` and each step
log ends with an elapsed-time and peak-memory line. This module reads what is
there and leaves out what is not, so a flow that stopped after synthesis
still produces a useful page.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from rtl_playground.project import Project, _nickname

# Later stages win when the same metric is reported more than once.
STAGE_ORDER = ("synth", "floorplan", "globalplace", "place", "detailedplace", "cts", "globalroute",
               "grt", "detailedroute", "route", "finish")
STEP_TITLES = {
    "1_1_yosys": "Synthesis (Yosys)", "1_2_yosys": "Synthesis (Yosys)", "1_synth": "Synthesis",
    "2_1_floorplan": "Floorplan", "2_2_floorplan_macro": "Macro placement", "2_3_floorplan_tapcell": "Tap cells",
    "2_4_floorplan_pdn": "Power grid", "3_1_place_gp_skip_io": "Global place (no I/O)", "3_2_place_iop": "I/O placement",
    "3_3_place_gp": "Global placement", "3_4_place_resized": "Resizing", "3_5_place_dp": "Detailed placement",
    "4_1_cts": "Clock tree", "5_1_grt": "Global route", "5_2_route": "Detailed route", "5_3_fillcell": "Fill cells",
    "6_1_fill": "Metal fill", "6_1_merge": "Merge GDS", "6_report": "Final report",
    "1_1_yosys_canonicalize": "Read RTL (Yosys)",
}
_ELAPSED = re.compile(r"Elapsed time:\s*([\d:.]+)\[h:\]min:sec.*?Peak memory:\s*(\d+)KB", re.S)


def orfs_dirs(project: Project, work: Path) -> dict[str, Path]:
    tail = Path(project.flow["platform"]) / _nickname(project.name) / "base"
    return {k: work / k / tail for k in ("logs", "reports", "results", "objects")}


def load_metrics(logs: Path) -> dict[str, Any]:
    """Merge every step's metrics JSON, later steps overriding earlier ones."""
    merged: dict[str, Any] = {}
    if not logs.is_dir():
        return merged
    for f in sorted(logs.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            merged.update(data)
    return merged


def _stage_rank(key: str) -> int:
    head = key.split("__", 1)[0]
    return STAGE_ORDER.index(head) if head in STAGE_ORDER else -1


def pick(metrics: dict[str, Any], *names: str) -> float | None:
    """The value of the first metric name found, preferring the latest stage that reported it."""
    for name in names:
        hits = [(k, v) for k, v in metrics.items() if (k == name or k.endswith("__" + name)) and _is_number(v)]
        if hits:
            hits.sort(key=lambda kv: _stage_rank(kv[0]))
            return float(hits[-1][1])
    return None


def pick_prefix(metrics: dict[str, Any], prefix: str) -> float | None:
    """Like pick, for metrics with a qualifier appended (``timing__fmax__clock:core_clock``)."""
    hits = [(k, v) for k, v in metrics.items() if _is_number(v) and (k.startswith(prefix) or ("__" + prefix) in k)]
    if not hits:
        return None
    hits.sort(key=lambda kv: _stage_rank(kv[0]))
    return float(hits[-1][1])


def _is_number(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return v == v and abs(v) != float("inf")
    return False


def step_times(logs: Path) -> list[dict[str, Any]]:
    out = []
    if not logs.is_dir():
        return out
    for f in sorted(logs.glob("*.log")):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        m = None
        for m in _ELAPSED.finditer(text):
            pass
        if m is None:
            continue
        parts = [float(p) for p in m.group(1).split(":")]
        seconds = 0.0
        for p in parts:
            seconds = seconds * 60 + p
        out.append({"name": STEP_TITLES.get(f.stem, f.stem), "step": f.stem, "elapsedS": seconds,
                    "peakMemMB": int(m.group(2)) / 1024})
    return out


def _time_scale(project: Project) -> float:
    """Factor from the platform's Liberty time unit to nanoseconds."""
    return 1e-3 if project.platform.time_unit == "ps" else 1.0


def collect(project: Project, work: Path, stage: str) -> dict[str, Any]:
    dirs = orfs_dirs(project, work)
    metrics = load_metrics(dirs["logs"])
    k = _time_scale(project)
    period = project.constraints["clock"]["periodNs"]

    def ns(v: float | None) -> float | None:
        return None if v is None else v * k

    setup_ws = ns(pick(metrics, "timing__setup__ws"))
    fmax_hz = pick_prefix(metrics, "timing__fmax")
    fmax_mhz = fmax_hz / 1e6 if fmax_hz else (1000.0 / (period - setup_ws) if setup_ws is not None and period - setup_ws > 0 else None)
    timing = None
    if setup_ws is not None or fmax_mhz is not None:
        timing = {
            "setupWnsNs": setup_ws,
            "setupTnsNs": ns(pick(metrics, "timing__setup__tns")),
            "holdWnsNs": ns(pick(metrics, "timing__hold__ws")),
            "holdTnsNs": ns(pick(metrics, "timing__hold__tns")),
            "fmaxMHz": fmax_mhz,
            "met": None if setup_ws is None else setup_ws >= 0,
            "source": "OpenSTA after " + _latest_stage(metrics, "timing__setup__ws"),
        }
    area = {
        "designUm2": pick(metrics, "design__instance__area__stdcell", "design__instance__area"),
        "coreUm2": pick(metrics, "design__core__area") or None,  # 0 until there is a floorplan
        "utilization": pick(metrics, "design__instance__utilization__stdcell", "design__instance__utilization"),
        "cells": pick(metrics, "design__instance__count__stdcell", "design__instance__count"),
        "sequential": pick(metrics, "design__instance__count__class:sequential_cell",
                           "design__instance__count__class:sequential"),
    }
    power_total = pick(metrics, "power__total")
    power = None
    if power_total is not None:
        power = {
            "totalW": power_total,
            "internalW": pick(metrics, "power__internal__total"),
            "switchingW": pick(metrics, "power__switching__total"),
            "leakageW": pick(metrics, "power__leakage__total"),
            "activity": "default switching activity (not from simulation)",
        }
    route = None
    wl = pick(metrics, "route__wirelength")
    drc = pick(metrics, "route__drc_errors")
    if wl is not None or drc is not None:
        route = {"wirelengthUm": wl, "drcErrors": None if drc is None else int(drc)}

    files = []
    rel = lambda p: p.relative_to(project.root).as_posix()  # noqa: E731
    for label, name in (("Final layout (GDS)", "6_final.gds"), ("Final netlist", "6_final.v"),
                        ("Parasitics (SPEF)", "6_final.spef"), ("Final DEF", "6_final.def"),
                        ("Final constraints", "6_final.sdc"), ("Synthesized netlist", "1_synth.v"),
                        ("Synthesized netlist", "1_2_yosys.v")):
        p = dirs["results"] / name
        if p.is_file() and label not in [f["label"] for f in files]:
            files.append({"label": label, "path": rel(p)})
    for label, name in (("Final timing and power report", "6_finish.rpt"), ("Synthesis statistics", "synth_stat.txt")):
        p = dirs["reports"] / name
        if p.is_file():
            files.append({"label": label, "path": rel(p)})

    # OpenROAD's save_images.tcl writes these at the end of the flow (PNG data despite the .webp.png name).
    images = []
    for label, stem in (("Layout", "final_all"), ("Routing", "final_routing"), ("Placement", "final_placement"),
                        ("Clock tree", "final_clocks"), ("Worst path", "final_worst_path"),
                        ("Congestion", "final_congestion"), ("IR drop", "final_ir_drop"),
                        ("Resizer changes", "final_resizer")):
        for suffix in (".webp.png", ".png", ".webp"):
            p = dirs["reports"] / f"{stem}{suffix}"
            if p.is_file():
                images.append({"label": label, "path": rel(p)})
                break

    warnings = []
    if not metrics:
        warnings.append("No OpenROAD metrics were written; the flow probably stopped early (see the log).")
    return {
        "stage": stage,
        "platform": project.platform.name,
        "predictive": project.platform.predictive,
        "note": project.platform.note,
        "clockPeriodNs": period,
        "timing": timing,
        "area": area if any(v is not None for v in area.values()) else None,
        "power": power,
        "route": route,
        "steps": step_times(dirs["logs"]),
        "files": files,
        "layoutPng": images[0]["path"] if images else None,
        "images": images,
        "warnings": warnings,
        "metricsCount": len(metrics),
    }


def _latest_stage(metrics: dict[str, Any], name: str) -> str:
    keys = [k for k in metrics if k == name or k.endswith("__" + name)]
    if not keys:
        return "the last stage"
    best = max(keys, key=_stage_rank)
    head = best.split("__", 1)[0]
    return head if head in STAGE_ORDER else "the last stage"


# --------------------------------------------------------------------------- #
# Power from simulation activity (rtlp_power.tcl, run by flows.power_steps)
# --------------------------------------------------------------------------- #

_ANNOTATION_BLOCK = re.compile(r"RTLP-ANNOTATION-BEGIN\n(.*?)\nRTLP-ANNOTATION-END", re.S)
_ANNOTATION_LINE = re.compile(r"^\s*(\w+)\s+(\d+)\s*$", re.M)
_POWER_JSON_BLOCK = re.compile(r"RTLP-POWER-JSON-BEGIN\n(.*?)\nRTLP-POWER-JSON-END", re.S)


def parse_power_annotation(log: str) -> tuple[int, int] | None:
    """(annotated, total) pin counts from report_activity_annotation's summary in the job log.

    OpenSTA prints one ``<category> <count>`` line per source; every category other than
    "unannotated" came from the VCD (RTL signal names only partly match the gate netlist,
    so most pins end up unannotated on a small design)."""
    m = _ANNOTATION_BLOCK.search(log)
    if not m:
        return None
    counts = {name: int(n) for name, n in _ANNOTATION_LINE.findall(m.group(1))}
    total = sum(counts.values())
    if total == 0:
        return None
    return total - counts.get("unannotated", 0), total


def parse_power_json(log: str) -> dict[str, float] | None:
    """{totalW, internalW, switchingW, leakageW} from report_power -format json's Total row."""
    m = _POWER_JSON_BLOCK.search(log)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except ValueError:
        return None
    total = data.get("Total")
    if not isinstance(total, dict):
        return None
    return {"totalW": total.get("total"), "internalW": total.get("internal"),
            "switchingW": total.get("switching"), "leakageW": total.get("leakage")}


_VCD_PERIOD = re.compile(r"STA-1452\]\s*clock \S+ vcd period ([\d.]+) differs from SDC clock period ([\d.]+)")


def collect_power(project: Project, work: Path, test_name: str, sim_time_ns: float | None, log: str) -> dict[str, Any]:
    """The power job's result: power from the test's simulated activity, the energy that
    implies over the test and per cycle, and the default-activity numbers (from the last
    finished flow run, when its metrics are still on disk) for comparison."""
    period = project.constraints["clock"]["periodNs"]
    watts = parse_power_json(log)
    annotation = parse_power_annotation(log)
    warnings: list[str] = []
    power = None
    if watts is not None:
        # Only ports and register outputs keep their RTL names; OpenSTA propagates their activity through the gates.
        activity = f"simulation: {test_name}" + (
            f" ({annotation[0]} of {annotation[1]} pins from the VCD, the rest propagated)" if annotation else "")
        power = {**watts, "activity": activity}
    else:
        warnings.append("OpenROAD did not report power; see the log.")
    mismatch = _VCD_PERIOD.search(log)
    if mismatch:
        scale = 1e-3 if project.platform.time_unit == "ps" else 1.0
        tb_ns, sdc_ns = float(mismatch.group(1)) * scale, float(mismatch.group(2)) * scale
        warnings.append(
            f"The testbench clock ({tb_ns:g} ns) differs from the constrained clock ({sdc_ns:g} ns), so this activity and "
            "energy do not describe the chip at speed. Drive the clock from RTLP_CLOCK_PERIOD_NS, as the sad_pe template does.")
    default_power = collect(project, work, "finish").get("power")
    energy_j = None
    energy_per_cycle_j = None
    if power and power.get("totalW") is not None:
        if sim_time_ns is not None:
            energy_j = power["totalW"] * sim_time_ns * 1e-9
        if period:
            energy_per_cycle_j = power["totalW"] * period * 1e-9
    return {
        "test": test_name,
        "clockPeriodNs": period,
        "simTimeNs": sim_time_ns,
        "power": power,
        "energyJ": energy_j,
        "energyPerCycleJ": energy_per_cycle_j,
        "defaultPower": default_power,
        "annotatedPins": annotation[0] if annotation else None,
        "annotatedPinsTotal": annotation[1] if annotation else None,
        "clockMismatch": bool(mismatch),
        "warnings": warnings,
    }


__all__ = ["collect", "collect_power", "load_metrics", "orfs_dirs", "parse_power_annotation", "parse_power_json",
           "pick", "step_times"]
