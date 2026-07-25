import { InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { cleanupSessionResources } from "@earendil-works/pi-ai";

export interface EphemeralPiSession {
  readonly session: Session;
  readonly sessionId: string;
}

export async function createEphemeralPiSession(): Promise<EphemeralPiSession> {
  const session = new Session(new InMemorySessionStorage());
  const metadata = await session.getMetadata();
  return Object.freeze({ session, sessionId: metadata.id });
}

export function releasePiSessionResources(sessionId: string): void {
  cleanupSessionResources(sessionId);
}
