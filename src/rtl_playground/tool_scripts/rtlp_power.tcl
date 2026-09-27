# Report power for the finished flow's final placed-and-routed design, with
# switching activity taken from a cocotb+Verilator VCD instead of ORFS's
# default guess (DESIGN.md section 13, "power from simulation activity").
#
# Run by `make run RUN_SCRIPT=<this file>` (see flow.tcl/Makefile "run" and
# scripts/open.tcl, which load a design the same way for the GUI), so every
# variable ORFS exports for the platform and the design (SCRIPTS_DIR,
# RESULTS_DIR, TECH_LEF, SC_LEF, ...) is already in the environment.
# The power job (flows.py) additionally sets:
#   RTLP_VCD        the VCD cocotb/Verilator wrote for the chosen test
#   RTLP_VCD_SCOPE  the VCD scope holding the design's ports, usually just
#                   the toplevel module name: cocotb's Verilator runner nests
#                   the DUT one level under an internal "$rootio" VPI shim,
#                   but OpenSTA's scope search finds "<toplevel>" inside it.
#
# Output is plain markers around report_activity_annotation's summary and
# report_power's JSON, both already on stdout; jobs.py's power_steps HostStep
# parses them back out of the job log rather than a side file.

source $::env(SCRIPTS_DIR)/util.tcl
source_env_var_if_exists PLATFORM_TCL
source $::env(SCRIPTS_DIR)/read_liberty.tcl

log_cmd read_lef $::env(TECH_LEF)
log_cmd read_lef $::env(SC_LEF)
if { [env_var_exists_and_non_empty ADDITIONAL_LEFS] } {
  foreach lef $::env(ADDITIONAL_LEFS) {
    log_cmd read_lef $lef
  }
}

log_cmd read_db {*}[hier_options] $::env(RESULTS_DIR)/6_final.odb
log_cmd read_sdc $::env(RESULTS_DIR)/6_final.sdc
log_cmd read_spef $::env(RESULTS_DIR)/6_final.spef
# CTS has run on the final design, so use its real clock tree instead of ideal clocks.
set_propagated_clock [all_clocks]

log_cmd read_vcd -scope $::env(RTLP_VCD_SCOPE) $::env(RTLP_VCD)

puts "RTLP-ANNOTATION-BEGIN"
report_activity_annotation
puts "RTLP-ANNOTATION-END"

puts "RTLP-POWER-JSON-BEGIN"
report_power -format json
puts "RTLP-POWER-JSON-END"
