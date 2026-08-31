# Live Pi model catalog

## Goal

Let Noesis discover newly published models for its existing Pi providers without requiring a Noesis release, while preserving offline startup, prompt-cache isolation, and frozen session routes.

## Contract

- Pi remains the authority for provider transport and model compatibility metadata.
- Noesis starts from Pi's bundled catalog and restores Pi's last-known persisted provider overlays without network access.
- Opening the model picker renders the current-provider snapshot immediately, then asks Pi to refresh configured provider catalogs in the background. The provider picker manages connection state and never opens a model list.
- A successful refresh updates the open picker and later route validation. Failure leaves the bundled or cached catalog usable and visible.
- Provider and model changes still create a fresh session. Catalog refresh never mutates the route of an existing session or enter its prompt, transcript, or provider-facing tool schema.
- Noesis exposes only its supported provider IDs even when Pi knows additional providers.
- OpenCode Zen and OpenCode Go retain distinct labels and credential sources while using Pi's model metadata and remote overlay.
- Selecting a disconnected provider authenticates before refreshing its catalog or creating a session on its default model. Stored credentials can be disconnected from the provider picker; environment credentials cannot.
- All model consumers retry one pre-output HTTP 401 once after an atomic stored-OAuth refresh. No request is replayed after visible output, and API-key failures require reconnection.
- A new model that uses an existing compiled Pi provider/API can arrive through the catalog. A new provider, authentication scheme, or transport still requires a Noesis/Pi release.

## Implementation

1. Upgrade the Pi packages together and use the exported Pi `ModelRuntime` with a Noesis-local persisted model store.
2. Compose Noesis's OpenCode Go name and `OPENCODE_GO_API_KEY` override over Pi's provider instead of replacing the provider, preserving Pi's remote refresh behavior.
3. Keep route reads synchronous snapshots and add an explicit asynchronous refresh operation. The model picker shows the snapshot first and replaces its rows after refresh completes.
4. Keep provider selection separate from model selection. Authenticate first, choose the provider's catalog default only after connection succeeds, and keep `/model` responsible for explicit model choice.
5. Wrap Pi's shared `Models` request boundary so foreground, role, subagent, and MCP calls share one safe OAuth-rejection recovery path.
6. Derive first-launch model choices from the same catalog while keeping Noesis's recommended default as presentation policy.

## Verification

- Cached and bundled routes are available without network access.
- A simulated Pi catalog refresh adds a model and updates an already-open picker.
- Refresh failure preserves the existing route list.
- Unknown or unsupported providers remain unavailable.
- OpenCode Zen and Go remain separately labelled and authenticated.
- Provider management shows connection sources, disconnects stored credentials after confirmation, and never opens the model picker.
- Controlled HTTP 401 tests prove one OAuth refresh and retry before output, no replay after output, and no API-key retry.
- Route changes still create a new empty resumable session; reasoning-only changes remain in-session.
