import type { AgentRuntimeImage } from "@noesis/agent-types";
import { validateComposerAttachmentInputs } from "@noesis/domain";
import type { ImageContent } from "@earendil-works/pi-ai";

export function imageBlocks(images: readonly AgentRuntimeImage[] = []): ImageContent[] {
  if (images.some((image) => !image.mimeType.startsWith("image/")))
    throw new Error("Image input requires a supported image MIME type");
  validateComposerAttachmentInputs(images.map((image, index) => ({ ...image, name: `image-${index}` })));
  return images.map(({ mimeType, data }) => ({ type: "image", mimeType, data }));
}

/** Never count encoded image bytes as text or expose them in context inspection. */
// BOUNDARY: Pi messages include extension-defined content. Redact image envelopes during serialization
// without treating arbitrary extension payloads as trusted model text.
export function imageSafeJson(value: unknown): string {
  // BOUNDARY: JSON.stringify invokes this callback with arbitrary nested provider-owned values.
  return JSON.stringify(value, (_key, item: unknown) => {
    // BOUNDARY: Recognize only the image envelope; leave other provider representations unchanged.
    if (item && typeof item === "object" && "type" in item && item.type === "image") {
      return {
        type: "image",
        mimeType: "mimeType" in item ? item.mimeType : "unknown",
        data: "[image bytes omitted; image tokens not estimated]",
      };
    }
    return item;
  });
}
