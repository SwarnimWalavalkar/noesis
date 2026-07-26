import type { TuiAgentAction } from "./state.ts";
import { safeTerminalText } from "./theme.ts";

/**
 * Codemode routes nearly all work through a single `execute` call whose nested SDK calls carry
 * whole file contents, command output, and HTTP bodies in their results. Rendering those payloads
 * verbatim costs hundreds of transcript rows per turn, so every action is reduced to one line here
 * and the full payload is reachable only through expansion or the run inspector.
 */

export const EXECUTE_ACTION_NAME = "execute";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function arrayField(value: unknown, key: string): readonly unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return Array.isArray(field) ? field : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

export function executionIdOf(action: TuiAgentAction): string | undefined {
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
  if (bytes < 1_000) return `${String(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function formatDuration(milliseconds: number): string {
  const roundedMilliseconds = Math.round(milliseconds);
  if (roundedMilliseconds < 1_000) return `${String(roundedMilliseconds)}ms`;
  const tenthsOfASecond = Math.round(milliseconds / 100);
  if (tenthsOfASecond < 600) return `${(tenthsOfASecond / 10).toFixed(1)}s`;
  const roundedSeconds = Math.round(milliseconds / 1_000);
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
  input: unknown,
  output: unknown,
) => {
  readonly subject?: string;
  readonly outcome?: string;
};

const NESTED_SUMMARIZERS: Readonly<Record<string, NestedSummarizer>> = {
  "files.read": (input, output) => {
    const path = stringField(output, "path") ?? stringField(input, "path");
    const totalLines = numberField(output, "totalLines");
    return {
      ...(path ? { subject: baseName(path) } : {}),
      ...(totalLines === undefined ? {} : { outcome: formatCount(totalLines, "line") }),
    };
  },
  "files.write": (input, output) => {
    const path = stringField(output, "path") ?? stringField(input, "path");
    const bytes = numberField(output, "bytes");
    return {
      ...(path ? { subject: baseName(path) } : {}),
      ...(bytes === undefined ? {} : { outcome: formatBytes(bytes) }),
    };
  },
  "files.search": (input, output) => {
    const query = stringField(input, "query");
    const matches = arrayField(output, "matches");
    const truncated = booleanField(output, "truncated") === true;
    return {
      ...(query ? { subject: `"${query}"` } : {}),
      ...(matches === undefined
        ? {}
        : {
            outcome: `${formatCount(matches.length, "match", "matches")}${truncated ? "+" : ""}`,
          }),
    };
  },
  "files.list": (input, output) => {
    const path = stringField(input, "path");
    const entries = arrayField(output, "entries");
    return {
      ...(path ? { subject: baseName(path) } : {}),
      ...(entries === undefined ? {} : { outcome: formatCount(entries.length, "entry", "entries") }),
    };
  },
  "shell.run": (input, output) => {
    const command = stringField(input, "command");
    const exitCode = numberField(output, "exitCode");
    return {
      ...(command ? { subject: firstLine(command) } : {}),
      ...(exitCode === undefined ? {} : { outcome: `exit ${String(exitCode)}` }),
    };
  },
  "web.fetch": (input, output) => {
    const url = stringField(output, "url") ?? stringField(input, "url");
    const status = numberField(output, "status");
    return {
      ...(url ? { subject: url.replace(/^https?:\/\//u, "") } : {}),
      ...(status === undefined ? {} : { outcome: String(status) }),
    };
  },
  "scripts.run": (input, output) => {
    const name = stringField(input, "name");
    const calls = numberField(output, "calls");
    return {
      ...(name ? { subject: name } : {}),
      ...(calls === undefined ? {} : { outcome: formatCount(calls, "call") }),
    };
  },
  "workflows.run": (input, output) => {
    const name = stringField(input, "name");
    const status = stringField(output, "status");
    return {
      ...(name ? { subject: name } : {}),
      ...(status ? { outcome: status } : {}),
    };
  },
  "workflows.resume": (input, output) => {
    const runId = stringField(input, "runId");
    const status = stringField(output, "status");
    return {
      ...(runId ? { subject: runId } : {}),
      ...(status ? { outcome: status } : {}),
    };
  },
  "noesis.search": (input, output) => {
    const query = stringField(input, "query");
    const tools = arrayField(output, "tools") ?? arrayField(output, "results");
    return {
      ...(query ? { subject: `"${query}"` } : {}),
      ...(tools === undefined ? {} : { outcome: formatCount(tools.length, "tool") }),
    };
  },
  "noesis.describe": (input) => {
    const name = stringField(input, "name");
    return name ? { subject: name } : {};
  },
};

/** Last resort for tools with no registered summarizer: name the most identifying input field. */
const GENERIC_SUBJECT_KEYS = ["path", "name", "query", "command", "url", "id", "pattern"] as const;

function genericSubject(input: unknown): string | undefined {
  for (const key of GENERIC_SUBJECT_KEYS) {
    const value = stringField(input, key);
    if (value) return key === "path" ? baseName(value) : firstLine(value);
  }
  return undefined;
}

function genericOutcome(output: unknown): string | undefined {
  if (output === undefined) return undefined;
  if (Array.isArray(output)) return formatCount(output.length, "item");
  if (typeof output === "string") return output ? formatCount(output.length, "char") : "empty";
  if (isRecord(output)) {
    const error = stringField(output, "error");
    if (error) return firstLine(error);
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
  return {
    name: safeName,
    ...(safeSubject ? { subject: safeSubject } : {}),
    ...(safeOutcome ? { outcome: safeOutcome } : {}),
  };
}

export function summarizeNestedAction(action: TuiAgentAction): ActionSummary {
  const summarizer = NESTED_SUMMARIZERS[action.name];
  const summarized = summarizer?.(action.input, action.output);
  const subject = summarized?.subject ?? genericSubject(action.input);
  const outcome =
    action.status === "running"
      ? undefined
      : (summarized?.outcome ??
        (action.status === "failed"
          ? (stringField(action.output, "error") ?? "failed")
          : genericOutcome(action.output)));
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
