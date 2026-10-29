# Learning system audit and redesign

Status: in progress on branch `learning-redesign`. See "Implementation status" at the end.

## Summary

The learning system works as plumbing. A settled turn starts a reflection job. The job can publish a Capability. Later turns can select that Capability, and the user can pause or restore it. The weak part is the learning itself. In real use the system has learned very little, and the one thing it learned in the current install is wrong.

The audit found five main causes:

- The reflector judges a turn before the user has reacted to it. The user's next message is the best signal of whether a turn went well, and the reflector never sees it.
- The reflector prompt sets no bar for learning. It says to create a Capability "immediately" when behavior "can improve".
- No part of the system checks whether a Capability helped after it was published. Code exists for this, but nothing runs it.
- Each turn can cost two extra calls to the foreground model, one for routing before the turn and one for reflection after it. Both use the foreground reasoning level.
- About 8,900 lines of older learning code and about 25 old tables are still in the repo, and the app does not call them.

The redesign keeps the parts that work and changes how learning decides and how it is checked:

- A Capability becomes one readable Markdown file. The user can open it, edit it, and see its history.
- Capabilities reach the model the way skills do. An "always" Capability puts its text in the system prompt. Every other Capability appears as a name and a "when to use" line, and the model loads the body when it needs it. This removes the router model call.
- Reflection waits for the user's reaction. It reads a turn together with the next user message, or with the end of the session.
- A slower review runs once per session. It looks across sessions for repeated work, merges duplicates, and retires Capabilities that did not help.
- Each Capability keeps a short track record of whether it helped when it was used. The reflector reads this record before it revises or pauses a Capability, and `/learning` shows it to the user.

## What the project set out to build

This section summarizes the Codex sessions from July to September 2026. The founding session is `rollout-2026-07-19T01-21-51`.

The first message described "a personal agent harness designed not merely to complete tasks, but to help its user think, learn, create, and grow". The harness "learns from how you use it, and it augments itself to better suite your needs". The goal was that it would "just feel like magic" and happen "without the user explicitly being involved, unless they want to be".

The user wanted the agent to change more than instructions. The founding session asks for it to "update its tools, and toolsets with arbitrary code. And also update its system prompt". The user also called cross-session recall the base of compounding: "very important that one session be able to query other sessions. That's how improvement compounds, right?"

The sessions drew on these references:

- Lilian Weng's post "Harness Engineering for Self-Improvement". It describes finding failures, making small edits, testing them on held-out cases, and keeping the evaluator outside the system it judges.
- The LangChain post "Continual learning for AI agents". It splits learning into model, harness, and context, and it learns from traces.
- GEPA, Self-Harness, SIA, and the "Continual Harness" paper. From these the sessions took reflection in plain language over traces, minimal edits checked against regressions, and the idea of several learning clocks running at different speeds.
- Hermes agent, Codex rollouts, Exo, Prime Agent, pi-fabric, and OpenCode, with local clones under `~/work/clones/`. The `/refine` alias came from Prime Agent. The Hermes study found that Hermes treats "doing nothing" as a missed chance to learn, and Noesis chose `no_change` as a valid result instead.
- Alex Zhang's writing on recursive language models, which shaped codemode and workflows.

The design then changed many times. Each change removed process:

1. July 18 to 22. The first plan had a ledger, a proposal and evaluation pipeline, and a staged rollout. The user said it was "a little too over engineered" and asked "Why do we need so many steps?"
2. August 4 to 5. Regular expressions were used to detect corrections. The user called this "super, super bad" and asked to use language models for anything that needs judgment.
3. August 6 to 9. The user worried that "our loop is too long, and most people wont feel the magic for a long time if at all". This led to fast working adjustments and to Programs that skip reflection.
4. August 15 to 18. An audit found that preflight trials never ran the candidate's actual bytes. The user agreed that "We overall have faarrr too much ceremony" and said "The cost of making a mistake is actually quite low, the high cost is not being able to correct a mistake". This produced the current Capability model, global by default, with reflection after every turn and evaluation postponed.
5. August 20. The user asked "We want our capabilities to actually be capabilities right?" This led to Program effects.

These wishes stayed the same through every version:

- Learning runs in the background, with no approval dialogs.
- Users feel improvements early, during their first project.
- Every change is easy to see, easy to undo, and explained by its evidence.
- Language models make every decision that depends on meaning.
- Prompts stay small.
- Each responsibility has one system.

Two goals from the start have faded. The first is evaluation. The user postponed it with "add a proper eval system later", and it was never added. The second is the user's own growth, e.g., learning and transfer, which the founding message put next to the agent's growth.

## How learning works today

After every admitted foreground turn settles, `runtime-composition.ts` enqueues a `runtime.reflect_capability` job. The next turn in the session waits up to 1.5 seconds for that job.

`createCapabilityLearningModule` in `packages/learning/src/capability-loop.ts` builds six messages for the reflector:

- the settled turn
- the current Capabilities
- the foreground Capability surface
- the current Capability materials, cut to 4,000 characters each
- the saved Programs
- an evidence packet with up to 32 citations, including 8 search hits from earlier sessions

The reflector uses the foreground provider, model, and reasoning level. It has no tools. It returns one of these decisions:

- `no_change`
- `create`
- `revise`
- `pause`
- `restore`
- `change_binding`

`createCapabilityPublisher` checks the decision, writes the instruction and skill bytes as file revisions, and updates the binding in SQLite with a compare and swap. The change takes effect on the next turn.

At the start of each later turn, `turn-intelligence.ts` collects the active Capabilities. If any Capability is in `relevant` mode, the turn waits for a `capability_router` model call. That call reads up to 24 messages and 64,000 characters and picks which Capabilities apply. It also names one Capability for "learning attribution", but nothing reads that attribution afterward.

The foreground agent can also publish through `capabilities.refine` after it loads the `noesis` skill. That call goes through the same publisher.

## What the audit found

### 1. In real use, the system learned the wrong thing

The live workspace at `~/.noesis` has 8 reflection jobs. Seven returned `no_change`. One created the only Capability, "Respond to simple greetings", which is active, global, and in `relevant` mode.

The turn that caused it was the user message "hey hey". That turn failed with a provider error, `400 MissingSessionID` from OpenCode Go. The model never ran. The outcome summary that the reflector received contained that error text. The reflector still wrote: "The current foreground turn containing only 'hey hey' failed without a response. A prior comparable greeting... was handled successfully... providing a concrete response pattern worth making durable."

The result is a wrong lesson. The cost of that lesson is a blocking router call on every later turn, because a `relevant` Capability now exists.

The development install at `work/noesis/.noesis` shows the same pattern on a larger scale. It has 173 foreground turns and 164 reflection jobs. The results of those jobs were:

- 72 returned `no_change`.
- 25 created a Capability.
- 3 revised a Capability.
- 61 failed. 49 of the failures came from the publisher check that rejects a revision whose name, description, or applicability differs from the original. That check is still in `capability-publisher.ts` at line 332.

All 27 Capabilities in that install are active, global, and in `relevant` mode. None was ever paused. Only 3 feedback rows exist. None uses a Program. Many Capabilities are narrow instruction patches that overlap, e.g., "Evidence-bounded compaction reporting", "Evidence-bounded active model reporting", and "Evidence-bounded error-message explanations". The install also has a Capability named "Responsive casual greetings". In this install, too, the system adds Capabilities, but it rarely improves one and never removes one.

### 2. The reflector judges a turn before the user reacts

Reflection runs as soon as a turn settles. The most useful evidence about a turn is the user's next message, e.g., "no, use pnpm", "perfect", or the user repeating the request. The reflector never sees that message as a reaction to the turn it is judging. It sees the message only when it reflects on the next turn, where the message counts as a new request.

This explains most of the `no_change` results. A turn that looks fine when it ends gives the reflector nothing to judge. A correction then arrives, and it is judged without the turn it corrects.

### 3. The reflector has no bar for learning

The reflector prompt in `rolePrompt("reflector")` says: "When durable behavior can improve, create or revise one concrete Capability immediately." It does not ask what the user would otherwise have to repeat. It does not ask whether the evidence comes from the user or only from the reflector's own view. It also does not ask whether the cause was the model's behavior or something outside it.

### 4. The reflector cannot tell infrastructure failures from behavior

The runtime already knows why a turn failed, e.g., a provider error, a tool error, or a user abort. It passes the reflector only a status of `failed` and a summary string. The reflector must then guess the cause, and in the greeting case it guessed wrong. The runtime can state the cause as a plain fact, and this is not a semantic classification.

### 5. Nothing checks whether a Capability helped

`capability_feedback` rows are written only as a side record of the reflector's own `revise`, `pause`, and `restore` decisions. No code links a Capability that was used in a turn to how that turn went. `learningAttribution` is stored in the frozen turn plan and never read. `continuous-feedback.ts`, `compounding-metrics.ts`, and `packages/evals` were built to do this, but the app does not call any of them.

So the system can add Capabilities, but it cannot tell a helpful one from a harmful one. The current install shows this. The greeting Capability has no record of whether it helped, and nothing will ever question it.

### 6. Routing adds a blocking model call to each turn

Once one `relevant` Capability exists, every turn waits for a router call before the foreground model starts. The router uses the foreground model and reasoning level and can read up to 64,000 characters. If the router call fails or returns invalid output, the turn fails. The foreground model already chooses skills by name and description, so it could make this choice itself at no extra cost.

### 7. Reflection is expensive

The reflector runs after every turn on the foreground model and reasoning level, with up to 64,000 characters of input. A "yo" turn costs as much to reflect on as a long debugging turn. Most results are `no_change`.

### 8. Revising a Capability is brittle

The publisher requires a revision to repeat the original name, description, and applicability exactly. In the development install this check caused 49 failed reflection jobs, while only 3 revisions succeeded. It also means Noesis cannot refine when a Capability applies, which is the part it most needs to learn.

### 9. The reflector cannot investigate

The foreground agent can search history, read files, and run Programs. The reflector gets one prepared packet, with history search limited to earlier sessions and keyed on the user message. It cannot look for repeated patterns across sessions. This is the kind of evidence that supports a skill or a Program, and it explains why no ambient Program effects exist.

### 10. Old code and tables remain

These files have no production caller. Tests still cover them.

| Area                              | Files                                                                                                                        | Lines       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Old learning organ                | `packages/learning/src/organ.ts`, most of `durable.ts`                                                                       | about 2,200 |
| Old coordinator and control plane | `packages/runtime/src/coordinator.ts`, `coordinator-composition.ts`, `control-plane.ts`                                      | about 1,500 |
| Old activation and feedback       | `atomic-activation.ts`, `preflight-policy.ts`, `protected-activation.ts`, `continuous-feedback.ts`, `compounding-metrics.ts` | about 2,300 |
| Evaluation lab                    | `packages/evals/src/*`                                                                                                       | about 2,950 |

The workspace schema still has about 25 tables from the older designs, e.g., `working_adjustments`, `experiments`, `experiment_*`, `preflight_*`, `activation_*`, `evaluations`, `feedback_signals`, and `compounding_replay_*`. `store.ts` is 5,953 lines, and `learning-audit-read-model.ts` is 73 KB, largely to read these tables. AGENTS.md asks for "one system for one responsibility", and the user said in the founding session "I am very unhappy however with having duplicate systems or dead code".

### 11. The user cannot easily read what was learned

A Capability is spread across a definition row, revision JSON, a binding row, feedback rows, and material files under `revisions/`. The founding session has two complaints about `/learning` showing "a bunch of IDs, but not enough actually useful or legible information about what changed". The data model makes a plain view hard to build.

## Design principles

These come from the product thesis and from the sessions.

1. Learn from the user's reactions. A correction, a repeated request, an explicit "remember this", and a repeated procedure are the strongest evidence. The reflector's own opinion of a turn is weak evidence.
2. Learn rarely and well. A wrong Capability costs more than a missed one, because it affects many later turns and nothing removes it. `no_change` should be the normal result.
3. Check every Capability against how it does in later use. A Capability that is used and then corrected should be revised or paused without the user asking.
4. Put what the system learned in one readable place. The user should be able to read one file and know what Noesis learned, when it applies, why, and how it has done since.
5. Use the mechanisms the model already has. Skills are already disclosed by name and description, so Capabilities should use the same path.
6. Spend money where the evidence is. A short exchange with no reaction should cost little to reflect on. A session with a clear correction or a repeated workflow deserves a capable model with tools.

## The redesign

### A Capability is one Markdown file

Each Capability is one file, `~/.noesis/capabilities/<slug>.md` for global ones and `<project>/.noesis/capabilities/<slug>.md` for project ones. The file is the authority for the Capability's content and settings. Every published version is an immutable file revision, as all definitions are today, so frozen turn plans still pin exact bytes.

```markdown
---
name: Use pnpm in this repo
when: Installing, adding, or running packages in the noesis repository.
mode: relevant # relevant | always
status: active # active | paused
program: null # or { mode: script, name: release-notes }
---

Use `pnpm`, not `npm` or `yarn`. Run single test files with explicit paths.

## Why

On 2026-10-12 the user said "no, we use pnpm here" after I ran `npm install`
(session 3f2c, turn 14). The same correction happened on 2026-10-20 (session 9a1b).

## History

- r2, 2026-10-21: added the test-path rule after a second correction.
- r1, 2026-10-12: created.
```

This changes how the parts fit together:

- The `when` line replaces `description` and `applicability`, and it can be revised. This fixes finding 8.
- Scope comes from where the file lives, so the project or global choice is visible in the file system. Session scope is removed. The August 8 session already called it "far too granular".
- Instruction and skill effects become one body. Short bodies in `always` mode go into the system prompt. Every other body is loaded on demand, in the same way as a skill.
- A Program effect is a reference to a saved project Program, as it is today.
- The `Why` and `History` sections are written by the publisher from structured fields, so a person can read them and a test can check them.

SQLite keeps the operational facts about Capabilities, which are the track record and the jobs. Activity rows still record each publish. The current binding table, revision JSON, and feedback table are replaced by the file and its revisions.

The user can edit the file directly. The publisher treats an edited working file the same way it treats a foreground edit. It records a new revision and uses it from the next turn.

### Capabilities reach the model like skills

The router role is removed.

- An `always` Capability adds its body to the system prompt. The publisher limits this body to a small size, e.g., 1,000 characters, and the total for all `always` bodies has a hard limit.
- A `relevant` Capability adds one line to the skill index, which holds its name and `when` line. The foreground model loads the body with `skills.load` when it needs it.
- A Capability with a Program also exposes the Program adapter, as today.

This removes one model call per turn and one point of failure. It also gives a truthful usage signal. A Capability counts as used when the model loaded it or when it was `always` active, not when a router guessed it was relevant.

When the index grows past a limit, e.g., 40 Capabilities, the planner shows the Capabilities that rank highest by the existing hybrid search on the current request. This uses retrieval, which the doctrine allows, and the model still makes the choice.

### Reflection reads a turn together with the user's reaction

The unit of reflection becomes an exchange. An exchange is one settled turn plus the next thing that happened, which is one of these:

- the next user message in the session
- the session going idle for a set time, e.g., 10 minutes
- the user closing or switching the session

The runtime enqueues the reflection when one of these happens. The next turn does not wait for it. The 1.5 second barrier is removed, because a lesson from turn N is not needed in turn N+1 when turn N+1 is the reaction to turn N. One exception remains. When the reaction is an explicit request to remember or change behavior, the foreground agent can publish directly through `capabilities.refine`, as it can today.

The reflector receives:

- the turn's user message, assistant reply, and a summary of its tool calls, as today
- the reaction, either the next user message or "no reply, session idle"
- runtime facts about the turn, as structured fields (see the next section)
- the Capabilities that were used in the turn, with their full bodies and track records
- the names and `when` lines of all other Capabilities, so it can avoid duplicates

The reflector returns one decision:

```ts
type ExchangeDecision =
  | { decision: "no_change"; reason: string }
  | { decision: "record_outcome"; outcomes: { capability: string; result: "helped" | "hurt" | "unclear"; reason: string }[] }
  | { decision: "create" | "revise"; capability: CapabilityDraft; evidence: EvidenceClaim; outcomes?: ... }
  | { decision: "pause"; capability: string; reason: string };
```

`EvidenceClaim` makes the reflector say what kind of evidence supports a lesson:

```ts
type EvidenceClaim = {
  kind: "explicit_request" | "user_correction" | "repeated_across_sessions" | "verified_method";
  quote: string; // the user's words or the observed result
  citations: number[]; // indexes into the supplied evidence
  wouldOtherwise: string; // what the user would have to repeat or correct without this lesson
};
```

The prompt sets the bar in plain terms:

- Create a Capability only when the user stated a preference or correction, or when the same need appears in more than one session, or when a method worked and the user is likely to need it again.
- Do not create a Capability from a turn that failed for a reason outside the model.
- Prefer revising the Capability that was used over creating a new one.

A language model still makes every one of these judgments. The schema only makes the model state its reasons in fields that people and tests can check.

The exchange reflector runs on a configurable, cheaper route, like the session title model. The default is the foreground provider's smaller model at low reasoning. The reflector role keeps its own prompt revision, so the project can compare prompts later.

### The runtime states failure causes as facts

Settlement already knows why a turn ended. It will record a `cause` field on the outcome:

- `completed`
- `user_aborted`
- `provider_error`, with the status and message
- `tool_error`, with the failing tool calls
- `runtime_error`, with the error

When the cause is `provider_error` or `runtime_error` and the model produced no output, the runtime skips behavior reflection for that turn. It records the skip as a `no_change` with the reason "turn failed before the model ran". This is a fact about the runtime, the same kind of fact as "a tool failed", so the "no regular expressions for meaning" rule allows it. With this check in place, the greeting Capability would not have been created.

### A session review finds repeated work

A second, slower reflector runs once per session. It runs after the session has been idle for a set time, e.g., 30 minutes, or when the user starts a new session. It runs only if the session had at least one completed turn.

The session reviewer is a background agent with read-only tools:

- `history.search` across sessions, including the current one
- `capabilities.inspect`
- `programs.list` and `programs.describe`
- `files.read`

It uses the foreground route. It looks for the evidence that the exchange reflector cannot see:

- a procedure the user asked for in more than one session, which could become a skill or a Program
- several Capabilities that overlap and should be merged
- a Capability with a poor track record that should be revised or paused
- a Capability that has not been used in a long time, e.g., 60 days, which it can mark for the user to review

It publishes through the same publisher, with the same decision schema, as one decision per change. It may also save a project Program and attach it, with the same "save, run once, then attach" rule that the foreground agent follows. This closes finding 9 and lets ambient learning produce Program effects.

The reviewer is not a foreground subagent. It runs under its own scheduler grant, so the AGENTS.md rule "Subagents may advise but may not publish" does not change.

### Each Capability keeps a track record

A new SQLite table records judged outcomes:

```sql
CREATE TABLE capability_outcomes (
  outcome_id TEXT PRIMARY KEY,
  capability_slug TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('helped', 'hurt', 'unclear')),
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
```

The table gets a row only when a Capability was used in an exchange and the reflector judged the result. Silent turns where the Capability was not used get no row, so this is not the usage log that the August design rejected.

Two rules use the table:

- When a revision has two `hurt` results and no `helped` results, the publisher pauses it. It tells the user, e.g., "Paused 'Use pnpm in this repo' after two corrections. /learning to restore."
- The reflector and the session reviewer always see the track record of the current revision before they revise it.

Both rules use counts of model judgments. Code does no semantic work here.

### What the user sees

- After a publish, a one-line notice appears, e.g., "Learned: Use pnpm in this repo (from your correction). /learning to view or undo." Ordinary turns get no notice.
- `/learning` lists Capabilities, not jobs. Each row shows the name, the `when` line, the scope, the mode, and the track record, e.g., "used 7 times, helped 5, hurt 1". Opening a row shows the file, its `Why` section, and its revisions. Undo restores the previous revision.
- `no_change` results appear only as a count and in a detailed audit view, as today.
- The user can still change anything in conversation, e.g., "stop doing that" or "make that one global". The foreground agent handles the request through `capabilities.refine`.

### What stays the same

- The foreground path, `capabilities.inspect`, `capabilities.refine`, and the `noesis` skill stay. Only the decision schema changes.
- Programs stay exactly as they are.
- Frozen turn plans still pin exact Capability revisions.
- The small consequence gate for credential export, recovery and audit control, and irreversible external actions stays.

## What we remove

- The `capability_router` role, `capabilityRouterMessages`, and the router checks in `turn-intelligence.ts`.
- The name, description, and applicability identity check in the publisher.
- The `current_capability_materials`, `foreground_capability_surface`, and `available_saved_programs` messages from the exchange reflector. The session reviewer gets these through tools instead.
- `capability_bindings`, `capability_revisions`, and `capability_feedback`. The file and its revisions replace them, after a one-time migration.
- The unused code in finding 10: `organ.ts`, the unused parts of `durable.ts`, the old coordinator and control plane, the activation and preflight modules, `continuous-feedback.ts`, `compounding-metrics.ts`, `packages/evals`, and their tests.
- The old tables. A one-time step exports their rows to a JSON artifact under `~/.noesis/archive/` and then drops them. The audit view reads the archive. This changes the AGENTS.md line "Existing experiment and preflight records remain readable history", because the records stay readable as a file instead of as tables.
- The read code in `learning-audit-read-model.ts` and `learning-read-model.ts` that serves only those tables.

## How we will know it works

### Measures from real use

A `noesis learning report` command reads SQLite and prints these measures for a time window:

- The repeat correction rate. This is the share of corrections that repeat a correction the user already made in an earlier session. It is the main measure of whether learning works, and it should fall over time.
- Helped and hurt counts per Capability, and the share of Capabilities that were paused or undone.
- The publish rate per 100 exchanges and the share of publishes by evidence kind.
- Reflection cost per exchange and per publish.
- The share of Capabilities used at least once in the 30 days after they were created.

The model's judgments supply these numbers, e.g., whether a message is a correction. The report only counts and divides.

### A learning acceptance suite

A suite of scripted scenarios runs locally against a real model. CI runs the same scenarios with the controlled provider and recorded responses. Each scenario has two sessions:

1. In session one, the user makes a correction or states a preference.
2. In session two, the user makes a related request, and the suite checks whether the agent follows the lesson.

The suite also needs negative cases:

- A turn that fails with a provider error must not create a Capability.
- A one-off request, e.g., "write this email formally", must not become a global rule.
- A Capability that is followed by two corrections must be paused.
- An unrelated request in session two must not load the Capability.

The "learn" and "restore" suites in the pi-fabric comparison have this shape.

## Plan

Each phase leaves the product working.

1. Stop the wrong lessons. Add the outcome `cause` field. Skip reflection when the model never ran. Rewrite the reflector prompt with the evidence bar. Remove the publisher's identity check. Pause the greeting Capability in the current install.
2. Delete the old code and tables, with the one-time archive export. This phase does not change behavior.
3. Move reflection to exchanges. Add the exchange trigger, the reaction field, the `EvidenceClaim` schema, and the cheaper configurable route. Remove the 1.5 second barrier.
4. Replace the router with skill-style disclosure and the large-index retrieval fallback.
5. Add `capability_outcomes`, the automatic pause rule, and the track record in `/learning`.
6. Move Capabilities to Markdown files, migrate existing Capabilities, and replace the binding, revision, and feedback tables. Rebuild `/learning` around the files.
7. Add the session reviewer with read-only tools and Program authoring.
8. Add `noesis learning report` and the learning acceptance suite.

Phases 1 and 2 are small and can ship this week. Phases 3 to 5 give most of the improvement in learning quality. Phase 6 gives most of the improvement in how easy the system is to read. It is also the largest change, so it can wait until phases 3 to 5 show results.

## Doctrine changes this needs

These AGENTS.md and `docs/` statements change:

- "Run reflection ambiently after every settled foreground turn". The new text is that reflection runs on every exchange once its reaction is known, and once per session.
- "`CapabilityBinding` is the sole authority" in `docs/agent-intelligence-and-experience.md`. The Capability file becomes the authority for content and settings.
- "The semantic router selects global `relevant` Capabilities". The foreground model selects them from the index.
- "The Capability record does not copy a list of turns that used it". This still holds, but `capability_outcomes` records judged outcomes.
- "Existing experiment and preflight records remain readable history". They stay readable as an archive file.
- Session scope is removed from the scope list.

## Open questions

1. Should the Capability file be the authority for `status` and `mode`, or should those stay in SQLite with compare and swap? Files are easier to read and edit. SQLite is safer when two writers change the same Capability at once. This plan chooses files and uses the existing definition publication check for concurrent writes.
2. Is pausing after two `hurt` results and no `helped` results the right default, or should Noesis only suggest the pause?
3. Should the founding goal of user growth return as its own design, e.g., tracking what the user is learning and offering review? This plan leaves it out, because it is a separate product decision.
4. Should the exchange reflector default to a smaller model, or to the foreground model at low reasoning? The first costs less. The second is safer across providers that have no small model.

## Implementation status

As of 2026-10-29, on branch `learning-redesign`, uncommitted.

Built:

- Phase 1. Settlement records how each turn ended in `outcomes.metadata.cause`. A turn that failed before the model produced any output is not reflected on. The reflector prompt sets the evidence bar, and every new or revised Capability must carry an evidence claim, which is stored on the revision. A revision may now change the name, description, and applicability.
- Phase 2. The unused learning code is deleted, about 17,000 lines, including `packages/evals`. The old tables are not dropped yet, because the `/learning` audit view still reads them.
- Phase 3. Reflection waits for the user's reaction. The next user message releases the held job, and otherwise it runs after `reflection.idleMinutes`, 10 by default. The 1.5 second barrier is gone. The reflector has its own route in `config.json` under `reflection`, with reasoning `low` by default.
- Phase 4. The router role and its model call are gone. An `always` Capability goes into the prompt. A `relevant` Capability is listed as a learned skill named `learned-<name>-<id hash>`, and the model loads it with `skills.load`.
- Phase 5. Migration 053 adds `capability_outcomes`. The reflector sees the Capabilities a turn used, with their track records, and judges each one. A revision with two hurt results and no helped result is paused automatically. `capabilities.inspect` and `/learning` show the track record and the evidence claim.
- Phase 7. A session review runs 30 minutes after a session's last turn. It uses a prepared packet of the session's requests, matching earlier sessions, and all Capabilities with their track records, and it publishes at most three decisions through the same publisher.
- Phase 8, first half. `noesis learning report [--days N]` prints the measures listed above. Reflection and session-review jobs now store their model's token usage, so the report includes cost. "Corrections after learning" is the share of judged uses that the reflector marked hurt.
- `always` guidance is limited to 2,000 characters per Capability, and all `always` guidance shares a 6,000 character allowance per turn. A Capability past the allowance is listed on demand for that turn.
- A session review's published change is announced once in each session the user works in, on that session's first turn after the review completed, labelled as a review of an earlier session. A review usually finishes after the user has left the session it covers. Each change it makes stays visible in `/learning` as part of that Capability's revisions and feedback.

Changed from the plan:

- The session reviewer has no tools. A prepared packet was simpler and fits the existing role runner. As a result it cannot author new Programs yet. It can still create, revise, pause, and rescope Capabilities.
- Session scope stays. The plan proposed removing it, but it is a narrow, explicit choice that the model or user makes, existing bindings use it, and removing it would need a migration for no gain in this change.
- The large-index retrieval fallback is not built. Today's installs have at most 27 Capabilities, so the full index fits.

- Phase 6, built differently from the plan. Each Capability has one Markdown file under `~/.noesis/definitions/capabilities/<name>-<id>.md`, and every revision pins an immutable snapshot of it. The working file is the editable source for the name, the "when" text, and the guidance. Before each turn and when `/learning` opens, Noesis records direct edits as new revisions through the publisher. It leaves an unreadable edit in place and reports it in `/learning`. A restore or a gate approval rewrites the working file to match. At startup, Noesis moves every older Capability into a file as a new revision. Status, scope, and mode stay in the SQLite binding instead of the frontmatter. They change often, and keeping them in SQLite keeps compare and swap and avoids a second copy. Instruction and skill drafts now become one guidance body.

Not built yet:

- The archive export and removal of the old experiment, preflight, activation, and working-adjustment tables. Both current installs have no rows in them, and the `/learning` audit view still reads them, so removing them does not change use.
- The second half of phase 8, two-session scenarios against a real model. The controlled-provider tests cover the main cases.
