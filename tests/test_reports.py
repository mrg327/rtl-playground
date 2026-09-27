"""The report parser against real OpenROAD-flow-scripts metrics (sad_pe on asap7, ORFS 26Q3-657)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from rtl_playground import reports
from rtl_playground.project import PROJECT_FILE, load_project

FIXTURE = Path(__file__).parent / "fixtures" / "orfs_sad_pe"
TEMPLATE = Path(__file__).parents[1] / "src" / "rtl_playground" / "templates" / "sad_pe" / PROJECT_FILE
# Real rtlp_power.tcl output: sad_pe on asap7, a VCD from the sad_pe cocotb suite (56590ns of
# simulation), OpenROAD 26Q3-657 via udocker. See the power job's manual verification notes.
POWER_LOG = (Path(__file__).parent / "fixtures" / "power_sad_pe.log").read_text()


@pytest.fixture
def project(tmp_path: Path):
    (tmp_path / "rtl").mkdir()
    (tmp_path / "rtl" / "sad_pe.sv").write_text("module sad_pe; endmodule\n")
    (tmp_path / PROJECT_FILE).write_text(TEMPLATE.read_text())
    shutil.copytree(FIXTURE, tmp_path / "build" / "orfs")
    return load_project(tmp_path)


def test_collect_reads_real_metrics(project):
    r = reports.collect(project, project.build / "orfs", "finish")
    t = r["timing"]
    assert t["met"] is True
    assert t["setupWnsNs"] == pytest.approx(0.83151)  # 831.51 ps in the asap7 time unit
    assert t["holdWnsNs"] == pytest.approx(0.0494704)
    assert t["fmaxMHz"] == pytest.approx(916.179, rel=1e-3)
    assert r["area"]["cells"] == 352 and r["area"]["sequential"] == 16
    assert r["area"]["designUm2"] == pytest.approx(32.8487)
    assert r["area"]["utilization"] == pytest.approx(0.465881)
    assert r["power"]["totalW"] == pytest.approx(5.52497e-05)
    assert r["route"] == {"wirelengthUm": 505.0, "drcErrors": 0}
    assert r["predictive"] is True
    assert r["layoutPng"] == "build/orfs/reports/asap7/sad_pe/base/final_all.webp.png"
    assert [i["label"] for i in r["images"]] == ["Layout"]
    labels = [f["label"] for f in r["files"]]
    assert "Final layout (GDS)" in labels and "Final timing and power report" in labels
    route = next(s for s in r["steps"] if s["step"] == "5_2_route")
    assert route["name"] == "Detailed route" and route["elapsedS"] > 0 and route["peakMemMB"] > 100


def test_collect_after_synthesis_only(project):
    logs = project.build / "orfs" / "logs" / "asap7" / "sad_pe" / "base"
    for f in logs.iterdir():
        if not f.name.startswith("1_"):
            f.unlink()
    r = reports.collect(project, project.build / "orfs", "synth")
    assert r["timing"] is None
    assert r["area"]["cells"] == 258 and r["area"]["coreUm2"] is None
    assert r["power"] is None and r["route"] is None


def test_collect_with_nothing_warns(tmp_path: Path):
    (tmp_path / PROJECT_FILE).write_text(json.dumps({"top": "x", "sources": ["*.sv"]}))
    p = load_project(tmp_path)
    r = reports.collect(p, p.build / "orfs", "finish")
    assert r["warnings"] and r["timing"] is None and r["files"] == []


def test_later_stage_wins():
    m = {"floorplan__timing__setup__ws": -5.0, "finish__timing__setup__ws": 1.0, "cts__timing__setup__ws": -1.0}
    assert reports.pick(m, "timing__setup__ws") == 1.0


# --------------------------------------------------------------------------- #
# Power from simulation activity
# --------------------------------------------------------------------------- #


def test_parse_power_json_from_real_log():
    watts = reports.parse_power_json(POWER_LOG)
    assert watts == {"totalW": pytest.approx(1.34e-4), "internalW": pytest.approx(8.60e-5),
                      "switchingW": pytest.approx(4.79e-5), "leakageW": pytest.approx(2.08e-8)}


def test_parse_power_json_missing_is_none():
    assert reports.parse_power_json("no markers here") is None
    assert reports.parse_power_json("RTLP-POWER-JSON-BEGIN\nnot json\nRTLP-POWER-JSON-END") is None


def test_parse_power_annotation_from_real_log():
    # 36 of the design's 992 pins matched a VCD signal by name; the rest (mostly internal
    # gates from synthesis) keep ORFS's default activity, per report_activity_annotation.
    assert reports.parse_power_annotation(POWER_LOG) == (36, 992)


def test_parse_power_annotation_missing_is_none():
    assert reports.parse_power_annotation("no markers here") is None


def test_collect_power_computes_energy_and_compares_to_default(project):
    r = reports.collect_power(project, project.build / "orfs", "sad_pe", 56590.0, POWER_LOG)
    assert r["test"] == "sad_pe"
    assert r["clockPeriodNs"] == pytest.approx(1.923)
    assert r["power"]["totalW"] == pytest.approx(1.34e-4)
    assert r["power"]["activity"] == "simulation: sad_pe (3.6% of pins annotated)"
    assert r["annotatedPins"] == 36 and r["annotatedPinsTotal"] == 992
    # energy = average power (from the simulated activity) x simulated time
    assert r["energyJ"] == pytest.approx(1.34e-4 * 56590.0 * 1e-9)
    assert r["energyPerCycleJ"] == pytest.approx(1.34e-4 * 1.923 * 1e-9)
    # the default-activity power from the last finished flow run, for comparison
    assert r["defaultPower"]["totalW"] == pytest.approx(5.52497e-05)
    assert r["defaultPower"]["activity"] == "default switching activity (not from simulation)"
    assert r["warnings"] == []


def test_collect_power_without_a_report_warns(project):
    r = reports.collect_power(project, project.build / "orfs", "sad_pe", 100.0, "OpenROAD crashed before reporting power\n")
    assert r["power"] is None
    assert r["energyJ"] is None and r["energyPerCycleJ"] is None
    assert r["annotatedPins"] is None
    assert "did not report power" in r["warnings"][0]
    # the default-activity comparison is still there even when the simulated run failed
    assert r["defaultPower"]["totalW"] == pytest.approx(5.52497e-05)
