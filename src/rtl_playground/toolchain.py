"""Where the open-source tools live: native on PATH, or in the pinned Docker image.

The host never links the heavy tools; it only builds command lines for them.
``native`` is used when Verilator, Yosys, OpenROAD, a cocotb-capable Python and
an OpenROAD-flow-scripts checkout are all found. Otherwise ``docker`` mode runs
the same commands in the playground's tool image with the project folder
mounted at ``/work`` (DESIGN.md section 13). The container engine is Docker,
podman, or udocker, in that order; udocker runs images as an ordinary user
through proot, for lab machines where students cannot install Docker
(``uvx --with udocker rtl-playground``).

Environment overrides:
  RTLP_TOOLCHAIN   native | docker | none  (skip detection)
  RTLP_TOOLS_PATH  extra PATH entries for native tools (os.pathsep separated)
  RTLP_TOOLS_PYTHON  Python with cocotb installed (native)
  RTLP_ORFS_FLOW   the ORFS ``flow`` directory (native; FLOW_HOME is also read)
  RTLP_IMAGE       the tool image for docker mode
  RTLP_ENGINE      docker | podman | udocker  (pick the container engine)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

TOOLS_IMAGE = "ghcr.io/mrg327/rtl-playground-tools"
# The image is versioned separately from the app so a patch release does not force a multi-GB pull.
TOOLS_IMAGE_TAG = "2026.09"
CONTAINER_WORK = "/work"
CONTAINER_FLOW_HOME = "/OpenROAD-flow-scripts/flow"
PROBE_TIMEOUT_S = 20.0


@dataclass
class Toolchain:
    mode: str  # "native" | "docker" | "none"
    reason: str = ""
    tools: dict[str, str] = field(default_factory=dict)  # tool -> version or path
    path_env: str = ""  # native: PATH to run with
    python: str = "python3"
    flow_home: str = ""
    engine: str = ""  # docker mode: the docker/podman/udocker executable
    engine_kind: str = ""  # docker | podman | udocker
    image: str = ""
    image_ready: bool = False  # the tool image is present locally; otherwise offer the setup job

    @property
    def available(self) -> bool:
        return self.mode in ("native", "docker")

    def describe(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "available": self.available,
            "reason": self.reason,
            "tools": self.tools,
            "image": self.image or None,
            "engine": self.engine_kind or None,
            "imageReady": self.image_ready if self.mode == "docker" else True,
            "flowHome": self.flow_home or None,
        }

    @property
    def container(self) -> str:
        """udocker runs a created container, not an image; its name is derived from the image tag."""
        tag = self.image.rsplit("/", 1)[-1]
        # udocker rejects '/', '.', ' ', '[' and ']' in names.
        return "rtlp-" + "".join(c if c.isalnum() or c in "-_" else "_" if c == "." else "-" for c in tag)

    def setup_commands(self) -> list[list[str]]:
        """Commands that download the tool image (and, for udocker, create its container)."""
        if self.mode != "docker":
            return []
        cmds = [[self.engine, "pull", self.image]]
        if self.engine_kind == "udocker":
            cmds.append([self.engine, "create", f"--name={self.container}", self.image])
        return cmds

    # ---- paths ------------------------------------------------------------------ #

    def tool_path(self, host_path: Path, root: Path) -> str:
        """``host_path`` as the tools see it. ``root`` is the folder mounted at /work in docker mode."""
        if self.mode == "docker":
            rel = Path(host_path).resolve().relative_to(Path(root).resolve())
            return str(PurePosixPath(CONTAINER_WORK) / PurePosixPath(rel.as_posix()))
        return str(Path(host_path).resolve())

    # ---- commands --------------------------------------------------------------- #

    def wrap(self, argv: list[str], *, root: Path, cwd: Path, env: dict[str, str] | None = None,
             name: str | None = None) -> tuple[list[str], dict[str, str]]:
        """Turn a tool command into the host command line and environment that runs it."""
        env = dict(env or {})
        if self.mode == "native":
            host_env = dict(os.environ)
            host_env["PATH"] = self.path_env or host_env.get("PATH", "")
            if self.flow_home:
                host_env.setdefault("FLOW_HOME", self.flow_home)
            host_env.update(env)
            return list(argv), host_env
        if self.mode == "docker":
            root = Path(root).resolve()
            workdir = self.tool_path(cwd, root)
            if self.engine_kind == "udocker":
                cmd = [self.engine, "run", "--nobanner", "-v", f"{root}:{CONTAINER_WORK}", "-w", workdir]
                for k, v in env.items():
                    cmd += ["-e", f"{k}={v}"]
                return [*cmd, self.container, *argv], dict(os.environ)
            cmd = [self.engine, "run", "--rm", "--init", "-v", f"{root}:{CONTAINER_WORK}", "-w", workdir]
            if name:
                cmd += ["--name", name]
            if hasattr(os, "getuid") and self.engine_kind == "docker":
                # Files written into the mounted project must belong to the student, not root.
                cmd += ["--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp"]
            for k, v in env.items():
                cmd += ["-e", f"{k}={v}"]
            cmd.append(self.image)
            cmd += argv
            return cmd, dict(os.environ)
        raise RuntimeError(f"no toolchain: {self.reason}")

    def kill(self, name: str) -> None:
        """Stop a named container (docker mode); the local process is killed by the caller."""
        if self.mode == "docker" and name and self.engine_kind != "udocker":
            subprocess.run([self.engine, "kill", name], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=PROBE_TIMEOUT_S, check=False)


def _run_probe(argv: list[str], path_env: str) -> str | None:
    env = dict(os.environ)
    env["PATH"] = path_env
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=PROBE_TIMEOUT_S, env=env, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    text = (out.stdout or out.stderr).strip()
    return text.splitlines()[0].strip() if text else ""


def _native_candidate() -> Toolchain:
    extra = os.environ.get("RTLP_TOOLS_PATH", "")
    path_env = os.pathsep.join(p for p in (extra, os.environ.get("PATH", "")) if p)
    missing: list[str] = []
    tools: dict[str, str] = {}
    for tool, args in (("verilator", ["--version"]), ("yosys", ["-V"]), ("openroad", ["-version"])):
        exe = shutil.which(tool, path=path_env)
        if exe is None:
            missing.append(tool)
            continue
        tools[tool] = _run_probe([exe, *args], path_env) or exe
    klayout = shutil.which("klayout", path=path_env)
    if klayout:
        tools["klayout"] = klayout

    python = os.environ.get("RTLP_TOOLS_PYTHON") or shutil.which("python3", path=path_env) or sys.executable
    cocotb = _run_probe([python, "-c", "import cocotb; print(cocotb.__version__)"], path_env)
    if cocotb is None:
        missing.append("cocotb")
    else:
        tools["cocotb"] = cocotb

    flow_home = os.environ.get("RTLP_ORFS_FLOW") or os.environ.get("FLOW_HOME") or ""
    if not flow_home or not (Path(flow_home) / "Makefile").is_file():
        missing.append("OpenROAD-flow-scripts (set RTLP_ORFS_FLOW to its flow/ directory)")
        flow_home = ""
    else:
        tools["orfs"] = str(Path(flow_home).resolve())

    if missing:
        return Toolchain("none", reason="native tools missing: " + ", ".join(missing), tools=tools)
    return Toolchain("native", tools=tools, path_env=path_env, python=python, flow_home=str(Path(flow_home).resolve()))


def _find_udocker() -> str | None:
    explicit = os.environ.get("RTLP_UDOCKER")
    if explicit:
        return explicit
    # Installed alongside the host (uvx --with udocker) puts the script next to this Python.
    beside = Path(sys.executable).parent / ("udocker.exe" if os.name == "nt" else "udocker")
    return str(beside) if beside.is_file() else shutil.which("udocker")


def _docker_candidate() -> Toolchain:
    image = os.environ.get("RTLP_IMAGE") or f"{TOOLS_IMAGE}:{TOOLS_IMAGE_TAG}"
    wanted = os.environ.get("RTLP_ENGINE", "").strip().lower()
    path_env = os.environ.get("PATH", "")
    problems: list[str] = []
    for kind in ("docker", "podman", "udocker"):
        if wanted and kind != wanted:
            continue
        engine = _find_udocker() if kind == "udocker" else shutil.which(kind)
        if engine is None:
            continue
        if kind == "docker":
            version = _run_probe([engine, "version", "--format", "{{.Server.Version}}"], path_env)
        elif kind == "podman":
            version = _run_probe([engine, "version", "--format", "{{.Version}}"], path_env)
        else:
            version = _run_probe([engine, "version"], path_env)
        if version is None:
            problems.append(f"{kind} is installed but not running" + (" (start Docker Desktop or the daemon)" if kind == "docker" else ""))
            continue
        tc = Toolchain("docker", tools={kind: version.removeprefix("version: ")}, engine=engine, engine_kind=kind,
                       image=image, flow_home=CONTAINER_FLOW_HOME, python="python3")
        if kind == "udocker":
            tc.image_ready = _run_probe([engine, "inspect", tc.container], path_env) is not None
        else:
            tc.image_ready = _run_probe([engine, "image", "inspect", "--format", "{{.Id}}", image], path_env) is not None
        return tc
    if problems:
        return Toolchain("none", reason="; ".join(problems))
    return Toolchain("none", reason="no container engine found (install Docker, or run with uvx --with udocker)")


def detect() -> Toolchain:
    forced = os.environ.get("RTLP_TOOLCHAIN", "").strip().lower()
    if forced == "none":
        return Toolchain("none", reason="disabled by RTLP_TOOLCHAIN=none")
    if forced == "native":
        return _native_candidate()
    if forced == "docker":
        return _docker_candidate()
    native = _native_candidate()
    if native.available:
        return native
    docker = _docker_candidate()
    if docker.available:
        return docker
    return Toolchain("none", reason=f"{native.reason}; {docker.reason}")


class ToolchainCache:
    """Detection runs subprocesses, so do it once and on explicit refresh."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value: Toolchain | None = None

    def get(self, refresh: bool = False) -> Toolchain:
        with self._lock:
            if self._value is None or refresh:
                self._value = detect()
            return self._value

    def set(self, value: Toolchain) -> None:
        with self._lock:
            self._value = value


__all__ = ["CONTAINER_FLOW_HOME", "CONTAINER_WORK", "TOOLS_IMAGE", "TOOLS_IMAGE_TAG", "Toolchain",
           "ToolchainCache", "detect"]
