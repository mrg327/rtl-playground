import { describe, it, expect } from 'vitest';
import { parseReadMemH, memFileToContents } from '../src/model/memfile';
import { parseList } from '../src/model/values';

describe('memfile', () => {
  it('parses $readmemh text: whitespace, comments, @address jumps, underscores', () => {
    const text = `
      // header comment
      00 01 02 /* inline */ 03
      @10
      ff_ee dd
    `;
    expect(parseReadMemH(text)).toEqual([
      { addr: 0, hex: '00' }, { addr: 1, hex: '01' }, { addr: 2, hex: '02' }, { addr: 3, hex: '03' },
      { addr: 16, hex: 'ffee' }, { addr: 17, hex: 'dd' },
    ]);
  });
  it('turns a .mem file into a contents param that parseList reads back as the same values', () => {
    const contents = memFileToContents('a5 00 1F', 4);
    expect(contents).toBe('0xa5 0x00 0x1F 0');
    expect(parseList(contents, 8)).toEqual([0xa5n, 0x00n, 0x1fn, 0n]);
  });
  it('drops addresses beyond depth and fills untouched ones with 0', () => {
    const contents = memFileToContents('@2 aa bb cc', 3);
    expect(parseList(contents, 8)).toEqual([0n, 0n, 0xaan]); // bb (addr 3) and cc (addr 4) are out of range
  });
});
