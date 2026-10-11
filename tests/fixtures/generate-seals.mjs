// Original synthetic SES appearances; dummy credentials do not validate signatures.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { zipSync } from 'fflate';

const xml = (name, body) => Buffer.from(`<ofd:${name} xmlns:ofd="http://www.ofdspec.org/2016">${body}</ofd:${name}>`);
function archive(files) {
  // ZIP records local calendar fields, so use the same fixed local date in every timezone.
  return zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) });
}
function png(width, height, pixel) {
  function chunk(kind, data) {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length); out.write(kind, 4); data.copy(out, 8);
    let crc = 0xffffffff;
    for (const byte of out.subarray(4, 8 + data.length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
    return out;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.concat(Array.from({ length: height }, (_, y) =>
    Buffer.from([0, ...Array.from({ length: width }, (_, x) => pixel(x, y)).flat()])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function der(tag, payload) {
  const length = [];
  for (let size = payload.length; size; size = Math.floor(size / 256)) length.unshift(size & 255);
  return Buffer.concat([Buffer.from([tag, ...(payload.length < 128 ? [payload.length] : [128 + length.length, ...length])]), payload]);
}
const seq = (...items) => der(48, Buffer.concat(items));
const integer = value => der(2, Buffer.from([value]));
const text = (value, tag = 22) => der(tag, Buffer.from(value));
function ses(picture, kind) {
  // SES v4/2020 structure. Certificate and signature are deliberately fake.
  const certificate = der(4, Buffer.alloc(0));
  const algorithm = der(6, Buffer.from('2a811ccf55018375', 'hex'));
  const signature = der(3, Buffer.alloc(65));
  const date = text('20240101000000Z', 24);
  const info = seq(seq(text('ES'), integer(4), text('synthetic')), text('fixture'),
    seq(integer(1), text('appearance', 12), integer(1), seq(certificate), date, date, date),
    seq(text(kind), der(4, picture), integer(20), integer(20)));
  const seal = seq(info, certificate, algorithm, signature);
  return seq(seq(integer(4), seal, date, der(3, Buffer.alloc(33)), text('appearance-only')),
    certificate, algorithm, signature);
}
function rect(x, y, width, height, color) {
  return `<ofd:PathObject Boundary="${x} ${y} ${width} ${height}" Fill="true" Stroke="false"><ofd:FillColor Value="${color}"/><ofd:AbbreviatedData>M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} C</ofd:AbbreviatedData></ofd:PathObject>`;
}
function document(width, height, content, signatures = false) {
  return {
    'OFD.xml': xml('OFD', '<ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>'
      + (signatures ? '<ofd:Signatures>Doc_0/Signs/Signatures.xml</ofd:Signatures>' : '') + '</ofd:DocBody>'),
    'Doc_0/Document.xml': xml('Document', `<ofd:CommonData><ofd:PageArea><ofd:PhysicalBox>0 0 ${width} ${height}</ofd:PhysicalBox></ofd:PageArea></ofd:CommonData><ofd:Pages><ofd:Page ID="1" BaseLoc="Pages/1.xml"/></ofd:Pages>`),
    'Doc_0/Pages/1.xml': xml('Page', `<ofd:Content><ofd:Layer ID="1">${content}</ofd:Layer></ofd:Content>`),
  };
}
function signature(boundary, clip = '') {
  return xml('Signature', `<ofd:SignedInfo><ofd:StampAnnot PageRef="1" Boundary="${boundary}"${clip}/></ofd:SignedInfo><ofd:SignedValue>SignedValue.dat</ofd:SignedValue>`);
}
const nested = archive(document(30, 20, rect(0, 0, 15, 20, '220 30 40') + rect(15, 0, 15, 5, '20 60 220')));
const ring = png(20, 20, (x, y) => x < 3 || x > 16 || y < 3 || y > 16 ? [220, 30, 40, 255] : [0, 0, 0, 0]);
const main = {
  ...document(80, 50, rect(0, 0, 80, 50, '20 180 40'), true),
  'Doc_0/Signs/Signatures.xml': xml('Signatures', '<ofd:Signature BaseLoc="PNG/Signature.xml"/><ofd:Signature BaseLoc="OFD/Signature.xml"/>'),
  'Doc_0/Signs/PNG/Signature.xml': signature('10 10 20 20', ' Clip="0 0 10 20"'),
  'Doc_0/Signs/PNG/SignedValue.dat': ses(ring, 'png'),
  'Doc_0/Signs/OFD/Signature.xml': signature('40 10 30 20'),
  'Doc_0/Signs/OFD/SignedValue.dat': ses(nested, 'ofd'),
};
const output = new URL('./seal-appearances.ofd', import.meta.url);
const bytes = Buffer.from(archive(main));
if (process.argv.includes('--check')) {
  if (!readFileSync(output).equals(bytes)) throw new Error('Seal fixture is stale; run node tests/fixtures/generate-seals.mjs');
} else writeFileSync(output, bytes);
