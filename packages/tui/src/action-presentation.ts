// biome-ignore-all lint/complexity/useLiteralKeys: unknown durable data requires bracket access under noPropertyAccessFromIndexSignature.
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
  readonly value: unknown;
  readonly unwrapped: boolean;
  readonly tools?: readonly PresentedTool[];
  readonly catalog?: PresentedCatalog;
}

function parseJsonText(value: unknown): { readonly value: unknown; readonly changed: boolean } {
  let current = value;
  let changed = false;
  for (let depth = 0; depth < 3 && typeof current === "string"; depth += 1) {
    try {
      current = JSON.parse(current) as unknown;
      changed = true;
    } catch {
      break;
    }
  }
  return { value: current, changed };
}

function piTextEnvelope(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value["content"]) || value["content"].length === 0) return undefined;
  const text: string[] = [];
  for (const part of value["content"]) {
    if (!isRecord(part) || part["type"] !== "text" || typeof part["text"] !== "string") return undefined;
    text.push(part["text"]);
  }
  return text.join("\n");
}

function presentedTool(value: unknown): PresentedTool | undefined {
  const name = stringField(value, "name");
  if (!name) return undefined;
  const description = stringField(value, "description");
  const revisionId = stringField(value, "revisionId");
  const score = numberField(value, "score");
  return Object.freeze({
    name,
    ...(description ? { description } : {}),
    ...(revisionId ? { revisionId } : {}),
    ...(score === undefined ? {} : { score }),
  });
}

function presentedTools(actionName: string, value: unknown): readonly PresentedTool[] | undefined {
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

function presentedCatalog(value: unknown): PresentedCatalog | undefined {
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
  return Object.freeze({
    ...(catalogId ? { catalogId } : {}),
    ...(catalogDigest ? { catalogDigest } : {}),
    ...(effects === undefined ? {} : { effectCount: effects }),
    ...(resources === undefined ? {} : { resourceCount: resources }),
    ...(credentials === undefined ? {} : { credentialCount: credentials }),
  });
}

/**
 * Interpret known Pi and codemode result shapes without mutating the exact action payload.
 * The caller chooses whether to render this semantic projection or the untouched raw value.
 */
export function presentActionPayload(actionName: string, payload: unknown): ActionPayloadPresentation {
  const activity = isRecord(payload) && isRecord(payload["activity"]) ? payload["activity"] : undefined;
  const progressValue =
    activity?.["type"] === "progress" && "value" in activity ? activity["value"] : undefined;
  const envelopeText = piTextEnvelope(progressValue ?? payload);
  const decoded = parseJsonText(envelopeText ?? progressValue ?? payload);
  const value = decoded.value;
  const tools = presentedTools(actionName, value);
  const catalog = presentedCatalog(value);
  return Object.freeze({
    value,
    unwrapped: progressValue !== undefined || envelopeText !== undefined || decoded.changed,
    ...(tools ? { tools } : {}),
    ...(catalog ? { catalog } : {}),
  });
}
