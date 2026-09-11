import { expect, test } from "vitest";
import { attachmentImageDimensions, validateComposerAttachmentInputs } from "../src/attachments.ts";

function header(mimeType: string, width: number, height: number): Buffer {
  const bytes = Buffer.alloc(40);
  if (mimeType === "image/png") {
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.write("IHDR", 12);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
  } else if (mimeType === "image/gif") {
    bytes.write("GIF89a");
    bytes.writeUInt16LE(width, 6);
    bytes.writeUInt16LE(height, 8);
  } else if (mimeType === "image/jpeg") {
    bytes.set([255, 216, 255, 192, 0, 17, 8]);
    bytes.writeUInt16BE(height, 7);
    bytes.writeUInt16BE(width, 9);
  } else {
    bytes.write("RIFF");
    bytes.write("WEBPVP8X", 8);
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  }
  return bytes;
}

test.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
  "%s bounds optional image projection without rejecting storage admission",
  (mimeType) => {
    const input = (width: number, height: number) => ({
      name: "image",
      mimeType,
      data: header(mimeType, width, height).toString("base64"),
    });
    expect(attachmentImageDimensions(input(4000, 4000))).toEqual({ width: 4000, height: 4000 });
    expect(validateComposerAttachmentInputs([input(4000, 4000)])).toHaveLength(1);
    expect(validateComposerAttachmentInputs([input(4001, 4000)])).toHaveLength(1);
    expect(() => attachmentImageDimensions(input(4001, 4000))).toThrow("dimensions");
    expect(() => attachmentImageDimensions(input(16385, 1))).toThrow("dimensions");
    expect(() =>
      attachmentImageDimensions({
        ...input(1, 1),
        data: header(mimeType, 1, 1).subarray(0, 9).toString("base64"),
      }),
    ).toThrow();
  },
);

test("parses WebP VP8 and VP8L dimensions without decoding", () => {
  const lossy = header("image/webp", 1, 1);
  lossy.write("VP8 ", 12);
  lossy.writeUInt16LE(320, 26);
  lossy.writeUInt16LE(160, 28);
  const lossless = header("image/webp", 1, 1);
  lossless.write("VP8L", 12);
  lossless.writeUInt32LE((319 | (159 << 14)) >>> 0, 21);
  for (const bytes of [lossy, lossless])
    expect(
      attachmentImageDimensions({
        name: "image.webp",
        mimeType: "image/webp",
        data: bytes.toString("base64"),
      }),
    ).toEqual({ width: 320, height: 160 });
});
