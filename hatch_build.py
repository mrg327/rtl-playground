"""Hatchling build hook: build the Vite front end into the wheel when needed.

The wheel must contain ``src/rtl_playground/static/index.html``. CI builds the
front end explicitly before ``uv build``; this hook only kicks in when the
static folder is missing (or ``RTL_FORCE_JS_BUILD`` is set), for example when
someone installs from a git URL.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class JsBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:  # noqa: ARG002
        if version == "editable":
            # `uv run` / `pip install -e .` in a checkout: never block on the front end.
            # The host serves a "front end not built" page until `npm run build` runs.
            self.app.display_info("editable install: skipping front end build")
            return
        root = Path(self.root)
        static_index = root / "src" / "rtl_playground" / "static" / "index.html"
        force = bool(os.environ.get("RTL_FORCE_JS_BUILD"))
        if static_index.is_file() and not force:
            self.app.display_info(f"front end already built: {static_index}")
            return

        frontend = root / "frontend"
        if not (frontend / "package.json").is_file():
            self._fail(
                "src/rtl_playground/static/index.html is missing and frontend/package.json "
                "was not found, so the front end cannot be built from this tree. "
                "Install a published wheel instead, or build from a full checkout."
            )

        npm = shutil.which("npm")
        if npm is None:
            self._fail(
                "src/rtl_playground/static/index.html is missing and npm is not on PATH. "
                "Install Node.js 22 and rerun, or install a published wheel."
            )

        lockfile = frontend / "package-lock.json"
        if not lockfile.is_file():
            self._fail(
                "src/rtl_playground/static/index.html is missing and frontend/package-lock.json "
                "does not exist, so `npm ci` cannot run. Run `npm install` in frontend/ once "
                "to create the lockfile (then `npm run build`), or install a published wheel."
            )

        self.app.display_info("building front end: npm ci && npm run build (in frontend/)")
        for cmd in (["ci"], ["run", "build"]):
            result = subprocess.run([npm, *cmd], cwd=frontend)
            if result.returncode != 0:
                self._fail(
                    f"`npm {' '.join(cmd)}` failed with exit code {result.returncode} in {frontend}. "
                    "Fix the front end build or install a published wheel."
                )

        if not static_index.is_file():
            self._fail(
                f"the front end build finished but {static_index} still does not exist. "
                "Check that frontend/vite.config.ts builds into src/rtl_playground/static/."
            )

    def _fail(self, message: str) -> None:
        # SystemExit with a string prints it to stderr and exits with status 1.
        raise SystemExit(f"\nrtl-playground build hook: {message}\n")
