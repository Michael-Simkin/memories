import { Window } from 'happy-dom';

let initPromise: Promise<MermaidApi> | null = null;

export interface MermaidApi {
  parse: (text: string) => Promise<unknown>;
}

export function getMermaid(): Promise<MermaidApi> {
  if (!initPromise) initPromise = init();
  return initPromise;
}

async function init(): Promise<MermaidApi> {
  const win = new Window({ url: 'http://localhost/' });
  const doc = win.document;
  doc.write('<!DOCTYPE html><html><body></body></html>');

  installGlobals({
    window: win,
    document: doc,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    DocumentFragment: win.DocumentFragment,
    SVGElement: win.SVGElement,
    getComputedStyle: win.getComputedStyle.bind(win),
  });

  const dompurifyModule = await import('dompurify');
  const dompurifyFactory = (dompurifyModule.default ?? dompurifyModule) as (
    win: unknown,
  ) => { sanitize: (s: string) => string };
  const purify = dompurifyFactory(win);
  (win as unknown as { DOMPurify: unknown }).DOMPurify = purify;

  const mermaidModule = await import('mermaid');
  const mermaid = (mermaidModule.default ?? mermaidModule) as {
    initialize: (cfg: Record<string, unknown>) => void;
    parse: (text: string) => Promise<unknown>;
  };
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    suppressErrorRendering: true,
  });

  return { parse: (text) => mermaid.parse(text) };
}

function installGlobals(entries: Record<string, unknown>): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(entries)) {
    try {
      Object.defineProperty(g, key, {
        value,
        configurable: true,
        writable: true,
        enumerable: true,
      });
    } catch {
      try {
        g[key] = value;
      } catch {
        // accept readonly globals (e.g. Node 24 navigator) — skip.
      }
    }
  }
}
