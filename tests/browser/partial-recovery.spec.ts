import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

function damagedArchive(): Uint8Array {
  const entries = unzipSync(new Uint8Array(readFileSync('public/sample.ofd')));
  entries['Doc_0/Document.xml'] = strToU8(strFromU8(entries['Doc_0/Document.xml'])
    .replace('</ofd:CommonData>', '<ofd:DocumentRes>../../escape.xml</ofd:DocumentRes><ofd:TemplatePage ID="999" BaseLoc="Tpl/missing.xml"/></ofd:CommonData>')
    .replace('</ofd:Pages>', '<ofd:Page ID="300" BaseLoc="Pages/missing.xml"/></ofd:Pages>')
    .replace('</ofd:Document>', '<ofd:Annotations>Annotations.xml</ofd:Annotations></ofd:Document>'));
  entries['Doc_0/Annotations.xml'] = strToU8('<ofd:Annotations xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Page PageID="100"><ofd:FileLoc>missing.xml</ofd:FileLoc></ofd:Page></ofd:Annotations>');
  entries['Doc_0/Pages/1.xml'] = strToU8(`<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Area><ofd:PhysicalBox>0 0 0 0</ofd:PhysicalBox></ofd:Area><ofd:Template TemplateID="999" ZOrder="Background"/><ofd:Content><ofd:Layer ID="10"><ofd:PathObject ID="bad" Boundary="10 10 20 20" CTM="1 0 0" Fill="true"><ofd:AbbreviatedData>M 0 0 L 20 0 L 20 20 C</ofd:AbbreviatedData></ofd:PathObject><ofd:PathObject ID="good" Boundary="10 10 20 20" Fill="true" Stroke="false"><ofd:FillColor Value="220 30 40"/><ofd:AbbreviatedData>M 0 0 L 20 0 L 20 20 L 0 20 C</ofd:AbbreviatedData></ofd:PathObject></ofd:Layer></ofd:Content></ofd:Page>`);
  return zipSync(entries);
}

test('retains readable objects and a blank page after optional parts fail', async ({ page }) => {
  const bytes = [...damagedArchive()];
  await page.goto('/');
  const result = await page.evaluate(async bytes => {
    // @ts-expect-error Browser imports source through Vite.
    const { getDocument } = await import('/src/index.ts');
    const doc = await getDocument(new Uint8Array(bytes));
    const render = async (number: number) => {
      const ofdPage = await doc.getPage(number), viewport = ofdPage.getViewport();
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
      await ofdPage.render({ canvasContext: ctx, viewport, pixelRatio: 1 }).promise;
      return { width: canvas.width, color: [...ctx.getImageData(Math.round(20 * viewport.unit), Math.round(20 * viewport.unit), 1, 1).data] };
    };
    const first = await render(1), missing = await render(3);
    const result = { pages: doc.numPages, first, missing, diagnostics: doc.diagnostics.map((d: { code: string }) => d.code) };
    doc.destroy(); return result;
  }, bytes);
  expect(result.pages).toBe(3);
  expect(result.first).toEqual({ width: 794, color: [220, 30, 40, 255] });
  expect(result.missing).toEqual({ width: 794, color: [255, 255, 255, 255] });
  for (const code of ['RESOURCE_PARSE', 'MISSING_TEMPLATE', 'ANNOTATION_CONTENT', 'OBJECT_RENDER', 'PAGE_CONTENT', 'PAGE_AREA']) {
    expect(result.diagnostics).toContain(code);
  }
});

test('still rejects a missing page when no physical size is known', async ({ page }) => {
  const entries = unzipSync(damagedArchive());
  entries['Doc_0/Document.xml'] = strToU8(strFromU8(entries['Doc_0/Document.xml']).replace(/<ofd:PageArea>.*?<\/ofd:PageArea>/s, ''));
  await page.goto('/');
  const result = await page.evaluate(async bytes => {
    // @ts-expect-error Browser imports source through Vite.
    const { getDocument } = await import('/src/index.ts');
    const doc = await getDocument(new Uint8Array(bytes));
    try { await doc.getPage(3); return 'resolved'; }
    catch (error) { return (error as Error).message; }
    finally { doc.destroy(); }
  }, [...zipSync(entries)]);
  expect(result).toContain('missing.xml');
});
