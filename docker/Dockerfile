# RTL Playground tool image: everything the Project view runs (DESIGN.md section 13).
#   OpenROAD-flow-scripts (Yosys, OpenROAD/OpenSTA, KLayout, and the asap7, sky130,
#   nangate45, gf180 and ihp-sg13g2 platforms), Verilator 5 and cocotb.
# Verilated testbenches compile at run time, so the runtime stage needs the zlib and lz4 headers (FST waves).
# Build:  docker build -t ghcr.io/mrg327/rtl-playground-tools:2026.09 docker/
# The tag is TOOLS_IMAGE_TAG in src/rtl_playground/toolchain.py; bump both together.

ARG ORFS_IMAGE=openroad/orfs:26Q3-657-gb74a7293e

FROM ${ORFS_IMAGE} AS verilator
ARG VERILATOR_TAG=v5.052
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git autoconf flex bison help2man perl python3 g++ make libfl-dev zlib1g-dev liblz4-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${VERILATOR_TAG} https://github.com/verilator/verilator /src/verilator \
 && cd /src/verilator && autoconf && ./configure --prefix=/opt/verilator \
 && make -j"$(nproc)" && make install && rm -rf /src/verilator

FROM ${ORFS_IMAGE}
ARG COCOTB_VERSION=2.1.0
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      g++ make python3 python3-venv python3-pip libfl2 zlib1g-dev liblz4-dev \
 && rm -rf /var/lib/apt/lists/*
COPY --from=verilator /opt/verilator /opt/verilator
RUN python3 -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir "cocotb==${COCOTB_VERSION}"
COPY entrypoint.sh /usr/local/bin/rtlp-entrypoint
RUN chmod 755 /usr/local/bin/rtlp-entrypoint \
 && chmod -R a+rX /OpenROAD-flow-scripts \
 && /usr/local/bin/rtlp-entrypoint sh -c 'verilator --version && yosys -V && openroad -version && python3 -c "import cocotb; print(\"cocotb\", cocotb.__version__)"'
ENV FLOW_HOME=/OpenROAD-flow-scripts/flow \
    PATH=/opt/verilator/bin:/opt/py/bin:$PATH \
    HOME=/tmp
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/rtlp-entrypoint"]
CMD ["bash"]
