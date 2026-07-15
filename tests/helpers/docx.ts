import { deflateRawSync } from "node:zlib";

interface ZipEntryInput {
  fileName: string;
  body: string;
}

function buildZip(entries: ZipEntryInput[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileNameBuffer = Buffer.from(entry.fileName, "utf8");
    const bodyBuffer = Buffer.from(entry.body, "utf8");
    const compressedBody = deflateRawSync(bodyBuffer);
    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressedBody.length, 18);
    localHeader.writeUInt32LE(bodyBuffer.length, 22);
    localHeader.writeUInt16LE(fileNameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localPart = Buffer.concat([localHeader, fileNameBuffer, compressedBody]);
    localParts.push(localPart);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(compressedBody.length, 20);
    centralHeader.writeUInt32LE(bodyBuffer.length, 24);
    centralHeader.writeUInt16LE(fileNameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralParts.push(Buffer.concat([centralHeader, fileNameBuffer]));
    localOffset += localPart.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = localOffset;
  const endOfCentralDirectory = Buffer.alloc(22);

  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

export function buildTestDocx(input: {
  paragraphs: string[];
  footnotes?: string[];
  comments?: string[];
  documentXml?: string;
}) {
  const entries: ZipEntryInput[] = [
    {
      fileName: "[Content_Types].xml",
      body: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        "</Types>"
      ].join("")
    },
    {
      fileName: "_rels/.rels",
      body: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
        "</Relationships>"
      ].join("")
    },
    {
      fileName: "word/document.xml",
      body:
        input.documentXml ??
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
          ...input.paragraphs.map(
            (paragraph) => `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`
          ),
          "</w:body></w:document>"
        ].join("")
    }
  ];

  if (input.footnotes?.length) {
    entries.push({
      fileName: "word/footnotes.xml",
      body: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        ...input.footnotes.map(
          (paragraph, index) =>
            `<w:footnote w:id="${index + 1}"><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:footnote>`
        ),
        "</w:footnotes>"
      ].join("")
    });
  }

  if (input.comments?.length) {
    entries.push({
      fileName: "word/comments.xml",
      body: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        ...input.comments.map(
          (paragraph, index) =>
            `<w:comment w:id="${index + 1}"><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:comment>`
        ),
        "</w:comments>"
      ].join("")
    });
  }

  return buildZip(entries);
}
