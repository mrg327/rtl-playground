// Unsigned integer values of arbitrary width as bigint.

export const mask = (w: number): bigint => (1n << BigInt(w)) - 1n;
export const trunc = (v: bigint, w: number): bigint => v & mask(w);
export const bit = (v: bigint, i: number): bigint => (v >> BigInt(i)) & 1n;
export const signed = (v: bigint, w: number): bigint => (bit(v, w - 1) ? v - (1n << BigInt(w)) : v);
export const maxVal = (w: number): bigint => mask(w);

export function toBig(v: unknown, w = 64): bigint {
  if (typeof v === 'bigint') return trunc(v, w);
  if (typeof v === 'number') return trunc(BigInt(Math.trunc(v)), w);
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (typeof v === 'string') {
    const s = v.trim().replace(/_/g, '');
    if (!s) return 0n;
    try {
      const m = /^(\d+)?'([bBhHdDoO])(.+)$/.exec(s);
      if (m) {
        const r = m[2].toLowerCase();
        const p = r === 'b' ? '0b' : r === 'h' ? '0x' : r === 'o' ? '0o' : '';
        const val = BigInt(p + m[3]);
        const width = m[1] ? parseInt(m[1], 10) : w;
        return trunc(val, Math.min(width, w));
      }
      if (/^-\d+$/.test(s)) return trunc(BigInt(s), w);
      return trunc(BigInt(s), w);
    } catch { return 0n; }
  }
  return 0n;
}

export function fmt(v: bigint, w: number, radix: 'bin' | 'hex' | 'dec' | 'sdec' | 'ascii' = 'dec'): string {
  switch (radix) {
    case 'bin': return v.toString(2).padStart(w, '0');
    case 'hex': return v.toString(16).toUpperCase().padStart(Math.ceil(w / 4), '0');
    case 'sdec': return signed(v, w).toString();
    case 'ascii': { const c = Number(v & 0xffn); return c >= 32 && c < 127 ? `'${String.fromCharCode(c)}'` : v.toString(); }
    default: return v.toString();
  }
}

/** Serialise a bigint for JSON: numbers when safe, strings otherwise. */
export const bigToJson = (v: bigint): number | string => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());

export function parseList(text: string, w: number): bigint[] {
  const t = text.trim();
  if (!t) return [];
  if (w === 1 && /^[01\s]+$/.test(t)) return t.replace(/\s/g, '').split('').map(c => BigInt(c));
  return t.split(/[\s,;]+/).filter(Boolean).map(x => toBig(x, w));
}
