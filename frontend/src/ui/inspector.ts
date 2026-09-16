import { defOf, type ParamDef, num } from '../model/library';
import { fmt, toBig } from '../model/values';
import type { Store } from './store';
import type { Block } from '../model/types';

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export function renderInspector(el: HTMLElement, store: Store, actions: { del(): void; rotate(): void; flip(): void }): void {
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
  for (const p of d.params) h += paramField(p, b, locked);
  if (d.help) h += `<p>${esc(d.help)}</p>`;
  const st = store.sim.frame.states.get(b.id) as { q?: bigint } | undefined;
  if (st && typeof st.q === 'bigint') h += `<p class="mono">Q = ${st.q} · ${fmt(st.q, num(b.params, 'width', num(b.params, 'len', 1)), 'hex')}h</p>`;
  h += `<label class="chk"><input type="checkbox" data-k="__trace" ${b.trace ? 'checked' : ''}> Show in waveform</label>`;
  h += `<div class="row"><button class="rot" title="R">Rotate</button><button class="flip" title="F">Flip</button><button class="del" ${locked ? 'disabled' : ''}>Delete</button></div>`;
  el.innerHTML = h;
  el.querySelector<HTMLButtonElement>('.del')!.onclick = actions.del; el.querySelector<HTMLButtonElement>('.rot')!.onclick = actions.rotate; el.querySelector<HTMLButtonElement>('.flip')!.onclick = actions.flip;
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

function coerce(p: ParamDef, raw: unknown, b: Block): unknown {
  switch (p.kind) {
    case 'int': { let n = parseInt(String(raw), 10); if (!Number.isFinite(n)) n = Number(p.default); return Math.max(p.min ?? 0, Math.min(p.max ?? 64, n)); }
    case 'bool': return !!raw;
    case 'value': { const w = typeof p.widthOf === 'number' ? p.widthOf : num(b.params, String(p.widthOf), 1); const v = toBig(raw, w); return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString(); }
    default: return String(raw);
  }
}
