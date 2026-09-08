import { zipSync, strToU8, zlibSync } from 'fflate';
import { writeFileSync } from 'node:fs';
const xml = body => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const ns = 'xmlns:ofd="http://www.ofdspec.org/2016"';
const text = (id, x, y, text, size = 5, color = '30 47 65') => `<ofd:TextObject ID="${id}" Boundary="${x} ${y} 170 15" Font="1" Size="${size}"><ofd:FillColor Value="${color}"/><ofd:TextCode X="0" Y="${size}">${text}</ofd:TextCode></ofd:TextObject>`;
const files = {
'OFD.xml': xml(`<ofd:OFD ${ns} Version="1.0" DocType="OFD"><ofd:DocBody><ofd:DocInfo><ofd:DocID>ofdjs-demo</ofd:DocID><ofd:Title>OFD.js sample</ofd:Title><ofd:Creator>OFD.js</ofd:Creator></ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`),
'Doc_0/Document.xml': xml(`<ofd:Document ${ns}><ofd:CommonData><ofd:MaxUnitID>999</ofd:MaxUnitID><ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea><ofd:PublicRes>PublicRes.xml</ofd:PublicRes><ofd:TemplatePage ID="10" BaseLoc="Tpl/Content.xml"/></ofd:CommonData><ofd:Pages><ofd:Page ID="100" BaseLoc="Pages/1.xml"/><ofd:Page ID="200" BaseLoc="Pages/2.xml"/></ofd:Pages></ofd:Document>`),
'Doc_0/PublicRes.xml': xml(`<ofd:Res ${ns} BaseLoc="Res"><ofd:Fonts><ofd:Font ID="1" FontName="Arial" FamilyName="Arial"/></ofd:Fonts><ofd:DrawParams><ofd:DrawParam ID="2" LineWidth=".4"><ofd:StrokeColor Value="22 134 117"/></ofd:DrawParam></ofd:DrawParams><ofd:MultiMedias><ofd:MultiMedia ID="3" Type="Image" Format="PNG"><ofd:MediaFile>pixel.png</ofd:MediaFile></ofd:MultiMedia></ofd:MultiMedias></ofd:Res>`),
'Doc_0/Tpl/Content.xml': xml(`<ofd:Page ${ns}><ofd:Content><ofd:Layer ID="11">${text(12,18,15,'OFD.JS  /  DOCUMENT ENGINE',3,'22 134 117')}<ofd:PathObject ID="13" Boundary="18 27 174 1" DrawParam="2"><ofd:AbbreviatedData>M 0 0.5 L 174 0.5</ofd:AbbreviatedData></ofd:PathObject>${text(14,18,275,'BROWSER NATIVE     /     CANVAS 2D     /     REACT',2.8,'100 115 130')}</ofd:Layer></ofd:Content></ofd:Page>`),
'Doc_0/Pages/1.xml': xml(`<ofd:Page ${ns}><ofd:Template TemplateID="10"/><ofd:Content><ofd:Layer ID="101">${text(102,18,43,'A document, rendered.',9)}${text(103,18,63,'OFD preview, directly in your browser.',4)}<ofd:PathObject ID="104" Boundary="18 91 174 51" Fill="true" Stroke="false"><ofd:FillColor Value="234 246 242"/><ofd:AbbreviatedData>M 0 0 L 174 0 L 174 51 L 0 51 C</ofd:AbbreviatedData></ofd:PathObject>${text(105,25,100,'01   Parse the archive',5,'22 110 95')}${text(106,25,112,'02   Resolve pages and resources',5,'22 110 95')}${text(107,25,124,'03   Paint on a real canvas',5,'22 110 95')}${text(108,18,160,'Text. Paths. Images. Templates.',5)}${text(109,18,176,'No upload required for local files.',3.5)}<ofd:PathObject ID="110" Boundary="18 205 170 40" Stroke="true" DrawParam="2"><ofd:AbbreviatedData>M 0 30 B 35 0 65 0 85 25 Q 130 50 165 10</ofd:AbbreviatedData></ofd:PathObject></ofd:Layer></ofd:Content></ofd:Page>`),
'Doc_0/Pages/2.xml': xml(`<ofd:Page ${ns}><ofd:Template TemplateID="10"/><ofd:Content><ofd:Layer ID="201">${text(202,18,43,'Built for your application.',8)}${text(203,18,66,'A small core. A familiar API.',4)}${text(204,18,92,'const doc = await getDocument(file);',4)}${text(205,18,106,'const page = await doc.getPage(1);',4)}${text(206,18,120,'await page.render(options).promise;',4)}<ofd:ImageObject ID="207" ResourceID="3" Boundary="18 150 30 30" CTM="30 0 0 30 0 0"/>${text(208,18,198,'Page 2 / 2',4)}</ofd:Layer></ofd:Content></ofd:Page>`)
};
const entries = Object.fromEntries(Object.entries(files).map(([k,v]) => [k,strToU8(v)]));
// Generate an original opaque PNG with valid CRCs, no external assets.
function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, data, checksum]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(24, 0); ihdr.writeUInt32BE(24, 4); ihdr[8] = 8; ihdr[9] = 6;
const pixels = Buffer.alloc(24 * (1 + 24 * 4));
for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
  const i = y * 97 + 1 + x * 4, light = ((x / 6 | 0) + (y / 6 | 0)) % 2;
  pixels.set(light ? [170, 220, 209, 255] : [22, 134, 117, 255], i);
}
entries['Doc_0/Res/pixel.png'] = new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from(zlibSync(pixels))), chunk('IEND', Buffer.alloc(0))]));
writeFileSync(new URL('../public/sample.ofd',import.meta.url),zipSync(entries));
console.log('Created public/sample.ofd (2 pages)');
