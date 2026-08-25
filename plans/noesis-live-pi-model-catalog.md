# Live Pi model catalog

## Goal

Let Noesis discover newly published models for its existing Pi providers without requiring a Noesis release, while preserving offline startup, prompt-cache isolation, and frozen session routes.

## Contract

- Pi remains the authority for provider transport and model compatibility metadata.
- Noesis starts from Pi's bundled catalog and restores Pi's last-known persisted provider overlays without network access.
- Opening a route picker renders the current snapshot immediately, then asks Pi to refresh configured provider catalogs in the background.
- A successful refresh updates the open picker and later route validation. Failure leaves the bundled or cached catalog usable and visible.
- Provider and model changes still create a fresh session. Catalog refresh never mutates the route of an existing session or enter its prompt, transcript, or provider-facing tool schema.
- Noesis exposes only its supported provider IDs even when Pi knows additional providers.
- OpenCode Zen and OpenCode Go retain distinct labels and credential sources while using Pi's model metadata and remote overlay.
- A new model that uses an existing compiled Pi provider/API can arrive through the catalog. A new provider, authentication scheme, or transport still requires a Noesis/Pi release.

## Implementation

1. Upgrade the Pi packages together and use the exported Pi `ModelRuntime` with a Noesis-local persisted model store.
2. Compose Noesis's OpenCode Go name and `OPENCODE_GO_API_KEY` override over Pi's provider instead of replacing the provider, preserving Pi's remote refresh behavior.
3. Keep route reads synchronous snapshots and add an explicit asynchronous refresh operation. Route pickers show the snapshot first and replace their rows after refresh completes.
4. Revalidate inline provider/model changes after a refresh so a newly published model works without reopening Noesis.
5. Derive first-launch model choices from the same catalog while keeping Noesis's recommended default as presentation policy.

## Verification

- Cached and bundled routes are available without network access.
- A simulated Pi catalog refresh adds a model and updates an already-open picker.
- Refresh failure preserves the existing route list.
- Unknown or unsupported providers remain unavailable.
- OpenCode Zen and Go remain separately labelled and authenticated.
- Route changes still create a new empty resumable session; reasoning-only changes remain in-session.
