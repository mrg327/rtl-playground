import { describe, it, expect } from 'vitest';
import { toBig, trunc, fmt, parseList, signed } from '../src/model/values';
describe('values', () => {
  it('parses numbers and literals', () => {
    expect(toBig(5, 8)).toBe(5n); expect(toBig('255', 8)).toBe(255n); expect(toBig('256', 8)).toBe(0n);
    expect(toBig("8'hFF", 8)).toBe(255n); expect(toBig("4'b1010", 8)).toBe(10n); expect(toBig("'d7", 8)).toBe(7n); expect(toBig("8'o17", 8)).toBe(15n);
    expect(toBig('-1', 4)).toBe(15n); expect(toBig('junk', 4)).toBe(0n); expect(toBig(true)).toBe(1n); expect(toBig('1_000', 16)).toBe(1000n);
  });
  it('formats', () => { expect(fmt(10n, 4, 'bin')).toBe('1010'); expect(fmt(255n, 8, 'hex')).toBe('FF'); expect(fmt(15n, 4, 'sdec')).toBe('-1'); expect(fmt(65n, 8, 'ascii')).toBe("'A'"); expect(signed(8n, 4)).toBe(-8n); expect(trunc(0x1ffn, 8)).toBe(255n); });
  it('parses lists', () => { expect(parseList('0110', 1)).toEqual([0n, 1n, 1n, 0n]); expect(parseList('1, 2 3;4', 4)).toEqual([1n, 2n, 3n, 4n]); expect(parseList('', 4)).toEqual([]); expect(parseList('17', 4)).toEqual([1n]); });
});
