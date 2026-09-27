"""Background tool jobs: one at a time, logs streamed by polling with an offset.

A job is a list of steps. A step is either a command (run through the
toolchain, output captured line by line) or a Python callable run on the
host (to generate files before a tool runs, or to parse its reports after).
Place and route wants most of a laptop's memory, so the manager refuses a
second job while one is running instead of queueing it (DESIGN.md section 13).
"""

from __future__ import annotations

import contextlib
import itertools
import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from rtl_playground.toolchain import Toolchain

MAX_LOG_CHARS = 8 * 1024 * 1024  # in-memory cap for runaway logs
KEEP_JOBS = 20

Status = str  # queued | running | passed | failed | cancelled | error


@dataclass
class Command:
    title: str
    argv: list[str]
    cwd: Path
    env: dict[str, str] = field(default_factory=dict)
    # Exit codes that let the job continue; None accepts any (a later host step judges the result).
    ok_codes: tuple[int, ...] | None = (0,)
    on_host: bool = False  # run as given (e.g. docker pull) instead of inside the toolchain


@dataclass
class HostStep:
    title: str
    run: Callable[["Job"], None]  # raise to fail the job; log with job.log()
    always: bool = False  # also run after an earlier command failed (to collect partial reports)


Step = Command | HostStep


class JobFailed(Exception):
    """Raised by a host step to fail the job with a message instead of a traceback."""


@dataclass
class Job:
    id: str
    kind: str
    title: str
    project: str  # project folder relative to the served root
    root: Path  # the served root (mounted at /work in docker mode)
    steps: list[Step]
    log_path: Path | None = None
    status: Status = "queued"
    step_index: int = -1
    created: float = field(default_factory=time.time)
    started: float | None = None
    ended: float | None = None
    result: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    _chunks: list[str] = field(default_factory=list, repr=False)
    _length: int = 0
    _dropped: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _proc: subprocess.Popen | None = field(default=None, repr=False)
    _container: str = ""
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    # ---- log -------------------------------------------------------------------- #

    def log(self, text: str) -> None:
        if not text:
            return
        with self._lock:
            self._chunks.append(text)
            self._length += len(text)
            if self._length - self._dropped > MAX_LOG_CHARS:
                self._trim()
        if self.log_path is not None:
            with contextlib.suppress(OSError), self.log_path.open("a", encoding="utf-8") as fh:
                fh.write(text)

    def _trim(self) -> None:
        # Keep the newest half; offsets stay absolute and the full log is on disk.
        kept = "".join(self._chunks)
        cut = len(kept) - MAX_LOG_CHARS // 2
        self._chunks = [kept[cut:]]
        self._dropped += cut

    def read_log(self, since: int) -> tuple[str, int]:
        """Text appended at or after absolute offset ``since``, and the next offset."""
        with self._lock:
            kept = "".join(self._chunks)
            if since < self._dropped:
                return "[... earlier output dropped; the full log is in build/jobs ...]\n" + kept, self._length
            return kept[since - self._dropped:], self._length

    # ---- state ------------------------------------------------------------------ #

    @property
    def done(self) -> bool:
        return self.status in ("passed", "failed", "cancelled", "error")

    def to_json(self, since: int | None = None) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "project": self.project,
            "status": self.status,
            "step": self.steps[self.step_index].title if 0 <= self.step_index < len(self.steps) else None,
            "stepIndex": self.step_index,
            "steps": [s.title for s in self.steps],
            "created": self.created,
            "started": self.started,
            "ended": self.ended,
            "elapsed": ((self.ended or time.time()) - self.started) if self.started else 0.0,
            "result": self.result,
            "error": self.error,
        }
        if since is not None:
            text, nxt = self.read_log(since)
            out["log"] = text
            out["next"] = nxt
        return out


class BusyError(Exception):
    def __init__(self, job: Job) -> None:
        super().__init__(f"job {job.id} ({job.title}) is still running")
        self.job = job


class JobManager:
    def __init__(self, toolchain_getter: Callable[[], Toolchain]) -> None:
        self._toolchain = toolchain_getter
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._ids = itertools.count(1)
        self._prefix = f"{os.getpid():x}{int(time.time()) & 0xFFFF:04x}"

    def new_id(self) -> str:
        return f"{self._prefix}-{next(self._ids)}"

    def running(self) -> Job | None:
        with self._lock:
            for jid in reversed(self._order):
                job = self._jobs[jid]
                if not job.done:
                    return job
        return None

    def submit(self, job: Job) -> Job:
        with self._lock:
            for jid in self._order:
                if not self._jobs[jid].done:
                    raise BusyError(self._jobs[jid])
            self._jobs[job.id] = job
            self._order.append(job.id)
            while len(self._order) > KEEP_JOBS:
                old = self._order.pop(0)
                self._jobs.pop(old, None)
        if job.log_path is not None:
            with contextlib.suppress(OSError):
                job.log_path.parent.mkdir(parents=True, exist_ok=True)
                job.log_path.write_text("", encoding="utf-8")
        threading.Thread(target=self._run, args=(job,), name=f"job-{job.id}", daemon=True).start()
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return [self._jobs[j] for j in self._order]

    def cancel(self, job_id: str) -> Job | None:
        job = self.get(job_id)
        if job is None or job.done:
            return job
        job._cancel.set()
        self._kill(job)
        return job

    def cancel_all(self) -> None:
        for job in self.list():
            if not job.done:
                self.cancel(job.id)

    # ---- worker ----------------------------------------------------------------- #

    def _kill(self, job: Job) -> None:
        if job._container:
            with contextlib.suppress(Exception):
                self._toolchain().kill(job._container)
        proc = job._proc
        if proc is not None and proc.poll() is None:
            with contextlib.suppress(OSError):
                if hasattr(os, "killpg"):
                    os.killpg(proc.pid, signal.SIGTERM)
                else:
                    proc.terminate()

    def _run(self, job: Job) -> None:
        job.status = "running"
        job.started = time.time()
        failed: str | None = None
        try:
            for i, step in enumerate(job.steps):
                if job._cancel.is_set():
                    break
                if failed and not (isinstance(step, HostStep) and step.always):
                    continue
                job.step_index = i
                job.log(f"\n━━ {step.title}\n")
                if isinstance(step, HostStep):
                    step.run(job)
                else:
                    code = self._run_command(job, step)
                    if job._cancel.is_set():
                        break
                    if step.ok_codes is not None and code not in step.ok_codes:
                        failed = f"{step.title} exited with code {code}"
                        job.log(f"\n✗ {failed}\n")
            if failed:
                job.status = "failed"
                job.error = failed
            elif job._cancel.is_set():
                job.status = "cancelled"
                job.log("\n■ cancelled\n")
            elif job.result.get("failed"):
                job.status = "failed"
            else:
                job.status = "passed"
        except JobFailed as exc:
            job.status = "failed"
            job.error = str(exc)
            job.log(f"\n✗ {exc}\n")
        except Exception as exc:  # noqa: BLE001
            job.status = "error"
            job.error = f"{type(exc).__name__}: {exc}"
            job.log(f"\n✗ internal error: {job.error}\n")
        finally:
            job.ended = time.time()
            job._proc = None

    def _run_command(self, job: Job, cmd: Command) -> int:
        tc = self._toolchain()
        if cmd.on_host:
            job._container = ""
            argv, env = list(cmd.argv), {**os.environ, **cmd.env}
        else:
            job._container = f"rtlp-{job.id}" if tc.mode == "docker" else ""
            argv, env = tc.wrap(cmd.argv, root=job.root, cwd=cmd.cwd, env=cmd.env, name=job._container or None)
        job.log("$ " + " ".join(_quote(a) for a in cmd.argv) + "\n")
        kwargs: dict[str, Any] = {}
        if hasattr(os, "setsid"):
            kwargs["start_new_session"] = True
        elif os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
        try:
            proc = subprocess.Popen(
                argv,
                cwd=str(cmd.cwd) if tc.mode == "native" or cmd.on_host else None,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                **kwargs,
            )
        except OSError as exc:
            job.log(f"cannot start {argv[0]}: {exc}\n")
            return 127
        job._proc = proc
        if job._cancel.is_set():
            self._kill(job)
        assert proc.stdout is not None
        for line in proc.stdout:
            job.log(line)
        return proc.wait()


def _quote(arg: str) -> str:
    if arg and all(c.isalnum() or c in "-_./=:,+@%" for c in arg):
        return arg
    return "'" + arg.replace("'", "'\\''") + "'"


__all__ = ["BusyError", "Command", "HostStep", "Job", "JobFailed", "JobManager", "Step"]
