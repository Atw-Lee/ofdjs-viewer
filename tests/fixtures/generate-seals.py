"""Build an original OFD with synthetic, non-validating SES appearance data."""

from io import BytesIO
from pathlib import Path
from struct import pack
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo
from zlib import compress, crc32

ROOT = Path(__file__).resolve().parent
NS = "http://www.ofdspec.org/2016"


def xml(name, body):
    return f'<ofd:{name} xmlns:ofd="{NS}">{body}</ofd:{name}>'.encode()


def archive(files):
    output = BytesIO()
    with ZipFile(output, "w") as target:
        for name, data in files.items():
            info = ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            target.writestr(info, data)
    return output.getvalue()


def png(width, height, pixel):
    def chunk(kind, data):
        return pack(">I", len(data)) + kind + data + pack(">I", crc32(kind + data))

    rows = b"".join(b"\0" + b"".join(bytes(pixel(x, y)) for x in range(width)) for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", compress(rows)) + chunk(b"IEND", b""))


def der(tag, payload):
    size = len(payload)
    raw = size.to_bytes(max(1, (size.bit_length() + 7) // 8), "big")
    length = bytes([size]) if size < 128 else bytes([128 + len(raw)]) + raw
    return bytes([tag]) + length + payload


def seq(*items):
    return der(48, b"".join(items))


def integer(value):
    return der(2, bytes([value]))


def text(value, tag=22):
    return der(tag, value.encode())


def ses(picture, kind):
    # SES v4/2020 structure. Certificate and signature are deliberately fake.
    certificate = der(4, b"")
    algorithm = der(6, bytes.fromhex("2a811ccf55018375"))
    signature = der(3, b"\0" + bytes(64))
    date = text("20240101000000Z", 24)
    info = seq(seq(text("ES"), integer(4), text("synthetic")), text("fixture"),
               seq(integer(1), text("appearance", 12), integer(1), seq(certificate), date, date, date),
               seq(text(kind), der(4, picture), integer(20), integer(20)))
    seal = seq(info, certificate, algorithm, signature)
    return seq(seq(integer(4), seal, date, der(3, b"\0" + bytes(32)), text("appearance-only")),
               certificate, algorithm, signature)


def rect(x, y, width, height, color):
    return (f'<ofd:PathObject Boundary="{x} {y} {width} {height}" Fill="true" Stroke="false">'
            f'<ofd:FillColor Value="{color}"/><ofd:AbbreviatedData>M 0 0 L {width} 0 L {width} {height} '
            f'L 0 {height} C</ofd:AbbreviatedData></ofd:PathObject>')


def document(width, height, content, signatures=False):
    files = {
        "OFD.xml": xml("OFD", '<ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>'
                       + ('<ofd:Signatures>Doc_0/Signs/Signatures.xml</ofd:Signatures>' if signatures else "")
                       + '</ofd:DocBody>'),
        "Doc_0/Document.xml": xml("Document", '<ofd:CommonData><ofd:PageArea><ofd:PhysicalBox>'
                                  f'0 0 {width} {height}</ofd:PhysicalBox></ofd:PageArea></ofd:CommonData>'
                                  '<ofd:Pages><ofd:Page ID="1" BaseLoc="Pages/1.xml"/></ofd:Pages>'),
        "Doc_0/Pages/1.xml": xml("Page", '<ofd:Content><ofd:Layer ID="1">' + content
                                  + '</ofd:Layer></ofd:Content>'),
    }
    return files


def signature(boundary, clip=""):
    return xml("Signature", '<ofd:SignedInfo><ofd:StampAnnot PageRef="1" Boundary="'
               + boundary + '"' + clip + '/></ofd:SignedInfo><ofd:SignedValue>SignedValue.dat</ofd:SignedValue>')


nested = archive(document(30, 20, rect(0, 0, 15, 20, "220 30 40")
                          + rect(15, 0, 15, 5, "20 60 220")))
ring = png(20, 20, lambda x, y: (220, 30, 40, 255) if x < 3 or x > 16 or y < 3 or y > 16 else (0, 0, 0, 0))
main = document(80, 50, rect(0, 0, 80, 50, "20 180 40"), signatures=True)
main.update({
    "Doc_0/Signs/Signatures.xml": xml("Signatures", '<ofd:Signature BaseLoc="PNG/Signature.xml"/>'
                                        '<ofd:Signature BaseLoc="OFD/Signature.xml"/>'),
    "Doc_0/Signs/PNG/Signature.xml": signature("10 10 20 20", ' Clip="0 0 10 20"'),
    "Doc_0/Signs/PNG/SignedValue.dat": ses(ring, "png"),
    "Doc_0/Signs/OFD/Signature.xml": signature("40 10 30 20"),
    "Doc_0/Signs/OFD/SignedValue.dat": ses(nested, "ofd"),
})
(ROOT / "seal-appearances.ofd").write_bytes(archive(main))
