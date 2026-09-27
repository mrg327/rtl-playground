import { defOf, type ParamDef, num } from '../model/library';
import { fmt, toBig } from '../model/values';
import type { Store } from './store';
import type { Block } from '../model/types';
import { memoryInfo, memoryRows } from './memview';

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export function renderInspector(el: HTMLElement, store: Store, actions: { del(): void; rotate(): void; flip(): void; loadMemFile?(id: string): void }): void {
  const m = store.module; const sel = store.sel;
  const blocks = m.blocks.filter(b => sel.blocks.has(b.id));
  if (blocks.length === 0 && sel.wires.size === 0 && sel.notes.size === 0) { el.innerHTML = `<p>Nothing selected. Click a block to inspect it, drag on empty space to select several.</p>`; return; }
  if (blocks.length === 0 && sel.wires.size > 0) {
    const w = m.wires.find(x => sel.wires.has(x.id)); const net = w ? store.sim.compiled.netlist.byPin.get(`${w.from.b}.${w.from.p}`) : null;
    el.innerHTML = `<h3>${sel.wires.size === 1 ? 'Wire' : `${sel.wires.size} wires`}</h3>${net ? `<p>Net <span class="mono">${esc(net.name)}</span>, ${net.width} bit${net.width > 1 ? 's' : ''}, ${net.loads.length} load${net.loads.length === 1 ? '' : 's'}.</p>` : ''}<p>Drag the middle segment to move it. Drag the input end to reconnect. <kbd>Delete</kbd> removes it.</p><div class="row"><button class="del">Delete</button></div>`;
    el.querySelector<HTMLButtonElement>('.del')!.onclick = actions.del; return;
  }
  if (blocks.length === 0 && sel.notes.size > 0) { el.innerHTML = `<h3>Note</h3><p>Double-click to edit the text. Drag the corner to resize.</p><div class="row"><button class="del">Delete</button></div>`; el.querySelector<HTMLButtonElement>('.del')!.onclick = actions.del; return; }
  if (blocks.length > 1) {
    el.innerHTML = `<h3>${blocks.length} blocks selected</h3><p>${blocks.map(b => b.id).join(', ')}</p><div class="row"><button class="rot">Rotate</button><button class="flip">Flip</button><button class="del">Delete</button></div>`;
    el.querySelector<HTMLButtonElement>('.del')!.onclick = actions.del; el.querySelector<HTMLButtonElement>('.rot')!.onclick = actions.rotate; el.querySelector<HTMLButtonElement>('.flip')!.onclick = actions.flip; return;
  }
  const b = blocks[0]; const d = defOf(b.type); const locked = m.locked.includes(b.id);
  let h = `<h3>${d.name} <span class="mono" style="color:var(--ink2);font-weight:400">${esc(b.id)}</span></h3>`;
  if (locked) h += `<p>🔒 This block is part of the exercise and cannot be edited.</p>`;
  h += `<label>Label</label><input type="text" data-k="__label" value="${esc(b.label ?? '')}" placeholder="e.g. Start" ${locked ? 'disabled' : ''}>`;
  if (b.type === 'instance') {
    // The available-modules dropdown (DESIGN.md task 3): the block library has no notion of "the current
    // design", so this one param is rendered here instead of through the generic paramField() below.
    const keys = Object.keys(store.design.modules);
    const cur = String(b.params.module ?? '');
    h += `<label>Module</label><select data-k="module" ${locked ? 'disabled' : ''}><option value="" ${cur ? '' : 'selected'}>(choose a module)</option>${keys.map(k => `<option value="${esc(k)}" ${k === cur ? 'selected' : ''}>${esc(k)}${k === store.viewModule ? ' (this sheet)' : ''}</option>`).join('')}</select>`;
    for (const p of d.params) if (p.key !== 'module') h += paramField(p, b, locked);
  } else for (const p of d.params) h += paramField(p, b, locked);
  if (d.help) h += `<p>${esc(d.help)}</p>`;
  const simId = store.hierBlock(b.id); // null on a sheet that is not being simulated
  const st = (simId === null ? undefined : store.sim.frame.states.get(simId)) as { q?: bigint } | undefined;
  if (st && typeof st.q === 'bigint') h += `<p class="mono">Q = ${st.q} · ${fmt(st.q, num(b.params, 'width', num(b.params, 'len', 1)), 'hex')}h</p>`;
  const memInfo = memoryInfo(b);
  if (memInfo && !locked && actions.loadMemFile) h += `<div class="row"><button class="loadmem">Load .mem file…</button></div>`;
  if (memInfo) h += renderMemoryTable(store, b, memInfo);
  h += `<label class="chk"><input type="checkbox" data-k="__trace" ${b.trace ? 'checked' : ''}> Show in waveform</label>`;
  h += `<div class="row"><button class="rot" title="R">Rotate</button><button class="flip" title="F">Flip</button><button class="del" ${locked ? 'disabled' : ''}>Delete</button></div>`;
  el.innerHTML = h;
  el.querySelector<HTMLButtonElement>('.del')!.onclick = actions.del; el.querySelector<HTMLButtonElement>('.rot')!.onclick = actions.rotate; el.querySelector<HTMLButtonElement>('.flip')!.onclick = actions.flip;
  el.querySelector<HTMLButtonElement>('.loadmem')?.addEventListener('click', () => actions.loadMemFile!(b.id));
  for (const input of el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]')) {
    const k = input.dataset.k!;
    const apply = (undoable: boolean) => {
      const raw = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value;
      const set = () => {
        if (k === '__label') b.label = String(raw) || undefined;
        else if (k === '__trace') b.trace = !!raw;
        else { const pd = d.params.find(p => p.key === k)!; b.params[k] = coerce(pd, raw, b); }
      };
      if (!undoable) store.stimulus(set); else store.mutate('Edit ' + k, set);
    };
    const isStimulus = b.type === 'in' && k === 'value';
    if (input instanceof HTMLInputElement && (input.type === 'text' || input.type === 'number')) {
      input.addEventListener('input', () => { if (isStimulus) apply(false); });
      input.addEventListener('change', () => { if (!isStimulus) apply(true); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    } else input.addEventListener('change', () => apply(true));
  }
}

function paramField(p: ParamDef, b: Block, locked: boolean): string {
  const v = b.params[p.key]; const dis = locked ? 'disabled' : '';
  switch (p.kind) {
    case 'int': return `<label>${p.label}</label><input type="number" data-k="${p.key}" value="${num(b.params, p.key, Number(p.default))}" min="${p.min ?? 0}" max="${p.max ?? 64}" ${dis}>`;
    case 'bool': return `<label class="chk"><input type="checkbox" data-k="${p.key}" ${v ? 'checked' : ''} ${dis}> ${p.label}</label>`;
    case 'enum': return `<label>${p.label}</label><select data-k="${p.key}" ${dis}>${(p.options ?? []).map(o => `<option value="${o.value}" ${String(v) === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`;
    case 'value': { const w = typeof p.widthOf === 'number' ? p.widthOf : num(b.params, String(p.widthOf), 1); const bv = toBig(v, w);
      return `<label>${p.label} (0 to ${(1n << BigInt(w)) - 1n})</label><input type="text" data-k="${p.key}" value="${esc(String(v ?? 0))}" ${dis}><p class="mono">bin ${fmt(bv, w, 'bin')} · hex ${fmt(bv, w, 'hex')}${w > 1 ? ` · signed ${fmt(bv, w, 'sdec')}` : ''}</p>`; }
    default: return `<label>${p.label}${p.help ? ` <span title="${esc(p.help)}">ⓘ</span>` : ''}</label><input type="text" data-k="${p.key}" value="${esc(String(v ?? ''))}" ${dis}>`;
  }
}

/** Hex table of a RAM/ROM/register-file block's contents (DESIGN.md section 4), following the time-travel
 * cursor: the address read this cycle and the address written getting here are highlighted. Read-only; to
 * change initial contents, edit the "Contents" field above (or load a .mem file) and Power-on, the same way
 * editing a register's reset value only takes effect on the next power-on. */
function renderMemoryTable(store: Store, b: Block, info: { width: number; depth: number }): string {
  const notSimulating = store.sim.frames.length === 1;
  return `<h3>Memory contents</h3><p class="mono">${info.depth} × ${info.width}-bit${notSimulating ? ' · edit "Contents" above, then Power-on to load it' : ''}</p><div class="memtable">${memoryTableRows(store, b, info)}</div>`;
}
function memoryTableRows(store: Store, b: Block, info: { width: number; depth: number }): string {
  const simId = store.hierBlock(b.id);
  if (simId === null) return `<p class="mono">This sheet is not being simulated; open it through an instance to see its contents.</p>`;
  const rows = memoryRows(store.sim, b, simId);
  if (!rows) return '';
  const addrDigits = memAddrHexDigits(info.depth);
  return `<table>${rows.map(r => `<tr class="${r.read ? 'memread' : ''}${r.write ? ' memwrite' : ''}"><td>${r.addr.toString(16).padStart(addrDigits, '0')}</td><td>${fmt(r.value, info.width, 'hex')}</td></tr>`).join('')}</table>`;
}
function memAddrHexDigits(depth: number): number { return Math.max(1, Math.ceil(Math.log2(Math.max(2, depth)) / 4)); }

/** Cheap counterpart to renderInspector for plain simulation events ('sim': a clock edge, a cursor scrub, a
 * run tick) — rebuilding the whole inspector every tick would be wasteful (and, at up to ~30 Hz during "Run",
 * visibly slow for a large memory's table), so app.ts calls this instead. It only patches the memory table's
 * rows in place when a single ram/rom/regfile block is selected and the inspector is already showing it;
 * everything else in the inspector (params, the Q= line, buttons) does not depend on the live cursor. */
export function refreshMemoryTable(el: HTMLElement, store: Store): void {
  const table = el.querySelector<HTMLElement>('.memtable');
  if (!table) return;
  const sel = store.sel; if (sel.blocks.size !== 1) return;
  const b = store.module.blocks.find(x => sel.blocks.has(x.id)); if (!b) return;
  const info = memoryInfo(b); if (!info) return;
  table.innerHTML = memoryTableRows(store, b, info);
}

function coerce(p: ParamDef, raw: unknown, b: Block): unknown {
  switch (p.kind) {
    case 'int': { let n = parseInt(String(raw), 10); if (!Number.isFinite(n)) n = Number(p.default); return Math.max(p.min ?? 0, Math.min(p.max ?? 64, n)); }
    case 'bool': return !!raw;
    case 'value': { const w = typeof p.widthOf === 'number' ? p.widthOf : num(b.params, String(p.widthOf), 1); const v = toBig(raw, w); return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString(); }
    default: return String(raw);
  }
}
