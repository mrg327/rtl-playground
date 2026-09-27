// The Waves tab: a suite's FST opened in Surfer (surfer-project.org, EUPL-1.2), same-origin
// in an iframe. Surfer's own web build is fetched by the host on first use, not shipped in
// the wheel (DESIGN.md section 7); this panel offers the one-click install and, always, the
// plain download link as a fallback.
import type { Host, SurferInfo } from '../host/api';

const esc = (t: string) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class WavesPanel {
  info: SurferInfo | null = null;
  path: string | null = null;
  private installing = false;

  constructor(private el: HTMLElement, private host: Host, private toast: (msg: string) => void) {}

  async refresh(): Promise<void> {
    try { this.info = await this.host.surfer(); } catch (e) { this.info = null; this.toast(`Cannot check the waveform viewer: ${(e as Error).message}`); }
    this.render();
  }

  open(path: string): void { this.path = path; this.render(); }

  private render(): void {
    if (!this.path) { this.el.innerHTML = `<p class="pj-empty">Run <b>Test</b>, then open a suite's waves here.</p>`; return; }
    if (!this.info) { this.el.innerHTML = `<p class="pj-empty">Checking the waveform viewer…</p>`; return; }
    const dl = this.host.rawUrl(this.path);
    if (!this.info.installed) {
      this.el.innerHTML = `
        <div class="pj-surfer-setup">
          <p>Waveforms open in <a href="https://surfer-project.org" target="_blank" rel="noopener">Surfer</a>, a waveform viewer that runs entirely in the browser.</p>
          <button id="pj-surfer-install" class="primary" ${this.installing ? 'disabled' : ''}>${this.installing ? 'Installing…' : `Install the waveform viewer (${this.info.sizeMB} MB, once)`}</button>
          <p class="pj-hint">Or skip the install and open the file yourself: <a href="${esc(dl)}" download>download the waveform</a> for Surfer or GTKWave.</p>
        </div>`;
      this.el.querySelector<HTMLButtonElement>('#pj-surfer-install')!.onclick = () => void this.install();
      return;
    }
    // Surfer's Rust-side URL parser rejects a root-relative load_url ("relative URL without
    // a base"), so this must be absolute even though the iframe is same-origin.
    const absolute = new URL(dl, location.origin).toString();
    const frameSrc = `/surfer/index.html?load_url=${encodeURIComponent(absolute)}`;
    this.el.innerHTML = `
      <div class="pj-waves-bar"><a href="${esc(dl)}" download>download</a><span class="spacer"></span>
        <a class="pj-surfer-credit" href="https://surfer-project.org" target="_blank" rel="noopener" title="${esc(this.info.version ?? '')}">Waveforms by Surfer (EUPL-1.2)</a></div>
      <iframe class="pj-waves-frame" src="${esc(frameSrc)}" title="Waveform viewer"></iframe>`;
  }

  private async install(): Promise<void> {
    this.installing = true; this.render();
    try {
      this.info = await this.host.installSurfer();
      this.toast(`Installed the waveform viewer${this.info.version ? ` (${this.info.version})` : ''}`);
    } catch (e) {
      this.toast(`Cannot install the waveform viewer: ${(e as Error).message}`);
    } finally {
      this.installing = false; this.render();
    }
  }
}
