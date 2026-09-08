// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync, unzipSync, strFromU8 } from 'fflate';
import { getDocument } from '../src/index';
import { expandDeltas, resolvePath, parseXML, colorNumbers } from '../src/core/xml';
import { drawPath } from '../src/core/path';
const sample = new Uint8Array(readFileSync('public/sample.ofd'));
describe('OFD archive and page model', () => {
  it('resolves templates, resources, physical size, metadata and text', async () => {
    const doc = await getDocument(sample);
    expect(doc.numPages).toBe(2); expect(doc.metadata.Title).toBe('OFD.js sample');
    const page = await doc.getPage(1); expect(page.contents).toHaveLength(2);
    expect(page.getViewport().width).toBeCloseTo(793.700787);
    expect(page.getViewport({ rotation: 90 }).height).toBeCloseTo(793.700787);
    expect((await page.getTextContent()).items.some(i => i.text === 'A document, rendered.')).toBe(true);
    await expect(doc.getPage(0)).rejects.toThrow('Page must');
    expect(() => page.getViewport({ scale: 0 })).toThrow();
    expect(() => page.getViewport({ rotation: 45 })).toThrow();
    doc.destroy(); await expect(doc.getPage(1)).rejects.toThrow('destroyed');
    expect(() => page.getViewport()).toThrow('destroyed');
  });
  it('uses per-page sizes when a producer omits the document default', async () => {
    const files = unzipSync(sample);
    files['Doc_0/Document.xml'] = strToU8(strFromU8(files['Doc_0/Document.xml']).replace(/<ofd:PageArea>.*?<\/ofd:PageArea>/s, ''));
    for (const [name, width, height] of [['1.xml', 180, 100], ['2.xml', 100, 180]] as const) {
      const path = `Doc_0/Pages/${name}`;
      files[path] = strToU8(strFromU8(files[path]).replace('<ofd:Template', `<ofd:Area><ofd:PhysicalBox>0 0 ${width} ${height}</ofd:PhysicalBox></ofd:Area><ofd:Template`));
    }
    const doc = await getDocument(zipSync(files));
    expect((await doc.getPage(1)).physicalBox).toEqual([0, 0, 180, 100]);
    expect((await doc.getPage(2)).physicalBox).toEqual([0, 0, 100, 180]);
    expect(doc.diagnostics.some(d => d.code === 'MISSING_DEFAULT_PAGE_AREA')).toBe(true);
    doc.destroy();
  });
  it('prefers a page size over the document default and otherwise inherits', async () => {
    const files = unzipSync(sample);
    files['Doc_0/Pages/1.xml'] = strToU8(strFromU8(files['Doc_0/Pages/1.xml']).replace('<ofd:Template', '<ofd:Area><ofd:PhysicalBox>1 2 180 100</ofd:PhysicalBox></ofd:Area><ofd:Template'));
    const doc = await getDocument(zipSync(files));
    expect((await doc.getPage(1)).physicalBox).toEqual([1, 2, 180, 100]);
    expect((await doc.getPage(2)).physicalBox).toEqual([0, 0, 210, 297]);
    doc.destroy();
  });
  it('does not guess a page size when both declarations are absent', async () => {
    const files = unzipSync(sample);
    files['Doc_0/Document.xml'] = strToU8(strFromU8(files['Doc_0/Document.xml']).replace(/<ofd:PageArea>.*?<\/ofd:PageArea>/s, ''));
    const doc = await getDocument(zipSync(files));
    await expect(doc.getPage(1)).rejects.toThrow('Page 1 has no PhysicalBox');
    doc.destroy();
  });
  it('rejects malformed archives and missing root', async () => {
    await expect(getDocument(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    await expect(getDocument(zipSync({ 'test.xml': strToU8('<Test/>') })) ).rejects.toThrow('OFD.xml');
  });
  it('enforces compressed and expanded limits and document index', async () => {
    await expect(getDocument(sample, { maxFileSize: 1 })).rejects.toThrow('size limit');
    await expect(getDocument(sample, { maxUncompressedSize: 20 })).rejects.toThrow('expansion limit');
    await expect(getDocument(sample, { maxEntries: 1 })).rejects.toThrow('expansion limit');
    await expect(getDocument(sample, { documentIndex: 2 })).rejects.toThrow('index');
  });
  it('honors abort before parsing', async () => {
    const c = new AbortController(); c.abort();
    await expect(getDocument(sample, { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
describe('OFD primitives', () => {
  it('resolves package absolute paths and normalizes separators without traversal', () => {
    expect(resolvePath('Doc/Pages/1.xml', '../../Res/a.png')).toBe('Res/a.png');
    expect(resolvePath('Doc/a.xml', '/Doc/Res/a.png')).toBe('Doc/Res/a.png');
    expect(resolvePath('Doc/a.xml', 'Res\\a.png')).toBe('Doc/Res/a.png');
    expect(() => resolvePath('Doc/a.xml', '../../outside')).toThrow('escapes');
  });
  it('reads decimal and hexadecimal color components', () => {
    expect(colorNumbers('#ee #20 #25')).toEqual([238, 32, 37]);
    expect(colorNumbers('255 0 128')).toEqual([255, 0, 128]);
  });
  it('expands repeated deltas and rejects malformed repetition', () => {
    expect(expandDeltas('g 3 2 -1 0')).toEqual([2, 2, 2, -1, 0]);
    expect(() => expandDeltas('g 100001 1')).toThrow(); expect(() => expandDeltas('g 2')).toThrow();
  });
  it('rejects entities, doctypes and broken XML', () => {
    expect(() => parseXML('<!DOCTYPE x><x/>', 'x')).toThrow('Unsafe');
    expect(() => parseXML('<x>', 'x')).toThrow('Invalid XML');
    expect(parseXML('<o:OFD xmlns:o="urn:test"/>', 'x').localName).toBe('OFD');
  });
  it('handles OFD cubic, quadratic, close and arc commands', () => {
    const calls: string[] = [];
    const ctx = new Proxy({}, { get: (_, name) => (..._args: unknown[]) => calls.push(String(name)) }) as CanvasRenderingContext2D;
    drawPath(ctx, 'M 0 0 L 1 1 B 1 2 3 4 5 6 Q 7 8 9 10 A 4 5 30 0 1 12 14 C');
    expect(calls).toEqual(['beginPath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'ellipse', 'closePath']);
    expect(() => drawPath(ctx, 'M 1')).toThrow();
  });
});
