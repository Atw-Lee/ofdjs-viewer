import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { strToU8, unzipSync, zipSync } from 'fflate';

function png(width: number, height: number, pixels: number[]): Uint8Array {
  const crc = (bytes: Uint8Array) => {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(kind, 4); Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.from([0, ...pixels.slice(y * width * 4, (y + 1) * width * 4)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]);
}

function archive(mask: string, format: string, maskBytes: Uint8Array): number[] {
  const entries = unzipSync(new Uint8Array(readFileSync('public/sample.ofd')));
  entries['Doc_0/PublicRes.xml'] = strToU8(`<ofd:Res xmlns:ofd="http://www.ofdspec.org/2016" BaseLoc="Res"><ofd:MultiMedias><ofd:MultiMedia ID="3" Type="Image" Format="PNG"><ofd:MediaFile>source.png</ofd:MediaFile></ofd:MultiMedia><ofd:MultiMedia ID="4" Type="Image" Format="${format}"><ofd:MediaFile>mask.bin</ofd:MediaFile></ofd:MultiMedia></ofd:MultiMedias></ofd:Res>`);
  entries['Doc_0/Res/source.png'] = new Uint8Array(png(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]));
  entries['Doc_0/Res/mask.bin'] = new Uint8Array(maskBytes);
  entries['Doc_0/Pages/1.xml'] = strToU8(`<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content><ofd:Layer ID="10"><ofd:PathObject ID="11" Boundary="10 10 20 10" Fill="true" Stroke="false"><ofd:FillColor Value="0 200 0"/><ofd:AbbreviatedData>M 0 0 L 20 0 L 20 10 L 0 10 C</ofd:AbbreviatedData></ofd:PathObject><ofd:ImageObject ID="12" Boundary="10 10 20 10" CTM="20 0 0 10 0 0" ResourceID="3" ImageMask="${mask}"/></ofd:Layer></ofd:Content></ofd:Page>`);
  return [...zipSync(entries)];
}

test('composes a locally decoded same-size mask and retains images for damaged masks', async ({ page }) => {
  const mask = png(2, 1, [255, 255, 255, 255, 0, 0, 0, 255]);
  const inputs = [
    archive('4', 'JBIG2', new Uint8Array([1, 2, 3])),
    archive('4', 'PNG', png(1, 1, [0, 0, 0, 255])),
    archive('missing', 'PNG', mask)
  ];
  await page.goto('/');
  const result = await page.evaluate(async ({ inputs, mask }) => {
    // @ts-expect-error Browser imports source through Vite.
    const { getDocument } = await import('/src/index.ts');
    const output = [];
    for (let n = 0; n < inputs.length; n++) {
      const formats: string[] = [], decoded: ImageBitmap[] = [];
      const doc = await getDocument(new Uint8Array(inputs[n]), { decodeImage: async (bytes: Uint8Array, format: string) => {
        formats.push(format);
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(format === 'JBIG2' ? mask : bytes)]));
        decoded.push(bitmap); return bitmap;
      } });
      const ofdPage = await doc.getPage(1), viewport = ofdPage.getViewport();
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
      await ofdPage.render({ canvasContext: ctx, viewport, pixelRatio: 1 }).promise;
      const sample = (x: number) => [...ctx.getImageData(Math.round(x * viewport.unit), Math.round(15 * viewport.unit), 1, 1).data];
      const pixels = [sample(15), sample(25)], diagnostics = doc.diagnostics.map((d: { code: string }) => d.code);
      doc.destroy(); await Promise.resolve();
      output.push({ pixels, diagnostics, formats, closed: decoded.every(bitmap => bitmap.width === 0) });
    }
    return output;
  }, { inputs, mask: [...mask] });
  expect(result[0]).toMatchObject({ pixels: [[255, 0, 0, 255], [0, 200, 0, 255]], formats: ['PNG', 'JBIG2'], closed: true });
  for (const item of result.slice(1)) {
    expect(item.pixels).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);
    expect(item.diagnostics).toContain('IMAGE_MASK');
    expect(item.closed).toBe(true);
  }
});
