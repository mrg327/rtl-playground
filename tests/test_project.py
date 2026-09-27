"""Project file validation and the generated SDC / ORFS config."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from rtl_playground.project import (
    PROJECT_FILE,
    ProjectError,
    find_projects,
    generate_orfs_config,
    generate_sdc,
    load_project,
    parse_project,
)

PROPOSAL = {
    "name": "motion estimator",
    "top": "me_top",
    "sources": ["rtl/*.sv"],
    "tests": [{"name": "unit", "module": "test_me", "dir": "tb"}],
    "constraints": {"clock": {"port": "clk", "periodNs": 1.923, "uncertaintyNs": 0.2},
                    "inputDelayNs": 0.5, "outputDelayNs": 0.5},
    "flow": {"platform": "asap7", "coreUtilization": 40, "placeDensity": 0.6, "extra": {"ABC_AREA": 1}},
}


@pytest.fixture
def proj(tmp_path: Path) -> Path:
    (tmp_path / "rtl").mkdir()
    (tmp_path / "rtl" / "b_pe.sv").write_text("module pe; endmodule\n")
    (tmp_path / "rtl" / "a_top.sv").write_text("module me_top; endmodule\n")
    (tmp_path / PROJECT_FILE).write_text(json.dumps(PROPOSAL))
    return tmp_path


def test_load_fills_defaults_and_expands_sources(proj: Path):
    p = load_project(proj)
    assert p.top == "me_top"
    assert [f.name for f in p.source_files()] == ["a_top.sv", "b_pe.sv"]
    assert p.tests[0]["toplevel"] == "me_top"
    assert p.tests[0]["waves"] is True
    assert p.platform.time_unit == "ps"
    assert p.summary()["platform"]["predictive"] is True


def test_sdc_in_picoseconds_for_asap7(proj: Path):
    sdc = generate_sdc(load_project(proj))
    assert "current_design me_top" in sdc
    assert "set clk_period 1923\n" in sdc
    assert "set setup_uncertainty 200\n" in sdc
    assert "set hold_uncertainty 0\n" in sdc
    assert "set_clock_uncertainty -setup $setup_uncertainty" in sdc
    assert "set input_delay 500\n" in sdc
    assert "set_output_delay $output_delay -clock $clk_name [all_outputs]" in sdc


def test_sdc_in_nanoseconds_for_sky130(proj: Path):
    data = dict(PROPOSAL, flow={"platform": "sky130hd"})
    sdc = generate_sdc(parse_project(proj, data))
    assert "set clk_period 1.923\n" in sdc
    assert "set setup_uncertainty 0.2\n" in sdc


def test_orfs_config(proj: Path):
    p = load_project(proj)
    cfg = generate_orfs_config(p, lambda path: "/work/" + path.relative_to(proj).as_posix(), proj / "build/orfs/c.sdc")
    assert "export PLATFORM = asap7\n" in cfg
    assert "export DESIGN_NAME = me_top\n" in cfg
    assert "export DESIGN_NICKNAME = motion_estimator\n" in cfg
    assert "export VERILOG_FILES = /work/rtl/a_top.sv /work/rtl/b_pe.sv\n" in cfg
    assert "export SDC_FILE = /work/build/orfs/c.sdc\n" in cfg
    assert "export ABC_AREA = 1\n" in cfg


@pytest.mark.parametrize(
    ("patch", "needle"),
    [
        ({"top": "9bad"}, "top must name"),
        ({"sources": []}, "sources must be"),
        ({"sources": ["../other/*.sv"]}, "inside the project"),
        ({"flow": {"platform": "tsmc14"}}, "flow.platform"),
        ({"flow": {"extra": {"rm -rf": "1"}}}, "not an ORFS variable"),
        ({"flow": {"extra": {"X": "a\nb"}}}, "single-line"),
        ({"constraints": {"clock": {"periodNs": 0}}}, "greater than 0"),
        ({"constraints": {"clock": {"periodNs": 1.0}, "inputDelayNs": 2.0}}, "shorter than the clock"),
        ({"tests": [{"module": "a"}, {"module": "a"}]}, "unique"),
        ({"version": 2}, "unsupported project version"),
    ],
)
def test_validation(proj: Path, patch: dict, needle: str):
    with pytest.raises(ProjectError) as info:
        parse_project(proj, dict(PROPOSAL, **patch))
    assert any(needle in p for p in info.value.problems), info.value.problems


def test_find_projects_skips_build_and_hidden(tmp_path: Path):
    for d in ("a", "b/c", "build/x", ".git/y"):
        (tmp_path / d).mkdir(parents=True)
        (tmp_path / d / PROJECT_FILE).write_text("{}")
    assert [p.relative_to(tmp_path).as_posix() for p in find_projects(tmp_path)] == ["a", "b/c"]
