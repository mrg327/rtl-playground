// CodeMirror 6 wrapper for project files: SystemVerilog, Python testbenches, SDC/Tcl, JSON.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { StreamLanguage, indentUnit } from '@codemirror/language';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';
import { python } from '@codemirror/legacy-modes/mode/python';
import { tcl } from '@codemirror/legacy-modes/mode/tcl';
import { json } from '@codemirror/legacy-modes/mode/javascript';
import { setDiagnostics, lintGutter, type Diagnostic } from '@codemirror/lint';
import { keymap } from '@codemirror/view';

export interface LineDiagnostic { line: number; col?: number | null; severity: 'error' | 'warning' | 'info'; message: string }

function languageFor(path: string): Extension {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (['.sv', '.svh', '.v', '.vh'].includes(ext)) return StreamLanguage.define(verilog);
  if (ext === '.py') return StreamLanguage.define(python);
  if (['.sdc', '.tcl'].includes(ext)) return StreamLanguage.define(tcl);
  if (['.json', '.rtlp'].includes(ext)) return StreamLanguage.define(json);
  return [];
}

export class CodeEditor {
  view: EditorView;
  private lang = new Compartment();
  private readOnly = new Compartment();
  private silent = false;

  constructor(parent: HTMLElement, opts: { onChange: () => void; onSave: () => void }) {
    const theme = EditorView.theme({
      '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--panel)', color: 'var(--ink)' },
      '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
      '.cm-gutters': { backgroundColor: 'var(--paper)', color: 'var(--ink2)', borderRight: '1px solid var(--line)' },
      '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--sel) 6%, transparent)' },
      '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--sel) 12%, transparent)' },
      '&.cm-focused': { outline: 'none' },
      '.cm-cursor': { borderLeftColor: 'var(--ink)' },
    });
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '',
        extensions: [
          basicSetup, theme, lintGutter(), indentUnit.of('  '),
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { opts.onSave(); return true; } }]),
          this.lang.of([]), this.readOnly.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of(u => { if (u.docChanged && !this.silent) opts.onChange(); }),
        ],
      }),
    });
  }

  open(path: string, text: string, readOnly = false): void {
    this.silent = true;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      effects: [this.lang.reconfigure(languageFor(path)), this.readOnly.reconfigure(EditorState.readOnly.of(readOnly))],
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
    this.silent = false;
    this.view.dispatch(setDiagnostics(this.view.state, []));
  }

  get text(): string { return this.view.state.doc.toString(); }

  diagnostics(list: LineDiagnostic[]): void {
    const doc = this.view.state.doc;
    const out: Diagnostic[] = [];
    for (const d of list) {
      if (d.line < 1 || d.line > doc.lines) continue;
      const line = doc.line(d.line);
      const from = Math.min(line.from + Math.max((d.col ?? 1) - 1, 0), line.to);
      out.push({ from, to: Math.max(from, line.to), severity: d.severity, message: d.message });
    }
    this.view.dispatch(setDiagnostics(this.view.state, out));
  }

  goto(line: number): void {
    const doc = this.view.state.doc; if (line < 1 || line > doc.lines) return;
    const pos = doc.line(line).from;
    this.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    this.view.focus();
  }
}
