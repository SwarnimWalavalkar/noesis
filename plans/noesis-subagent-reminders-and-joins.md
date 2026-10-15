# Subagent reminders, wake-ups, and value joins

Status: active.

This plan amends [process-scoped subagents](noesis-process-scoped-subagents.html). The mailbox, retained actors, and Code Mode surface stay. What changes is how results and messages reach an actor, and when `agents.wait` is appropriate.

## Problem

- A settled subagent task notifies nobody. The parent only learns the result through `agents.wait`, `agents.inspect`, or a voluntary `agents.send`, so models wait just to avoid losing results.
- Foreground delivery steers `[Subagent <id>]` as a user message. That gives child text user framing, and Pi's steering guard skips the parent's already-proposed tool calls as if the user had interrupted.
- A steered child message is never written to the foreground session's messages, so it disappears from later turns.
- An idle foreground session holds child messages until the user types. The TUI shows "A subagent message is waiting for this session's next safe boundary."

## Decisions

1. **Completion notices.** When a task completes, fails, or is interrupted, the supervisor sends a notice to the task's requester: the sender of the message that triggered the task. A notice is a mailbox message with `kind = 'completion'`, attributed to the subagent. It is skipped when:
   - the requester is already joining the task through `agents.wait`, since the value already flows into code;
   - the task was cancelled, because cancel and close return the result to the caller;
   - the process is shutting down;
   - the triggering message was itself a completion notice, which prevents notice ping-pong between actors.
2. **System reminders.** All mailbox deliveries render as one `<system-reminder>` block that states it is a runtime collaboration notice and not user authority. Pending messages for one recipient coalesce into one reminder.
3. **Active recipient.** The reminder is steered into the running Pi turn at the next model boundary. Reminder steers do not trigger the skip guard for already-proposed tool calls. Foreground deliveries persist as session messages (`origin: "collaboration"`, `deliveryMode: "steer"`), so replay, compaction, and inspection see the same bytes.
4. **Idle recipient wakes up.**
   - An idle subagent starts a new task, as already happens for messages.
   - A message steered into a subagent task that settles before consuming it is not lost. Once that task settles, the message goes to the agent's next running task or triggers a new follow-up task. The message keeps its original immutable `task_id`; the follow-up task names it as `trigger_message_id`.
   - An idle foreground session runs a collaboration turn whose input is the reminder. It uses the same interaction queue and serialization as user turns, but no user intent.
   - A queue paused by an explicit interrupt or failure is not woken. The reminder joins the next turn the user starts.
   - Reflection still runs after a collaboration turn and receives the reminder text, which identifies itself.
5. **Value joins only.** Code Mode rejects, before execution, any `agents.wait` call whose value is discarded. This covers a bare `await agents.wait(...)` statement, `void`, and a discarded `Promise.all`/`allSettled`/`race`/`any` of waits. This is a syntactic AST check, not a semantic classifier. Waiting is for composing a child's value into downstream logic.
6. **Workflows compose agents.** Foreground saved Programs, including workflow phases, may declare and call `agents.*`, so dependent fan-out/fan-in graphs are expressed as workflows. Descendant spawning from subagents still requires an explicit grant.
7. **Guidance.** The `execute` skill and the `agents.wait` description teach these rules:
   - Spawn and continue, or end the turn; results arrive as reminders.
   - Wait only to use the value in code.
   - Use a workflow when outputs feed other agents.

## Persistence

Migration `051_agent_message_kind.sql` adds `agent_messages.kind` (`message` or `completion`), defaulting to `message`. The mailbox remains the authority for collaboration messages. A foreground session message row is the delivered transcript copy and cites `mailboxMessageIds`.

## Validation

Verified end to end on 2026-10-15 against a real model (`openai-codex`) through the real TUI and Pi AgentHarness (`scripts/noesis-dev`, driven over a PTY):

1. **Idle wake.** The foreground spawned `scout` and ended its turn. The completion notice woke the idle session; the woken turn's input was the stored `origin: collaboration` reminder, and the model answered with the child's word.
2. **Discarded wait.** `await agents.wait(...)` as a statement failed before any subagent spawned. The model recovered with `return await agents.wait(...)`, and no duplicate notice was sent.
3. **Active turn.** A reminder arrived after `sleep 25` in the same turn and was stored with `deliveryMode: steer`. The `echo` call the model made next still ran. The TUI showed `clock finished · the agent sees it at its next step` and an `AGENTS` block.
4. **Workflow fan-out.** The model saved and ran a workflow whose phase spawned two subagents and joined them. The run returned `red + blue`, with no completion notices.

Format, lint, and typecheck pass.
