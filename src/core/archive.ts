import { unzip } from 'fflate';
import { parseXML, resolvePath } from './xml.js';
export type OFDSource = string | URL | Blob | ArrayBuffer | Uint8Array;
export interface LoadOptions { signal?: AbortSignal; maxFileSize?: number; maxUncompressedSize?: number; maxEntries?: number; documentIndex?: number; }
export function abort(signal?: AbortSignal): void { signal?.throwIfAborted(); }
export class Archive {
  private xmlCache = new Map<string, Element>();
  constructor(private files: Record<string, Uint8Array>) {}
  has(path: string) { return Object.prototype.hasOwnProperty.call(this.files, path); }
  bytes(path: string) { const bytes = this.files[path]; if (!bytes) throw new Error(`OFD resource not found: ${path}`); return bytes; }
  xml(path: string) { let el = this.xmlCache.get(path); if (!el) { el = parseXML(new TextDecoder().decode(this.bytes(path)), path); this.xmlCache.set(path, el); } return el; }
  clear() { this.files = {}; this.xmlCache.clear(); }
}
export async function openArchive(source: OFDSource, options: LoadOptions): Promise<Archive> {
  const { signal, maxFileSize = 64 * 1024 * 1024, maxUncompressedSize = 256 * 1024 * 1024, maxEntries = 10000 } = options;
  abort(signal);
  let bytes: Uint8Array;
  if (typeof source === 'string' || source instanceof URL) {
    const response = await fetch(source, { signal });
    if (!response.ok) throw new Error(`OFD download failed: HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > maxFileSize) { await response.body?.cancel(); throw new Error('OFD file size limit exceeded'); }
    if (!response.body) throw new Error('OFD response has no body');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { abort(signal); const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxFileSize) throw new Error('OFD file size limit exceeded'); chunks.push(value); } }
    finally { await reader.cancel(); reader.releaseLock(); }
    bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  } else if (source instanceof Blob) {
    if (source.size > maxFileSize) throw new Error('OFD file size limit exceeded');
    bytes = new Uint8Array(await source.arrayBuffer());
  } else bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.length > maxFileSize) throw new Error('OFD file size limit exceeded');
  abort(signal);
  return new Promise((resolve, reject) => {
    let total = 0, count = 0, violation: Error | undefined;
    const onAbort = () => { terminate(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const terminate = unzip(bytes, { filter(file) {
      total += file.originalSize; count++;
      if (total > maxUncompressedSize || count > maxEntries) violation = new Error('OFD archive expansion limit exceeded');
      return !violation;
    } }, (err, files) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(signal.reason);
      if (err || violation) return reject(violation ?? err);
      try {
        const normalized: Record<string, Uint8Array> = Object.create(null);
        for (const [name, data] of Object.entries(files)) {
          if (name.endsWith('/')) continue;
          const path = resolvePath('', name);
          if (normalized[path]) throw new Error(`Duplicate OFD entry: ${path}`);
          normalized[path] = data;
        }
        resolve(new Archive(normalized));
      } catch (error) { reject(error); }
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
