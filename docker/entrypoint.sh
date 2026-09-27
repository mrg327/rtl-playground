#!/bin/bash
# Put the ORFS-built tools (openroad, yosys, klayout) on PATH, then run the command.
if [ -f /OpenROAD-flow-scripts/env.sh ]; then
  # env.sh prints its settings; keep job logs clean.
  source /OpenROAD-flow-scripts/env.sh >/dev/null 2>&1 || true
fi
export PATH=/opt/verilator/bin:/opt/py/bin:$PATH
exec "$@"
