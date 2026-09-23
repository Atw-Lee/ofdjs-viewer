import { Archive, openArchive, abort, type LoadOptions, type OFDSource } from './archive.js';
import { boundary, box, child, children, descendants, resolvePath, value, type Box } from './xml.js';
import { renderPage, type RenderOptions, type RenderTask, type Viewport } from './render.js';
export interface Diagnostic { code: string; message: string; }
export interface TextItem { text: string; boundary: Box; font: string; size: number; }
export interface PageContent { root: Element; resources: Resources; }
let documentSequence = 0;
export class Resources {
  colorSpaces = new Map<string, Element>(); fonts = new Map<string, Element>(); images = new Map<string, string>(); drawParams = new Map<string, Element>();
  private imageFormats = new Map<string, string>();
  private fontPaths = new Map<string, string>(); private loadedFonts = new Map<string, Promise<string>>();
  private loadedImages = new Map<string, Promise<ImageBitmap>>(); private maskedImages = new Map<string, Promise<ImageBitmap>>(); private faces: FontFace[] = []; private disposed = false;
  private namespace = `ofd_${++documentSequence}`;
  constructor(private archive: Archive, private warn: (code: string, message: string) => void, readonly parent?: Resources, private options: LoadOptions = parent?.options ?? {}) {}
  load(path: string, reference?: string) {
    try { this.loadResource(reference === undefined ? path : resolvePath(path, reference)); }
    catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      this.warn('RESOURCE_PARSE', 'A resource catalog could not be read; other content is retained.');
    }
  }
  private loadResource(path: string) {
    if (!this.archive.has(path)) { this.warn('MISSING_RESOURCE', `Referenced resource file is absent: ${path}`); return; }
    const root = this.archive.xml(path);
    const base = resolvePath(path, `${root.getAttribute('BaseLoc') || '.'}/__resource__`);
    for (const font of descendants(root, 'Font')) {
      const id = font.getAttribute('ID')!; this.fonts.set(id, font);
      if (value(font, 'FontFile')) this.fontPaths.set(id, resolvePath(base, value(font, 'FontFile')));
    }
    for (const media of descendants(root, 'MultiMedia')) {
      if (media.getAttribute('Type') === 'Image') {
        const id = media.getAttribute('ID')!, file = value(media, 'MediaFile');
        this.images.set(id, resolvePath(base, file));
        this.imageFormats.set(id, media.getAttribute('Format') || file.split('.').pop() || '');
      }
    }
    for (const param of descendants(root, 'DrawParam')) this.drawParams.set(param.getAttribute('ID')!, param);
    for (const space of descendants(root, 'ColorSpace')) this.colorSpaces.set(space.getAttribute('ID')!, space);
    for (const feature of ['CompositeGraphicUnit']) if (descendants(root, feature).length) this.warn(`RESOURCE_${feature.toUpperCase()}`, `${feature} resources may require unsupported rendering features.`);
  }
  getColorSpace(id: string): Element | undefined { return this.colorSpaces.get(id) ?? this.parent?.getColorSpace(id); }
  getParam(id: string): Element | undefined { return this.drawParams.get(id) ?? this.parent?.getParam(id); }
  font(id: string): Promise<string> {
    if (!this.fonts.has(id) && this.parent) return this.parent.font(id);
    let result = this.loadedFonts.get(id); if (result) return result;
    result = (async () => {
      const font = this.fonts.get(id), path = this.fontPaths.get(id);
      const fallback = JSON.stringify(font?.getAttribute('FamilyName') || font?.getAttribute('FontName') || 'sans-serif') + ', sans-serif';
      if (!path) { this.warn('FONT_SUBSTITUTION', 'Some fonts are not embedded; text uses locally available fonts.'); return fallback; }
      try {
        const family = `${this.namespace}_${id.replace(/[^a-z0-9]/gi, '_')}`;
        const face = await new FontFace(family, this.archive.bytes(path).slice().buffer).load();
        if (this.disposed) return fallback;
        document.fonts.add(face); this.faces.push(face); return family;
      } catch (error) { if ((error as Error)?.name === 'AbortError') throw error; this.warn('FONT_DECODE', `Unable to load embedded font ${id}; using system font.`); return fallback; }
    })(); this.loadedFonts.set(id, result); return result;
  }
  image(id: string): Promise<ImageBitmap> {
    if (!this.images.has(id) && this.parent) return this.parent.image(id);
    let result = this.loadedImages.get(id); if (result) return result;
    result = (async () => {
      const path = this.images.get(id); if (!path) throw new Error(`Missing image resource: ${id}`);
      const data = this.archive.bytes(path).slice();
      const bitmap = this.options.decodeImage
        ? await this.options.decodeImage(data, this.imageFormats.get(id) || '')
        : await createImageBitmap(new Blob([data.buffer]));
      if (this.disposed) { bitmap.close(); throw new Error('OFD document destroyed'); }
      return bitmap;
    })(); this.loadedImages.set(id, result); return result;
  }
  imageWithMask(id: string, maskID: string | null): Promise<ImageBitmap> {
    if (!maskID) return this.image(id);
    const key = JSON.stringify([id, maskID]);
    let result = this.maskedImages.get(key); if (result) return result;
    result = (async () => {
      const image = await this.image(id);
      let canvas: HTMLCanvasElement | undefined;
      try {
        const mask = await this.image(maskID);
        // OFD requires matching dimensions; resampling malformed masks can remove valid content.
        if (image.width !== mask.width || image.height !== mask.height) throw new Error('Image mask dimensions differ');
        const { width, height } = image;
        if (width * height > 16_000_000) throw new Error('Image mask pixel limit exceeded');
        canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Image mask canvas unavailable');
        ctx.drawImage(mask, 0, 0);
        const maskPixels = ctx.getImageData(0, 0, width, height).data;
        ctx.clearRect(0, 0, width, height); ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, width, height);
        for (let i = 0; i < pixels.data.length; i += 4) if (maskPixels[i] < 128) pixels.data[i + 3] = 0;
        ctx.putImageData(pixels, 0, 0);
        const bitmap = await createImageBitmap(canvas);
        if (this.disposed) { bitmap.close(); throw new Error('OFD document destroyed'); }
        return bitmap;
      } catch (error) {
        if ((error as Error)?.name === 'AbortError' || this.disposed) throw error;
        this.warn('IMAGE_MASK', 'An image mask could not be applied; retaining the original image.');
        return image;
      } finally { if (canvas) { canvas.width = 0; canvas.height = 0; } }
    })(); this.maskedImages.set(key, result); return result;
  }
  destroy() {
    this.disposed = true;
    for (const face of this.faces) document.fonts.delete(face);
    const closed = new WeakSet<ImageBitmap>();
    for (const img of [...this.loadedImages.values(), ...this.maskedImages.values()]) {
      void img.then(bitmap => { if (!closed.has(bitmap)) { closed.add(bitmap); bitmap.close(); } }, () => {});
    }
    this.loadedImages.clear(); this.maskedImages.clear(); this.loadedFonts.clear();
  }
}
export class OFDPage {
  constructor(private owner: OFDDocument, readonly pageNumber: number, readonly id: string, readonly physicalBox: Box, readonly contents: PageContent[]) {}
  getViewport({ scale = 1, rotation = 0 }: { scale?: number; rotation?: number } = {}): Viewport {
    this.owner.assertAlive();
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Scale must be positive');
    if (!Number.isFinite(rotation) || rotation % 90) throw new Error('Rotation must be a multiple of 90');
    rotation = ((rotation % 360) + 360) % 360;
    const unit = 96 / 25.4 * scale, w = this.physicalBox[2] * unit, h = this.physicalBox[3] * unit;
    return { width: rotation % 180 ? h : w, height: rotation % 180 ? w : h, scale, rotation, unit };
  }
  render(options: RenderOptions): RenderTask { this.owner.assertAlive(); return this.owner.track(renderPage(this, options, this.owner.warn)); }
  async getTextContent(): Promise<{ items: TextItem[] }> {
    this.owner.assertAlive();
    return { items: this.contents.flatMap(({ root }) => descendants(root, 'TextObject').map(el => ({ text: descendants(el, 'TextCode').map(t => t.textContent || '').join(''), boundary: boundary(el.getAttribute('Boundary')), font: el.getAttribute('Font') || '', size: Number(el.getAttribute('Size')) }))) };
  }
}
export class OFDDocument {
  readonly diagnostics: Diagnostic[] = []; readonly metadata: Record<string, string> = {};
  readonly numPages: number;
  private pages: Element[]; private pageCache = new Map<number, Promise<OFDPage>>(); private resources: Resources;
  private scopes: Resources[] = []; private templates = new Map<string, Element>(); private tasks = new Set<RenderTask>();
  private destroyed = false; private physicalBox?: Box; private annotationPath: string;
  constructor(private archive: Archive, private path: string, info?: Element, options: LoadOptions = {}) {
    const doc = archive.xml(path), common = child(doc, 'CommonData');
    if (!common) throw new Error('Missing OFD CommonData');
    const defaultArea = child(common, 'PageArea');
    if (defaultArea) this.physicalBox = box(value(defaultArea, 'PhysicalBox'));
    else this.warn('MISSING_DEFAULT_PAGE_AREA', 'Document has no default PageArea; each page must supply its own PhysicalBox.');
    this.resources = new Resources(archive, this.warn, undefined, options); this.scopes.push(this.resources);
    for (const name of ['PublicRes', 'DocumentRes']) for (const res of children(common, name)) this.resources.load(path, res.textContent!.trim());
    for (const t of children(common, 'TemplatePage')) this.templates.set(t.getAttribute('ID')!, t);
    this.pages = children(child(doc, 'Pages') ?? doc, 'Page'); this.numPages = this.pages.length;
    if (!this.numPages) throw new Error('OFD document contains no pages');
    this.annotationPath = value(doc, 'Annotations');
    if (info) for (const item of children(info)) this.metadata[item.localName] = item.textContent ?? '';
  }
  warn = (code: string, message: string) => { if (!this.diagnostics.some(d => d.code === code && d.message === message)) this.diagnostics.push({ code, message }); };
  assertAlive() { if (this.destroyed) throw new Error('OFD document destroyed'); }
  track(task: RenderTask) { this.tasks.add(task); void task.promise.then(() => this.tasks.delete(task), () => this.tasks.delete(task)); return task; }
  async getPage(pageNumber: number): Promise<OFDPage> {
    this.assertAlive();
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.numPages) throw new RangeError(`Page must be between 1 and ${this.numPages}`);
    let result = this.pageCache.get(pageNumber);
    if (!result) { result = this.parsePage(pageNumber); this.pageCache.set(pageNumber, result); }
    return result;
  }
  private scope(root: Element, path: string) {
    const resources = new Resources(this.archive, this.warn, this.resources); this.scopes.push(resources);
    for (const res of children(root, 'PageRes')) resources.load(path, res.textContent!.trim());
    return resources;
  }
  private async parsePage(n: number): Promise<OFDPage> {
    const entry = this.pages[n - 1];
    let path = this.path, root: Element;
    try {
      path = resolvePath(this.path, entry.getAttribute('BaseLoc') || '');
      root = this.archive.xml(path);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError' || !this.physicalBox) throw error;
      this.warn('PAGE_CONTENT', `Page ${n} content could not be read; preserving its place and document page size.`);
      root = document.createElementNS('http://www.ofdspec.org/2016', 'Page');
    }
    const contents: PageContent[] = [], foreground: PageContent[] = [];
    for (const t of children(root, 'Template')) {
      try {
        const template = this.templates.get(t.getAttribute('TemplateID')!);
        if (!template) throw new Error('Missing template definition');
        const tp = resolvePath(this.path, template.getAttribute('BaseLoc')!); const tr = this.archive.xml(tp);
        const content = { root: tr, resources: this.scope(tr, tp) };
        ((t.getAttribute('ZOrder') || template.getAttribute('ZOrder')) === 'Foreground' ? foreground : contents).push(content);
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') throw error;
        this.warn('MISSING_TEMPLATE', 'A referenced template page could not be read; other content is retained.');
      }
    }
    contents.push({ root, resources: this.scope(root, path) }, ...foreground);
    if (this.annotationPath) {
      try {
        const ap = resolvePath(this.path, this.annotationPath), annots = this.archive.xml(ap);
        for (const page of children(annots, 'Page')) {
          if (page.getAttribute('PageID') !== entry.getAttribute('ID')) continue;
          try {
            const file = resolvePath(ap, value(page, 'FileLoc')), ar = this.archive.xml(file);
            for (const annot of children(ar, 'Annot')) if (annot.getAttribute('Visible') !== 'false') {
              const appearance = child(annot, 'Appearance'); if (appearance) contents.push({ root: appearance, resources: this.resources });
            }
          } catch (error) {
            if ((error as Error)?.name === 'AbortError') throw error;
            this.warn('ANNOTATION_CONTENT', 'An annotation could not be read; other content is retained.');
          }
        }
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') throw error;
        this.warn('ANNOTATION_METADATA', 'Annotation metadata could not be read; other content is retained.');
      }
    }
    const pageArea = child(root, 'Area'), pageBox = pageArea && value(pageArea, 'PhysicalBox');
    if (!pageBox && !this.physicalBox) throw new Error(`Page ${n} has no PhysicalBox and the document has no default PageArea`);
    let physicalBox: Box;
    try { physicalBox = box(pageBox, this.physicalBox); }
    catch (error) {
      if (!this.physicalBox) throw error;
      physicalBox = this.physicalBox;
      this.warn('PAGE_AREA', 'Invalid page area; using the document page size.');
    }
    return new OFDPage(this, n, entry.getAttribute('ID') || '', physicalBox, contents);
  }
  destroy() { if (this.destroyed) return; this.destroyed = true; for (const task of this.tasks) task.cancel(); for (const scope of this.scopes) scope.destroy(); this.pageCache.clear(); this.archive.clear(); }
}
export async function getDocument(source: OFDSource, options: LoadOptions = {}): Promise<OFDDocument> {
  const archive = await openArchive(source, options);
  try {
    abort(options.signal);
    const root = archive.xml('OFD.xml'); if (root.localName !== 'OFD') throw new Error('Invalid OFD root');
    const bodies = children(root, 'DocBody'), index = options.documentIndex ?? 0;
    if (!Number.isInteger(index) || index < 0 || !bodies[index]) throw new Error('OFD document index out of range');
    const body = bodies[index], doc = new OFDDocument(archive, resolvePath('OFD.xml', value(body, 'DocRoot')), child(body, 'DocInfo'), options);
    if (value(body, 'Signatures')) doc.warn('SIGNATURE_UNSUPPORTED', 'Digital signatures and embedded seals are not rendered or verified.');
    if (bodies.length > 1) doc.warn('MULTI_DOCUMENT', `Archive has ${bodies.length} documents; selected index ${index}.`);
    return doc;
  } catch (error) { archive.clear(); throw error; }
}
