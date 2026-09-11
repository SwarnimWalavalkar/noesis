# Prompt cache and token efficiency implementation

This implements the first bounded changes from the prompt-cache audit and Pi/OpenCode comparison. The objective is lower repeated input without changing authority or discarding recoverable evidence.

- Hash workspace and logical foreground trail, subagent identity, or role variant into an enabled provider prompt-cache key. Keep Pi execution/session resource identities unique; only existing payload cache keys are replaced. Providers without an explicit key keep their existing behavior. A key does not guarantee a cache hit or overcome a changed prefix.
- Put the bounded structured-output contract after stable role instructions in the system prompt. Keep it identical during repair. Remove the unique run ID from model-visible role input while retaining trace identity. Render role JSON compactly and preserve evidence ordering.
- Project completed direct-tool and execute results above 32 KiB into a head/tail preview with digest, original byte count, and recovery path. Production composition saves exact serialized returned results through WorkspaceStore artifacts first. Existing upstream log truncation still applies; the artifact does not recover bytes already discarded upstream. Transport errors and streaming updates are outside this projection. Missing or failing artifact persistence returns a bounded preview that preserves execution completion, marks recovery unavailable, and warns against repeating the completed call.

The artifact is a model-facing projection with provenance to the frozen foreground turn; existing operational result records remain authoritative. Output is projected once when ingested instead of repeatedly rewriting older conversation messages. Long JSON lines can be recovered with bounded byte extraction through shell.

Validation includes a credential-free Pi AgentHarness consumer test for the next provider request, Unicode artifact recovery and failure behavior, cache-key isolation, and structured repair contract preservation. No paid provider calls or measured cache-hit/cost claims are part of this change.

Follow-up work requires a separate design: durable typed conversation replay, frozen context epochs, cache-read/write usage accounting, and task-level comparisons of completion quality, cost, and latency. Subagent keys currently group by agent identity; continuation across newly generated agent identities is not introduced. Cache routing headers and provider transport reuse retain Pi behavior.
