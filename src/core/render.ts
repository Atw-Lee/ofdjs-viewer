import type { OFDPage, Resources } from './document.js';
import type { GlyphFont } from './archive.js';
import { boundary, child, children, colorNumbers, expandDeltas, numberAttr, numbers, value } from './xml.js';
import { drawPath } from './path.js';
export interface Viewport { width: number; height: number; scale: number; rotation: number; unit: number; }
export interface RenderOptions { canvasContext: CanvasRenderingContext2D; viewport: Viewport; pixelRatio?: number; background?: string; signal?: AbortSignal; maxCanvasPixels?: number; }
export interface RenderTask { promise: Promise<void>; cancel(): void; }
const busy = new WeakSet<HTMLCanvasElement>();
type Warn = (code: string, message: string) => void;
export function renderPage(page: OFDPage, options: RenderOptions, warn: Warn): RenderTask {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const promise = (async () => {
    const { canvasContext: ctx, viewport: v, pixelRatio = globalThis.devicePixelRatio || 1, background = '#fff', maxCanvasPixels = 32_000_000 } = options;
    if (![v.width, v.height, v.unit, pixelRatio].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid viewport or pixel ratio');
    const width = Math.ceil(v.width * pixelRatio), height = Math.ceil(v.height * pixelRatio);
    if (width * height > maxCanvasPixels) throw new Error('Canvas pixel limit exceeded; reduce scale or pixelRatio');
    const signal = controller.signal, canvas = ctx.canvas;
    signal.throwIfAborted();
    if (busy.has(canvas)) throw new Error('Canvas is already rendering; await the previous render task');
    busy.add(canvas);
    try {
      // Await resources before touching the destination. Recheck cancellation after every await.
      const fontNames = new Map<Element, string>(), glyphFonts = new Map<Element, GlyphFont | undefined>(), images = new Map<Element, ImageBitmap>();
      for (const { root, resources } of page.contents) {
        for (const el of [root, ...Array.from(root.getElementsByTagName('*'))]) {
          signal.throwIfAborted();
          if (el.localName === 'TextObject') {
            try {
              const id = el.getAttribute('Font') || '';
              fontNames.set(el, await resources.font(id));
              signal.throwIfAborted();
              if (child(el, 'CGTransform')) glyphFonts.set(el, await resources.glyphFont(id));
            } catch (error) {
              rethrowAbort(signal, error);
              warn('FONT_DECODE', `Font ${el.getAttribute('Font')} could not be loaded; using a local fallback.`);
            }
            signal.throwIfAborted();
          }
          if (el.localName === 'ImageObject') {
            try { images.set(el, await resources.image(el.getAttribute('ResourceID') || '')); }
            catch (e) { signal.throwIfAborted(); if ((e as Error)?.name === 'AbortError') throw e; warn('IMAGE_DECODE', `Image ${el.getAttribute('ResourceID')} could not be decoded (PNG/JPEG/WebP supported): ${String(e)}`); }
            signal.throwIfAborted();
          }
        }
      }
      signal.throwIfAborted(); canvas.width = width; canvas.height = height;
      canvas.style.width = `${v.width}px`; canvas.style.height = `${v.height}px`;
      ctx.save();
      try {
        ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
        ctx.scale(pixelRatio, pixelRatio);
        if (v.rotation === 90) { ctx.translate(v.width, 0); ctx.rotate(Math.PI / 2); }
        else if (v.rotation === 180) { ctx.translate(v.width, v.height); ctx.rotate(Math.PI); }
        else if (v.rotation === 270) { ctx.translate(0, v.height); ctx.rotate(-Math.PI / 2); }
        ctx.scale(v.unit, v.unit); ctx.translate(-page.physicalBox[0], -page.physicalBox[1]);
        let count = 0;
        const paint = async (el: Element, resources: Resources, inherited: Element[] = []): Promise<void> => {
          signal.throwIfAborted();
          if (++count % 100 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); signal.throwIfAborted(); }
          if (el.getAttribute('Visible') === 'false') return;
          const type = el.localName;
          if (['Area', 'Template', 'PageRes', 'Actions'].includes(type)) return;
          if (['CompositeObject', 'VideoObject'].includes(type)) { warn(`UNSUPPORTED_${type}`, `${type} is not supported.`); return; }
          ctx.save();
          try {
            const chain = [...inherited, ...paramChain(resources, el.getAttribute('DrawParam')), el];
            if (el.hasAttribute('Boundary') && (type.endsWith('Object') || type === 'Appearance')) {
              const [x, y, w, h] = boundary(el.getAttribute('Boundary')); ctx.translate(x, y);
              if (type === 'TextObject' && (w === 0 || h === 0)) {
                // Some producers retain TextCode/CTM but emit an empty boundary.
                warn('ZERO_TEXT_BOUNDARY', 'Text with a zero-size Boundary is rendered without boundary clipping; its extent may differ from the source.');
              } else {
                ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
              }
            }
            const ctm = numbers(el.getAttribute('CTM'));
            if (ctm.length) { if (ctm.length !== 6) throw new Error('Invalid CTM'); ctx.transform(ctm[0], ctm[1], ctm[2], ctm[3], ctm[4], ctm[5]); }
            if (el.hasAttribute('Alpha')) ctx.globalAlpha *= numberAttr(el, 'Alpha', 255) / 255;
            applyStyle(ctx, chain, resources, warn);
            applyClips(ctx, el, warn);
            if (type === 'TextObject') {
              const glyphFont = glyphFonts.get(el);
              if (child(el, 'CGTransform') && !glyphFont) warn('GLYPH_TRANSFORM', 'Embedded glyph outlines are unavailable; using text as a fallback.');
              const readDirection = textDirection(el, 'ReadDirection');
              const charDirection = textDirection(el, 'CharDirection');
              const size = numberAttr(el, 'Size', 3.5);
              const hScale = numberAttr(el, 'HScale', 1);
              ctx.font = `${el.getAttribute('Italic') === 'true' ? 'italic ' : ''}${el.getAttribute('Weight') || (el.getAttribute('Bold') === 'true' ? '700' : '400')} ${size}px ${fontNames.get(el) || 'sans-serif'}`;
              ctx.textBaseline = 'alphabetic';
              // Omitted X/Y inherit the previous TextCode origin, not its final cursor.
              let originX = 0, originY = 0;
              let transforms: Element[] = [];
              for (const code of children(el)) {
                if (code.localName === 'CGTransform') { transforms.push(code); continue; }
                if (code.localName !== 'TextCode') continue;
                originX = numberAttr(code, 'X', originX);
                originY = numberAttr(code, 'Y', originY);
                let x = originX, y = originY;
                const dx = expandDeltas(code.getAttribute('DeltaX')), dy = expandDeltas(code.getAttribute('DeltaY'));
                const naturalSpacing = !code.hasAttribute('DeltaX') && !code.hasAttribute('DeltaY');
                // Prepare the entire run before painting: a later outline or metric
                // failure must not leave earlier mapped glyphs on the canvas.
                const prepare = (glyph: Glyph) => {
                  const outline = glyph.index === undefined ? undefined : new Path2D(glyphFont!.path(glyph.index, size));
                  const advance = naturalSpacing
                    ? (glyph.index === undefined ? ctx.measureText(glyph.text).width : glyphFont!.advance(glyph.index, size)) * hScale
                    : 0;
                  if (!Number.isFinite(advance)) throw new Error('Invalid glyph advance');
                  return { text: glyph.text, outline, advance };
                };
                let glyphs;
                try {
                  glyphs = glyphRun(code, transforms, glyphFont, warn).map(prepare);
                } catch (error) {
                  rethrowAbort(signal, error);
                  warn('GLYPH_RENDER', 'An embedded glyph could not be drawn; using text as a fallback.');
                  glyphs = Array.from(code.textContent || '').map(text => prepare({ text }));
                }
                transforms = [];
                if (naturalSpacing && glyphs.length > 1) warn('TEXT_POSITION_FALLBACK', 'Text has no explicit glyph advances; using local font metrics.');
                for (let i = 0; i < glyphs.length; i++) {
                  const { text, outline, advance } = glyphs[i];
                  ctx.save();
                  try {
                    ctx.translate(x, y);
                    ctx.rotate(charDirection * Math.PI / 180);
                    ctx.scale(hScale, 1);
                    if (outline) {
                      if (el.getAttribute('Fill') !== 'false') ctx.fill(outline);
                      if (el.getAttribute('Stroke') === 'true') ctx.stroke(outline);
                    } else {
                      if (el.getAttribute('Fill') !== 'false') ctx.fillText(text, 0, 0);
                      if (el.getAttribute('Stroke') === 'true') ctx.strokeText(text, 0, 0);
                    }
                  } finally { ctx.restore(); }
                  if (naturalSpacing) {
                    if (readDirection === 0) x += advance;
                    else if (readDirection === 90) y += advance;
                    else if (readDirection === 180) x -= advance;
                    else y -= advance;
                  } else {
                    x += dx[i] ?? (dx.length ? dx[dx.length - 1] : 0);
                    y += dy[i] ?? (dy.length ? dy[dy.length - 1] : 0);
                  }
                }
              }
            } else if (type === 'PathObject') {
              drawPath(ctx, value(el, 'AbbreviatedData'));
              if (el.getAttribute('Fill') === 'true') ctx.fill(el.getAttribute('Rule') === 'Even-Odd' ? 'evenodd' : 'nonzero');
              if (el.getAttribute('Stroke') !== 'false') ctx.stroke();
            } else if (type === 'ImageObject') {
              const image = images.get(el); if (image) ctx.drawImage(image, 0, 0, 1, 1);
              if (el.hasAttribute('Mask') || el.hasAttribute('Substitution')) warn('IMAGE_MASK', 'Image masks and substitutions are not supported.');
            } else {
              let nodes = children(el);
              if (type === 'Content') nodes = nodes.map((node, index) => ({ node, index })).sort((a, b) => layerOrder(a.node) - layerOrder(b.node) || a.index - b.index).map(x => x.node);
              for (const nested of nodes) await paint(nested, resources, chain);
            }
          } catch (error) {
            signal.throwIfAborted();
            if ((error as Error)?.name === 'AbortError') throw error;
            warn('OBJECT_RENDER', `${type} ${el.getAttribute('ID') || ''} could not be rendered; continuing with the remaining page content.`);
          } finally { ctx.restore(); }
        };
        for (const { root, resources } of page.contents) await paint(root, resources);
      } finally { ctx.restore(); }
    } finally { busy.delete(canvas); }
  })().finally(() => options.signal?.removeEventListener('abort', onAbort));
  return { promise, cancel: () => controller.abort(new DOMException('Rendering cancelled', 'AbortError')) };
}
interface Glyph { text: string; index?: number; }
// CT_Text repeats (CGTransform*, TextCode). Mappings address characters in the
// following TextCode; DeltaX/Y then address the resulting glyph sequence.
function glyphRun(code: Element, transforms: Element[], font: GlyphFont | undefined, warn: Warn): Glyph[] {
  const chars = Array.from(code.textContent || '');
  const fallback = () => chars.map(text => ({ text }));
  if (!font || !transforms.length) return fallback();
  try {
    const mappings = transforms.map(el => {
      const start = numberAttr(el, 'CodePosition', -1);
      const count = numberAttr(el, 'CodeCount', 1);
      const glyphCount = numberAttr(el, 'GlyphCount', 1);
      const indices = numbers(value(el, 'Glyphs'));
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 1
          || start + count > chars.length || !Number.isInteger(glyphCount) || glyphCount < 1
          || indices.length !== glyphCount || indices.some(n => !Number.isInteger(n) || n < 0)) {
        throw new Error('Invalid glyph mapping');
      }
      return { start, count, indices };
    }).sort((a, b) => a.start - b.start);
    const result: Glyph[] = [];
    let offset = 0;
    for (const mapping of mappings) {
      if (mapping.start < offset) throw new Error('Overlapping glyph mappings');
      while (offset < mapping.start) result.push({ text: chars[offset++] });
      const text = chars.slice(offset, offset + mapping.count).join('');
      for (let i = 0; i < mapping.indices.length; i++) result.push({ index: mapping.indices[i], text: i === 0 ? text : '' });
      offset += mapping.count;
    }
    while (offset < chars.length) result.push({ text: chars[offset++] });
    return result;
  } catch {
    warn('GLYPH_MAPPING', 'Invalid embedded glyph mapping; using text as a fallback.');
    return fallback();
  }
}
function rethrowAbort(signal: AbortSignal, error: unknown): void {
  signal.throwIfAborted();
  if ((error as Error)?.name === 'AbortError') throw error;
}
function textDirection(el: Element, name: string): number {
  const direction = numberAttr(el, name);
  if (![0, 90, 180, 270].includes(direction)) throw new Error(`Invalid ${name}`);
  return direction;
}
function layerOrder(el: Element) { return el.getAttribute('Type') === 'Background' ? 0 : el.getAttribute('Type') === 'Foreground' ? 2 : 1; }
function paramChain(resources: Resources, id: string | null, seen = new Set<string>()): Element[] {
  if (!id) return [];
  if (seen.has(id)) throw new Error('Circular DrawParam reference');
  seen.add(id); const el = resources.getParam(id);
  if (!el) return [];
  return [...paramChain(resources, el.getAttribute('Relative'), seen), el];
}
function applyStyle(ctx: CanvasRenderingContext2D, chain: Element[], resources: Resources, warn: Warn) {
  const attr = (name: string) => [...chain].reverse().find(el => el.hasAttribute(name))?.getAttribute(name);
  const color = (name: string): string => {
    const node = [...chain].reverse().map(el => child(el, name)).find(Boolean);
    if (!node) return '#000';
    if (children(node).length) warn('COLOR_EFFECT', 'Gradient and pattern colors are not supported.');
    const space = resources.getColorSpace(node.getAttribute('ColorSpace') || '');
    if (space?.hasAttribute('Profile')) warn('ICC_PROFILE', 'ICC color profiles are not applied.');
    let raw = node.getAttribute('Value');
    if (node.hasAttribute('Index')) {
      const palette = space && child(space, 'Palette');
      raw = palette ? children(palette, 'CV')[numberAttr(node, 'Index')]?.textContent ?? null : null;
      if (!raw) warn('COLOR_INDEX', 'A palette color could not be resolved.');
    }
    const bits = space ? numberAttr(space, 'BitsPerComponent', 8) : 8;
    const ns = colorNumbers(raw).map(n => n * 255 / (2 ** bits - 1)); let rgb: number[];
    if (ns.length === 1) rgb = [ns[0], ns[0], ns[0]];
    else if (ns.length === 4) rgb = ns.slice(0, 3).map(n => 255 * (1 - n / 255) * (1 - ns[3] / 255));
    else rgb = ns.length === 3 ? ns : [0, 0, 0];
    return `rgba(${rgb.map(n => Math.min(255, Math.max(0, n))).join(',')},${numberAttr(node, 'Alpha', 255) / 255})`;
  };
  ctx.fillStyle = color('FillColor'); ctx.strokeStyle = color('StrokeColor');
  const width = Number(attr('LineWidth') ?? .353); ctx.lineWidth = Number.isFinite(width) && width > 0 ? width : .01;
  ctx.lineCap = ({ Butt: 'butt', Round: 'round', Square: 'square' } as const)[attr('Cap') as 'Butt'] || 'butt';
  ctx.lineJoin = ({ Miter: 'miter', Round: 'round', Bevel: 'bevel' } as const)[attr('Join') as 'Miter'] || 'miter';
  ctx.miterLimit = Number(attr('MiterLimit') || 10); ctx.setLineDash(numbers(attr('DashPattern'))); ctx.lineDashOffset = Number(attr('DashOffset') || 0);
}

function applyClips(ctx: CanvasRenderingContext2D, el: Element, warn: Warn) {
  const clips = child(el, 'Clips'); if (!clips) return;
  for (const clip of children(clips, 'Clip')) {
    if (children(clip, 'Area').flatMap(area => children(area, 'Path')).length > 1)
      warn('CLIP_UNION_APPROXIMATION', 'Overlapping clip regions may not preserve independent fill rules.');
    const combined = new Path2D(); let supported = false, rule: CanvasFillRule = 'nonzero';
    for (const area of children(clip, 'Area')) {
      const matrix = new DOMMatrix(); const ac = numbers(area.getAttribute('CTM'));
      if (ac.length === 6) matrix.multiplySelf(new DOMMatrix(ac));
      for (const path of children(area)) {
        if (path.localName !== 'Path') { warn('TEXT_CLIP', 'Text clipping shapes are not supported.'); continue; }
        const transform = new DOMMatrix(Array.from(matrix.toFloat64Array()));
        if (path.hasAttribute('Boundary')) { const [x, y] = boundary(path.getAttribute('Boundary')); transform.translateSelf(x, y); }
        const ctm = numbers(path.getAttribute('CTM')); if (ctm.length === 6) transform.multiplySelf(new DOMMatrix(ctm));
        const shape = new Path2D(); drawPath(shape, value(path, 'AbbreviatedData'));
        combined.addPath(shape, transform); supported = true;
        if (path.getAttribute('Rule') === 'Even-Odd') rule = 'evenodd';
      }
    }
    if (supported) ctx.clip(combined, rule);
  }
}
