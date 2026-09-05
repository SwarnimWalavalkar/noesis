import {
  MemorySessionRepo,
  TODO_CONTEXT,
  type CompactionSettings,
  type Context,
  type Session,
} from "@earendil-works/pi-agent-core";
import { resolve } from "import-meta-resolve";
import { cleanupSessionResources } from "@earendil-works/pi-ai";

// npm may retain Pi's shrinkwrapped dependencies as separate module instances.
// Resolve cleanup from each owner, not just Noesis's top-level pi-ai import.
const localResourceOwner = resolve("@earendil-works/pi-ai", import.meta.url);
const resourceOwners = [
  ...new Set(
    ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core"].map((owner) =>
      resolve("@earendil-works/pi-ai", resolve(owner, import.meta.url)),
    ),
  ),
].filter((owner) => owner !== localResourceOwner);

export const NOESIS_PI_COMPACTION_SETTINGS: CompactionSettings = Object.freeze({
  enabled: false,
  reserveTokens: 0,
  keepRecentTokens: 0,
});

export const NOESIS_PI_LANE_NAME = "main";

export interface EphemeralPiSession {
  readonly session: Session;
  readonly close: (context?: Context) => Promise<void>;
}

export async function createEphemeralPiSession(context: Context = TODO_CONTEXT): Promise<EphemeralPiSession> {
  const sessions = new MemorySessionRepo();
  const session = await sessions.create({}, context);
  const resourceSessionId = `${session.metadata.id}:${NOESIS_PI_LANE_NAME}`;
  let closePromise: Promise<void> | undefined;
  const close = (closeContext: Context = TODO_CONTEXT): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await session.close(closeContext);
      } finally {
        try {
          await sessions.close(closeContext);
        } finally {
          await releasePiSessionResources(resourceSessionId);
        }
      }
    })();
    return closePromise;
  };
  return Object.freeze({ session, close });
}

export async function releasePiSessionResources(sessionId: string): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => cleanupSessionResources(sessionId)),
    ...resourceOwners.map(async (owner) => {
      const resources: unknown = await import(owner);
      if (
        typeof resources !== "object" ||
        resources === null ||
        !("cleanupSessionResources" in resources) ||
        typeof resources.cleanupSessionResources !== "function"
      )
        throw new Error(`Pi resource owner does not expose cleanupSessionResources: ${owner}`);
      resources.cleanupSessionResources(sessionId);
    }),
  ]);
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length > 0) throw new AggregateError(failures, "Failed to cleanup session resources");
}
