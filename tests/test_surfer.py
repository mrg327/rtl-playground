"""Tests for rtl_playground.surfer: cache-dir choice, safe zip extraction, the install
flow (network mocked, never hit), and the /surfer/ static route and /api/surfer endpoints
wired up in server.py.
"""

from __future__ import annotations

import io
import os
import sys
import threading
import zipfile
from hashlib import sha256
from pathlib import Path

import pytest

from rtl_playground import surfer as surfer_mod
from rtl_playground.server import make_server
from test_server import TOKEN, Client

INDEX_HTML = """<!doctype html><html><head>
<script type="module">import init from '/dist/surfer.js'; await init({module_or_path: '/dist/surfer_bg.wasm'});</script>
<base href="/dist/" /></head><body>hi</body></html>"""


def _make_zip(files: dict[str, bytes], *, top: str = "surfer_wasm") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(f"{top}/", b"")  # a directory entry, as real archives have
        for name, data in files.items():
            zf.writestr(f"{top}/{name}", data)
    return buf.getvalue()


class _FakeResponse:
    def __init__(self, data: bytes) -> None:
        self._buf = io.BytesIO(data)

    def read(self, n: int = -1) -> bytes:
        return self._buf.read(n)

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def _fake_opener(data: bytes):
    def opener(*_args, **_kwargs) -> _FakeResponse:
        return _FakeResponse(data)

    return opener


# --------------------------------------------------------------------------- #
# Cache directory choice
# --------------------------------------------------------------------------- #


def test_cache_root_macos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    assert surfer_mod.cache_root() == Path.home() / "Library" / "Caches" / "rtl-playground"


def test_cache_root_windows_uses_localappdata(monkeypatch: pytest.MonkeyPatch) -> None:
    # sys.platform (not os.name) drives the choice, on purpose: pathlib's Path() refuses to
    # construct the "wrong" OS's concrete class even when os.name is monkeypatched, which
    # would make this branch untestable off real Windows. See cache_root()'s docstring.
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", "C:\\Users\\student\\AppData\\Local")
    assert surfer_mod.cache_root() == Path("C:\\Users\\student\\AppData\\Local") / "rtl-playground"


def test_cache_root_windows_falls_back_without_localappdata(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    assert surfer_mod.cache_root() == Path.home() / "AppData" / "Local" / "rtl-playground"


def test_cache_root_linux_uses_xdg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("XDG_CACHE_HOME", "/tmp/xdg-cache")
    assert surfer_mod.cache_root() == Path("/tmp/xdg-cache") / "rtl-playground"


def test_cache_root_linux_falls_back_to_dot_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
    assert surfer_mod.cache_root() == Path.home() / ".cache" / "rtl-playground"


# --------------------------------------------------------------------------- #
# Safe zip extraction
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "name",
    ["../evil.txt", "/etc/passwd", "a/../../escape.txt", "..\\evil.txt", "C:\\evil.txt", "sub/../../../etc/passwd"],
)
def test_member_target_rejects_unsafe_paths(tmp_path: Path, name: str) -> None:
    with pytest.raises(surfer_mod.SurferError):
        surfer_mod._member_target(tmp_path.resolve(), name)


def test_member_target_accepts_and_confines_safe_paths(tmp_path: Path) -> None:
    dest = tmp_path.resolve()
    target = surfer_mod._member_target(dest, "sub/dir/file.txt")
    assert target == dest / "sub" / "dir" / "file.txt"
    assert surfer_mod._member_target(dest, "./") is None


def test_safe_extract_rejects_malicious_archive(tmp_path: Path) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("safe.txt", b"ok")
        zf.writestr("../../evil.txt", b"escaped")
    dest = tmp_path / "install"
    with zipfile.ZipFile(buf) as zf, pytest.raises(surfer_mod.SurferError):
        surfer_mod._safe_extract(zf, dest)
    # Nothing escaped: the parent of dest holds no file dropped by the archive.
    assert not (tmp_path / "evil.txt").exists()
    assert not (tmp_path.parent / "evil.txt").exists()


def test_safe_extract_writes_expected_files(tmp_path: Path) -> None:
    data = _make_zip({"index.html": INDEX_HTML.encode(), "surfer.js": b"//js"})
    dest = tmp_path / "install"
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        surfer_mod._safe_extract(zf, dest)
    assert (dest / "surfer_wasm" / "index.html").read_text() == INDEX_HTML
    assert (dest / "surfer_wasm" / "surfer.js").read_bytes() == b"//js"


# --------------------------------------------------------------------------- #
# install()
# --------------------------------------------------------------------------- #


def test_install_verifies_checksum_and_rewrites_index(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    zip_bytes = _make_zip({"index.html": INDEX_HTML.encode(), "surfer_bg.wasm": b"\x00wasm"})
    digest = sha256(zip_bytes).hexdigest()
    dest = tmp_path / "surfer-web"
    logged: list[str] = []

    version = surfer_mod.install(
        logged.append,
        url="http://example.invalid/ignored",
        expected_sha256=digest,
        version="test-version",
        dest=dest,
        opener=_fake_opener(zip_bytes),
    )

    assert version == "test-version"
    assert (dest / "index.html").is_file()
    text = (dest / "index.html").read_text()
    assert "/dist/" not in text
    assert "./surfer.js" in text or "'./surfer_bg.wasm'" in text
    assert (dest / ".sha256").read_text() == digest
    assert any("Downloading" in line for line in logged)
    assert any("installed" in line for line in logged)

    monkeypatch.setattr(surfer_mod, "SURFER_SHA256", digest)
    assert surfer_mod.installed_version(dest) == surfer_mod.SURFER_VERSION


def test_install_rejects_checksum_mismatch(tmp_path: Path) -> None:
    zip_bytes = _make_zip({"index.html": INDEX_HTML.encode()})
    dest = tmp_path / "surfer-web"
    with pytest.raises(surfer_mod.SurferError, match="checksum"):
        surfer_mod.install(
            url="http://example.invalid/ignored",
            expected_sha256="0" * 64,
            dest=dest,
            opener=_fake_opener(zip_bytes),
        )
    assert not dest.exists()


def test_install_rejects_archive_without_index(tmp_path: Path) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("surfer_wasm/readme.txt", b"no index here")
    data = buf.getvalue()
    digest = sha256(data).hexdigest()
    with pytest.raises(surfer_mod.SurferError, match="index.html"):
        surfer_mod.install(
            url="http://example.invalid/ignored",
            expected_sha256=digest,
            dest=tmp_path / "surfer-web",
            opener=_fake_opener(data),
        )


def test_installed_version_reports_stale_pin_as_missing(tmp_path: Path) -> None:
    d = tmp_path / "surfer-web"
    d.mkdir()
    (d / "index.html").write_text("hi")
    (d / ".sha256").write_text("not-the-current-pin")
    assert surfer_mod.installed_version(d) is None


def test_describe_reports_size_and_installed_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(surfer_mod, "surfer_dir", lambda: tmp_path / "missing")
    d = surfer_mod.describe()
    assert d == {"installed": False, "version": None, "sizeMB": surfer_mod.SURFER_SIZE_MB}


# --------------------------------------------------------------------------- #
# Server integration: /surfer/ static route and /api/surfer*
# --------------------------------------------------------------------------- #


@pytest.fixture
def srv(tmp_path_factory, monkeypatch):
    root = tmp_path_factory.mktemp("root")
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


def test_api_surfer_reports_not_installed(client: Client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(surfer_mod, "surfer_dir", lambda: tmp_path / "not-there")
    status, data = client.request("GET", "/api/surfer")
    assert status == 200
    assert data == {"installed": False, "version": None, "sizeMB": surfer_mod.SURFER_SIZE_MB}


def test_surfer_route_404_when_not_installed(client: Client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(surfer_mod, "surfer_dir", lambda: tmp_path / "not-there")
    status, _ = client.request("GET", "/surfer/index.html")
    assert status == 404


def test_surfer_route_serves_installed_build_with_wasm_mime(
    client: Client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    d = tmp_path / "installed"
    d.mkdir()
    (d / "index.html").write_text("<html>surfer</html>")
    (d / "surfer_bg.wasm").write_bytes(b"\x00asm\x01\x00\x00\x00")
    (d / "sub").mkdir()
    (d / "sub" / "other.js").write_text("//js")
    (d / ".sha256").write_text(surfer_mod.SURFER_SHA256)
    monkeypatch.setattr(surfer_mod, "surfer_dir", lambda: d)

    resp, body = client.request("GET", "/surfer/index.html", raw=True)
    assert resp.status == 200
    assert body == b"<html>surfer</html>"
    assert "text/html" in resp.getheader("Content-Type")

    resp, body = client.request("GET", "/surfer/surfer_bg.wasm", raw=True)
    assert resp.status == 200
    assert resp.getheader("Content-Type") == "application/wasm"
    assert body == b"\x00asm\x01\x00\x00\x00"

    resp, body = client.request("GET", "/surfer/sub/other.js", raw=True)
    assert resp.status == 200
    assert "javascript" in resp.getheader("Content-Type")

    # "/surfer" alone (no trailing slash) serves the index too.
    resp, body = client.request("GET", "/surfer", raw=True)
    assert resp.status == 200
    assert body == b"<html>surfer</html>"


def test_surfer_route_blocks_path_traversal(client: Client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    d = tmp_path / "installed"
    d.mkdir()
    (d / "index.html").write_text("hi")
    (d / ".sha256").write_text(surfer_mod.SURFER_SHA256)
    secret = tmp_path / "secret.txt"
    secret.write_text("do not serve me")
    monkeypatch.setattr(surfer_mod, "surfer_dir", lambda: d)

    resp, _ = client.request("GET", "/surfer/../secret.txt", raw=True)
    assert resp.status in (403, 404)
    resp, _ = client.request("GET", "/surfer/..%2f..%2fsecret.txt", raw=True)
    assert resp.status in (403, 404)


def test_surfer_install_requires_token(client: Client) -> None:
    status, _ = client.request("POST", "/api/surfer/install")
    assert status == 403


def test_surfer_install_end_to_end_with_mocked_download(
    client: Client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import urllib.request

    zip_bytes = _make_zip({"index.html": INDEX_HTML.encode(), "surfer_bg.wasm": b"\x00wasm"})
    digest = sha256(zip_bytes).hexdigest()
    dest = tmp_path / "surfer-web"
    monkeypatch.setattr(surfer_mod, "surfer_dir", lambda: dest)
    monkeypatch.setattr(surfer_mod, "SURFER_SHA256", digest)
    monkeypatch.setattr(surfer_mod, "SURFER_VERSION", "test-version")
    monkeypatch.setattr(urllib.request, "urlopen", _fake_opener(zip_bytes))

    status, data = client.request("POST", "/api/surfer/install", {}, token=TOKEN)
    assert status == 200
    assert data == {"installed": True, "version": "test-version", "sizeMB": surfer_mod.SURFER_SIZE_MB}

    status, data = client.request("GET", "/api/surfer")
    assert status == 200
    assert data["installed"] is True

    resp, body = client.request("GET", "/surfer/index.html", raw=True)
    assert resp.status == 200
    assert b"/dist/" not in body

    # Installing again short-circuits without re-downloading (the opener would raise
    # if called a second time with different, exhausted stream state; instead assert
    # the second call still reports installed and does not error).
    status, data = client.request("POST", "/api/surfer/install", {}, token=TOKEN)
    assert status == 200
    assert data["installed"] is True


def test_surfer_install_reports_checksum_mismatch(
    client: Client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import urllib.request

    zip_bytes = _make_zip({"index.html": INDEX_HTML.encode()})
    dest = tmp_path / "surfer-web"
    monkeypatch.setattr(surfer_mod, "surfer_dir", lambda: dest)
    # Leave SURFER_SHA256 at its real pinned value: our fake zip will not match it.
    monkeypatch.setattr(urllib.request, "urlopen", _fake_opener(zip_bytes))

    status, data = client.request("POST", "/api/surfer/install", {}, token=TOKEN)
    assert status == 502
    assert "checksum" in data["error"]
    assert not dest.exists()


def test_install_falls_back_from_the_mirror_to_gitlab(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import urllib.error

    zip_bytes = _make_zip({"index.html": INDEX_HTML.encode()})
    monkeypatch.setattr(surfer_mod, "SURFER_SHA256", sha256(zip_bytes).hexdigest())
    tried: list[str] = []

    def opener(req, **_kwargs):  # noqa: ANN001
        tried.append(req.full_url)
        if "github.com" in req.full_url:
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)
        return _FakeResponse(zip_bytes)

    logs: list[str] = []
    surfer_mod.install(logs.append, dest=tmp_path / "surfer-web", opener=opener)
    assert tried == list(surfer_mod.SURFER_URLS)
    assert "github.com" in tried[0] and "gitlab.com" in tried[1]
    assert any("404" in line for line in logs)
    assert surfer_mod.installed_version(tmp_path / "surfer-web") == surfer_mod.SURFER_VERSION


def test_install_reports_every_failed_url(tmp_path: Path) -> None:
    with pytest.raises(surfer_mod.SurferError) as info:
        surfer_mod.install(dest=tmp_path / "surfer-web", opener=_fake_opener(b"not the pinned zip"))
    assert "github.com" in str(info.value) and "gitlab.com" in str(info.value)
