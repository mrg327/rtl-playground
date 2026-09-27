"""Surfer, embedded: download the pinned web (WASM) build into a per-user cache and
serve it read-only at ``/surfer/`` (DESIGN.md section 7 revisits the "no Surfer" call:
only the *viewer*, not its multi-megabyte WASM, needs to reach the browser on first use,
and only once per machine).

Surfer (https://surfer-project.org, EUPL-1.2, gitlab.com/surfer-project/surfer) does not
publish a versioned release of its web build: its GitLab CI deploys the wasm build
continuously to https://app.surfer-project.org/ (GitLab Pages, from ``main``) and keeps
it as a CI job artifact that is pruned once a newer pipeline on ``main`` supersedes it as
"latest successful". So instead of pinning a release tag, this module pins one such job's
artifact by URL and verifies it by sha256; ``SURFER_VERSION`` records which commit that
job built. If GitLab eventually prunes that job (the download then 404s), bump
SURFER_URL/SURFER_SHA256/SURFER_VERSION to a newer ``wasm_artifacts`` job from
https://gitlab.com/surfer-project/surfer/-/pipelines?ref=main&status=success (open the
pipeline, find the ``wasm_artifacts`` job, and its "download artifacts" link is the URL).

Surfer's own build bakes an absolute ``/dist/`` public URL into ``index.html`` (its
GitLab Pages deploy step patches this the same way we do here, since Pages also serves it
from a subpath); we rewrite it to a relative path so the build works from ``/surfer/``.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from hashlib import sha256
from pathlib import Path
from typing import Any, Callable

# Pinned to the `wasm_artifacts` job of pipeline 2872490384 (commit c9db19e7, 2026-09-22),
# the latest successful build of `main` at the time this was written. See the module
# docstring for how to re-pin this if it stops resolving.
SURFER_URL = "https://gitlab.com/surfer-project/surfer/-/jobs/16662751065/artifacts/download"
SURFER_SHA256 = "330e1404d7ffcfdf5a0e4ca29a03b53bd92e453bb62e2cab1c4a8e3176ef505a"
SURFER_VERSION = "surfer@c9db19e7 (main, 2026-09-22)"
SURFER_SIZE_MB = 15  # rounded up from the ~14.6 MiB download, for the install prompt

DOWNLOAD_TIMEOUT_S = 180.0
# The real download is ~15 MB; refuse anything wildly larger so a redirected or
# compromised URL cannot fill the disk before the sha256 check runs.
MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024
CACHE_SUBDIR = "surfer-web"
MARKER_NAME = ".sha256"


class SurferError(Exception):
    """The download, its checksum, or the archive layout was not what was expected."""


# --------------------------------------------------------------------------- #
# Cache directory (stdlib only)
# --------------------------------------------------------------------------- #


def cache_root() -> Path:
    """Per-user cache root: XDG on Linux, ``~/Library/Caches`` on macOS, ``%LOCALAPPDATA%``
    on Windows, falling back to ``~/.cache`` if the platform is none of those.

    Branches on ``sys.platform`` rather than ``os.name`` so it stays testable on any host:
    pathlib's ``Path()`` refuses to construct the "wrong" OS's concrete class even when
    ``os.name`` is monkeypatched, but does not care about ``sys.platform`` at all.
    """
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    elif sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        base = Path(local) if local else Path.home() / "AppData" / "Local"
    else:
        xdg = os.environ.get("XDG_CACHE_HOME")
        base = Path(xdg) if xdg else Path.home() / ".cache"
    return base / "rtl-playground"


def surfer_dir() -> Path:
    return cache_root() / CACHE_SUBDIR


# --------------------------------------------------------------------------- #
# Status
# --------------------------------------------------------------------------- #


def installed_version(directory: Path | None = None) -> str | None:
    """The pinned version string if a matching, complete install is present, else None.

    A directory left by an older pin (a stale sha256 marker) reports as not installed,
    so ``install()`` cleanly replaces it rather than mixing files from two builds.
    """
    d = directory or surfer_dir()
    marker = d / MARKER_NAME
    if not (d / "index.html").is_file() or not marker.is_file():
        return None
    try:
        recorded = marker.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return SURFER_VERSION if recorded == SURFER_SHA256 else None


def describe() -> dict[str, Any]:
    version = installed_version()
    return {"installed": version is not None, "version": version, "sizeMB": SURFER_SIZE_MB}


# --------------------------------------------------------------------------- #
# Safe zip extraction
# --------------------------------------------------------------------------- #


def _member_target(dest: Path, name: str) -> Path | None:
    """The extraction path for a zip member, or None for a directory entry with no path.

    Rejects absolute paths, Windows drive letters, NUL bytes and ``..`` components, and
    (defensively) re-checks that the resolved path is still inside ``dest``.
    """
    rel = name.replace("\\", "/")
    if not rel or "\x00" in rel or rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
        raise SurferError(f"unsafe path in the Surfer archive: {name!r}")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise SurferError(f"unsafe path in the Surfer archive: {name!r}")
    if not parts:
        return None
    target = dest.joinpath(*parts)
    resolved = target.resolve()
    if resolved != dest and dest not in resolved.parents:
        raise SurferError(f"path escapes the install directory: {name!r}")
    return target


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    dest = dest.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    for info in zf.infolist():
        target = _member_target(dest, info.filename)
        if target is None:
            continue  # a pure directory entry; files below create their own parents
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, target.open("wb") as out:
            shutil.copyfileobj(src, out)


def _patch_index(index: Path) -> None:
    """Rewrite the baked-in absolute ``/dist/`` public URL to a relative one, so the
    build works from whatever prefix it is served at (mirrors Surfer's own GitLab Pages
    deploy step: ``sed -i 's|/dist/|./|g' index.html``)."""
    text = index.read_text(encoding="utf-8")
    index.write_text(text.replace("/dist/", "./"), encoding="utf-8")


def _find_build_root(extracted: Path) -> Path:
    if (extracted / "index.html").is_file():
        return extracted
    candidates = [p for p in extracted.iterdir() if p.is_dir() and (p / "index.html").is_file()]
    if not candidates:
        raise SurferError("the downloaded archive does not contain an index.html")
    return candidates[0]


# --------------------------------------------------------------------------- #
# Install
# --------------------------------------------------------------------------- #


def install(
    log: Callable[[str], None] = lambda _text: None,
    *,
    url: str | None = None,
    expected_sha256: str | None = None,
    version: str | None = None,
    dest: Path | None = None,
    opener: Callable[..., Any] | None = None,
) -> str:
    """Download the pinned build, verify it, and install it into the cache.

    Runs synchronously (see the API route for why this is a plain endpoint, not a job):
    the download is ~15 MB, finishes in a few seconds even on a slow connection, and
    tying it to the single-job-at-a-time project job manager would make it contend with,
    or be blocked by, an unrelated synthesis or test run.

    ``url``, ``expected_sha256``, ``version``, ``dest`` and ``opener`` default to the
    module's pinned constants and ``urllib.request.urlopen``, looked up here rather than
    as default-argument values so that tests (and a future re-pin) can override the
    module attributes without needing every caller to pass them through explicitly.
    """
    url = url if url is not None else SURFER_URL
    expected_sha256 = expected_sha256 if expected_sha256 is not None else SURFER_SHA256
    version = version if version is not None else SURFER_VERSION
    dest = dest or surfer_dir()
    opener = opener or urllib.request.urlopen
    log(f"Downloading Surfer ({SURFER_SIZE_MB} MB) from {url}\n")
    fd, tmp_name = tempfile.mkstemp(prefix="rtlp-surfer-", suffix=".zip")
    tmp_path = Path(tmp_name)
    try:
        hasher = sha256()
        total = 0
        try:
            with os.fdopen(fd, "wb") as out, opener(
                urllib.request.Request(url, headers={"User-Agent": "rtl-playground"}),
                timeout=DOWNLOAD_TIMEOUT_S,
            ) as resp:
                while True:
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_DOWNLOAD_BYTES:
                        raise SurferError("download exceeded the expected size; refusing to continue")
                    hasher.update(chunk)
                    out.write(chunk)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise SurferError(f"cannot download Surfer: {exc}") from exc

        digest = hasher.hexdigest()
        if digest != expected_sha256:
            raise SurferError(
                f"downloaded file does not match the pinned checksum (got {digest}, expected {expected_sha256})"
            )
        log(f"Verified sha256 ({total // 1024} KiB)\n")

        parent = dest.parent
        parent.mkdir(parents=True, exist_ok=True)
        extract_tmp = Path(tempfile.mkdtemp(prefix=f".{dest.name}.extract-", dir=parent))
        try:
            with zipfile.ZipFile(tmp_path) as zf:
                _safe_extract(zf, extract_tmp)
            build_root = _find_build_root(extract_tmp)
            _patch_index(build_root / "index.html")
            (build_root / MARKER_NAME).write_text(expected_sha256, encoding="utf-8")

            log("Installing into the cache\n")
            staged = parent / f".{dest.name}.new"
            with contextlib.suppress(FileNotFoundError):
                shutil.rmtree(staged)
            shutil.move(str(build_root), str(staged))
            if dest.exists():
                shutil.rmtree(dest)
            os.replace(staged, dest)
        finally:
            shutil.rmtree(extract_tmp, ignore_errors=True)
    finally:
        with contextlib.suppress(OSError):
            tmp_path.unlink()
    log(f"{version} installed\n")
    return version


__all__ = [
    "MAX_DOWNLOAD_BYTES",
    "SURFER_SHA256",
    "SURFER_SIZE_MB",
    "SURFER_URL",
    "SURFER_VERSION",
    "SurferError",
    "cache_root",
    "describe",
    "install",
    "installed_version",
    "surfer_dir",
]
