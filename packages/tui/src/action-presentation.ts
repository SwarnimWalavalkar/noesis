import { createConditionalObject, type JsonValue, JsonValueSchema } from "@noesis/domain";
import { isRecord, numberField, stringField } from "./record-fields.ts";
export interface PresentedTool {
  readonly name: string;
  readonly description?: string;
  readonly revisionId?: string;
  readonly score?: number;
}
export interface PresentedCatalog {
  readonly catalogId?: string;
  readonly catalogDigest?: string;
  readonly effectCount?: number;
  readonly resourceCount?: number;
  readonly credentialCount?: number;
}
export interface ActionPayloadPresentation {
  readonly value: JsonValue | undefined;
  readonly unwrapped: boolean;
  readonly tools?: readonly PresentedTool[];
  readonly catalog?: PresentedCatalog;
}
function parseJsonText(value: JsonValue | undefined): {
  readonly value: JsonValue | undefined;
  readonly changed: boolean;
} {
  let current = value;
  let changed = false;
  for (let depth = 0; depth < 3 && typeof current === "string"; depth += 1) {
    try {
      current = JsonValueSchema.parse(JSON.parse(current));
      changed = true;
    } catch {
      break;
    }
  }
  return { value: current, changed };
}
function piTextEnvelope(value: JsonValue | undefined): string | undefined {
  if (!isRecord(value) || !Array.isArray(value["content"]) || value["content"].length === 0) return undefined;
  const text: string[] = [];
  for (const part of value["content"]) {
    if (!isRecord(part) || part["type"] !== "text" || typeof part["text"] !== "string") return undefined;
    text.push(part["text"]);
  }
  return text.join("\n");
}
function presentedTool(value: JsonValue): PresentedTool | undefined {
  const name = stringField(value, "name");
  if (!name) return undefined;
  const description = stringField(value, "description");
  const revisionId = stringField(value, "revisionId");
  const score = numberField(value, "score");
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      name,
    } as const)
      .addOptional(description ? { description } : undefined)
      .addOptional(revisionId ? { revisionId } : undefined)
      .addOptional(!(score === undefined) ? { score } : undefined)
      .finish(),
  );
}
function presentedTools(
  actionName: string,
  value: JsonValue | undefined,
): readonly PresentedTool[] | undefined {
  const candidates =
    actionName === "noesis.search" && Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value["tools"])
        ? value["tools"]
        : undefined;
  if (!candidates) return undefined;
  const tools = candidates.map(presentedTool).filter((tool): tool is PresentedTool => tool !== undefined);
  return tools.length === candidates.length ? Object.freeze(tools) : undefined;
}
function presentedCatalog(value: JsonValue | undefined): PresentedCatalog | undefined {
  if (!isRecord(value)) return undefined;
  const catalogId = stringField(value, "catalogId");
  const catalogDigest = stringField(value, "catalogDigest");
  const permissions = isRecord(value["permissions"]) ? value["permissions"] : undefined;
  const effects =
    permissions && Array.isArray(permissions["effects"]) ? permissions["effects"].length : undefined;
  const resources =
    permissions && Array.isArray(permissions["resourcePatterns"])
      ? permissions["resourcePatterns"].length
      : undefined;
  const credentials =
    permissions && Array.isArray(permissions["credentialRefs"])
      ? permissions["credentialRefs"].length
      : undefined;
  if (
    !catalogId &&
    !catalogDigest &&
    effects === undefined &&
    resources === undefined &&
    credentials === undefined
  )
    return undefined;
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({} as const)
      .addOptional(catalogId ? { catalogId } : undefined)
      .addOptional(catalogDigest ? { catalogDigest } : undefined)
      .addOptional(!(effects === undefined) ? { effectCount: effects } : undefined)
      .addOptional(!(resources === undefined) ? { resourceCount: resources } : undefined)
      .addOptional(!(credentials === undefined) ? { credentialCount: credentials } : undefined)
      .finish(),
  );
}
/**
 * Interpret known Pi and codemode result shapes without mutating the exact action payload.
 * The caller chooses whether to render this semantic projection or the untouched raw value.
 */
export function presentActionPayload(
  actionName: string,
  payload: JsonValue | undefined,
): ActionPayloadPresentation {
  const activity = isRecord(payload) && isRecord(payload["activity"]) ? payload["activity"] : undefined;
  const hasProgressValue = activity?.["type"] === "progress" && "value" in activity;
  const semanticPayload = hasProgressValue ? activity["value"] : payload;
  const envelopeText = piTextEnvelope(semanticPayload);
  const decoded = parseJsonText(envelopeText ?? semanticPayload);
  const value = decoded.value;
  const tools = presentedTools(actionName, value);
  const catalog = presentedCatalog(value);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      value,
      unwrapped: hasProgressValue || envelopeText !== undefined || decoded.changed,
    } as const)
      .addOptional(tools ? { tools } : undefined)
      .addOptional(catalog ? { catalog } : undefined)
      .finish(),
  );
}
