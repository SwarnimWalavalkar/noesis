import type { ComposerAttachmentInput } from "./attachments.ts";

export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_DIMENSION = 16_384;

type Dimensions = Readonly<{ width: number; height: number }>;

/** Header inspection only: never decode untrusted pixels on the admission thread. */
function headerDimensions(bytes: Buffer, mimeType: string): Dimensions | undefined {
  if (mimeType === "image/png" && bytes.length >= 24 && bytes.toString("ascii", 12, 16) === "IHDR")
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mimeType === "image/gif" && bytes.length >= 10)
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (mimeType === "image/webp") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8 " && bytes.length >= 30)
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X" && bytes.length >= 30)
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 1 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) return undefined;
      // Standalone markers have no segment length.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) return undefined;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return undefined;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8) return undefined;
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  return undefined;
}

export function validateImageDimensions(bytes: Buffer, mimeType: string): Dimensions {
  const dimensions = headerDimensions(bytes, mimeType);
  if (
    !dimensions ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > MAX_IMAGE_DIMENSION ||
    dimensions.height > MAX_IMAGE_DIMENSION ||
    dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
  )
    throw new Error("Image dimensions are invalid or exceed the 16 megapixel attachment limit.");
  return dimensions;
}

export function attachmentImageDimensions(input: ComposerAttachmentInput): Dimensions {
  return validateImageDimensions(Buffer.from(input.data, "base64"), input.mimeType);
}
