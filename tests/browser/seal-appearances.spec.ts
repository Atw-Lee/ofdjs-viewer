import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { strToU8, unzipSync, zipSync } from 'fflate';

test('composites raster and nested OFD seal appearances before render resolves', async ({ page }) => {
  const bytes = [...readFileSync('tests/fixtures/seal-appearances.ofd')];
  await page.goto('/');
  const result = await page.evaluate(async bytes => {
    // @ts-expect-error Browser imports source through Vite.
    const { getDocument } = await import('/src/index.ts');
    const doc = await getDocument(new Uint8Array(bytes));
    const output = [];
    for (const scale of [1, 2]) {
      const ofdPage = await doc.getPage(1), viewport = ofdPage.getViewport({ scale });
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
      await ofdPage.render({ canvasContext: ctx, viewport, pixelRatio: 1 }).promise;
      const color = (x: number, y: number) => [...ctx.getImageData(Math.round(x * viewport.unit), Math.round(y * viewport.unit), 1, 1).data];
      output.push([color(11, 20), color(20, 20), color(29, 20), color(45, 20), color(60, 12), color(60, 20)]);
    }
    const diagnostics = doc.diagnostics.map((d: { code: string }) => d.code);
    doc.destroy();
    return { output, diagnostics };
  }, bytes);
  for (const colors of result.output) {
    expect(colors).toEqual([
      [220, 30, 40, 255], [20, 180, 40, 255], [20, 180, 40, 255],
      [220, 30, 40, 255], [20, 60, 220, 255], [20, 180, 40, 255]
    ]);
  }
  expect(result.diagnostics).toContain('SIGNATURE_NOT_VERIFIED');
  expect(result.diagnostics).not.toContain('SEAL_RENDER');
});

test('closes a seal image returned after cancellation and document disposal', async ({ page }) => {
  const bytes = [...readFileSync('tests/fixtures/seal-appearances.ofd')];
  await page.goto('/');
  const result = await page.evaluate(async bytes => {
    // @ts-expect-error Browser imports source through Vite.
    const { getDocument } = await import('/src/index.ts');
    const original = createImageBitmap;
    let begin!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    let bitmap: ImageBitmap | undefined;
    globalThis.createImageBitmap = (async (image: ImageBitmapSource) => {
      bitmap = await original(image);
      begin(); await release;
      return bitmap;
    }) as typeof createImageBitmap;
    try {
      const doc = await getDocument(new Uint8Array(bytes)), ofdPage = await doc.getPage(1);
      const canvas = document.createElement('canvas');
      const task = ofdPage.render({ canvasContext: canvas.getContext('2d')!, viewport: ofdPage.getViewport(), pixelRatio: 1 });
      const settled = task.promise.then(() => 'resolved', (error: Error) => error.name);
      await started;
      task.cancel(); doc.destroy(); finish();
      const state = await settled;
      await Promise.resolve();
      return { state, closed: bitmap?.width === 0 };
    } finally {
      finish(); globalThis.createImageBitmap = original;
    }
  }, bytes);
  expect(result).toEqual({ state: 'AbortError', closed: true });
});

for (const scenario of ['invalid metadata path', 'damaged raster seal', 'page without stamps']) {
  test(`retains page content with ${scenario}`, async ({ page }) => {
    const entries = unzipSync(new Uint8Array(readFileSync('tests/fixtures/seal-appearances.ofd')));
    if (scenario === 'invalid metadata path') {
      entries['OFD.xml'] = strToU8(new TextDecoder().decode(entries['OFD.xml']).replace('Doc_0/Signs/Signatures.xml', '../outside.xml'));
    } else if (scenario === 'damaged raster seal') {
      entries['Doc_0/Signs/PNG/SignedValue.dat'] = new Uint8Array([48, 128]);
    } else {
      entries['Doc_0/Document.xml'] = strToU8(new TextDecoder().decode(entries['Doc_0/Document.xml']).replace('</ofd:Pages>', '<ofd:Page ID="2" BaseLoc="Pages/2.xml"/></ofd:Pages>'));
      entries['Doc_0/Pages/2.xml'] = entries['Doc_0/Pages/1.xml'];
    }
    await page.goto('/');
    const result = await page.evaluate(async ({ bytes, pageNumber }) => {
      // @ts-expect-error Browser imports source through Vite.
      const { getDocument } = await import('/src/index.ts');
      const doc = await getDocument(new Uint8Array(bytes));
      try {
        const ofdPage = await doc.getPage(pageNumber), viewport = ofdPage.getViewport();
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
        await ofdPage.render({ canvasContext: ctx, viewport, pixelRatio: 1 }).promise;
        const color = (x: number) => [...ctx.getImageData(Math.round(x * viewport.unit), Math.round(20 * viewport.unit), 1, 1).data];
        return { colors: [color(11), color(45)], diagnostics: doc.diagnostics.map((d: { code: string }) => d.code) };
      } finally { doc.destroy(); }
    }, { bytes: [...zipSync(entries)], pageNumber: scenario === 'page without stamps' ? 2 : 1 });
    expect(result.colors[0]).toEqual([20, 180, 40, 255]);
    expect(result.colors[1]).toEqual(scenario === 'damaged raster seal' ? [220, 30, 40, 255] : [20, 180, 40, 255]);
    if (scenario === 'invalid metadata path') expect(result.diagnostics).toContain('SEAL_METADATA');
    if (scenario === 'damaged raster seal') expect(result.diagnostics).toContain('SEAL_RENDER');
    if (scenario === 'page without stamps') expect(result.diagnostics).not.toContain('SEAL_RENDER');
  });
}
