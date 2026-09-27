// Parses Verilog $readmemh-format `.mem` files into the space-separated hex value list used by the memory
// blocks' `contents` param (DESIGN.md section 4). Loaded through the host file API (src/host/api.ts); see
// App.loadMemFile in src/ui/app.ts.

/** Strip `//` line comments and `/* ... *‍/` block comments, as $readmemh allows. */
function stripComments(text: string): string {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Tokenize into (address, hex-digits) pairs, honouring `@hexaddr` jumps (address defaults to sequential). */
export function parseReadMemH(text: string): { addr: number; hex: string }[] {
  const tokens = stripComments(text).trim().split(/\s+/).filter(Boolean);
  const out: { addr: number; hex: string }[] = [];
  let addr = 0;
  for (const t of tokens) {
    if (t.startsWith('@')) { addr = parseInt(t.slice(1), 16) || 0; continue; }
    const hex = t.replace(/_/g, '');
    if (hex) { out.push({ addr, hex }); addr++; }
  }
  return out;
}

/** `.mem` file text -> a memory block's `contents` param text. Values at addresses >= depth are dropped;
 * addresses never written (before the first entry, or skipped by an `@addr` jump) stay "0". Each value is
 * emitted as a `0x`-prefixed token so `parseList`/`toBig` (src/model/values.ts) parse it as hexadecimal,
 * matching $readmemh's own radix, without needing a width-prefixed `N'h..` literal. */
export function memFileToContents(text: string, depth: number): string {
  const words = new Array<string>(depth).fill('0');
  for (const { addr, hex } of parseReadMemH(text)) if (addr < depth) words[addr] = '0x' + hex;
  return words.join(' ');
}
