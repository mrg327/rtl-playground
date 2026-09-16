"""Command-line entry point for the RTL Playground host."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from rtl_playground import __version__


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rtl-playground",
        description="Start the RTL Playground local host and open it in a browser.",
    )
    parser.add_argument(
        "file",
        nargs="?",
        help="a .rtlp design to open (must live under the served directory)",
    )
    parser.add_argument(
        "--dir",
        dest="directory",
        default=None,
        help="directory to serve and save designs in (default: current directory, "
        "or the folder of FILE when given)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="TCP port on 127.0.0.1 (default: a free port chosen by the OS)",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="do not open a browser; just print the URL",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    open_file: str | None = None
    if args.directory is not None:
        root = Path(args.directory).expanduser().resolve()
    elif args.file is not None:
        root = Path(args.file).expanduser().resolve().parent
    else:
        root = Path.cwd().resolve()

    if not root.is_dir():
        print(f"rtl-playground: not a directory: {root}", file=sys.stderr)
        return 2

    if args.file is not None:
        file_path = Path(args.file).expanduser().resolve()
        try:
            open_file = file_path.relative_to(root).as_posix()
        except ValueError:
            print(
                f"rtl-playground: {file_path} is not inside the served directory {root}",
                file=sys.stderr,
            )
            return 2
        if not file_path.is_file():
            print(f"rtl-playground: file not found: {file_path}", file=sys.stderr)
            return 2

    if args.port < 0 or args.port > 65535:
        print("rtl-playground: --port must be between 0 and 65535", file=sys.stderr)
        return 2

    from rtl_playground.server import serve

    return serve(
        root=root,
        port=args.port,
        open_browser=not args.no_browser,
        open_file=open_file,
        debug=bool(os.environ.get("RTLP_DEBUG")),
    )


if __name__ == "__main__":
    raise SystemExit(main())
