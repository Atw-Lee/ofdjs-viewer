import { getSealDocument, type OFDDocument } from './document.js';
import type { Archive, LoadOptions } from './archive.js';
import { box, child, children, descendants, resolvePath, value, type Box } from './xml.js';

interface SealSource { path: string; standalone: boolean; }
interface SealStamp { key: string; sources: SealSource[]; boundary: Box; clip?: Box; }
interface LoadedSeal { document?: OFDDocument; image?: ImageBitmap; }
interface ASNNode { tag: number; start: number; end: number; }

// Read only the SES picture field. This is appearance extraction, not signature
// verification. Definite ASN.1 lengths and fixed schema paths prevent scanning
// certificate/signature payloads for arbitrary image-like bytes.
function picture(bytes: Uint8Array, standalone: boolean): { format: string; bytes: Uint8Array } {
    const read = (start: number, limit: number): ASNNode => {
        if (start + 2 > limit)
            throw new Error('Truncated SES value');
        const tag = bytes[start];
        let length = bytes[start + 1], offset = start + 2;
        if (length & 128) {
            const count = length & 127;
            if (!count || count > 4 || offset + count > limit)
                throw new Error('Unsupported SES length');
            length = 0;
            for (let i = 0; i < count; i++)
                length = length * 256 + bytes[offset++];
        }
        const end = offset + length;
        if (end > limit)
            throw new Error('Truncated SES field');
        return { tag, start: offset, end };
    };
    const fields = (node: ASNNode): ASNNode[] => {
        if (node.tag !== 48)
            throw new Error('Expected SES sequence');
        const result: ASNNode[] = [];
        for (let offset = node.start; offset < node.end;) {
            const item = read(offset, node.end);
            result.push(item);
            offset = item.end;
            if (result.length > 64)
                throw new Error('SES sequence limit exceeded');
        }
        return result;
    };
    let node = read(0, bytes.length);
    if (node.end !== bytes.length)
        throw new Error('Unexpected trailing SES data');
    for (const index of standalone ? [0, 3] : [0, 1, 0, 3]) {
        node = fields(node)[index];
        if (!node)
            throw new Error('Missing SES picture');
    }
    const [type, data, width, height] = fields(node);
    if (type?.tag !== 22 || data?.tag !== 4 || width?.tag !== 2 || height?.tag !== 2)
        throw new Error('Unsupported SES picture structure');
    const format = new TextDecoder().decode(bytes.subarray(type.start, type.end)).toLowerCase();
    if (!['png', 'ofd', 'jpg', 'jpeg'].includes(format))
        throw new Error('Unsupported SES picture format');
    return { format, bytes: bytes.slice(data.start, data.end) };
}

export class SealStore {
    private pages = new Map<string, SealStamp[]>();
    private loaded = new Map<string, Promise<LoadedSeal>>();
    private disposed = false;
    constructor(private owner: OFDDocument, private archive: Archive, private options: LoadOptions, private depth: number) {}
    load(path: string): void {
        // A nested seal's own signatures do not add to its appearance.
        if (this.depth)
            return;
        try {
            for (const entry of children(this.archive.xml(path), 'Signature')) {
                try {
                    const signaturePath = resolvePath(path, entry.getAttribute('BaseLoc') || '');
                    const signature = this.archive.xml(signaturePath);
                    const info = child(signature, 'SignedInfo');
                    if (!info)
                        continue;
                    const signedValue = value(signature, 'SignedValue');
                    const seal = child(info, 'Seal');
                    const standalone = seal && value(seal, 'BaseLoc');
                    const sources: SealSource[] = [];
                    if (signedValue)
                        sources.push({ path: resolvePath(signaturePath, signedValue), standalone: false });
                    if (standalone)
                        sources.push({ path: resolvePath(signaturePath, standalone), standalone: true });
                    for (const annot of descendants(info, 'StampAnnot')) {
                        try {
                            const id = annot.getAttribute('PageRef') || '';
                            const stamps = this.pages.get(id) || [];
                            stamps.push({ key: signaturePath, sources, boundary: box(annot.getAttribute('Boundary')),
                                clip: annot.hasAttribute('Clip') ? box(annot.getAttribute('Clip')) : undefined });
                            this.pages.set(id, stamps);
                        } catch {
                            this.owner.warn('SEAL_POSITION', 'An electronic seal position is invalid; other stamps are retained.');
                        }
                    }
                } catch {
                    this.owner.warn('SEAL_METADATA', 'An electronic seal reference could not be read; other content is retained.');
                }
            }
        } catch {
            this.owner.warn('SEAL_METADATA', 'Electronic seal metadata could not be read; other content is retained.');
        }
    }
    get(stamp: SealStamp): Promise<LoadedSeal> {
        if (!this.loaded.has(stamp.key)) {
            const pending: Promise<LoadedSeal> = (async () => {
                for (const source of stamp.sources) {
                    try {
                        const extracted = picture(this.archive.bytes(source.path), source.standalone);
                        const result: LoadedSeal = extracted.format === 'ofd'
                            ? { document: await getSealDocument(extracted.bytes, this.options, this.depth + 1) }
                            : { image: await createImageBitmap(new Blob([new Uint8Array(extracted.bytes)])) };
                        if (this.disposed) {
                            result.document?.destroy();
                            result.image?.close();
                            throw new Error('OFD document destroyed');
                        }
                        return result;
                    } catch (error) {
                        if ((error as Error)?.name === 'AbortError' || this.disposed) throw error;
                        // Try a standalone seal when SignedValue's picture cannot decode.
                    }
                }
                throw new Error('Electronic seal picture unavailable');
            })();
            this.loaded.set(stamp.key, pending);
        }
        return this.loaded.get(stamp.key)!;
    }
    async render(pageID: string, ctx: CanvasRenderingContext2D, unit: number, signal: AbortSignal, maxCanvasPixels: number): Promise<void> {
        for (const stamp of this.pages.get(pageID) || []) {
            let temporary: HTMLCanvasElement | undefined;
            ctx.save();
            try {
                signal.throwIfAborted();
                const [x, y, width, height] = stamp.boundary;
                if (width <= 0 || height <= 0)
                    continue;
                const seal = await this.get(stamp);
                signal.throwIfAborted();
                let image: CanvasImageSource | undefined = seal.image;
                if (seal.document) {
                    const page = await seal.document.getPage(1);
                    signal.throwIfAborted();
                    const targetWidth = Math.max(1, Math.ceil(width * unit));
                    const targetHeight = Math.max(1, Math.ceil(height * unit));
                    const base = page.getViewport();
                    // Render the embedded document at sufficient density for both
                    // axes before fitting it into StampAnnot's physical boundary.
                    const scale = Math.max(targetWidth / base.width, targetHeight / base.height);
                    let viewport = page.getViewport({ scale });
                    const area = Math.ceil(viewport.width) * Math.ceil(viewport.height);
                    if (area > maxCanvasPixels)
                        viewport = page.getViewport({ scale: scale * Math.sqrt(maxCanvasPixels / area) * 0.99 });
                    temporary = document.createElement('canvas');
                    const context = temporary.getContext('2d');
                    if (!context)
                        throw new Error('Unable to create seal canvas');
                    await page.render({ canvasContext: context, viewport, pixelRatio: 1,
                        background: 'rgba(0,0,0,0)', signal, maxCanvasPixels }).promise;
                    signal.throwIfAborted();
                    for (const diagnostic of seal.document.diagnostics)
                        this.owner.warn(`SEAL_${diagnostic.code}`, diagnostic.message);
                    image = temporary;
                }
                ctx.translate(x, y);
                ctx.beginPath();
                ctx.rect(0, 0, width, height);
                ctx.clip();
                if (stamp.clip) {
                    ctx.beginPath();
                    ctx.rect(...stamp.clip);
                    ctx.clip();
                }
                if (!image) throw new Error('Electronic seal picture unavailable');
                ctx.drawImage(image, 0, 0, width, height);
            } catch (error) {
                signal.throwIfAborted();
                if ((error as Error)?.name === 'AbortError') throw error;
                this.owner.warn('SEAL_RENDER', 'An electronic seal could not be drawn; other content is retained.');
            } finally {
                ctx.restore();
                if (temporary) {
                    temporary.width = 0;
                    temporary.height = 0;
                }
            }
        }
    }
    destroy() {
        this.disposed = true;
        for (const pending of this.loaded.values())
            void pending.then(seal => { seal.image?.close(); seal.document?.destroy(); }, () => {});
        this.loaded.clear();
        this.pages.clear();
    }
}
