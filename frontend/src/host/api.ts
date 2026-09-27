// Client for the local Python host. Falls back gracefully when running without it (dev server or file://).

export interface HostInfo { version: string; root: string; hdl: boolean; python: string }
export interface Entry { name: string; type: 'file' | 'dir'; size: number; mtime: number }

// ---- projects and tool jobs (DESIGN.md section 13) ----
export interface PlatformInfo { name: string; title: string; timeUnit: string; predictive: boolean; note: string }
export interface ToolsInfo { mode: 'native' | 'docker' | 'none'; available: boolean; reason: string; tools: Record<string, string>; image: string | null; engine: 'docker' | 'podman' | 'udocker' | null; imageReady: boolean; flowHome: string | null; platforms: PlatformInfo[]; stages: string[] }
export interface ProjectRef { path: string; name: string; top: string | null; problems: string[] }
export interface ProjectTest { name: string; module: string; toplevel: string; dir: string; parameters: Record<string, unknown>; waves: boolean }
export interface ProjectInfo {
  path: string; file: string; name: string; top: string; sources: string[]; tests: ProjectTest[];
  constraints: { clock: { port: string; periodNs: number; uncertaintyNs: number; holdUncertaintyNs: number }; inputDelayNs: number; outputDelayNs: number; sdc: string | null };
  flow: { platform: string; coreUtilization: number; placeDensity: number; extra: Record<string, string> };
  platform: PlatformInfo;
}
export type JobKind = 'lint' | 'test' | 'synth' | 'flow' | 'setup';
// ---- Surfer, the waveform viewer embedded in the Waves tab (DESIGN.md section 7) ----
export interface SurferInfo { installed: boolean; version: string | null; sizeMB: number }
export type JobStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'error';
export interface JobInfo {
  id: string; kind: JobKind; title: string; project: string; status: JobStatus; step: string | null; stepIndex: number; steps: string[];
  created: number; started: number | null; ended: number | null; elapsed: number; result: Record<string, any>; error: string | null;
  log?: string; next?: number;
}

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

  tools(refresh = false): Promise<ToolsInfo> { return this.call('GET', `/api/tools${refresh ? '?refresh=1' : ''}`); }
  projects(): Promise<{ projects: ProjectRef[] }> { return this.call('GET', '/api/projects'); }
  project(path: string): Promise<ProjectInfo> { return this.call('GET', `/api/project?path=${encodeURIComponent(path)}`); }
  templates(): Promise<{ templates: { name: string; title: string }[] }> { return this.call('GET', '/api/templates'); }
  newProject(path: string, template: string): Promise<{ path: string; files: string[] }> { return this.call('POST', '/api/project/new', { path, template }); }
  jobs(): Promise<{ jobs: JobInfo[] }> { return this.call('GET', '/api/jobs'); }
  submit(project: string, kind: JobKind, options: Record<string, unknown> = {}): Promise<JobInfo> { return this.call('POST', '/api/jobs', { project, kind, options }); }
  job(id: string, since: number): Promise<JobInfo> { return this.call('GET', `/api/job?id=${encodeURIComponent(id)}&since=${since}`); }
  cancel(id: string): Promise<JobInfo> { return this.call('POST', `/api/job/cancel?id=${encodeURIComponent(id)}`, {}); }
  rawUrl(path: string): string { return `/api/raw?path=${encodeURIComponent(path)}`; }

  surfer(): Promise<SurferInfo> { return this.call('GET', '/api/surfer'); }
  installSurfer(): Promise<SurferInfo> { return this.call('POST', '/api/surfer/install', {}); }
}

export function download(name: string, text: string, type = 'application/json'): void {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export function upload(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = async () => { const f = i.files?.[0]; res(f ? { name: f.name, text: await f.text() } : null); }; i.click(); });
}
