"""End-to-end tests for the stdlib host, using http.client against a real socket."""

from __future__ import annotations

import http.client
import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest

from rtl_playground import __version__, server as server_mod
from rtl_playground.server import make_server

TOKEN = "0123456789abcdef0123456789abcdef"


class Client:
    def __init__(self, port: int, token: str) -> None:
        self.port = port
        self.token = token

    def request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        *,
        token: str | None = None,
        host: str | None = None,
        origin: str | None = None,
        raw: bool = False,
    ):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers: dict[str, str] = {}
        headers["Host"] = host if host is not None else f"127.0.0.1:{self.port}"
        if origin is not None:
            headers["Origin"] = origin
        if token is not None:
            headers["X-RTLP-Token"] = token
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        payload = resp.read()
        conn.close()
        if raw:
            return resp, payload
        try:
            decoded = json.loads(payload.decode("utf-8"))
        except ValueError:
            decoded = payload
        return resp.status, decoded


@pytest.fixture
def static_dir(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("static")
    (d / "index.html").write_text("<!doctype html><title>placeholder</title><div id=app></div>")
    (d / "assets").mkdir()
    (d / "assets" / "app.js").write_text("console.log('hi')")
    (d / "assets" / "style.css").write_text("body{}")
    return d


@pytest.fixture
def root(tmp_path_factory) -> Path:
    r = tmp_path_factory.mktemp("root")
    (r / "counter.rtlp").write_text('{"version": 2}')
    (r / "notes.md").write_text("# notes")
    (r / "secret.txt").write_text("not listed")
    (r / ".hidden.rtlp").write_text("{}")
    (r / "node_modules").mkdir()
    (r / "sub").mkdir()
    (r / "sub" / "alu.sv").write_text("module alu; endmodule")
    return r


@pytest.fixture
def srv(root: Path, static_dir: Path, monkeypatch):
    # Exercise discovery through the monkeypatched hook rather than passing static_dir directly.
    monkeypatch.setattr(server_mod, "default_static_dir", lambda: static_dir)
    s = make_server(root, 0, token=TOKEN)
    t = threading.Thread(target=s.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    t.start()
    try:
        yield s
    finally:
        s.shutdown()
        s.server_close()
        t.join(5)


@pytest.fixture
def client(srv) -> Client:
    return Client(srv.port, TOKEN)


def test_version(client: Client, root: Path):
    status, data = client.request("GET", "/api/version")
    assert status == 200
    assert data["version"] == __version__
    assert Path(data["root"]) == root.resolve()
    assert isinstance(data["hdl"], bool)
    assert data["python"].startswith(f"{sys.version_info[0]}.{sys.version_info[1]}")


def test_url_contains_token_and_open(srv):
    assert srv.url() == f"http://127.0.0.1:{srv.port}/#token={TOKEN}"
    assert srv.url("sub/alu.sv").endswith(f"#token={TOKEN}&open=sub/alu.sv")


def test_list_root_filters(client: Client):
    status, data = client.request("GET", "/api/files")
    assert status == 200
    assert data["dir"] == ""
    names = [(e["name"], e["type"]) for e in data["entries"]]
    assert ("sub", "dir") in names
    assert ("counter.rtlp", "file") in names
    assert ("notes.md", "file") in names
    assert all(n not in ("secret.txt", ".hidden.rtlp", "node_modules") for n, _ in names)
    # dirs first, then files
    assert names[0] == ("sub", "dir")
    entry = next(e for e in data["entries"] if e["name"] == "counter.rtlp")
    assert entry["size"] == len('{"version": 2}')
    assert isinstance(entry["mtime"], float)


def test_list_subdir(client: Client):
    status, data = client.request("GET", "/api/files?dir=sub")
    assert status == 200
    assert data["dir"] == "sub"
    assert [e["name"] for e in data["entries"]] == ["alu.sv"]
    status, _ = client.request("GET", "/api/files?dir=missing")
    assert status == 404


def test_read_file(client: Client):
    status, data = client.request("GET", "/api/file?path=sub/alu.sv")
    assert status == 200
    assert data["path"] == "sub/alu.sv"
    assert data["text"] == "module alu; endmodule"
    assert isinstance(data["mtime"], float)
    status, data = client.request("GET", "/api/file?path=nope.rtlp")
    assert status == 404
    assert "error" in data


def test_write_requires_token(client: Client, root: Path):
    status, data = client.request("PUT", "/api/file?path=new.rtlp", {"text": "{}"})
    assert status == 403
    assert not (root / "new.rtlp").exists()
    status, data = client.request("PUT", "/api/file?path=new.rtlp", {"text": "{}"}, token="wrong")
    assert status == 403
    status, data = client.request("DELETE", "/api/file?path=counter.rtlp")
    assert status == 403
    assert (root / "counter.rtlp").exists()


def test_write_with_token_creates_parents(client: Client, root: Path):
    status, data = client.request(
        "PUT", "/api/file?path=deep/er/design.rtlp", {"text": '{"a": 1}'}, token=TOKEN
    )
    assert status == 200
    assert data["ok"] is True
    assert (root / "deep" / "er" / "design.rtlp").read_text() == '{"a": 1}'
    assert data["mtime"] == (root / "deep" / "er" / "design.rtlp").stat().st_mtime
    # no temp files left behind
    assert [p.name for p in (root / "deep" / "er").iterdir()] == ["design.rtlp"]


def test_write_rejects_unsupported_extension(client: Client, root: Path):
    status, data = client.request("PUT", "/api/file?path=evil.py", {"text": "x"}, token=TOKEN)
    assert status == 400
    assert not (root / "evil.py").exists()


def test_if_mtime_conflict(client: Client, root: Path):
    status, data = client.request("GET", "/api/file?path=counter.rtlp")
    mtime = data["mtime"]
    # matching mtime: accepted
    status, data = client.request(
        "PUT", "/api/file?path=counter.rtlp", {"text": "v2", "ifMtime": mtime}, token=TOKEN
    )
    assert status == 200
    new_mtime = data["mtime"]
    # someone else edits the file on disk
    time.sleep(0.02)
    (root / "counter.rtlp").write_text("edited elsewhere")
    os.utime(root / "counter.rtlp", (new_mtime + 5, new_mtime + 5))
    status, data = client.request(
        "PUT", "/api/file?path=counter.rtlp", {"text": "v3", "ifMtime": new_mtime}, token=TOKEN
    )
    assert status == 409
    assert data["mtime"] == (root / "counter.rtlp").stat().st_mtime
    assert (root / "counter.rtlp").read_text() == "edited elsewhere"
    # ifMtime on a file that no longer exists is also a conflict
    status, data = client.request(
        "PUT", "/api/file?path=gone.rtlp", {"text": "v", "ifMtime": 1.0}, token=TOKEN
    )
    assert status == 409
    assert data["mtime"] is None


def test_delete(client: Client, root: Path):
    status, data = client.request("DELETE", "/api/file?path=counter.rtlp", token=TOKEN)
    assert status == 200 and data == {"ok": True}
    assert not (root / "counter.rtlp").exists()
    status, _ = client.request("DELETE", "/api/file?path=counter.rtlp", token=TOKEN)
    assert status == 404


@pytest.mark.parametrize(
    "path",
    [
        "../outside.rtlp",
        "sub/../../outside.rtlp",
        "/etc/passwd.rtlp",
        "%2e%2e/outside.rtlp",
        "..%2Foutside.rtlp",
        "C:/Windows/x.rtlp",
    ],
)
def test_traversal_refused(client: Client, root: Path, path: str):
    outside = root.parent / "outside.rtlp"
    status, _ = client.request("GET", f"/api/file?path={path}")
    assert status == 403
    status, _ = client.request("PUT", f"/api/file?path={path}", {"text": "x"}, token=TOKEN)
    assert status == 403
    assert not outside.exists()
    status, _ = client.request("GET", f"/api/files?dir={path}")
    assert status == 403


def test_symlink_outside_root_refused(client: Client, root: Path):
    target = root.parent / "elsewhere.rtlp"
    target.write_text("{}")
    link = root / "link.rtlp"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlinks not supported")
    status, _ = client.request("GET", "/api/file?path=link.rtlp")
    assert status == 403


def test_host_check(client: Client, srv):
    status, _ = client.request("GET", "/api/version", host="evil.example:80")
    assert status == 403
    status, _ = client.request("GET", "/api/version", host=f"localhost:{srv.port}")
    assert status == 200
    status, _ = client.request("GET", "/api/version", host="127.0.0.1")  # port missing
    assert status == 403
    # Origin, when present, must match too.
    status, _ = client.request("GET", "/api/version", origin="http://evil.example")
    assert status == 403
    status, _ = client.request("GET", "/api/version", origin=f"http://127.0.0.1:{srv.port}")
    assert status == 200
    status, _ = client.request(
        "PUT", "/api/file?path=x.rtlp", {"text": ""}, token=TOKEN, origin="http://attacker:1"
    )
    assert status == 403


def test_unknown_api(client: Client):
    status, data = client.request("GET", "/api/nothing")
    assert status == 404
    status, data = client.request("GET", "/api/hdl/lint")
    assert status == 405


def test_static_and_spa_fallback(client: Client):
    resp, body = client.request("GET", "/", raw=True)
    assert resp.status == 200
    assert b"placeholder" in body
    assert resp.getheader("Cache-Control") == "no-store"
    assert resp.getheader("Content-Type").startswith("text/html")

    resp, body = client.request("GET", "/some/spa/route", raw=True)
    assert resp.status == 200
    assert b"placeholder" in body
    assert resp.getheader("Cache-Control") == "no-store"

    resp, body = client.request("GET", "/assets/app.js", raw=True)
    assert resp.status == 200
    assert resp.getheader("Content-Type").startswith("text/javascript")
    assert resp.getheader("Cache-Control") is None
    resp, body = client.request("GET", "/assets/style.css", raw=True)
    assert resp.getheader("Content-Type").startswith("text/css")

    # a missing asset is a real 404, not the SPA page
    resp, body = client.request("GET", "/assets/missing.js", raw=True)
    assert resp.status == 404


def test_mime_table():
    m = server_mod.MIME_TYPES
    assert m[".wasm"] == "application/wasm"
    assert m[".svg"] == "image/svg+xml"
    assert m[".json"].startswith("application/json")
    assert m[".mem"].startswith("text/plain")
    assert m[".sv"].startswith("text/plain")


def test_not_built_page(root: Path, monkeypatch):
    monkeypatch.setattr(server_mod, "default_static_dir", lambda: None)
    s = make_server(root, 0, token=TOKEN)
    t = threading.Thread(target=s.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    t.start()
    try:
        c = Client(s.port, TOKEN)
        resp, body = c.request("GET", "/", raw=True)
        assert resp.status == 200
        assert b"npm run build" in body
        status, data = c.request("GET", "/api/version")
        assert status == 200
    finally:
        s.shutdown()
        s.server_close()


def test_hdl_501_when_yowasp_missing(client: Client, monkeypatch):
    monkeypatch.setitem(sys.modules, "yowasp_yosys", None)  # makes `import yowasp_yosys` fail
    status, data = client.request("GET", "/api/version")
    assert data["hdl"] is False
    status, data = client.request(
        "POST", "/api/hdl/elaborate", {"files": {"a.sv": "module a; endmodule"}}, token=TOKEN
    )
    assert status == 501
    assert data["error"] == "yowasp-yosys not installed"
    assert "uvx --with yowasp-yosys" in data["hint"]
    status, data = client.request(
        "POST", "/api/hdl/lint", {"files": {"a.sv": "module a; endmodule"}}, token=TOKEN
    )
    assert status == 501
    # token still required first
    status, _ = client.request("POST", "/api/hdl/lint", {"files": {"a.sv": ""}})
    assert status == 403


def test_hdl_runs_with_fake_yowasp(client: Client, monkeypatch):
    """Drive the runner with a fake yowasp_yosys module to check script and plumbing."""
    import types

    calls: list[list[str]] = []

    def run_yosys(argv):
        calls.append(list(argv))
        script = Path(argv[argv.index("-s") + 1])
        logfile = Path(argv[argv.index("-l") + 1])
        text = script.read_text()
        if text.startswith("read_slang"):
            logfile.write_text("ERROR: No such command: read_slang\n")
            return 1
        logfile.write_text("done\n")
        for line in text.splitlines():
            if line.startswith("write_json"):
                Path(line.split(" ", 1)[1].strip('"')).write_text('{"modules": {}}')
        print("stdout noise")
        return 0

    monkeypatch.setitem(sys.modules, "yowasp_yosys", types.SimpleNamespace(run_yosys=run_yosys))
    status, data = client.request(
        "POST",
        "/api/hdl/elaborate",
        {"files": {"a.sv": "module a; endmodule"}, "top": "a"},
        token=TOKEN,
    )
    assert status == 200, data
    assert data["json"] == {"modules": {}}
    assert data["frontend"] == "verilog"
    assert "done" in data["log"] and "stdout noise" in data["log"]
    assert len(calls) == 2
    script = Path(calls[1][calls[1].index("-s") + 1])
    assert not script.exists()  # temp dir cleaned up

    status, data = client.request(
        "POST", "/api/hdl/lint", {"files": {"a.sv": "module a; endmodule"}}, token=TOKEN
    )
    assert status == 200 and data["ok"] is True

    status, data = client.request("POST", "/api/hdl/lint", {"files": {}}, token=TOKEN)
    assert status == 400
    status, data = client.request("POST", "/api/hdl/lint", {"files": {"../x.sv": ""}}, token=TOKEN)
    assert status == 400


def test_hdl_failure_is_422(client: Client, monkeypatch):
    import types

    def run_yosys(argv):
        Path(argv[argv.index("-l") + 1]).write_text("ERROR: syntax error\n")
        return 1

    monkeypatch.setitem(sys.modules, "yowasp_yosys", types.SimpleNamespace(run_yosys=run_yosys))
    status, data = client.request(
        "POST", "/api/hdl/elaborate", {"files": {"a.sv": "module"}}, token=TOKEN
    )
    assert status == 422
    assert "syntax error" in data["log"]


def test_hdl_timeout_is_504(client: Client, monkeypatch):
    import types

    monkeypatch.setattr(server_mod, "HDL_TIMEOUT_S", 0.2)
    release = threading.Event()

    def run_yosys(argv):
        release.wait(5)
        return 0

    monkeypatch.setitem(sys.modules, "yowasp_yosys", types.SimpleNamespace(run_yosys=run_yosys))
    try:
        status, data = client.request(
            "POST", "/api/hdl/lint", {"files": {"a.sv": "module a; endmodule"}}, token=TOKEN
        )
        assert status == 504
    finally:
        release.set()


def test_busy_port_exits_1(root: Path, capsys):
    import socket

    holder = socket.socket()
    holder.bind(("127.0.0.1", 0))
    holder.listen(1)
    port = holder.getsockname()[1]
    try:
        rc = server_mod.serve(root, port, open_browser=False)
    finally:
        holder.close()
    assert rc == 1
    assert f"127.0.0.1:{port}" in capsys.readouterr().err


def test_cli_parses(monkeypatch, root: Path):
    from rtl_playground import cli

    parser = cli.build_parser()
    args = parser.parse_args(["--dir", str(root), "--port", "8765", "--no-browser", "x.rtlp"])
    assert args.directory == str(root) and args.port == 8765 and args.no_browser and args.file == "x.rtlp"
    with pytest.raises(SystemExit):
        parser.parse_args(["--host", "0.0.0.0"])
