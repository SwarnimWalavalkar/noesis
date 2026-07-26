import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  formatCount,
  formatDuration,
  sourceOf,
  summarizeNestedAction,
} from "./action-summary.ts";
import type {
  TuiExecutionArtifact,
  TuiExecutionDetail,
} from "./runtime-port.ts";
import {
  childActions,
  timelineActions,
  type NoesisTuiState,
  type TuiAgentAction,
  type TuiInspectorState,
} from "./state.ts";
import { highlightCode } from "./syntax.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

export const INSPECTOR_HINT = "↑/↓ · pgup/pgdn scroll · esc close";

/** Codemode results carry whole file contents, so every section is bounded before it is styled. */
const SECTION_MAX_CHARACTERS = 20_000;
const DIGEST_DISPLAY_CHARACTERS = 24;

interface Section {
  readonly label: string;
  /** Qualifies the section without competing with its label, e.g. an artifact path. */
  readonly note?: string;
  readonly lines: readonly string[];
}

function boundedText(text: string): string {
  const safe = safeTerminalText(text);
  return safe.length <= SECTION_MAX_CHARACTERS
    ? safe
    : `${safe.slice(0, SECTION_MAX_CHARACTERS)}\n… truncated`;
}

function encodeJson(value: unknown): string {
  try {
    return JSON.stringify(value, undefined, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

const shortDigest = (digest: string): string =>
  digest.length > DIGEST_DISPLAY_CHARACTERS
    ? `${digest.slice(0, DIGEST_DISPLAY_CHARACTERS)}…`
    : digest;

/**
 * Right-aligned dim line numbers, so a stack trace or phase error can be located by eye. Long
 * lines are wrapped here rather than by the panel so their continuations stay under the first
 * column of code instead of colliding with the gutter.
 */
function numberedCode(
  source: string,
  language: string,
  width: number,
  colorEnabled: boolean,
): readonly string[] {
  const lines = highlightCode(boundedText(source), language, colorEnabled);
  const gutter = String(lines.length).length;
  const indent = " ".repeat(gutter + 2);
  const codeWidth = Math.max(8, width - gutter - 2);
  return lines.flatMap((line, index) =>
    wrapTextWithAnsi(line, codeWidth).map((part, position) =>
      position === 0
        ? `${styled(colorEnabled, ANSI.dim, String(index + 1).padStart(gutter))}  ${part}`
        : `${indent}${part}`,
    ),
  );
}

function keyValueLines(
  entries: readonly (readonly [string, string])[],
  colorEnabled: boolean,
): readonly string[] {
  const keyWidth = Math.max(0, ...entries.map(([key]) => key.length));
  return entries.map(
    ([key, value]) =>
      `${styled(colorEnabled, ANSI.dim, key.padEnd(keyWidth))}  ${value}`,
  );
}

const statusGlyph = (status: string): string =>
  status === "running" || status === "paused"
    ? "●"
    : status === "failed" || status === "cancelled" || status === "interrupted"
      ? "×"
      : "✓";

const statusColor = (status: string): string =>
  status === "running" || status === "paused"
    ? ANSI.cyan
    : status === "failed" || status === "cancelled" || status === "interrupted"
      ? ANSI.red
      : ANSI.green;

function artifactSection(
  label: string,
  artifact: TuiExecutionArtifact | undefined,
  colorEnabled: boolean,
): readonly Section[] {
  if (!artifact) return [];
  const preview = artifact.preview.trim();
  return [
    {
      label,
      note: `${artifact.path}${artifact.truncated ? " · preview truncated" : ""}`,
      lines: preview
        ? boundedText(preview).split("\n")
        : [styled(colorEnabled, ANSI.dim, "(empty)")],
    },
  ];
}

/** Nested calls read as a numbered list whose columns line up with the transcript summaries. */
function callsSection(
  children: readonly TuiAgentAction[],
  colorEnabled: boolean,
): readonly Section[] {
  if (children.length === 0) return [];
  const ordinalWidth = String(children.length).length;
  const nameWidth = Math.max(...children.map((child) => child.name.length));
  return [
    {
      label: "calls",
      lines: children.map((child, index) => {
        const summary = summarizeNestedAction(child);
        const trailing = [
          summary.subject,
          summary.outcome,
          child.durationMs === undefined
            ? undefined
            : formatDuration(child.durationMs),
        ].filter((part): part is string => Boolean(part));
        return [
          styled(
            colorEnabled,
            ANSI.dim,
            String(index + 1).padStart(ordinalWidth),
          ),
          styled(
            colorEnabled,
            statusColor(child.status),
            statusGlyph(child.status),
          ),
          child.name.padEnd(nameWidth),
          styled(colorEnabled, ANSI.dim, trailing.join(" · ")),
        ].join(" ");
      }),
    },
  ];
}

function phasesSection(
  detail: TuiExecutionDetail | undefined,
  colorEnabled: boolean,
): readonly Section[] {
  const phases = detail?.phases ?? [];
  if (phases.length === 0) return [];
  return [
    {
      label: "phases",
      lines: phases.flatMap((phase) => [
        `${styled(colorEnabled, ANSI.dim, String(phase.index + 1))} ${styled(
          colorEnabled,
          statusColor(phase.status),
          statusGlyph(phase.status),
        )} ${phase.name} ${styled(colorEnabled, ANSI.dim, `· ${phase.status}`)}`,
        ...(phase.error
          ? [`  ${styled(colorEnabled, ANSI.red, phase.error)}`]
          : []),
      ]),
    },
  ];
}

function provenanceSection(
  detail: TuiExecutionDetail | undefined,
  colorEnabled: boolean,
): readonly Section[] {
  if (!detail) return [];
  const entries: (readonly [string, string])[] = [
    ["execution", detail.executionId],
    ...(detail.parentExecutionId
      ? ([["parent", detail.parentExecutionId]] as const)
      : []),
    ...(detail.catalogDigest
      ? ([["catalog", shortDigest(detail.catalogDigest)]] as const)
      : []),
    ...(detail.sourceDigest
      ? ([["source", shortDigest(detail.sourceDigest)]] as const)
      : []),
    ["started", detail.startedAt],
    ...(detail.completedAt
      ? ([["completed", detail.completedAt]] as const)
      : []),
  ];
  return [{ label: "provenance", lines: keyValueLines(entries, colorEnabled) }];
}

function errorText(
  action: TuiAgentAction,
  detail: TuiExecutionDetail | undefined,
): string | undefined {
  if (detail?.error) return detail.error;
  if (action.status !== "failed") return undefined;
  const output = action.output;
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const error = Reflect.get(output, "error");
    if (typeof error === "string") return error;
    return encodeJson(output);
  }
  return "The run failed without reporting an error.";
}

/**
 * One layout serves both the durable execution record and the in-memory action. The record
 * supplies provenance and artifacts when it resolves; the nested calls, program, and result are
 * always available from the action itself, so the panel never degrades to a different shape.
 */
function buildSections(
  action: TuiAgentAction,
  children: readonly TuiAgentAction[],
  detail: TuiExecutionDetail | undefined,
  width: number,
  colorEnabled: boolean,
): readonly Section[] {
  const error = errorText(action, detail);
  const source = detail?.sourceArtifact?.preview ?? sourceOf(action);
  // A failure reported through the action output is already the error section; showing the same
  // payload again as a result would just push the useful sections further down.
  const result =
    detail?.result ??
    (action.output === undefined || (error && !detail?.error)
      ? undefined
      : encodeJson(action.output));
  return [
    // The reason a failed run gets opened is the error, so it never sits below the program.
    ...(error
      ? [
          {
            label: "error",
            lines: boundedText(error)
              .split("\n")
              .map((line) => styled(colorEnabled, ANSI.red, line)),
          },
        ]
      : []),
    ...phasesSection(detail, colorEnabled),
    ...callsSection(children, colorEnabled),
    ...(source
      ? [
          {
            label: "source",
            lines: numberedCode(source, "js", width, colorEnabled),
          },
        ]
      : action.input === undefined
        ? []
        : [
            {
              label: "input",
              lines: highlightCode(
                boundedText(encodeJson(action.input)),
                "json",
                colorEnabled,
              ),
            },
          ]),
    ...(result
      ? [
          {
            label: "result",
            lines: highlightCode(boundedText(result), "json", colorEnabled),
          },
        ]
      : []),
    ...artifactSection("stdout", detail?.stdoutArtifact, colorEnabled),
    ...artifactSection("stderr", detail?.stderrArtifact, colorEnabled),
    ...provenanceSection(detail, colorEnabled),
  ];
}

function sectionRule(
  section: Section,
  width: number,
  colorEnabled: boolean,
): string {
  const label = styled(colorEnabled, ANSI.bold, section.label.toUpperCase());
  const note = section.note
    ? ` ${styled(colorEnabled, ANSI.dim, section.note)}`
    : "";
  const used =
    section.label.length + (section.note ? section.note.length + 1 : 0);
  const fill = Math.max(0, width - used - 4);
  return `${styled(colorEnabled, ANSI.dim, "──")} ${label}${note} ${styled(colorEnabled, ANSI.dim, "─".repeat(fill))}`;
}

/** The identity line answers "what ran, how much of it, and how long" before any section. */
function identityLines(
  action: TuiAgentAction,
  children: readonly TuiAgentAction[],
  inspector: TuiInspectorState,
  colorEnabled: boolean,
): readonly string[] {
  const detail = inspector.detail;
  const callCount = Math.max(children.length, detail?.callCount ?? 0);
  const parts = [
    detail?.kind ?? (sourceOf(action) ? "codemode" : "tool"),
    ...(callCount > 0 ? [formatCount(callCount, "call")] : []),
    ...(action.durationMs === undefined
      ? []
      : [formatDuration(action.durationMs)]),
    ...(detail ? [detail.executionId] : []),
  ];
  const note =
    inspector.status === "loading"
      ? "resolving the durable run record…"
      : detail
        ? undefined
        : "no durable run record resolved; showing the in-memory call";
  return [
    styled(colorEnabled, ANSI.dim, parts.join(" · ")),
    ...(note ? [styled(colorEnabled, ANSI.dim, note)] : []),
  ];
}

function padTo(line: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(line));
  return `${line}${" ".repeat(padding)}`;
}

interface FrameEdge {
  readonly left: string;
  readonly right: string;
}

function frameEdge(
  edge: FrameEdge,
  leading: string,
  trailing: string,
  width: number,
  colorEnabled: boolean,
): string {
  const used = visibleWidth(leading) + visibleWidth(trailing);
  // "╭─ ", the spaces around the rule, and " ─╮" account for eight fixed columns.
  const fill = Math.max(0, width - used - 8);
  const dim = (text: string): string => styled(colorEnabled, ANSI.dim, text);
  return elideText(
    `${dim(`${edge.left}─`)} ${leading} ${dim("─".repeat(fill))} ${trailing} ${dim(`─${edge.right}`)}`,
    width,
  );
}

export function renderRunInspector(
  state: NoesisTuiState,
  width: number,
  height: number,
): string[] {
  const inspector = state.inspector;
  if (!inspector || width < 16 || height < 4) return [];
  const colorEnabled = state.colorEnabled;
  const actions = timelineActions(state.timeline);
  const action = actions.find(
    (candidate) => candidate.actionId === inspector.actionId,
  );
  const inner = width - 4;
  const body = action
    ? [
        ...identityLines(
          action,
          childActions(actions, action.actionId),
          inspector,
          colorEnabled,
        ),
        ...buildSections(
          action,
          childActions(actions, action.actionId),
          inspector.detail,
          inner,
          colorEnabled,
        ).flatMap((section) => [
          "",
          sectionRule(section, inner, colorEnabled),
          ...section.lines,
        ]),
      ]
    : ["This run is no longer available."];
  const wrapped = body.flatMap((line) => wrapTextWithAnsi(line, inner));

  // Two rows of chrome: the top and bottom frame edges.
  const visibleRows = Math.max(1, height - 2);
  const maxScroll = Math.max(0, wrapped.length - visibleRows);
  const scroll = Math.min(inspector.scroll, maxScroll);
  const rows = wrapped.slice(scroll, scroll + visibleRows);
  const status = inspector.detail?.status ?? action?.status ?? "unknown";
  const title = `${styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "RUN")}${
    action
      ? `${styled(colorEnabled, ANSI.dim, " · ")}${styled(colorEnabled, ANSI.bold, action.name)}`
      : ""
  }`;
  const position =
    maxScroll > 0
      ? `${String(scroll + 1)}–${String(scroll + rows.length)} of ${String(wrapped.length)}`
      : formatCount(wrapped.length, "row");

  // The right frame edge doubles as a scrollbar track so the panel shows how much lies below.
  const thumbSize =
    maxScroll > 0
      ? Math.max(1, Math.round((visibleRows / wrapped.length) * visibleRows))
      : 0;
  const thumbStart =
    maxScroll > 0
      ? Math.round((scroll / maxScroll) * (visibleRows - thumbSize))
      : 0;
  const dim = (text: string): string => styled(colorEnabled, ANSI.dim, text);
  return [
    frameEdge(
      { left: "╭", right: "╮" },
      title,
      styled(
        colorEnabled,
        statusColor(status),
        `${statusGlyph(status)} ${status}`,
      ),
      width,
      colorEnabled,
    ),
    ...rows.map((line, index) => {
      const scrollbar =
        thumbSize > 0 && index >= thumbStart && index < thumbStart + thumbSize
          ? styled(colorEnabled, ANSI.cyan, "┃")
          : dim("│");
      return `${dim("│")} ${padTo(elideText(line, inner), inner)} ${scrollbar}`;
    }),
    frameEdge(
      { left: "╰", right: "╯" },
      dim(INSPECTOR_HINT),
      dim(position),
      width,
      colorEnabled,
    ),
  ];
}
