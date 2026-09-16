// Canonical design model. Everything (rendering, simulation, HDL, tests) derives from this.
// Keep it plain JSON-serialisable (bigint values are stored as strings; see serialize.ts).

export type Dir = 'in' | 'out';
export type Side = 'l' | 'r' | 't' | 'b';
export type Rot = 0 | 90 | 180 | 270;

export interface PinRef { b: string; p: string }

export interface Block {
  id: string;
  type: string;
  params: Record<string, unknown>;
  x: number;
  y: number;
  label?: string;
  rot?: Rot;
  flip?: boolean;
  /** Included in the waveform by default. */
  trace?: boolean;
}

export interface Wire {
  id: string;
  from: PinRef; // output pin
  to: PinRef;   // input pin
  /** Optional horizontal position of the vertical segment, in world units. */
  mid?: number;
}

export interface Note { id: string; x: number; y: number; w: number; h: number; text: string }

export interface ModulePort { name: string; dir: Dir; width: number }

export interface Module {
  source: 'schematic' | 'fsm' | 'hdl';
  ports: ModulePort[];
  blocks: Block[];
  wires: Wire[];
  notes: Note[];
  locked: string[];
  text?: string; // hdl source
}

export interface TestRow { cells: string[] }
export interface Test {
  name: string;
  module: string;
  columns: string[];
  rows: string[][];
  hidden?: boolean;
}

export interface DesignOptions {
  resetStyle: 'sync_high';
  xUntilReset: boolean;
  clockName: string;
  resetName: string;
}

export interface Design {
  version: 2;
  name: string;
  top: string;
  options: DesignOptions;
  modules: Record<string, Module>;
  tests: Test[];
  views: { wave: { signals: string[]; radix: Record<string, Radix> } };
}

export type Radix = 'bin' | 'hex' | 'dec' | 'sdec' | 'ascii';

export interface Point { x: number; y: number }

export const emptyModule = (): Module => ({ source: 'schematic', ports: [], blocks: [], wires: [], notes: [], locked: [] });

export const emptyDesign = (name = 'untitled'): Design => ({
  version: 2,
  name,
  top: 'top',
  options: { resetStyle: 'sync_high', xUntilReset: false, clockName: 'clk', resetName: 'rst' },
  modules: { top: emptyModule() },
  tests: [],
  views: { wave: { signals: [], radix: {} } },
});
