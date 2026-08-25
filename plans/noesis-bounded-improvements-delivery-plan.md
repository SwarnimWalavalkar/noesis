# Bounded improvements delivery plan

Status: completed

## Goal

Ship the parts of the August improvement list whose product contract and architecture are already clear. Keep the design-heavy requests out of the implementation batch until their core choices are resolved.

## Work in this batch

### Provider completion

- Register OpenCode Zen and OpenCode Go through Pi's existing provider system.
- Surface Claude, OpenCode Zen, and OpenCode Go in first-launch onboarding.
- Use `claude-opus-4-8` and `kimi-k2.6` as their recommended defaults.
- Include all supported providers in `auth status`.
- Give actionable missing-authentication errors for foreground and protected role calls.
- Preserve config schema version 1 and the generic provider/model config contract.

### Empty transcript prompts

- Replace the single empty-state sentence with a small fixed set.
- Select one prompt when a transcript renderer is created.
- Keep the prompt stable across repaint and resize.
- Do not persist it or add configuration.

### Resume verification

- Keep the complete SQLite transcript separate from the bounded history sent to the model.
- Verify existing restart and TUI hydration coverage for messages, tool calls, nested calls, and interrupted work.
- Add code only if the production-boundary checks expose a gap.

### Honest compaction command

- Stop `/compact` from reporting success while the production implementation is a no-op.
- Return an explicit unsupported error until durable context checkpoints are implemented.

## Verification and delivery

1. Run focused provider, onboarding, TUI, transcript, and runtime tests.
2. Run the full repository checks.
3. Review the complete diff in a fresh context for correctness and architectural drift.
4. Fix substantive findings in one local batch.
5. Open one ready-for-review PR.
6. Address substantive review-bot comments, then squash merge and update local `main`.

## Deferred design work

The following requests have focused workshop documents in this directory:

- durable session compaction
- MCP integration
- learning, reflection, and evaluation simplification
- the self-improvement explorer
