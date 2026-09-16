import { LIB, GROUPS } from '../model/library';

export function renderPalette(el: HTMLElement, onAdd: (type: string) => void): void {
  el.innerHTML = `<input type="text" placeholder="Search blocks… (/)" class="q"><div class="items"></div>`;
  const q = el.querySelector<HTMLInputElement>('.q')!, items = el.querySelector<HTMLElement>('.items')!;
  const draw = () => {
    const f = q.value.trim().toLowerCase(); let h = '';
    for (const g of GROUPS) {
      const defs = Object.values(LIB).filter(d => d.group === g && (!f || d.name.toLowerCase().includes(f) || d.type.includes(f)));
      if (!defs.length) continue;
      h += `<div class="grp">${g}</div>`;
      for (const d of defs) h += `<button data-t="${d.type}" title="${(d.help ?? '').replace(/"/g, '&quot;')}"><span>${d.name}</span><small>${d.kind === 'seq' && d.next ? 'clk' : d.type}</small></button>`;
    }
    items.innerHTML = h;
  };
  draw();
  q.oninput = draw;
  q.onkeydown = e => { if (e.key === 'Enter') { const b = items.querySelector<HTMLButtonElement>('button'); if (b) { onAdd(b.dataset.t!); } } if (e.key === 'Escape') { q.value = ''; draw(); q.blur(); } };
  items.onclick = e => { const b = (e.target as HTMLElement).closest('button'); if (b) onAdd(b.dataset.t!); };
  document.addEventListener('keydown', e => { if (e.key === '/' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); q.focus(); q.select(); } });
}
