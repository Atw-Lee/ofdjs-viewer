import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8 } from 'fflate';
test('renders pixels, navigates, zooms, rotates, and opens a file', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Canvas · 本地渲染');
  const canvas = page.locator('canvas'); await expect(canvas).toBeVisible();
  const stats = await canvas.evaluate((c: HTMLCanvasElement) => {
    const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height); let dark = 0, green = 0;
    for (let i = 0; i < data.length; i += 4) { if (data[i] < 120 && data[i+1] < 150 && data[i+2] < 150) dark++; if (data[i+1] > data[i] + 20 && data[i] < 80) green++; }
    return { width: c.width, height: c.height, dark, green };
  });
  expect(stats.dark).toBeGreaterThan(5000); expect(stats.green).toBeGreaterThan(500);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(canvas).toHaveAttribute('aria-label', '第 2 页');
  await expect(page.getByRole('status')).toHaveText('Canvas · 本地渲染');
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect(page.getByText('125%')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Canvas · 本地渲染');
  await page.getByRole('button', { name: '旋转页面' }).click();
  await expect(page.getByRole('status')).toHaveText('Canvas · 本地渲染');
  expect(await canvas.evaluate((c: HTMLCanvasElement) => c.width > c.height)).toBe(true);
  await page.locator('input[type=file]').setInputFiles('public/sample.ofd');
  await expect(canvas).toHaveAttribute('aria-label', '第 1 页');
  await expect(page.getByRole('status')).toHaveText('Canvas · 本地渲染');
  expect(errors).toEqual([]);
  for (let n = 0; n < 3; n++) await page.getByRole('button', { name: '旋转页面' }).click();
  await page.getByRole('button', { name: '适合宽度' }).click();
  await expect(page.getByRole('status')).toHaveText('Canvas · 本地渲染');
  await page.screenshot({ path: 'test-results/viewer.png', fullPage: true });
});
test('reports invalid files and recovers', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'bad.ofd', mimeType: 'application/ofd', buffer: Buffer.from('bad') });
  await expect(page.getByRole('alert')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles('public/sample.ofd');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('cancels rendering and isolates two documents', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    // @ts-expect-error Browser imports the source through Vite.
    const { getDocument } = await import('/dist/browser/ofdjs.js');
    const a = await getDocument('/sample.ofd'), b = await getDocument('/sample.ofd');
    const p = await a.getPage(1), canvas = document.createElement('canvas');
    const task = p.render({ canvasContext: canvas.getContext('2d'), viewport: p.getViewport() }); task.cancel();
    let cancelled = false; try { await task.promise; } catch (e) { cancelled = (e as Error).name === 'AbortError'; }
    a.destroy();
    const bp = await b.getPage(2); await bp.render({ canvasContext: canvas.getContext('2d'), viewport: bp.getViewport(), pixelRatio: 1 }).promise;
    if (b.diagnostics.some((d: { code: string }) => d.code === 'IMAGE_DECODE')) throw new Error('Sample image failed to decode');
    const out = { cancelled, width: canvas.width, pages: b.numPages }; b.destroy(); return out;
  });
  expect(result).toEqual({ cancelled: true, width: 794, pages: 2 });
});
const references = (process.env.OFD_REFERENCE_FILES || process.env.OFD_REFERENCE_FILE || '').split(',');
for (const reference of references) test(`renders all pages of external sample ${reference.split('/').pop() || '(not supplied)'}`,  async ({ page }, testInfo) => {
  test.skip(!reference || !existsSync(reference), 'Set OFD_REFERENCE_FILE to a local OFD fixture.');
  await page.goto('/');
  const data = [...readFileSync(reference!)];
  const result = await page.evaluate(async bytes => {
    // @ts-expect-error Browser imports the source through Vite.
    const { getDocument } = await import('/src/index.ts');
    const doc = await getDocument(new Uint8Array(bytes)); let textCount = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n), canvas = document.createElement('canvas');
      await p.render({ canvasContext: canvas.getContext('2d'), viewport: p.getViewport({ scale: .75 }), pixelRatio: 1 }).promise;
      textCount += (await p.getTextContent()).items.length;
    }
    const result = { pages: doc.numPages, textCount, diagnostics: doc.diagnostics }; doc.destroy(); return result;
  }, data);
  expect(result.pages).toBeGreaterThan(0); expect(result.textCount).toBeGreaterThanOrEqual(0);
  console.log('Reference sample:', JSON.stringify(result));
  await page.locator('input[type=file]').setInputFiles(reference);
  await expect(page.getByRole('status')).toHaveText('Canvas · 本地渲染');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const canvas = page.locator('canvas'); await expect(canvas).toBeVisible();
  const ink = await canvas.evaluate((c: HTMLCanvasElement) => {
    const bytes = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let ink = 0; for (let i = 0; i < bytes.length; i += 4) if (Math.min(bytes[i], bytes[i+1], bytes[i+2]) < 200) ink++;
    return ink;
  });
  expect(ink).toBeGreaterThan(100);
  const png = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png').split(',')[1]);
  writeFileSync(testInfo.outputPath('reference-page.png'), Buffer.from(png, 'base64'));
});

test('renders hexadecimal colors and path clipping into expected pixels', async ({ page }) => {
  const entries = unzipSync(new Uint8Array(readFileSync('public/sample.ofd')));
  entries['Doc_0/Pages/1.xml'] = strToU8(`<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content><ofd:Layer ID="10"><ofd:PathObject ID="20" Boundary="10 10 40 20" Fill="true" Stroke="false"><ofd:FillColor Value="#ee #20 #25"/><ofd:Clips><ofd:Clip><ofd:Area><ofd:Path Boundary="0 0 40 20"><ofd:AbbreviatedData>M 0 0 L 20 0 L 20 20 L 0 20 C</ofd:AbbreviatedData></ofd:Path></ofd:Area></ofd:Clip></ofd:Clips><ofd:AbbreviatedData>M 0 0 L 40 0 L 40 20 L 0 20 C</ofd:AbbreviatedData></ofd:PathObject></ofd:Layer></ofd:Content></ofd:Page>`);
  await page.goto('/');
  const pixels = await page.evaluate(async bytes => {
    // @ts-expect-error Browser imports source through Vite.
    const { getDocument } = await import('/src/index.ts');
    const doc = await getDocument(new Uint8Array(bytes)), p = await doc.getPage(1);
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!, viewport = p.getViewport();
    await p.render({ canvasContext: ctx, viewport, pixelRatio: 1 }).promise;
    const sample = (x: number) => [...ctx.getImageData(Math.round(x * viewport.unit), Math.round(15 * viewport.unit), 1, 1).data];
    const out = [sample(15), sample(35)]; doc.destroy(); return out;
  }, [...zipSync(entries)]);
  expect(pixels).toEqual([[238, 32, 37, 255], [255, 255, 255, 255]]);
});
