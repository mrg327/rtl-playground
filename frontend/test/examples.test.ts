import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deserialize } from '../src/model/serialize';
import { Simulator } from '../src/sim/engine';
import { runAll } from '../src/sim/tests';
import { setActiveDesign } from '../src/model/library';
import { flattenModule } from '../src/model/hierarchy';
const dir = resolve(__dirname, '../../examples');
describe('examples', () => {
  for (const f of readdirSync(dir).filter(f => f.endsWith('.rtlp'))) it(f, () => {
    const d = deserialize(readFileSync(resolve(dir, f), 'utf8'));
    setActiveDesign(d);
    // Flatten before simulating (DESIGN.md section 6): a hierarchical example's `top` isn't directly
    // simulatable, exactly as in the app and in gen-examples.ts.
    const { module, problems } = flattenModule(d, d.top);
    const sim = new Simulator(module, problems);
    expect(sim.compiled.problems.filter(p => p.level === 'error')).toEqual([]); expect(d.tests.length).toBeGreaterThan(0);
    for (const r of runAll(d)) expect(r.passed, `${r.name}: ${JSON.stringify(r.rows.filter(x => !x.ok))}`).toBe(true);
  });
});
