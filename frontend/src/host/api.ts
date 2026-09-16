// Client for the local Python host. Falls back gracefully when running without it (dev server or file://).

export interface HostInfo { version: string; root: string; hdl: boolean; python: string }
export interface Entry { name: string; type: 'file' | 'dir'; size: number; mtime: number }

function tokenFromHash(): string | null { const m = /token=([0-9a-f]+)/.exec(location.hash); return m ? m[1] : null; }
export function openFromHash(): string | null { const m = /open=([^&]+)/.exec(location.hash); return m ? decodeURIComponent(m[1]) : null; }

export class Host {
  token = tokenFromHash();
  info: HostInfo | null = null;
  get available(): boolean { return this.info !== null; }

  async connect(): Promise<boolean> {
    try { const r = await fetch('/api/version', { headers: this.headers() }); if (!r.ok) return false; this.info = await r.json(); return true; } catch { return false; }
  }
  private headers(): Record<string, string> { return this.token ? { 'X-RTLP-Token': this.token } : {}; }
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(path, { method, headers: { ...this.headers(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `${method} ${path} failed (${r.status})`), { status: r.status, data });
    return data as T;
  }
  list(dir = ''): Promise<{ dir: string; entries: Entry[] }> { return this.call('GET', `/api/files?dir=${encodeURIComponent(dir)}`); }
  read(path: string): Promise<{ path: string; text: string; mtime: number }> { return this.call('GET', `/api/file?path=${encodeURIComponent(path)}`); }
  write(path: string, text: string, ifMtime?: number | null): Promise<{ ok: boolean; mtime: number }> { return this.call('PUT', `/api/file?path=${encodeURIComponent(path)}`, ifMtime != null ? { text, ifMtime } : { text }); }
  remove(path: string): Promise<{ ok: boolean }> { return this.call('DELETE', `/api/file?path=${encodeURIComponent(path)}`); }
}

export function download(name: string, text: string, type = 'application/json'): void {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export function upload(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = async () => { const f = i.files?.[0]; res(f ? { name: f.name, text: await f.text() } : null); }; i.click(); });
}
