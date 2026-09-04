import {
  MemorySessionRepo,
  TODO_CONTEXT,
  type CompactionSettings,
  type Context,
  type Session,
} from "@earendil-works/pi-agent-core";
import { cleanupSessionResources } from "@earendil-works/pi-ai";

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
          releasePiSessionResources(resourceSessionId);
        }
      }
    })();
    return closePromise;
  };
  return Object.freeze({ session, close });
}

export function releasePiSessionResources(sessionId: string): void {
  cleanupSessionResources(sessionId);
}
