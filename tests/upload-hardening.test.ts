import { describe, expect, it } from "vitest";
import {
  MAX_MULTIPART_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_FILE_SIZE_BYTES
} from "@/lib/files/policy";
import { POST as createWorkspaceRoute } from "@/app/api/workspaces/route";
import {
  FileUploadError,
  readBoundedMultipartFormData,
  validateWorkspaceUpload
} from "@/lib/server/workspace-files";
import { buildTestDocx } from "./helpers/docx";
import { buildTestPdf } from "./helpers/pdf";

function validationInput() {
  return {
    existingFileCount: 0,
    maxFiles: 5,
    requireFiles: true
  };
}

describe("workspace upload hardening", () => {
  it("accepts validated containers and assigns canonical content types", async () => {
    const pdf = buildTestPdf([
      "A complete policy report contains enough readable evidence for validation."
    ]);
    const docx = buildTestDocx({
      paragraphs: [
        "A complete Word report contains enough readable evidence for validation."
      ]
    });

    const prepared = await validateWorkspaceUpload(
      [
        new File([new Uint8Array(pdf)], "report.pdf", {
          type: "text/html"
        }),
        new File([new Uint8Array(docx)], "report.docx", {
          type: "application/javascript"
        }),
        new File(["Readable notes"], "notes.md", {
          type: "text/html"
        })
      ],
      validationInput()
    );

    expect(prepared.map((file) => file.mimeType)).toEqual([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/markdown; charset=utf-8"
    ]);
  });

  it("rejects extension-spoofed and binary uploads before persistence", async () => {
    await expect(
      validateWorkspaceUpload(
        [new File(["not a PDF"], "spoofed.pdf", { type: "application/pdf" })],
        validationInput()
      )
    ).rejects.toThrow(/valid PDF signature/);

    await expect(
      validateWorkspaceUpload(
        [
          new File(
            [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])],
            "spoofed.docx",
            { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
          )
        ],
        validationInput()
      )
    ).rejects.toThrow(/complete DOCX central directory/);

    await expect(
      validateWorkspaceUpload(
        [new File([new Uint8Array([0x41, 0x00, 0x42])], "binary.txt")],
        validationInput()
      )
    ).rejects.toThrow(/binary data/);
  });

  it("validates maximum-size text with bounded working memory", async () => {
    const content = Buffer.alloc(MAX_UPLOAD_FILE_SIZE_BYTES, 0x61);
    const [prepared] = await validateWorkspaceUpload(
      [new File([content], "maximum.txt", { type: "text/plain" })],
      validationInput()
    );

    expect(prepared.buffer.byteLength).toBe(MAX_UPLOAD_FILE_SIZE_BYTES);
    expect(prepared.mimeType).toBe("text/plain; charset=utf-8");
  });

  it("prepares multiple uploads sequentially", async () => {
    let activeReads = 0;
    let maximumActiveReads = 0;

    class TrackedFile extends File {
      async arrayBuffer() {
        activeReads += 1;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);

        try {
          await Promise.resolve();
          return await super.arrayBuffer();
        } finally {
          activeReads -= 1;
        }
      }
    }

    await validateWorkspaceUpload(
      [
        new TrackedFile(["First readable source note."], "first.txt"),
        new TrackedFile(["Second readable source note."], "second.md")
      ],
      validationInput()
    );

    expect(maximumActiveReads).toBe(1);
  });

  it("rejects an oversized multipart body with a typed 413 before parsing", async () => {
    const request = new Request("http://localhost/api/workspaces", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        "content-length": String(MAX_MULTIPART_UPLOAD_SIZE_BYTES + 1)
      },
      body: "small body"
    });

    const error = await readBoundedMultipartFormData(request).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(FileUploadError);
    expect((error as FileUploadError).status).toBe(413);
    expect((error as Error).message).toContain("aggregate limit");
  });

  it("preserves the multipart 413 at the public workspace route", async () => {
    const response = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=test",
          "content-length": String(MAX_MULTIPART_UPLOAD_SIZE_BYTES + 1)
        },
        body: "small body"
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("aggregate limit")
    });
  });

  it("rejects oversized JSON workspace creation before parsing", async () => {
    const response = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(64 * 1024 + 1)
        },
        body: "{}"
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Workspace creation request")
    });
  });
});
