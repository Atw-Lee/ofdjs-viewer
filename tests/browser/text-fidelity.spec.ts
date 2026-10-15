import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { strToU8, unzipSync, zipSync } from 'fflate';

test('keeps DeltaY-only text vertical and uses the preceding TextCode origin', async ({ page }) => {
  const entries = unzipSync(new Uint8Array(readFileSync('public/sample.ofd')));
  entries['Doc_0/PublicRes.xml'] = strToU8(new TextDecoder().decode(entries['Doc_0/PublicRes.xml']).replace('<ofd:Font ID="1" FontName="Arial" FamilyName="Arial"/>', '<ofd:Font ID="1" FontName="Arial" FamilyName="Arial"><ofd:FontFile>mock.ttf</ofd:FontFile></ofd:Font>'));
  entries['Doc_0/Res/mock.ttf'] = new Uint8Array(32);
  entries['Doc_0/Pages/1.xml'] = strToU8(`<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content><ofd:Layer ID="10">
    <ofd:TextObject ID="11" Boundary="0 0 100 100" Font="1" Size="5"><ofd:TextCode X="10" Y="20" DeltaY="10 10">AB</ofd:TextCode></ofd:TextObject>
    <ofd:TextObject ID="12" Boundary="0 0 100 100" Font="1" Size="5"><ofd:CGTransform CodePosition="0" CodeCount="1" GlyphCount="1"><ofd:Glyphs>7</ofd:Glyphs></ofd:CGTransform><ofd:TextCode X="30" Y="20" DeltaX="8">Q</ofd:TextCode><ofd:CGTransform CodePosition="0" CodeCount="1" GlyphCount="1"><ofd:Glyphs>8</ofd:Glyphs></ofd:CGTransform><ofd:TextCode Y="30" DeltaX="8">R</ofd:TextCode></ofd:TextObject>
    <ofd:TextObject ID="13" Boundary="0 0 100 100" Font="1" Size="5"><ofd:CGTransform CodePosition="0" CodeCount="1" GlyphCount="2"><ofd:Glyphs>9 10</ofd:Glyphs></ofd:CGTransform><ofd:TextCode X="50" Y="20" DeltaX="8 8">S</ofd:TextCode><ofd:CGTransform CodePosition="0" CodeCount="2" GlyphCount="1"><ofd:Glyphs>11</ofd:Glyphs></ofd:CGTransform><ofd:TextCode X="50" Y="30" DeltaX="8">TU</ofd:TextCode></ofd:TextObject>
    <ofd:TextObject ID="14" Boundary="0 0 100 100" Font="1" Size="5" ReadDirection="90" CharDirection="90"><ofd:CGTransform CodePosition="0" CodeCount="2" GlyphCount="2"><ofd:Glyphs>12 13</ofd:Glyphs></ofd:CGTransform><ofd:TextCode X="70" Y="20">WX</ofd:TextCode></ofd:TextObject>
  </ofd:Layer></ofd:Content></ofd:Page>`);
  await page.goto('/');
  const result = await page.evaluate(async bytes => {
    // @ts-expect-error Browser imports the source through Vite.
    const { getDocument } = await import('/src/index.ts');
    const loaded: number[] = [];
    const doc = await getDocument(new Uint8Array(bytes), { loadFont: async (data: Uint8Array) => {
      loaded.push(data.length);
      return { path: (index: number) => { loaded.push(index); return 'M 0 0 L 4 0 L 4 -4 L 0 -4 Z'; }, advance: () => 4 };
    } });
    const inspect = async (scale: number) => {
      const ofdPage = await doc.getPage(1);
      const viewport = ofdPage.getViewport({ scale });
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
      await ofdPage.render({ canvasContext: ctx, viewport, pixelRatio: 1 }).promise;
      const ink = (x: number, y: number, w: number, h: number) => {
        const data = ctx.getImageData(Math.round(x * viewport.unit), Math.round(y * viewport.unit), Math.round(w * viewport.unit), Math.round(h * viewport.unit)).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) count++;
        return count;
      };
      return { vertical: [ink(10, 14, 5, 7), ink(10, 24, 5, 7)], shifted: ink(18, 24, 5, 7), glyphs: [ink(30, 16, 4, 4), ink(30, 26, 4, 4)], wrongOrigin: ink(38, 26, 4, 4), rotated: [ink(70, 20, 4, 4), ink(70, 24, 4, 4)] };
    };
    const atOne = await inspect(1), atTwo = await inspect(2);
    const diagnostics = doc.diagnostics.map((d: { code: string }) => d.code);
    doc.destroy();
    return { atOne, atTwo, loaded, diagnostics };
  }, [...zipSync(entries)]);
  for (const image of [result.atOne, result.atTwo]) {
    expect(image.vertical[0]).toBeGreaterThan(0);
    expect(image.vertical[1]).toBeGreaterThan(0);
    expect(image.shifted).toBe(0);
    expect(image.glyphs[0]).toBeGreaterThan(0);
    expect(image.glyphs[1]).toBeGreaterThan(0);
    expect(image.wrongOrigin).toBe(0);
    expect(image.rotated[0]).toBeGreaterThan(0);
    expect(image.rotated[1]).toBeGreaterThan(0);
  }
  expect(result.loaded.filter(value => value === 32)).toHaveLength(1);
  for (const index of [7, 8, 9, 10, 11, 12, 13]) expect(result.loaded).toContain(index);
  expect(result.diagnostics).not.toContain('GLYPH_TRANSFORM');
});

for (const failure of ['path', 'advance', 'nan', 'infinity', 'abort', 'explicit'] as const) {
  test(`handles ${failure} while preparing mapped glyphs`, async ({ page }) => {
    const entries = unzipSync(new Uint8Array(readFileSync('public/sample.ofd')));
    entries['Doc_0/PublicRes.xml'] = strToU8(`<ofd:Res xmlns:ofd="http://www.ofdspec.org/2016" BaseLoc="Res"><ofd:Fonts><ofd:Font ID="1" FontName="Arial"><ofd:FontFile>mock.ttf</ofd:FontFile></ofd:Font></ofd:Fonts></ofd:Res>`);
    entries['Doc_0/Res/mock.ttf'] = new Uint8Array(32);
    entries['Doc_0/Pages/1.xml'] = strToU8(`<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content><ofd:Layer ID="10"><ofd:TextObject ID="11" Boundary="0 0 100 100" Font="1" Size="5" HScale="1.5" ReadDirection="90" CharDirection="90"><ofd:CGTransform CodePosition="0" CodeCount="2" GlyphCount="3"><ofd:Glyphs>7 8 9</ofd:Glyphs></ofd:CGTransform><ofd:TextCode X="20" Y="20" ${failure === 'explicit' ? 'DeltaY="8 8"' : ''}>WX</ofd:TextCode></ofd:TextObject></ofd:Layer></ofd:Content></ofd:Page>`);
    await page.goto('/');
    const result = await page.evaluate(async ({ bytes, failure }) => {
      // @ts-expect-error Browser imports the source through Vite.
      const { getDocument } = await import('/src/index.ts');
      let advances = 0;
      const doc = await getDocument(new Uint8Array(bytes), { loadFont: async () => ({
        path: (index: number) => {
          if (failure === 'path' && index === 8) throw new Error('Broken outline');
          return 'M 0 0 L 4 0 L 4 -4 L 0 -4 Z';
        },
        advance: (index: number) => {
          advances++;
          if (failure === 'explicit') throw new Error('Explicit spacing must not request metrics');
          if (index !== 8) return 4;
          if (failure === 'nan') return NaN;
          if (failure === 'infinity') return Infinity;
          if (failure === 'abort') throw new DOMException('Cancelled metrics', 'AbortError');
          throw new Error('Broken metrics');
        }
      }) });
      const fallback = await getDocument(new Uint8Array(bytes));
      try {
        const output = [];
        for (const scale of [1, 2]) {
          const render = async (document: typeof doc) => {
            const ofdPage = await document.getPage(1), viewport = ofdPage.getViewport({ scale });
            const canvas = window.document.createElement('canvas'), ctx = canvas.getContext('2d')!;
            let state = 'resolved';
            try { await ofdPage.render({ canvasContext: ctx, viewport, pixelRatio: 1 }).promise; }
            catch (error) { state = (error as Error).name; }
            return { state, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
          };
          const actual = await render(doc), expected = await render(fallback);
          output.push({ state: actual.state, same: actual.pixels.every((value, i) => value === expected.pixels[i]),
            ink: actual.pixels.some((value, i) => i % 4 !== 3 && value < 128) });
        }
        return { output, advances, diagnostics: doc.diagnostics.map((d: { code: string }) => d.code) };
      } finally { doc.destroy(); fallback.destroy(); }
    }, { bytes: [...zipSync(entries)], failure });
    for (const actual of result.output) {
      if (failure === 'abort') expect(actual.state).toBe('AbortError');
      else expect(actual).toEqual({ state: 'resolved', same: failure !== 'explicit', ink: true });
    }
    if (failure === 'explicit') expect(result.advances).toBe(0);
    if (failure === 'abort' || failure === 'explicit') expect(result.diagnostics).not.toContain('GLYPH_RENDER');
    else expect(result.diagnostics).toContain('GLYPH_RENDER');
    expect(result.diagnostics).not.toContain('OBJECT_RENDER');
  });
}
