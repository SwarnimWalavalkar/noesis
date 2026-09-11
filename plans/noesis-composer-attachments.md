# Composer attachments

Status: implemented; PR validation in progress.

## Scope

Add image clipboard capture and explicit file attachment to the terminal composer. Show a bounded preview above the editor, retain the original attachment bytes, and deliver images as model image content. Long pasted text stays editable and expands losslessly when submitted.

Terminal compatibility takes priority over displaying graphics. Unknown terminals and unsupported multiplexers get compact text labels with the same attachment controls. Clipboard access is a separate capability from graphics support. Local OS clipboard helpers are optional, invoked only by an explicit paste action. `/attach` remains available when clipboard access is unavailable, including remote sessions.

## Ownership

- TUI owns ephemeral draft references, input routing, asynchronous preparation, and bounded previews. It does not own durable attachment state.
- WorkspaceStore owns attachment artifacts and authoritative metadata.
- Runtime carries attachments with the same user intent through admission, queueing, restoration, and replay.
- Runtime Pi projects image attachments into provider-visible image blocks. Other files get exact artifact references, not a promise of native model support for arbitrary formats.

## Constraints

- No image decoding or clipboard subprocesses during render or per-keystroke input handling.
- Bound input bytes, image dimensions, attachment count, concurrent preparation, and preview dimensions.
- Use PNG preview bytes for Kitty's PNG protocol, independently of the original file format.
- Never interpret arbitrary pasted paths as commands or attachments.
- Preserve the draft on preparation or admission failure. Prevent submission of a partly prepared attachment set.
- Keep long-paste marker handling and terminal control-character sanitization intact.
- Validate unsupported model image input explicitly rather than silently omitting it.
- Do not change repository policy or commit without a separate request.

## Validation

Run focused tests for composer rendering and input lifecycle, OS clipboard command construction and failures, artifact integrity, queue/restoration, and credential-free Pi image input and replay. Exercise graphics and text fallback capabilities with controlled terminal fixtures. Run typechecking, formatting, lint, and release build checks for any new runtime assets. Automated terminal fixtures do not establish physical compatibility with every terminal emulator.

## Delivered and verified

- `Ctrl+V` local OS image clipboard; `/attach` file fallback; `/detach` removal; lossless literal text pastes.
- First-image thumbnail capped at two terminal rows plus one label row; conservative text fallback in unknown terminals and multiplexers. Only the visible image is prepared, outside render, by a serialized worker.
- Immutable attachment artifacts, attachment-aware SQLite intent digest and migration 050, queue restoration/reroute, consumption-acknowledged steering, current model image blocks, restart and fork replay.
- Explicit unsupported-model admission failure. Generic files receive absolute verified artifact paths; compaction receives attachment references rather than image bytes.
- No repository policy changes.
- Review correction: model admission validates resolved inputs before creating artifacts; repeated unsupported-image retries do not write artifact rows or files.
- Review correction: deferred automatic text-snippet collapsing. Pi interprets literal marker-looking text as owned snippets and recursively expands it; use the public literal insertion path to preserve text, cursor behavior, and undo until identity-aware collapsing is available.

Regression run: `pnpm exec vitest run packages/agent-types/test packages/runtime-pi/test packages/runtime/test packages/workspace/test packages/tui/test apps/noesis/test/runtime-composition.test.ts apps/noesis/test/attachments-acceptance.test.ts apps/noesis/test/attachment-history.test.ts apps/noesis/test/compaction-acceptance.test.ts apps/noesis/test/context-inspection.test.ts` — 833 tests passed across 64 files.

Final targeted run after the worker launch fix and live composer test: `pnpm exec vitest run packages/tui/test/composer-lifecycle.test.ts packages/tui/test/attachment-input.test.ts packages/tui/test/attachment-presentation.test.ts apps/noesis/test/attachment-history.test.ts apps/noesis/test/attachments-acceptance.test.ts` — 25 tests passed across 5 files.

Typechecking and changed-file lint/format checks passed. The release build passed without circular-module warnings. An actual emitted thumbnail worker, invoked from `node --input-type=module`, converted a 640×320 JPEG into a 320×160 PNG (1,461 bytes). Clipboard adapters have subprocess and construction tests, not physical verification on every OS. See [usage and compatibility](../docs/composer-attachments.md).

## PR validation

- Affected suite with `--maxWorkers=4` and the explicit package/app test paths above: **847 tests passed across 66 files**.
- A prior default-worker run had one graceful-interrupt lifecycle timing failure (846 passed); the complete lifecycle file passed in isolation (61 tests), then the complete affected suite passed with bounded concurrency. No retry-only code changes or weakened assertions.
- Repository formatting, lint, typechecking, production dependency audit, release build, and installed package smoke passed.
- Parent review findings have regressions for repeated unsupported-image rejection without artifact writes and literal paste-marker preservation plus undo. Automatic snippet collapsing is intentionally deferred rather than risking silent text corruption.
- Clipboard/terminal compatibility is tested with automated adapters and fixtures, not physical cross-platform validation.

## User-requested large-file revision (supersedes earlier admission limits)

- Checkpoint `bbd948f` removes attachment-count/byte/empty-file admission caps. Copied files and paths stay on disk and use the existing artifact importer, now cancellation-aware and bounded to the selected source extent with identity/mutation checks.
- Originals remain durable after source deletion; restored generic refs never reread whole contents. Bounded prompt summaries link to a complete streamed immutable manifest, and `/attachments <page>` exposes all draft indices/statuses.
- Optional preview/model image working-set and decode bounds do not reject originals. Unsupported, oversized, or unsafe inline views emit explicit notices and preserve original artifact paths.
- Clipboard pixels spool with backpressure, with cancellation and source ownership through pending admission. Preview queue jobs/payload bytes remain bounded and cancellable.
- Validation: **924 tests / 73 files passed** on explicit domain, agent-types, runtime-pi, runtime, workspace, TUI, tools, and affected app test paths with `--maxWorkers=4`. This includes 12 files with two >16MiB originals and empty files, source deletion, complete manifests, mutation detection, retry dedup, real import cancellation, and clipboard spool/lifetime regressions.
- Original checkpoint CI failed only lint issues; fixing those before the next push. Final-head CI and bot reviews—not original-head results—remain the merge gate.

## Final-head bot corrections

- Domain-separated attached-intent digests cannot collide with literal JSON text-only input; legacy text-only hashes remain unchanged. SQL again rejects embedded-NUL digests and delivered rows retaining attachment copies.
- Frozen history now pins authoritative attachment text and image content digests. Pi ignores caller attachment-text overrides and verifies decoded replay image bytes against frozen digests without filesystem authority.
- History/current attachment text participates in context admission. Optional image projection reserves a conservative dimension-based context allowance independently of storage admission; images that do not fit remain original files with explicit notices.
- Metadata-only restore additionally checks file existence/type/length (not whole generic-file hashes). Partial successful imports remain registered session-linked artifacts, and identical retries reuse identities rather than destructive cleanup.
- Pending clipboard/path requests receive an explicit retry notice; empty transcript projections and reasoning-only entries no longer carry irrelevant attachment arrays.
- Full affected suite: **927 tests / 73 files passed** before the additional standalone SQL invariant regression. Formatting, lint, and typecheck pass. All final-head CI and bot reviews remain mandatory before merge.
