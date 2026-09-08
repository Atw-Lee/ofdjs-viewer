export const children = (el: Element, name?: string): Element[] => Array.from(el.children).filter(e => !name || e.localName === name);
export const child = (el: Element, name: string) => children(el, name)[0];
export const descendants = (el: Element, name: string): Element[] => Array.from(el.getElementsByTagNameNS('*', name));
export const value = (el: Element, name: string) => child(el, name)?.textContent?.trim() ?? '';
export function numbers(value: string | null | undefined): number[] {
  if (!value?.trim()) return [];
  const result = value.trim().split(/[\s,]+/).map(Number);
  if (result.some(n => !Number.isFinite(n))) throw new Error(`Invalid OFD number: ${value}`);
  return result;
}
export function numberAttr(el: Element, name: string, fallback = 0): number {
  const raw = el.getAttribute(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}: ${raw}`);
  return n;
}
export type Box = [number, number, number, number];
export function box(raw: string | null | undefined, fallback?: Box): Box {
  const ns = numbers(raw);
  if (!ns.length && fallback) return [...fallback];
  if (ns.length !== 4 || ns[2] <= 0 || ns[3] <= 0) throw new Error(`Invalid OFD box: ${raw}`);
  return ns as Box;
}
export function resolvePath(baseFile: string, relative: string): string {
  const parts = relative.replace(/\\/g, '/').startsWith('/') ? [] : baseFile.split('/').slice(0, -1);
  for (const part of relative.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('OFD path escapes archive'); parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}
export function parseXML(data: string, path: string): Element {
  if (/<!DOCTYPE|<!ENTITY/i.test(data)) throw new Error(`Unsafe XML in ${path}`);
  const doc = new DOMParser().parseFromString(data, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`Invalid XML: ${path}`);
  return doc.documentElement;
}
/** OFD uses g <repeat count> <delta>, not SVG's repeat syntax. */
export function expandDeltas(raw: string | null): number[] {
  const tokens = raw?.trim().split(/\s+/).filter(Boolean) ?? [];
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'g') {
      const count = Number(tokens[++i]), delta = Number(tokens[++i]);
      if (!Number.isInteger(count) || count < 0 || count > 100000 || !Number.isFinite(delta)) throw new Error('Invalid OFD delta sequence');
      for (let j = 0; j < count; j++) out.push(delta);
    } else {
      const n = Number(tokens[i]);
      if (!Number.isFinite(n)) throw new Error('Invalid OFD delta');
      out.push(n);
    }
    if (out.length > 100000) throw new Error('OFD delta limit exceeded');
  }
  return out;
}

export function colorNumbers(raw: string | null): number[] {
  return numbers(raw?.replace(/#([0-9a-f]+)/gi, (_, hex: string) => String(parseInt(hex, 16))));
}
