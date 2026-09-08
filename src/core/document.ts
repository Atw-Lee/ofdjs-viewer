import { Archive, openArchive, abort, type LoadOptions, type OFDSource } from './archive.js';
import { box, child, children, descendants, resolvePath, value, type Box } from './xml.js';
import { renderPage, type RenderOptions, type RenderTask, type Viewport } from './render.js';
export interface Diagnostic { code: string; message: string; }
export interface TextItem { text: string; boundary: Box; font: string; size: number; }
export interface PageContent { root: Element; resources: Resources; }
let documentSequence = 0;
export class Resources {
  colorSpaces = new Map<string, Element>(); fonts = new Map<string, Element>(); images = new Map<string, string>(); drawParams = new Map<string, Element>();
  private fontPaths = new Map<string, string>(); private loadedFonts = new Map<string, Promise<string>>();
  private loadedImages = new Map<string, Promise<ImageBitmap>>(); private faces: FontFace[] = []; private disposed = false;
  private namespace = `ofd_${++documentSequence}`;
  constructor(private archive: Archive, private warn: (code: string, message: string) => void, readonly parent?: Resources) {}
  load(path: string) {
    if (!this.archive.has(path)) { this.warn('MISSING_RESOURCE', `Referenced resource file is absent: ${path}`); return; }
    const root = this.archive.xml(path);
    const base = resolvePath(path, `${root.getAttribute('BaseLoc') || '.'}/__resource__`);
    for (const font of descendants(root, 'Font')) {
      const id = font.getAttribute('ID')!; this.fonts.set(id, font);
      if (value(font, 'FontFile')) this.fontPaths.set(id, resolvePath(base, value(font, 'FontFile')));
    }
    for (const media of descendants(root, 'MultiMedia')) {
      if (media.getAttribute('Type') === 'Image') this.images.set(media.getAttribute('ID')!, resolvePath(base, value(media, 'MediaFile')));
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
      } catch { this.warn('FONT_DECODE', `Unable to load embedded font ${id}; using system font.`); return fallback; }
    })(); this.loadedFonts.set(id, result); return result;
  }
  image(id: string): Promise<ImageBitmap> {
    if (!this.images.has(id) && this.parent) return this.parent.image(id);
    let result = this.loadedImages.get(id); if (result) return result;
    result = (async () => {
      const path = this.images.get(id); if (!path) throw new Error(`Missing image resource: ${id}`);
      const data = this.archive.bytes(path).slice();
      const bitmap = await createImageBitmap(new Blob([data.buffer]));
      if (this.disposed) { bitmap.close(); throw new Error('OFD document destroyed'); }
      return bitmap;
    })(); this.loadedImages.set(id, result); return result;
  }
  destroy() { this.disposed = true; for (const face of this.faces) document.fonts.delete(face); for (const img of this.loadedImages.values()) void img.then(b => b.close(), () => {}); this.loadedImages.clear(); this.loadedFonts.clear(); }
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
    return { items: this.contents.flatMap(({ root }) => descendants(root, 'TextObject').map(el => ({ text: descendants(el, 'TextCode').map(t => t.textContent || '').join(''), boundary: box(el.getAttribute('Boundary')), font: el.getAttribute('Font') || '', size: Number(el.getAttribute('Size')) }))) };
  }
}
export class OFDDocument {
  readonly diagnostics: Diagnostic[] = []; readonly metadata: Record<string, string> = {};
  readonly numPages: number;
  private pages: Element[]; private pageCache = new Map<number, Promise<OFDPage>>(); private resources: Resources;
  private scopes: Resources[] = []; private templates = new Map<string, Element>(); private tasks = new Set<RenderTask>();
  private destroyed = false; private physicalBox?: Box; private annotationPath: string;
  constructor(private archive: Archive, private path: string, info?: Element) {
    const doc = archive.xml(path), common = child(doc, 'CommonData');
    if (!common) throw new Error('Missing OFD CommonData');
    const defaultArea = child(common, 'PageArea');
    if (defaultArea) this.physicalBox = box(value(defaultArea, 'PhysicalBox'));
    else this.warn('MISSING_DEFAULT_PAGE_AREA', 'Document has no default PageArea; each page must supply its own PhysicalBox.');
    this.resources = new Resources(archive, this.warn); this.scopes.push(this.resources);
    for (const name of ['PublicRes', 'DocumentRes']) for (const res of children(common, name)) this.resources.load(resolvePath(path, res.textContent!.trim()));
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
    for (const res of children(root, 'PageRes')) resources.load(resolvePath(path, res.textContent!.trim()));
    return resources;
  }
  private async parsePage(n: number): Promise<OFDPage> {
    const entry = this.pages[n - 1], path = resolvePath(this.path, entry.getAttribute('BaseLoc') || '');
    const root = this.archive.xml(path), contents: PageContent[] = [], foreground: PageContent[] = [];
    for (const t of children(root, 'Template')) {
      const template = this.templates.get(t.getAttribute('TemplateID')!);
      if (!template) { this.warn('MISSING_TEMPLATE', 'A referenced template page is missing.'); continue; }
      const tp = resolvePath(this.path, template.getAttribute('BaseLoc')!); const tr = this.archive.xml(tp);
      const content = { root: tr, resources: this.scope(tr, tp) };
      ((t.getAttribute('ZOrder') || template.getAttribute('ZOrder')) === 'Foreground' ? foreground : contents).push(content);
    }
    contents.push({ root, resources: this.scope(root, path) }, ...foreground);
    if (this.annotationPath) {
      const ap = resolvePath(this.path, this.annotationPath), annots = this.archive.xml(ap);
      for (const page of children(annots, 'Page')) if (page.getAttribute('PageID') === entry.getAttribute('ID')) {
        const file = resolvePath(ap, value(page, 'FileLoc')), ar = this.archive.xml(file);
        for (const annot of children(ar, 'Annot')) if (annot.getAttribute('Visible') !== 'false') {
          const appearance = child(annot, 'Appearance'); if (appearance) contents.push({ root: appearance, resources: this.resources });
        }
      }
    }
    const pageArea = child(root, 'Area'), pageBox = pageArea && value(pageArea, 'PhysicalBox');
    if (!pageBox && !this.physicalBox) throw new Error(`Page ${n} has no PhysicalBox and the document has no default PageArea`);
    return new OFDPage(this, n, entry.getAttribute('ID') || '', box(pageBox, this.physicalBox), contents);
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
    const body = bodies[index], doc = new OFDDocument(archive, resolvePath('OFD.xml', value(body, 'DocRoot')), child(body, 'DocInfo'));
    if (value(body, 'Signatures')) doc.warn('SIGNATURE_UNSUPPORTED', 'Digital signatures and embedded seals are not rendered or verified.');
    if (bodies.length > 1) doc.warn('MULTI_DOCUMENT', `Archive has ${bodies.length} documents; selected index ${index}.`);
    return doc;
  } catch (error) { archive.clear(); throw error; }
}
