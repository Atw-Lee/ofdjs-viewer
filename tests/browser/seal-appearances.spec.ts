import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

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
