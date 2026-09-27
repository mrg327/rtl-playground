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
