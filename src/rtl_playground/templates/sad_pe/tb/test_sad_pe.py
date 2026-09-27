"""cocotb tests for sad_pe: directed cases plus random blocks checked against a Python model."""

import random

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ReadOnly, RisingEdge

BLOCK = 16 * 16


def sad_model(cur, ref):
    """Reference model: the sum of absolute differences of two pixel lists."""
    return sum(abs(c - r) for c, r in zip(cur, ref))


async def reset(dut):
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    dut.rst.value = 1
    dut.valid.value = 0
    dut.first.value = 0
    dut.cur_px.value = 0
    dut.ref_px.value = 0
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.rst.value = 0


async def stream_block(dut, cur, ref):
    """Drive one block of pixel pairs and return the SAD the PE computed."""
    for i, (c, r) in enumerate(zip(cur, ref)):
        dut.valid.value = 1
        dut.first.value = int(i == 0)
        dut.cur_px.value = c
        dut.ref_px.value = r
        await RisingEdge(dut.clk)
    dut.valid.value = 0
    await ReadOnly()
    got = int(dut.sad.value)
    await RisingEdge(dut.clk)
    return got


@cocotb.test()
async def identical_blocks_give_zero(dut):
    await reset(dut)
    block = [random.randrange(256) for _ in range(BLOCK)]
    assert await stream_block(dut, block, block) == 0


@cocotb.test()
async def worst_case_fits(dut):
    await reset(dut)
    got = await stream_block(dut, [255] * BLOCK, [0] * BLOCK)
    assert got == 255 * BLOCK, f"expected {255 * BLOCK}, got {got}"


@cocotb.test()
async def random_blocks_match_model(dut):
    await reset(dut)
    rng = random.Random(852)
    for n in range(20):
        cur = [rng.randrange(256) for _ in range(BLOCK)]
        ref = [rng.randrange(256) for _ in range(BLOCK)]
        got = await stream_block(dut, cur, ref)
        assert got == sad_model(cur, ref), f"block {n}: expected {sad_model(cur, ref)}, got {got}"
