import { deflateSync } from "node:zlib";

function escapePdfLiteral(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r?\n/g, " ");
}

export function buildTestPdf(
  pages: string[],
  input?: {
    flate?: boolean;
  }
) {
  let nextObjectId = 3;
  const pageObjectIds: number[] = [];
  const contentObjectIds: number[] = [];

  for (let index = 0; index < pages.length; index += 1) {
    pageObjectIds.push(nextObjectId);
    nextObjectId += 1;
    contentObjectIds.push(nextObjectId);
    nextObjectId += 1;
  }

  const fontObjectId = nextObjectId;
  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>\nendobj`
  ];

  for (let index = 0; index < pages.length; index += 1) {
    const pageObjectId = pageObjectIds[index]!;
    const contentObjectId = contentObjectIds[index]!;
    const contentText = [
      "BT",
      "/F1 12 Tf",
      "72 720 Td",
      `(${escapePdfLiteral(pages[index]!)}) Tj`,
      "ET"
    ].join("\n");
    const streamBuffer = input?.flate
      ? deflateSync(Buffer.from(contentText, "latin1"))
      : Buffer.from(contentText, "latin1");
    const filterPart = input?.flate ? "/Filter /FlateDecode " : "";

    objects.push(
      `${pageObjectId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjectId} 0 R /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> >>\nendobj`
    );
    objects.push(
      `${contentObjectId} 0 obj\n<< ${filterPart}/Length ${streamBuffer.length} >>\nstream\n${streamBuffer.toString("latin1")}\nendstream\nendobj`
    );
  }

  objects.push(
    `${fontObjectId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`
  );

  return Buffer.from(`%PDF-1.4\n${objects.join("\n")}\n%%EOF`, "latin1");
}
