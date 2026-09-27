// One processing element of a full-search block matcher.
//
// Streams pixel pairs (current block, candidate block from the search window)
// and accumulates the sum of absolute differences (SAD). A 16x16 block is 256
// pairs, so the worst-case SAD is 256 * 255 = 65280, which fits in 16 bits.
// A motion estimator instantiates many of these in parallel, one per candidate
// displacement, and keeps the smallest SAD.
module sad_pe #(
  parameter int PIX_W = 8,
  parameter int ACC_W = 16
) (
  input  logic             clk,
  input  logic             rst,     // synchronous, active high
  input  logic             valid,   // cur_px / ref_px hold a pixel pair this cycle
  input  logic             first,   // this pair is the first of a new block
  input  logic [PIX_W-1:0] cur_px,
  input  logic [PIX_W-1:0] ref_px,
  output logic [ACC_W-1:0] sad
);
  logic [PIX_W-1:0] diff;

  always_comb diff = (cur_px > ref_px) ? cur_px - ref_px : ref_px - cur_px;

  always_ff @(posedge clk) begin
    if (rst) sad <= '0;
    else if (valid) sad <= (first ? '0 : sad) + ACC_W'(diff);
  end
endmodule
