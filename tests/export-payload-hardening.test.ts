import { describe, expect, it } from "vitest";
import { pngDataUrlToBuffer } from "@/app/api/workspaces/[workspaceId]/export/png/route";
import {
  ExportObservabilityRequestError,
  MAX_EXPORT_REQUEST_BYTES,
  MAX_PNG_EXPORT_BYTES,
  readExportObservabilityRequest
} from "@/lib/server/export-observability";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

describe("export payload hardening", () => {
  it("accepts a bounded PNG signature and rejects non-PNG base64", () => {
    const valid = `data:image/png;base64,${PNG_SIGNATURE.toString("base64")}`;
    const invalid = `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`;

    expect(pngDataUrlToBuffer(valid)).toEqual(PNG_SIGNATURE);
    expect(() => pngDataUrlToBuffer(invalid)).toThrow(/valid PNG signature/);
  });

  it("rejects a decoded PNG larger than the binary ceiling", () => {
    const bytes = Buffer.concat([
      PNG_SIGNATURE,
      Buffer.alloc(MAX_PNG_EXPORT_BYTES - PNG_SIGNATURE.length + 1)
    ]);
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;

    expect(() => pngDataUrlToBuffer(dataUrl)).toThrow(
      ExportObservabilityRequestError
    );
  });

  it("honors a stricter configured decoded PNG ceiling", () => {
    const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8)]);
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;

    expect(() => pngDataUrlToBuffer(dataUrl, PNG_SIGNATURE.length)).toThrow(
      /byte limit/
    );
  });

  it("returns a typed 413 before consuming an oversized JSON body", async () => {
    const request = new Request("http://localhost/api/workspaces/demo/export/png", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_EXPORT_REQUEST_BYTES + 1)
      },
      body: "{}"
    });

    const error = await readExportObservabilityRequest(request).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(ExportObservabilityRequestError);
    expect((error as ExportObservabilityRequestError).status).toBe(413);
  });

  it("fails closed on non-empty malformed or over-schema export JSON", async () => {
    const malformed = new Request("http://localhost/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    });
    const unexpectedField = new Request("http://localhost/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ futureInternalField: "must not pass" })
    });

    await expect(readExportObservabilityRequest(malformed)).rejects.toMatchObject({
      status: 400
    });
    await expect(
      readExportObservabilityRequest(unexpectedField)
    ).rejects.toMatchObject({ status: 400 });
  });
});
