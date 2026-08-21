import { createConditionalObject, type JsonValue } from "@noesis/domain";
import { presentActionPayload } from "./action-presentation.ts";
import { isRecord, numberField, stringField } from "./record-fields.ts";
import type { TuiAgentAction } from "./state.ts";
import { safeTerminalText } from "./theme.ts";
/**
 * Codemode routes nearly all work through a single `execute` call whose nested SDK calls carry
 * whole file contents, command output, and HTTP bodies in their results. Rendering those payloads
 * verbatim costs hundreds of transcript rows per turn, so every action is reduced to one line here
 * and the full payload is reachable only through expansion or the run inspector.
 */
export const EXECUTE_ACTION_NAME = "execute";
function arrayField(value: JsonValue | undefined, key: string): readonly JsonValue[] | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return Array.isArray(field) ? field : undefined;
}
function booleanField(value: JsonValue | undefined, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}
export function executionIdOf(action: TuiAgentAction): string | undefined {
  if (action.executionId) return action.executionId;
  const details = isRecord(action.output) ? action.output["details"] : undefined;
  if (stringField(details, "kind") === "result") {
    const completedExecutionId = stringField(details, "executionId");
    if (completedExecutionId) return completedExecutionId;
  }
  if (stringField(action.update, "kind") !== "activity") return undefined;
  return (
    stringField(action.update, "executionId") ??
    stringField(isRecord(action.update) ? action.update["activity"] : undefined, "executionId")
  );
}
export function sourceOf(action: TuiAgentAction): string | undefined {
  return stringField(action.input, "source");
}
const baseName = (path: string): string => {
  const trimmed = path.replace(/\/+$/u, "");
  const separator = trimmed.lastIndexOf("/");
  return separator < 0 ? trimmed : trimmed.slice(separator + 1) || trimmed;
};
export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`;
  if (bytes < 1000000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1000000).toFixed(1)} MB`;
}
export function formatDuration(milliseconds: number): string {
  const roundedMilliseconds = Math.round(milliseconds);
  if (roundedMilliseconds < 1000) return `${String(roundedMilliseconds)}ms`;
  const tenthsOfASecond = Math.round(milliseconds / 100);
  if (tenthsOfASecond < 600) return `${(tenthsOfASecond / 10).toFixed(1)}s`;
  const roundedSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`;
}
const firstLine = (text: string): string => text.split("\n", 1)[0] ?? "";
function summaryLine(text: string): string {
  return firstLine(safeTerminalText(text));
}
/** Reduce one nested SDK call to a subject and an outcome, e.g. "state.ts" and "287 lines". */
type NestedSummarizer = (
  input: JsonValue | undefined,
  output: JsonValue | undefined,
) => {
  readonly subject?: string;
  readonly outcome?: string;
};
const NESTED_SUMMARIZERS = {
  "files.read": (input, output) => {
    const path = stringField(output, "path") ?? stringField(input, "path");
    const totalLines = numberField(output, "totalLines");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({} as const)
      .addOptional(path ? { subject: baseName(path) } : undefined)
      .addOptional(!(totalLines === undefined) ? { outcome: formatCount(totalLines, "line") } : undefined)
      .finish();
  },
  "files.write": (input, output) => {
    const path = stringField(output, "path") ?? stringField(input, "path");
    const bytes = numberField(output, "bytes");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({} as const)
      .addOptional(path ? { subject: baseName(path) } : undefined)
      .addOptional(!(bytes === undefined) ? { outcome: formatBytes(bytes) } : undefined)
      .finish();
  },
  "files.search": (input, output) => {
    const query = stringField(input, "query");
    const matches = arrayField(output, "matches");
    const truncated = booleanField(output, "truncated") === true;
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({} as const)
      .addOptional(query ? { subject: `"${query}"` } : undefined)
      .addOptional(
        !(matches === undefined)
          ? {
              outcome: `${formatCount(matches.length, "match", "matches")}${truncated ? "+" : ""}`,
            }
          : undefined,
      )
      .finish();
  },
  "files.list": (input, output) => {
    const path = stringField(input, "path");
    const entries = arrayField(output, "entries");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({} as const)
      .addOptional(path ? { subject: baseName(path) } : undefined)
      .addOptional(
        !(entries === undefined) ? { outcome: formatCount(entries.length, "entry", "entries") } : undefined,
      )
      .finish();
  },
  "shell.run": (input, output) => {
    const command = stringField(input, "command");
    const exitCode = numberField(output, "exitCode");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({} as const)
      .addOptional(command ? { subject: firstLine(command) } : undefined)
      .addOptional(!(exitCode === undefined) ? { outcome: `exit ${String(exitCode)}` } : undefined)
      .finish();
  },
  "web.fetch": (input, output) => {
    const url = stringField(output, "url") ?? stringField(input, "url");
    const status = numberField(output, "status");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({} as const)
      .addOptional(url ? { subject: url.replace(/^https?:\/\//u, "") } : undefined)
      .addOptional(!(status === undefined) ? { outcome: String(status) } : undefined)
      .finish();
  },
  "scripts.run": (input, output) => {
    const name = stringField(input, "name");
    const calls = numberField(output, "calls");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({} as const)
      .addOptional(name ? { subject: name } : undefined)
      .addOptional(!(calls === undefined) ? { outcome: formatCount(calls, "call") } : undefined)
      .finish();
  },
  "workflows.run": (input, output) => {
    const name = stringField(input, "name");
    const status = stringField(output, "status");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({} as const)
      .addOptional(name ? { subject: name } : undefined)
      .addOptional(status ? { outcome: status } : undefined)
      .finish();
  },
  "workflows.resume": (input, output) => {
    const runId = stringField(input, "runId");
    const status = stringField(output, "status");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({} as const)
      .addOptional(runId ? { subject: runId } : undefined)
      .addOptional(status ? { outcome: status } : undefined)
      .finish();
  },
  "noesis.search": (input, output) => {
    const query = stringField(input, "query");
    const tools = presentActionPayload("noesis.search", output).tools;
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({} as const)
      .addOptional(query ? { subject: `"${query}"` } : undefined)
      .addOptional(!(tools === undefined) ? { outcome: formatCount(tools.length, "tool") } : undefined)
      .finish();
  },
  "noesis.describe": (input) => {
    const name = stringField(input, "name");
    return name ? { subject: name } : {};
  },
  inspect_self: (input, output) => {
    const section = stringField(input, "section") ?? "overview";
    const presentation = presentActionPayload("inspect_self", output);
    const count =
      presentation.tools?.length ??
      (Array.isArray(presentation.value) ? presentation.value.length : undefined);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({
      subject: section,
    } as const)
      .addOptional(
        !(count === undefined)
          ? {
              outcome: formatCount(count, presentation.tools ? "tool" : "item"),
            }
          : undefined,
      )
      .finish();
  },
} satisfies Readonly<Record<string, NestedSummarizer>>;
/** Last resort for tools with no registered summarizer: name the most identifying input field. */
// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
const GENERIC_SUBJECT_KEYS = ["path", "name", "query", "command", "url", "id", "pattern"] as const;
function genericSubject(input: JsonValue | undefined): string | undefined {
  for (const key of GENERIC_SUBJECT_KEYS) {
    const value = stringField(input, key);
    if (value) return key === "path" ? baseName(value) : firstLine(value);
  }
  return undefined;
}
function genericOutcome(output: JsonValue | undefined): string | undefined {
  if (output === undefined) return undefined;
  if (Array.isArray(output)) return formatCount(output.length, "item");
  if (typeof output === "string") return output ? formatCount(output.length, "char") : "empty";
  if (isRecord(output)) {
    const error = stringField(output, "error");
    if (error) return firstLine(error);
    const results = arrayField(output, "results");
    if (results) return formatCount(results.length, "item");
    return undefined;
  }
  return undefined;
}
export interface ActionSummary {
  readonly name: string;
  /** What the call acted on. */
  readonly subject?: string;
  /** What it produced. */
  readonly outcome?: string;
}
function createActionSummary(name: string, subject?: string, outcome?: string): ActionSummary {
  const safeName = summaryLine(name);
  const safeSubject = subject === undefined ? undefined : summaryLine(subject);
  const safeOutcome = outcome === undefined ? undefined : summaryLine(outcome);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    name: safeName,
  } as const)
    .addOptional(safeSubject ? { subject: safeSubject } : undefined)
    .addOptional(safeOutcome ? { outcome: safeOutcome } : undefined)
    .finish();
}
export function summarizeNestedAction(action: TuiAgentAction): ActionSummary {
  const summarizer: NestedSummarizer | undefined = Object.entries(NESTED_SUMMARIZERS).find(
    ([name]) => name === action.name,
  )?.[1];
  const summarized = summarizer?.(action.input, action.output);
  const subject = summarized?.subject ?? genericSubject(action.input);
  const outcome =
    action.status === "running"
      ? undefined
      : action.status === "completed"
        ? (summarized?.outcome ?? genericOutcome(action.output))
        : action.status === "failed"
          ? (stringField(action.output, "error") ?? "failed")
          : action.status;
  return createActionSummary(action.name, subject, outcome);
}
/** Collapse repeated nested tool names into `2 files.read · 1 shell.run`, most frequent first. */
export function summarizeNestedCalls(children: readonly TuiAgentAction[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const child of children) counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([leftName, leftCount], [rightName, rightCount]) =>
      leftCount === rightCount ? leftName.localeCompare(rightName) : rightCount - leftCount,
    )
    .map(([name, count]) => `${String(count)} ${name}`);
}
export function summarizeExecuteAction(
  action: TuiAgentAction,
  children: readonly TuiAgentAction[],
): ActionSummary {
  const failures = children.filter((child) => child.status === "failed").length;
  const reportedCalls = numberField(action.output, "calls");
  const callCount = Math.max(children.length, reportedCalls ?? 0);
  const parts = [
    ...(callCount > 0 ? [formatCount(callCount, "call")] : []),
    ...summarizeNestedCalls(children),
    ...(failures > 0 ? [`${formatCount(failures, "failure")}`] : []),
    ...(action.status === "running" || action.status === "completed" ? [] : [action.status]),
    ...(action.durationMs === undefined ? [] : [formatDuration(action.durationMs)]),
  ];
  // Once nested calls are visible beneath the row they describe the work better than the opening
  // line of the program does, so the source is only previewed before the first call lands.
  const source = children.length === 0 ? sourceOf(action) : undefined;
  return createActionSummary(action.name, source, parts.length > 0 ? parts.join(" · ") : undefined);
}
export function summarizeAction(action: TuiAgentAction, children: readonly TuiAgentAction[]): ActionSummary {
  return action.name === EXECUTE_ACTION_NAME
    ? summarizeExecuteAction(action, children)
    : summarizeNestedAction(action);
}
