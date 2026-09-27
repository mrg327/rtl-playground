"""The job runner and the project API, driven with fake tools on a native toolchain."""

from __future__ import annotations

import json
import os
import shutil
import stat
import sys
import threading
import time
from pathlib import Path

import pytest

from rtl_playground import flows
from rtl_playground.jobs import BusyError, Command, HostStep, Job, JobManager
from rtl_playground.project import PROJECT_FILE, load_project
from rtl_playground.server import make_server
from rtl_playground.toolchain import Toolchain

from test_server import TOKEN, Client

PY = sys.executable


def native(tmp_path: Path) -> Toolchain:
    return Toolchain("native", path_env=f"{tmp_path / 'bin'}{os.pathsep}{os.environ['PATH']}", python=PY,
                     flow_home=str(tmp_path / "flow"))


def wait(job: Job, timeout: float = 10.0) -> Job:
    end = time.monotonic() + timeout
    while not job.done and time.monotonic() < end:
        time.sleep(0.02)
    assert job.done, f"job still {job.status}"
    return job


def make_job(tmp_path: Path, steps) -> Job:  # noqa: ANN001
    return Job(id="t1", kind="test", title="t", project="", root=tmp_path, steps=steps,
               log_path=tmp_path / "build" / "jobs" / "t1.log")


def test_job_runs_steps_and_streams_log(tmp_path: Path):
    mgr = JobManager(lambda: native(tmp_path))
    seen = []
    job = make_job(tmp_path, [
        HostStep("before", lambda j: seen.append("before")),
        Command("echo", [PY, "-c", "print('hello'); print('world')"], tmp_path),
        HostStep("after", lambda j: j.result.update(ok=True)),
    ])
    mgr.submit(job)
    wait(job)
    assert job.status == "passed"
    assert seen == ["before"]
    assert job.result == {"ok": True}
    text, nxt = job.read_log(0)
    assert "hello\nworld\n" in text
    rest, nxt2 = job.read_log(nxt)
    assert rest == "" and nxt2 == nxt
    assert "hello" in (tmp_path / "build" / "jobs" / "t1.log").read_text()


def test_failing_command_stops_the_job(tmp_path: Path):
    mgr = JobManager(lambda: native(tmp_path))
    ran = []
    job = make_job(tmp_path, [
        Command("fail", [PY, "-c", "import sys; sys.exit(3)"], tmp_path),
        HostStep("never", lambda j: ran.append(1)),
    ])
    mgr.submit(job)
    wait(job)
    assert job.status == "failed"
    assert "code 3" in job.error
    assert ran == []


def test_always_steps_run_after_a_failure(tmp_path: Path):
    mgr = JobManager(lambda: native(tmp_path))
    ran = []
    job = make_job(tmp_path, [
        Command("fail", [PY, "-c", "raise SystemExit(2)"], tmp_path),
        HostStep("skipped", lambda j: ran.append("skipped")),
        HostStep("reports", lambda j: ran.append("reports"), always=True),
    ])
    mgr.submit(job)
    assert wait(job).status == "failed"
    assert ran == ["reports"]
    assert "code 2" in job.error


def test_ok_codes_none_continues(tmp_path: Path):
    mgr = JobManager(lambda: native(tmp_path))
    job = make_job(tmp_path, [Command("fail", [PY, "-c", "raise SystemExit(1)"], tmp_path, ok_codes=None)])
    mgr.submit(job)
    assert wait(job).status == "passed"


def test_cancel_and_busy(tmp_path: Path):
    mgr = JobManager(lambda: native(tmp_path))
    job = make_job(tmp_path, [Command("sleep", [PY, "-c", "import time; print('go', flush=True); time.sleep(30)"], tmp_path)])
    mgr.submit(job)
    end = time.monotonic() + 5
    while "go" not in job.read_log(0)[0] and time.monotonic() < end:
        time.sleep(0.02)
    other = Job(id="t2", kind="x", title="x", project="", root=tmp_path, steps=[])
    with pytest.raises(BusyError):
        mgr.submit(other)
    mgr.cancel(job.id)
    assert wait(job).status == "cancelled"


# --------------------------------------------------------------------------- #
# Through the HTTP API
# --------------------------------------------------------------------------- #

FAKE_VERILATOR = f"""#!{PY}
import sys
files = [a for a in sys.argv[1:] if a.endswith('.sv')]
print('%Warning-UNUSEDPARAM: ' + files[0] + ':3:14: Parameter is not used: W')
if any('bad' in open(f).read() for f in files):
    print('%Error: ' + files[0] + ':5:1: syntax error, unexpected endmodule')
    sys.exit(1)
sys.exit(0)
"""


@pytest.fixture
def project_root(tmp_path: Path) -> Path:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    v = bindir / "verilator"
    v.write_text(FAKE_VERILATOR)
    v.chmod(v.stat().st_mode | stat.S_IEXEC)
    proj = tmp_path / "me"
    (proj / "rtl").mkdir(parents=True)
    (proj / "rtl" / "top.sv").write_text("module me_top; endmodule\n")
    (proj / PROJECT_FILE).write_text(json.dumps({"top": "me_top", "sources": ["rtl/*.sv"]}))
    return tmp_path


@pytest.fixture
def api(project_root: Path):
    s = make_server(project_root, 0, token=TOKEN)
    s.toolchain.set(native(project_root))
    t = threading.Thread(target=s.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    t.start()
    client = Client(s.port, TOKEN)
    client.server = s  # type: ignore[attr-defined]
    try:
        yield client
    finally:
        s.shutdown()
        s.server_close()
        t.join(5)


def poll(api: Client, job_id: str) -> tuple[dict, str]:
    log, since = "", 0
    end = time.monotonic() + 10
    while time.monotonic() < end:
        status, data = api.request("GET", f"/api/job?id={job_id}&since={since}")
        assert status == 200
        log += data["log"]
        since = data["next"]
        if data["status"] not in ("queued", "running"):
            return data, log
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_projects_and_project(api: Client):
    status, data = api.request("GET", "/api/projects")
    assert status == 200
    assert data["projects"] == [{"path": "me", "name": "me_top", "top": "me_top", "problems": []}]
    status, data = api.request("GET", "/api/project?path=me")
    assert status == 200
    assert data["sources"] == ["rtl/top.sv"]
    assert data["platform"]["name"] == "asap7"


def test_project_problems_are_422(api: Client, project_root: Path):
    (project_root / "me" / PROJECT_FILE).write_text(json.dumps({"top": "1x"}))
    status, data = api.request("GET", "/api/project?path=me")
    assert status == 422
    assert any("top must name" in p for p in data["problems"])


def test_tools_lists_platforms(api: Client):
    status, data = api.request("GET", "/api/tools")
    assert status == 200
    assert data["mode"] == "native"
    assert "asap7" in [p["name"] for p in data["platforms"]]
    assert data["stages"][-1] == "finish"


def test_lint_job_reports_diagnostics(api: Client, project_root: Path):
    status, data = api.request("POST", "/api/jobs", {"project": "me", "kind": "lint"}, token=TOKEN)
    assert status == 202, data
    done, log = poll(api, data["id"])
    assert done["status"] == "passed"
    assert "$ verilator --lint-only" in log
    diag = done["result"]["diagnostics"]
    assert diag == [{"severity": "warning", "code": "UNUSEDPARAM", "file": "rtl/top.sv", "line": 3, "col": 14,
                     "message": "Parameter is not used: W"}]

    (project_root / "me" / "rtl" / "top.sv").write_text("module me_top; bad endmodule\n")
    status, data = api.request("POST", "/api/jobs", {"project": "me", "kind": "lint"}, token=TOKEN)
    done, _ = poll(api, data["id"])
    assert done["status"] == "failed"
    assert done["result"]["errors"] == 1
    assert (project_root / "me" / "build" / "jobs" / f"{data['id']}.log").is_file()


def test_submit_needs_token_and_valid_kind(api: Client):
    status, _ = api.request("POST", "/api/jobs", {"project": "me", "kind": "lint"})
    assert status == 403
    status, data = api.request("POST", "/api/jobs", {"project": "me", "kind": "rm"}, token=TOKEN)
    assert status == 400


def test_raw_serves_artifacts_inside_root_only(api: Client, project_root: Path):
    (project_root / "me" / "build").mkdir(exist_ok=True)
    (project_root / "me" / "build" / "final.png").write_bytes(b"\x89PNG\r\n")
    resp, payload = api.request("GET", "/api/raw?path=me/build/final.png", raw=True)
    assert resp.status == 200 and payload == b"\x89PNG\r\n"
    assert resp.getheader("Content-Type") == "image/png"
    status, _ = api.request("GET", "/api/raw?path=../etc/passwd.txt")
    assert status == 403


def test_new_project_from_template(api: Client, project_root: Path):
    status, data = api.request("GET", "/api/templates")
    assert status == 200 and "sad_pe" in [t["name"] for t in data["templates"]]
    status, data = api.request("POST", "/api/project/new", {"path": "hw/final", "template": "sad_pe"}, token=TOKEN)
    assert status == 201, data
    assert (project_root / "hw" / "final" / "rtl" / "sad_pe.sv").is_file()
    status, data = api.request("GET", "/api/project?path=hw/final")
    assert status == 200 and data["top"] == "sad_pe" and data["constraints"]["clock"]["periodNs"] == 1.923
    status, data = api.request("POST", "/api/project/new", {"path": "hw/final"}, token=TOKEN)
    assert status == 409


def test_udocker_wrap_and_setup(tmp_path: Path):
    tc = Toolchain("docker", engine="/x/udocker", engine_kind="udocker", image="ghcr.io/o/rtl-playground-tools:2026.09",
                   flow_home="/OpenROAD-flow-scripts/flow")
    assert tc.container == "rtlp-rtl-playground-tools-2026_09"
    argv, _ = tc.wrap(["make", "synth"], root=tmp_path, cwd=tmp_path / "p", env={"A": "1"})
    assert argv == ["/x/udocker", "run", "--nobanner", "-v", f"{tmp_path.resolve()}:/work", "-w", "/work/p",
                    "-e", "A=1", "rtlp-rtl-playground-tools-2026_09", "make", "synth"]
    assert tc.setup_commands() == [["/x/udocker", "pull", tc.image],
                                   ["/x/udocker", "create", f"--name={tc.container}", tc.image]]
    docker = Toolchain("docker", engine="/usr/bin/docker", engine_kind="docker", image="img:1")
    argv, _ = docker.wrap(["verilator", "--version"], root=tmp_path, cwd=tmp_path, name="rtlp-j1")
    assert argv[:4] == ["/usr/bin/docker", "run", "--rm", "--init"] and "--name" in argv and argv[-3:] == ["img:1", "verilator", "--version"]
    assert docker.setup_commands() == [["/usr/bin/docker", "pull", "img:1"]]


# --------------------------------------------------------------------------- #
# Power job: cocotb with a VCD dump, then OpenROAD's report_power, with fake tools
# --------------------------------------------------------------------------- #

FAKE_COCOTB_RUNNER = f"""#!{PY}
import json, sys
from pathlib import Path
spec = json.load(open(sys.argv[2]))
assert spec["wavesFormat"] == "vcd"
run_dir = Path(spec["runDir"])
run_dir.mkdir(parents=True, exist_ok=True)
(run_dir / "dump.vcd").write_text("$enddefinitions $end\\n")
Path(spec["resultsXml"]).write_text('''<testsuites><testsuite>
<testcase classname="test_pw" name="case1" time="0.01">
<properties><property name="sim_time_duration" value="1000.0"/><property name="sim_time_unit" value="ns"/></properties>
</testcase></testsuite></testsuites>''')
sys.exit(0)
"""

FAKE_MAKE = f"""#!{PY}
import os, sys
print("RTLP_VCD=" + os.environ.get("RTLP_VCD", ""))
print("RTLP_VCD_SCOPE=" + os.environ.get("RTLP_VCD_SCOPE", ""))
print("RTLP-ANNOTATION-BEGIN")
print("vcd            10")
print("unannotated    90")
print("RTLP-ANNOTATION-END")
print("RTLP-POWER-JSON-BEGIN")
print('{{"Total": {{"internal": 1e-05, "switching": 2e-05, "leakage": 1e-09, "total": 3e-05}}}}')
print("RTLP-POWER-JSON-END")
sys.exit(0)
"""


def _write_fake(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


@pytest.fixture
def power_project(tmp_path: Path) -> Path:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    _write_fake(bindir / "make", FAKE_MAKE)
    proj = tmp_path / "pw"
    (proj / "rtl").mkdir(parents=True)
    (proj / "tb").mkdir()
    (proj / "rtl" / "pw_top.sv").write_text("module pw_top; endmodule\n")
    (proj / "tb" / "test_pw.py").write_text("")
    (proj / PROJECT_FILE).write_text(json.dumps({
        "top": "pw_top", "sources": ["rtl/*.sv"],
        "tests": [{"name": "pw", "module": "test_pw", "toplevel": "pw_top", "dir": "tb"}],
        "constraints": {"clock": {"periodNs": 2.0}},
        "flow": {"platform": "asap7"},
    }))
    final = proj / "build" / "orfs" / "results" / "asap7" / "pw_top" / "base"
    final.mkdir(parents=True)
    for name in ("6_final.odb", "6_final.sdc", "6_final.spef"):
        (final / name).write_text("")
    return tmp_path


def run_power_job(tmp_path: Path, options: dict | None = None, cocotb_ok: bool = True) -> Job:
    tc = native(tmp_path)
    tc.python = str(tmp_path / "bin" / "cocotb-runner")
    _write_fake(Path(tc.python), FAKE_COCOTB_RUNNER if cocotb_ok else "#!/bin/sh\nexit 1\n")
    project = load_project(tmp_path / "pw")
    title, steps = flows.build_steps("power", project, tc, tmp_path, options or {})
    job = Job(id="p1", kind="power", title=title, project="pw", root=tmp_path, steps=steps,
              log_path=project.build / "jobs" / "p1.log")
    mgr = JobManager(lambda: tc)
    mgr.submit(job)
    return wait(job)


def test_power_job_reports_simulated_power_and_energy(power_project: Path):
    job = run_power_job(power_project)
    assert job.status == "passed", job.error
    r = job.result
    assert r["test"] == "pw"
    assert r["power"] == {"totalW": pytest.approx(3e-5), "internalW": pytest.approx(1e-5),
                          "switchingW": pytest.approx(2e-5), "leakageW": pytest.approx(1e-9),
                          "activity": "simulation: pw (10% of pins annotated)"}
    assert r["simTimeNs"] == pytest.approx(1000.0)
    assert r["energyJ"] == pytest.approx(3e-5 * 1000.0 * 1e-9)
    assert r["energyPerCycleJ"] == pytest.approx(3e-5 * 2.0 * 1e-9)
    assert r["annotatedPins"] == 10 and r["annotatedPinsTotal"] == 100
    assert r["waves"] == "build/power/pw/dump.vcd"
    assert r["warnings"] == []
    text, _ = job.read_log(0)
    assert "RTLP_VCD_SCOPE=pw_top" in text
    assert "RTLP_VCD=" in text and "dump.vcd" in text


def test_power_job_requires_a_finished_flow(power_project: Path):
    shutil.rmtree(power_project / "pw" / "build" / "orfs")
    tc = native(power_project)
    project = load_project(power_project / "pw")
    with pytest.raises(Exception) as exc:
        flows.build_steps("power", project, tc, power_project, {})
    assert "run Implement first" in str(exc.value)


def test_power_job_requires_a_test(power_project: Path):
    data = json.loads((power_project / "pw" / PROJECT_FILE).read_text())
    data["tests"] = []
    (power_project / "pw" / PROJECT_FILE).write_text(json.dumps(data))
    tc = native(power_project)
    project = load_project(power_project / "pw")
    with pytest.raises(Exception) as exc:
        flows.build_steps("power", project, tc, power_project, {})
    assert "no tests defined" in str(exc.value)


def test_power_job_fails_cleanly_without_a_vcd(power_project: Path):
    job = run_power_job(power_project, cocotb_ok=False)
    assert job.status == "failed"
    assert "no VCD" in job.error


def test_power_job_via_http_rejects_an_unfinished_flow(api: Client):
    status, data = api.request("POST", "/api/jobs", {"project": "me", "kind": "power"}, token=TOKEN)
    assert status == 400
    assert "run Implement first" in data["error"]


def test_jobs_refused_until_image_is_downloaded(api: Client, project_root: Path):
    engine = project_root / "bin" / "fake-engine"
    engine.write_text(f"#!{PY}\nimport sys\nprint('engine', *sys.argv[1:])\n")
    engine.chmod(engine.stat().st_mode | stat.S_IEXEC)
    api.server.toolchain.set(Toolchain("docker", engine=str(engine), engine_kind="docker", image="img:1"))  # type: ignore[attr-defined]
    status, data = api.request("POST", "/api/jobs", {"project": "me", "kind": "lint"}, token=TOKEN)
    assert status == 503 and "Set up tools" in data["reason"]
    status, data = api.request("GET", "/api/tools")
    assert data["imageReady"] is False and data["engine"] == "docker"
    status, data = api.request("POST", "/api/jobs", {"kind": "setup"}, token=TOKEN)
    assert status == 202, data
    done, log = poll(api, data["id"])
    assert done["status"] == "passed", log
    assert "engine pull img:1" in log
