"""Allow ``python -m rtl_playground`` / ``uv run -m rtl_playground``."""

from rtl_playground.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
