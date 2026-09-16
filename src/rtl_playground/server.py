"""Stdlib-only local host for RTL Playground.

Serves the built front end from ``static/`` and a small JSON API under ``/api``:
a sandboxed file API rooted at the launch directory, and optional Yosys
endpoints backed by ``yowasp-yosys`` when that extra is installed.

Security model (see DESIGN.md section 10): the server binds to loopback only,
every ``/api`` request must carry a loopback ``Host`` (and matching ``Origin``
when present), and every write endpoint must carry the startup token in the
``X-RTLP-Token`` header. The token travels in the URL fragment so it never
reaches the server in a request line or a Referer.
"""

from __future__ import annotations

import contextlib
import errno
import hmac
import html
import importlib.resources
import importlib.util
import io
import json
import os
import secrets
import socket
import stat
import sys
import tempfile
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from rtl_playground import __version__

# Files the file API is willing to list, read, write and delete.
ALLOWED_SUFFIXES = frozenset({".rtlp", ".json", ".sv", ".v", ".mem", ".hex", ".vcd", ".md"})
SKIP_DIRS = frozenset({"node_modules", ".venv", "__pycache__"})
MAX_BODY_BYTES = 32 * 1024 * 1024
HDL_TIMEOUT_S = 60.0

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".mem": "text/plain; charset=utf-8",
    ".hex": "text/plain; charset=utf-8",
    ".sv": "text/plain; charset=utf-8",
    ".v": "text/plain; charset=utf-8",
    ".rtlp": "application/json; charset=utf-8",
    ".vcd": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    "": "application/octet-stream",
}

NOT_BUILT_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>RTL Playground: front end not built</title>
<style>body{{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}}
code,pre{{background:#f3f3f3;padding:.1rem .3rem;border-radius:3px}}pre{{padding:.8rem;overflow:auto}}</style></head>
<body><h1>RTL Playground v{version}</h1>
<p>The Python host is running, but the front end has not been built, so there is nothing to show yet.</p>
<p>If you installed from PyPI this is a packaging bug; please report it. If you are working from a
source checkout, build the front end once:</p>
<pre>cd frontend
npm install
npm run build</pre>
<p>That writes <code>src/rtl_playground/static/</code>. Then reload this page. For day-to-day front-end work,
run <code>npm run dev</code> in <code>frontend/</code> instead and let Vite proxy <code>/api</code> to this host.</p>
<p>Serving <code>{root}</code>. The JSON API is live at <code>/api/version</code>.</p>
</body></html>
"""


class ApiError(Exception):
    """Raised inside API handlers to produce a JSON error response."""

    def __init__(self, status: int, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def default_static_dir() -> Path | None:
    """Locate the packaged ``static/`` folder, or return None if it is absent."""
    try:
        candidate = importlib.resources.files("rtl_playground") / "static"
        path = Path(str(candidate))
    except (TypeError, ModuleNotFoundError, FileNotFoundError):
        return None
    if (path / "index.html").is_file():
        return path
    return None


def hdl_available() -> bool:
    try:
        return importlib.util.find_spec("yowasp_yosys") is not None
    except (ImportError, ValueError):
        return False


def _import_yowasp():
    try:
        import yowasp_yosys  # type: ignore[import-not-found]
    except ImportError:
        return None
    return yowasp_yosys


def _file_mtime(path: Path) -> float:
    return path.stat().st_mtime


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise


def _validate_hdl_filename(name: str) -> None:
    if not name or name != os.path.basename(name) or name.startswith(".") or "\x00" in name:
        raise ApiError(400, f"invalid HDL file name: {name!r}")
    if Path(name).suffix.lower() not in {".sv", ".v", ".svh", ".vh"}:
        raise ApiError(400, f"HDL file must end in .sv or .v: {name!r}")


# --------------------------------------------------------------------------- #
# Yosys runner
# --------------------------------------------------------------------------- #


def run_yosys_script(
    files: dict[str, str],
    commands_after_read: list[str],
    timeout: float | None = None,
    workdir: Path | None = None,
) -> dict[str, Any]:
    """Run Yosys via yowasp on ``files`` with a read step followed by ``commands_after_read``.

    Returns ``{"ok": bool, "log": str, "frontend": "slang"|"verilog", "workdir": Path}``.
    Raises ApiError(501) when yowasp-yosys is missing and ApiError(504) on timeout.
    The caller owns the temporary directory returned as ``workdir``.
    """
    yowasp = _import_yowasp()
    if yowasp is None:
        raise ApiError(
            501,
            "yowasp-yosys not installed",
            hint="uvx --with yowasp-yosys rtl-playground",
        )
    if not files:
        raise ApiError(400, "no HDL files given")
    for name in files:
        _validate_hdl_filename(name)

    if workdir is None:
        workdir = Path(tempfile.mkdtemp(prefix="rtlp-hdl-"))
    for name, text in files.items():
        (workdir / name).write_text(text, encoding="utf-8")

    if timeout is None:
        timeout = HDL_TIMEOUT_S
    deadline = time.monotonic() + timeout

    def attempt(read_cmd: str, tag: str) -> tuple[bool, str]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ApiError(504, "Yosys timed out")
        script = workdir / f"script-{tag}.ys"
        logfile = workdir / f"yosys-{tag}.log"
        script.write_text("\n".join([read_cmd, *commands_after_read, ""]), encoding="utf-8")
        argv = ["-q", "-l", str(logfile), "-s", str(script)]
        out, err = io.StringIO(), io.StringIO()
        result: dict[str, Any] = {}

        def target() -> None:
            try:
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    result["code"] = yowasp.run_yosys(argv)
            except SystemExit as exc:  # some runtimes exit instead of returning
                result["code"] = exc.code if isinstance(exc.code, int) else 1
            except BaseException as exc:  # noqa: BLE001
                result["code"] = 1
                result["exc"] = exc

        thread = threading.Thread(target=target, name=f"yosys-{tag}", daemon=True)
        thread.start()
        thread.join(remaining)
        if thread.is_alive():
            raise ApiError(504, "Yosys timed out", log=out.getvalue() + err.getvalue())

        log = ""
        if logfile.is_file():
            with contextlib.suppress(OSError):
                log = logfile.read_text(encoding="utf-8", errors="replace")
        captured = out.getvalue() + err.getvalue()
        if captured.strip() and captured.strip() not in log:
            log = log + ("\n" if log and not log.endswith("\n") else "") + captured
        if "exc" in result:
            log += f"\n{type(result['exc']).__name__}: {result['exc']}\n"
        code = result.get("code", 1)
        ok = code in (0, None)
        return ok, log

    quoted = " ".join(f'"{(workdir / name).as_posix()}"' for name in files)
    slang_ok, slang_log = attempt(f"read_slang {quoted}", "slang")
    if slang_ok:
        return {"ok": True, "log": slang_log, "frontend": "slang", "workdir": workdir}

    slang_missing = (not slang_log.strip()) or ("No such command: read_slang" in slang_log)

    verilog_ok, verilog_log = attempt(f"read_verilog -sv {quoted}", "verilog")
    if verilog_ok:
        return {"ok": True, "log": verilog_log, "frontend": "verilog", "workdir": workdir}

    # Both failed. Report the more useful diagnostics: slang's when it was present.
    log = verilog_log if slang_missing else slang_log
    return {"ok": False, "log": log, "frontend": "verilog" if slang_missing else "slang", "workdir": workdir}


def _cleanup_workdir(workdir: Path) -> None:
    import shutil

    shutil.rmtree(workdir, ignore_errors=True)


def hdl_elaborate(files: dict[str, str], top: str | None) -> dict[str, Any]:
    if top is not None and (not top.replace("_", "a").replace("$", "a").isalnum()):
        raise ApiError(400, f"invalid top module name: {top!r}")
    hier = f"hierarchy -check -top {top}" if top else "hierarchy -check -auto-top"
    commands = [
        hier,
        "proc",
        "opt_clean",
        "fsm_detect",
        "fsm_extract",
        "fsm_opt",
        "memory -nomap",
        "wreduce",
        "opt",
    ]
    workdir = Path(tempfile.mkdtemp(prefix="rtlp-hdl-"))
    out_json = workdir / "out.json"
    commands.append(f'write_json "{out_json.as_posix()}"')
    try:
        result = run_yosys_script(files, commands, workdir=workdir)
        if not result["ok"]:
            raise ApiError(422, "Yosys failed", log=result["log"])
        if not out_json.is_file():
            raise ApiError(422, "Yosys did not produce out.json", log=result["log"])
        try:
            data = json.loads(out_json.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise ApiError(422, f"could not parse Yosys JSON: {exc}", log=result["log"]) from exc
        return {"json": data, "log": result["log"], "frontend": result["frontend"]}
    finally:
        _cleanup_workdir(workdir)


def hdl_lint(files: dict[str, str]) -> dict[str, Any]:
    commands = ["hierarchy -check -auto-top", "proc", "check -assert"]
    workdir = Path(tempfile.mkdtemp(prefix="rtlp-hdl-"))
    try:
        result = run_yosys_script(files, commands, workdir=workdir)
        return {"ok": bool(result["ok"]), "log": result["log"], "frontend": result["frontend"]}
    finally:
        _cleanup_workdir(workdir)


# --------------------------------------------------------------------------- #
# Server and handler
# --------------------------------------------------------------------------- #


class PlaygroundServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # never steal a port that is genuinely in use

    def __init__(
        self,
        root: Path,
        port: int = 0,
        *,
        static_dir: Path | None = None,
        token: str | None = None,
        debug: bool = False,
    ) -> None:
        self.root = Path(root).resolve()
        self.static_dir = Path(static_dir).resolve() if static_dir is not None else None
        self.token = token or secrets.token_hex(16)
        self.debug = debug
        self.hdl_lock = threading.Lock()
        super().__init__(("127.0.0.1", port), PlaygroundHandler)

    @property
    def port(self) -> int:
        return int(self.server_address[1])

    def url(self, open_file: str | None = None) -> str:
        url = f"http://127.0.0.1:{self.port}/#token={self.token}"
        if open_file:
            from urllib.parse import quote

            url += f"&open={quote(open_file, safe='/')}"
        return url

    def handle_error(self, request, client_address) -> None:  # noqa: ANN001
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        if self.debug:
            super().handle_error(request, client_address)

    # ---- sandboxed path resolution ------------------------------------------------ #

    def resolve(self, rel: str, *, allow_root: bool = False) -> Path:
        """Map a client-supplied relative path onto a path under ``root`` or raise 403."""
        if rel is None:
            raise ApiError(400, "missing path")
        rel = rel.replace("\\", "/")
        if "\x00" in rel:
            raise ApiError(403, "invalid path")
        if rel in ("", ".", "./"):
            if allow_root:
                return self.root
            raise ApiError(400, "missing path")
        if rel.startswith("/") or os.path.isabs(rel) or (len(rel) > 1 and rel[1] == ":"):
            raise ApiError(403, "absolute paths are not allowed")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if any(p == ".." for p in parts):
            raise ApiError(403, "path escapes the served directory")
        candidate = self.root.joinpath(*parts)
        try:
            resolved = candidate.resolve()
        except (OSError, RuntimeError) as exc:
            raise ApiError(403, "invalid path") from exc
        if resolved != self.root and self.root not in resolved.parents:
            raise ApiError(403, "path escapes the served directory")
        return resolved

    def relpath(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()


class PlaygroundHandler(SimpleHTTPRequestHandler):
    server: PlaygroundServer
    server_version = f"RTLPlayground/{__version__}"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    extensions_map = MIME_TYPES

    def __init__(self, request, client_address, server: PlaygroundServer) -> None:  # noqa: ANN001
        self._no_store = False
        directory = str(server.static_dir) if server.static_dir else str(Path(tempfile.gettempdir()))
        super().__init__(request, client_address, server, directory=directory)

    # ---- logging ----------------------------------------------------------------- #

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        if self.server.debug:
            super().log_message(format, *args)

    # ---- static files ------------------------------------------------------------ #

    def end_headers(self) -> None:
        if self._no_store:
            self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _url_path(self) -> str:
        return urlsplit(self.path).path

    def do_GET(self) -> None:
        if self._url_path().startswith("/api/") or self._url_path() == "/api":
            self._dispatch_api()
            return
        self._serve_static()

    def do_HEAD(self) -> None:
        if self._url_path().startswith("/api"):
            self._send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method not allowed"})
            return
        self._serve_static()

    def _serve_static(self) -> None:
        static_dir = self.server.static_dir
        if static_dir is None:
            self._send_not_built()
            return
        url_path = self._url_path()
        target = Path(self.translate_path(self.path))
        if url_path in ("", "/"):
            self._serve_index()
            return
        if target.is_file():
            self._no_store = target.name == "index.html"
            self._serve_file_via_base()
            return
        # Unknown path: a missing asset gets a 404, anything else is an SPA route.
        suffix = Path(url_path).suffix.lower()
        if suffix and suffix in MIME_TYPES and suffix not in (".html", ".htm"):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return
        self._serve_index()

    def _serve_index(self) -> None:
        self._no_store = True
        self.path = "/index.html"
        self._serve_file_via_base()

    def _serve_file_via_base(self) -> None:
        if self.command == "HEAD":
            super().do_HEAD()
        else:
            super().do_GET()

    def _send_not_built(self) -> None:
        body = NOT_BUILT_HTML.format(
            version=html.escape(__version__), root=html.escape(str(self.server.root))
        ).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._no_store = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # ---- API plumbing ------------------------------------------------------------ #

    def do_PUT(self) -> None:
        self._dispatch_api()

    def do_POST(self) -> None:
        self._dispatch_api()

    def do_DELETE(self) -> None:
        self._dispatch_api()

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._no_store = True
        self.end_headers()
        self.wfile.write(body)

    def _check_host_origin(self) -> None:
        port = self.server.port
        allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in allowed_hosts:
            raise ApiError(403, "bad Host header")
        origin = self.headers.get("Origin")
        if origin is not None:
            origin = origin.strip().lower()
            if origin not in {f"http://{h}" for h in allowed_hosts}:
                raise ApiError(403, "bad Origin header")

    def _check_token(self) -> None:
        given = self.headers.get("X-RTLP-Token") or ""
        if not hmac.compare_digest(given.encode("utf-8"), self.server.token.encode("utf-8")):
            raise ApiError(403, "missing or invalid X-RTLP-Token")

    def _read_json_body(self) -> dict[str, Any]:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            raise ApiError(411, "Content-Length required")
        try:
            length = int(length_header)
        except ValueError as exc:
            raise ApiError(400, "bad Content-Length") from exc
        if length < 0 or length > MAX_BODY_BYTES:
            raise ApiError(413, "request body too large")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ApiError(400, f"body is not valid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise ApiError(400, "body must be a JSON object")
        return data

    def _drain_body(self) -> None:
        """Consume an unread body so keep-alive connections stay in sync."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if 0 < length <= MAX_BODY_BYTES:
            with contextlib.suppress(OSError):
                self.rfile.read(length)

    def _dispatch_api(self) -> None:
        parts = urlsplit(self.path)
        query = {k: v[-1] for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
        route = (self.command, parts.path)
        body_read = False
        try:
            self._check_host_origin()
            if self.command in ("PUT", "POST", "DELETE"):
                self._check_token()
            handler = API_ROUTES.get(route)
            if handler is None:
                if any(p == parts.path for _, p in API_ROUTES):
                    raise ApiError(405, "method not allowed")
                raise ApiError(404, "unknown API endpoint")
            body: dict[str, Any] = {}
            if self.command in ("PUT", "POST"):
                body = self._read_json_body()
                body_read = True
            status, payload = handler(self, query, body)
            self._send_json(status, payload)
        except ApiError as exc:
            if not body_read:
                self._drain_body()
            payload = {"error": exc.message}
            payload.update(exc.extra)
            self._send_json(exc.status, payload)
        except (BrokenPipeError, ConnectionResetError):
            raise
        except Exception as exc:  # noqa: BLE001
            if not body_read:
                self._drain_body()
            if self.server.debug:
                import traceback

                traceback.print_exc()
            self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})

    # ---- API endpoints ----------------------------------------------------------- #

    def api_version(self, query: dict[str, str], body: dict[str, Any]) -> tuple[int, Any]:
        return 200, {
            "version": __version__,
            "root": str(self.server.root),
            "hdl": hdl_available(),
            "python": ".".join(str(n) for n in sys.version_info[:3]),
        }

    def api_files(self, query: dict[str, str], body: dict[str, Any]) -> tuple[int, Any]:
        rel = query.get("dir", "")
        directory = self.server.resolve(rel, allow_root=True)
        if not directory.is_dir():
            raise ApiError(404, "directory not found")
        entries = []
        try:
            with os.scandir(directory) as it:
                children = sorted(it, key=lambda e: e.name.lower())
        except OSError as exc:
            raise ApiError(500, f"cannot list directory: {exc}") from exc
        for entry in children:
            name = entry.name
            if name.startswith(".") or name in SKIP_DIRS:
                continue
            try:
                st = entry.stat()
            except OSError:
                continue
            if stat.S_ISDIR(st.st_mode):
                entries.append({"name": name, "type": "dir", "size": 0, "mtime": st.st_mtime})
            elif stat.S_ISREG(st.st_mode) and Path(name).suffix.lower() in ALLOWED_SUFFIXES:
                entries.append({"name": name, "type": "file", "size": st.st_size, "mtime": st.st_mtime})
        entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
        rel_out = "" if directory == self.server.root else self.server.relpath(directory)
        return 200, {"dir": rel_out, "entries": entries}

    def _file_target(self, query: dict[str, str]) -> Path:
        rel = query.get("path")
        if not rel:
            raise ApiError(400, "missing path")
        target = self.server.resolve(rel)
        if target.suffix.lower() not in ALLOWED_SUFFIXES:
            raise ApiError(
                400,
                f"unsupported file type {target.suffix!r}; allowed: {', '.join(sorted(ALLOWED_SUFFIXES))}",
            )
        return target

    def api_file_get(self, query: dict[str, str], body: dict[str, Any]) -> tuple[int, Any]:
        target = self._file_target(query)
        if not target.is_file():
            raise ApiError(404, "file not found")
        try:
            text = target.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise ApiError(415, "file is not UTF-8 text") from exc
        except OSError as exc:
            raise ApiError(500, f"cannot read file: {exc}") from exc
        return 200, {"path": self.server.relpath(target), "text": text, "mtime": _file_mtime(target)}

    def api_file_put(self, query: dict[str, str], body: dict[str, Any]) -> tuple[int, Any]:
        target = self._file_target(query)
        text = body.get("text")
        if not isinstance(text, str):
            raise ApiError(400, "body must contain a string 'text'")
        if target.exists() and not target.is_file():
            raise ApiError(409, "path exists and is not a file")
        if "ifMtime" in body and body["ifMtime"] is not None:
            try:
                expected = float(body["ifMtime"])
            except (TypeError, ValueError) as exc:
                raise ApiError(400, "ifMtime must be a number") from exc
            current = _file_mtime(target) if target.is_file() else None
            if current is None or abs(current - expected) > 1e-6:
                raise ApiError(
                    409,
                    "file changed on disk since it was read",
                    mtime=current,
                )
        try:
            _atomic_write_text(target, text)
        except OSError as exc:
            raise ApiError(500, f"cannot write file: {exc}") from exc
        return 200, {"ok": True, "mtime": _file_mtime(target)}

    def api_file_delete(self, query: dict[str, str], body: dict[str, Any]) -> tuple[int, Any]:
        target = self._file_target(query)
        if not target.is_file():
            raise ApiError(404, "file not found")
        try:
            target.unlink()
        except OSError as exc:
            raise ApiError(500, f"cannot delete file: {exc}") from exc
        return 200, {"ok": True}

    def _hdl_files(self, body: dict[str, Any]) -> dict[str, str]:
        files = body.get("files")
        if not isinstance(files, dict) or not files:
            raise ApiError(400, "body must contain a non-empty 'files' object")
        for name, text in files.items():
            if not isinstance(name, str) or not isinstance(text, str):
                raise ApiError(400, "'files' must map file names to source text")
        return files

    def api_hdl_elaborate(self, query: dict[str, str], body: dict[str, Any]) -> tuple[int, Any]:
        files = self._hdl_files(body)
        top = body.get("top")
        if top is not None and not isinstance(top, str):
            raise ApiError(400, "'top' must be a string")
        with self.server.hdl_lock:
            return 200, hdl_elaborate(files, top or None)

    def api_hdl_lint(self, query: dict[str, str], body: dict[str, Any]) -> tuple[int, Any]:
        files = self._hdl_files(body)
        with self.server.hdl_lock:
            return 200, hdl_lint(files)


API_ROUTES = {
    ("GET", "/api/version"): PlaygroundHandler.api_version,
    ("GET", "/api/files"): PlaygroundHandler.api_files,
    ("GET", "/api/file"): PlaygroundHandler.api_file_get,
    ("PUT", "/api/file"): PlaygroundHandler.api_file_put,
    ("DELETE", "/api/file"): PlaygroundHandler.api_file_delete,
    ("POST", "/api/hdl/elaborate"): PlaygroundHandler.api_hdl_elaborate,
    ("POST", "/api/hdl/lint"): PlaygroundHandler.api_hdl_lint,
}


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def make_server(
    root: Path,
    port: int = 0,
    *,
    static_dir: Path | None = None,
    token: str | None = None,
    debug: bool = False,
) -> PlaygroundServer:
    """Create (and bind) a server. Pass ``static_dir`` explicitly to override discovery."""
    if static_dir is None:
        static_dir = default_static_dir()
    return PlaygroundServer(root, port, static_dir=static_dir, token=token, debug=debug)


def serve(
    root: Path,
    port: int = 0,
    *,
    open_browser: bool = True,
    open_file: str | None = None,
    debug: bool = False,
) -> int:
    try:
        server = make_server(root, port, debug=debug)
    except OSError as exc:
        if exc.errno in (errno.EADDRINUSE, errno.EACCES) or isinstance(exc, PermissionError):
            print(
                f"rtl-playground: cannot listen on 127.0.0.1:{port}: {exc.strerror or exc}. "
                "Another program is using that port; pick a different --port or omit it "
                "to let the OS choose a free one.",
                file=sys.stderr,
            )
        else:
            print(f"rtl-playground: cannot start server: {exc}", file=sys.stderr)
        return 1

    url = server.url(open_file)
    print(f"RTL Playground v{__version__} at {url}")
    print(f"Serving {server.root}")
    if server.static_dir is None:
        print("Note: the front end is not built; the page will explain how to build it.")
    print("Ctrl-C to stop")
    sys.stdout.flush()

    timer: threading.Timer | None = None
    if open_browser:
        timer = threading.Timer(0.3, _open_browser, args=(url,))
        timer.daemon = True
        timer.start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        if timer is not None:
            timer.cancel()
        server.server_close()
    return 0


def _open_browser(url: str) -> None:
    try:
        webbrowser.open(url)
    except Exception:  # noqa: BLE001  (WSL, headless: the URL is printed anyway)
        pass


__all__ = [
    "ALLOWED_SUFFIXES",
    "ApiError",
    "PlaygroundHandler",
    "PlaygroundServer",
    "default_static_dir",
    "hdl_available",
    "hdl_elaborate",
    "hdl_lint",
    "make_server",
    "run_yosys_script",
    "serve",
]
