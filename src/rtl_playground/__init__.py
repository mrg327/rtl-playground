"""RTL Playground: an educational digital-design tool.

The Python side is a small, stdlib-only local host that serves the built
front end and exposes a sandboxed file API plus optional Yosys endpoints.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version as _dist_version

try:
    __version__ = _dist_version("rtl-playground")
except PackageNotFoundError:  # running from a source checkout without install
    __version__ = "0.1.0a1+unknown"

__all__ = ["__version__"]
