import './ui/styles.css';
import { App } from './ui/app';

const app = new App(document.getElementById('app')!);
(window as unknown as { rtlp: App }).rtlp = app;
