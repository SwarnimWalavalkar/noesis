import { createConditionalObject, isJsonObject, type JsonValue } from "@noesis/domain";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  type ActionPayloadPresentation,
  type PresentedTool,
  presentActionPayload,
} from "./action-presentation.ts";
import { formatCount, formatDuration, sourceOf, summarizeNestedAction } from "./action-summary.ts";
import type { TuiExecutionArtifact, TuiExecutionDetail } from "./runtime-port.ts";
import {
  childActions,
  type NoesisTuiState,
  type TuiAgentAction,
  type TuiInspectorState,
  timelineActions,
} from "./state.ts";
import { highlightCode } from "./syntax.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";
const SEMANTIC_INSPECTOR_HINT = "↑/↓ scroll · pgup/pgdn scroll · space exact · esc close";
const RAW_INSPECTOR_HINT = "↑/↓ scroll · pgup/pgdn scroll · space semantic · esc close";
/** Compatibility export for the inspector's default semantic view. */
export const INSPECTOR_HINT = SEMANTIC_INSPECTOR_HINT;
function inspectorHint(view: TuiInspectorState["view"]): string {
  return view === "raw" ? RAW_INSPECTOR_HINT : SEMANTIC_INSPECTOR_HINT;
}
export interface RenderedRunInspector {
  readonly rows: readonly string[];
  readonly maxScroll: number;
}
/** Artifact detail is a convenience preview. Exact action payloads stay available through scroll. */
const ARTIFACT_PREVIEW_MAX_CHARACTERS = 20000;
const DIGEST_DISPLAY_CHARACTERS = 24;
const CALL_SUMMARY_MAX_CHARACTERS = 256;
const TOOL_DESCRIPTION_MAX_CHARACTERS = 180;
const TOOL_NAME_MAX_CHARACTERS = 128;
interface Section {
  readonly label: string;
  /** Qualifies the section without competing with its label, e.g. an artifact path. */
  readonly note?: string;
  readonly lines: readonly string[];
}
function boundedArtifactPreview(text: string): string {
  const safe = safeTerminalText(text);
  return safe.length <= ARTIFACT_PREVIEW_MAX_CHARACTERS
    ? safe
    : `${safe.slice(0, ARTIFACT_PREVIEW_MAX_CHARACTERS)}\n… truncated`;
}
const exactText = (text: string): string => safeTerminalText(text);
/** Inspector metadata occupies one framed row; controls and embedded rows are never structural. */
function safeInspectorScalar(text: string): string {
  return safeTerminalText(text).replaceAll("\t", " ").replaceAll("\n", " ");
}
function boundedInspectorScalar(text: string, maxCharacters: number): string {
  const safe = safeInspectorScalar(text);
  return safe.length <= maxCharacters ? safe : `${safe.slice(0, maxCharacters)}…`;
}
function encodeJson(value: JsonValue): string {
  try {
    return JSON.stringify(value, undefined, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
function jsonLines(value: JsonValue, colorEnabled: boolean): readonly string[] {
  return highlightCode(exactText(encodeJson(value)), "json", colorEnabled);
}
function rawPayloadSection(
  label: string,
  value: JsonValue | undefined,
  colorEnabled: boolean,
): readonly Section[] {
  if (value === undefined) return [];
  return [
    {
      label,
      lines: typeof value === "string" ? exactText(value).split("\n") : jsonLines(value, colorEnabled),
    },
  ];
}
const shortDigest = (digest: string): string => {
  const safe = safeInspectorScalar(digest);
  return safe.length > DIGEST_DISPLAY_CHARACTERS ? `${safe.slice(0, DIGEST_DISPLAY_CHARACTERS)}…` : safe;
};
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
  const lines = highlightCode(exactText(source), language, colorEnabled);
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
  return entries.map(([key, value]) => `${styled(colorEnabled, ANSI.dim, key.padEnd(keyWidth))}  ${value}`);
}
const statusGlyph = (status: string): string =>
  status === "running" || status === "paused"
    ? "●"
    : status === "pending"
      ? "○"
      : status === "failed" || status === "cancelled" || status === "interrupted"
        ? "×"
        : status === "completed"
          ? "✓"
          : "?";
const statusColor = (status: string): string =>
  status === "running" || status === "paused"
    ? ANSI.cyan
    : status === "pending"
      ? ANSI.yellow
      : status === "failed" || status === "cancelled" || status === "interrupted"
        ? ANSI.red
        : status === "completed"
          ? ANSI.green
          : ANSI.yellow;
function artifactSection(
  label: string,
  artifact: TuiExecutionArtifact | undefined,
  colorEnabled: boolean,
): readonly Section[] {
  if (!artifact) return [];
  const preview = artifact.preview;
  return [
    {
      label,
      note: `${safeInspectorScalar(artifact.path)}${artifact.truncated ? " · preview truncated" : ""}`,
      lines: preview
        ? boundedArtifactPreview(preview).split("\n")
        : [styled(colorEnabled, ANSI.dim, "(empty)")],
    },
  ];
}
/** Nested calls read as a numbered list whose columns line up with the transcript summaries. */
function callsSection(children: readonly TuiAgentAction[], colorEnabled: boolean): readonly Section[] {
  if (children.length === 0) return [];
  const ordinalWidth = String(children.length).length;
  const summaries = children.map((child) => {
    const summary = summarizeNestedAction(child);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return {
      child,
      summary: createConditionalObject({
        name: boundedInspectorScalar(summary.name, CALL_SUMMARY_MAX_CHARACTERS),
      } as const)
        .addOptional(
          summary.subject
            ? {
                subject: boundedInspectorScalar(summary.subject, CALL_SUMMARY_MAX_CHARACTERS),
              }
            : undefined,
        )
        .addOptional(
          summary.outcome
            ? {
                outcome: boundedInspectorScalar(summary.outcome, CALL_SUMMARY_MAX_CHARACTERS),
              }
            : undefined,
        )
        .finish(),
    };
  });
  const nameWidth = Math.max(...summaries.map(({ summary }) => summary.name.length));
  return [
    {
      label: "calls",
      lines: summaries.map(({ child, summary }, index) => {
        const trailing = [
          summary.subject,
          summary.outcome,
          child.durationMs === undefined ? undefined : formatDuration(child.durationMs),
        ].filter((part): part is string => Boolean(part));
        return [
          styled(colorEnabled, ANSI.dim, String(index + 1).padStart(ordinalWidth)),
          styled(colorEnabled, statusColor(child.status), statusGlyph(child.status)),
          summary.name.padEnd(nameWidth),
          styled(colorEnabled, ANSI.dim, trailing.join(" · ")),
        ].join(" ");
      }),
    },
  ];
}
function toolListLines(tools: readonly PresentedTool[], colorEnabled: boolean): readonly string[] {
  const ordinalWidth = String(tools.length).length;
  const presented = tools.map((tool) =>
    Object.freeze({
      tool,
      name: boundedInspectorScalar(tool.name, TOOL_NAME_MAX_CHARACTERS),
    }),
  );
  const nameWidth = Math.max(0, ...presented.map(({ name }) => visibleWidth(name)));
  return [
    styled(colorEnabled, ANSI.dim, formatCount(tools.length, "tool")),
    ...presented.map(({ tool, name }, index) => {
      const metadata = [
        tool.score === undefined ? undefined : `score ${String(tool.score)}`,
        tool.revisionId ? `rev ${shortDigest(tool.revisionId)}` : undefined,
      ].filter((item): item is string => item !== undefined);
      const description = tool.description
        ? boundedInspectorScalar(tool.description, TOOL_DESCRIPTION_MAX_CHARACTERS)
        : undefined;
      return [
        styled(colorEnabled, ANSI.dim, String(index + 1).padStart(ordinalWidth)),
        `${name}${" ".repeat(Math.max(0, nameWidth - visibleWidth(name)))}`,
        description ? styled(colorEnabled, ANSI.dim, `— ${description}`) : "",
        metadata.length > 0 ? styled(colorEnabled, ANSI.dim, `· ${metadata.join(" · ")}`) : "",
      ]
        .filter(Boolean)
        .join(" ");
    }),
  ];
}
function semanticPayloadLines(
  presentation: ActionPayloadPresentation,
  colorEnabled: boolean,
): readonly string[] {
  if (presentation.tools) {
    const catalog = presentation.catalog;
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const metadata: (readonly [string, string])[] = catalog
      ? [
          ...(catalog.catalogId ? ([["catalog", safeInspectorScalar(catalog.catalogId)]] as const) : []),
          ...(catalog.catalogDigest ? ([["digest", shortDigest(catalog.catalogDigest)]] as const) : []),
          ...(catalog.effectCount === undefined ? [] : ([["effects", String(catalog.effectCount)]] as const)),
          ...(catalog.resourceCount === undefined
            ? []
            : ([["resources", String(catalog.resourceCount)]] as const)),
          ...(catalog.credentialCount === undefined
            ? []
            : ([["credentials", String(catalog.credentialCount)]] as const)),
        ]
      : [];
    return [
      ...(metadata.length > 0 ? [...keyValueLines(metadata, colorEnabled), ""] : []),
      ...toolListLines(presentation.tools, colorEnabled),
    ];
  }
  if (typeof presentation.value === "string") return exactText(presentation.value).split("\n");
  if (presentation.value === undefined) return [styled(colorEnabled, ANSI.dim, "(empty)")];
  if (presentation.value === null) return [styled(colorEnabled, ANSI.dim, "(null)")];
  return jsonLines(presentation.value, colorEnabled);
}
function semanticPayloadSection(
  label: string,
  actionName: string,
  value: JsonValue | undefined,
  colorEnabled: boolean,
): readonly Section[] {
  if (value === undefined) return [];
  const presentation = presentActionPayload(actionName, value);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return [
    createConditionalObject({
      label,
    } as const)
      .addOptional(
        presentation.unwrapped || presentation.tools ? { note: "semantic · space for exact" } : undefined,
      )
      .add({
        lines: semanticPayloadLines(presentation, colorEnabled),
      } as const)
      .finish(),
  ];
}
function phasesSection(detail: TuiExecutionDetail | undefined, colorEnabled: boolean): readonly Section[] {
  const phases = detail?.phases ?? [];
  if (phases.length === 0) return [];
  return [
    {
      label: "phases",
      lines: phases.flatMap((phase) => {
        const name = safeInspectorScalar(phase.name);
        const status = safeInspectorScalar(phase.status);
        const error = phase.error ? boundedArtifactPreview(phase.error) : undefined;
        return [
          `${styled(colorEnabled, ANSI.dim, String(phase.index + 1))} ${styled(colorEnabled, statusColor(status), statusGlyph(status))} ${name} ${styled(colorEnabled, ANSI.dim, `· ${status}`)}`,
          ...(error ? [`  ${styled(colorEnabled, ANSI.red, error)}`] : []),
        ];
      }),
    },
  ];
}
function provenanceSection(
  detail: TuiExecutionDetail | undefined,
  colorEnabled: boolean,
): readonly Section[] {
  if (!detail) return [];
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const entries: (readonly [string, string])[] = [
    ["execution", safeInspectorScalar(detail.executionId)],
    ...(detail.parentExecutionId
      ? ([["parent", safeInspectorScalar(detail.parentExecutionId)]] as const)
      : []),
    ...(detail.catalogDigest ? ([["catalog", shortDigest(detail.catalogDigest)]] as const) : []),
    ...(detail.sourceDigest ? ([["source", shortDigest(detail.sourceDigest)]] as const) : []),
    ["started", safeInspectorScalar(detail.startedAt)],
    ...(detail.completedAt ? ([["completed", safeInspectorScalar(detail.completedAt)]] as const) : []),
  ];
  return [{ label: "provenance", lines: keyValueLines(entries, colorEnabled) }];
}
function errorText(action: TuiAgentAction, detail: TuiExecutionDetail | undefined): string | undefined {
  if (detail?.error) return detail.error;
  if (action.status !== "failed") return undefined;
  const output = action.output;
  if (typeof output === "string") return output;
  if (isJsonObject(output)) {
    const error = output["error"];
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
  view: TuiInspectorState["view"],
): readonly Section[] {
  const error = errorText(action, detail);
  // The transcript action is authoritative. Execution artifacts are intentionally bounded
  // previews, so they are only a fallback for older/in-memory actions without an exact payload.
  const exactSource = sourceOf(action);
  const source = exactSource ?? detail?.sourceArtifact?.preview;
  // A failure reported through the action output is already the error section; showing the same
  // payload again as a result would just push the useful sections further down.
  const semanticResult =
    action.output === undefined || (error && !detail?.error) ? detail?.result : action.output;
  // Raw mode is the exact escape hatch. Even when semantic mode suppresses a failed output that
  // duplicates the error section, the untouched structured payload must remain inspectable.
  const rawResult = action.output === undefined ? detail?.result : action.output;
  const common = [
    // The reason a failed run gets opened is the error, so it never sits below the program.
    ...(error
      ? [
          {
            label: "error",
            lines: exactText(error)
              .split("\n")
              .map((line) => styled(colorEnabled, ANSI.red, line)),
          },
        ]
      : []),
    ...phasesSection(detail, colorEnabled),
    ...callsSection(children, colorEnabled),
  ];
  if (view === "raw")
    return [
      ...common,
      ...(!exactSource ? artifactSection("source", detail?.sourceArtifact, colorEnabled) : []),
      ...rawPayloadSection("raw input", action.input, colorEnabled),
      ...rawPayloadSection("raw update", action.update, colorEnabled),
      ...rawPayloadSection("raw result", rawResult, colorEnabled),
      ...artifactSection("stdout", detail?.stdoutArtifact, colorEnabled),
      ...artifactSection("stderr", detail?.stderrArtifact, colorEnabled),
      ...provenanceSection(detail, colorEnabled),
    ];
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return [
    ...common,
    ...(source
      ? [
          createConditionalObject({
            label: "source",
          } as const)
            .addOptional(
              !exactSource && detail?.sourceArtifact?.truncated ? { note: "preview truncated" } : undefined,
            )
            .add({
              lines: numberedCode(source, "js", width, colorEnabled),
            } as const)
            .finish(),
        ]
      : action.input === undefined
        ? []
        : [
            {
              label: "input",
              lines: jsonLines(action.input, colorEnabled),
            },
          ]),
    ...semanticPayloadSection("update", action.name, action.update, colorEnabled),
    ...semanticPayloadSection("result", action.name, semanticResult, colorEnabled),
    ...artifactSection("stdout", detail?.stdoutArtifact, colorEnabled),
    ...artifactSection("stderr", detail?.stderrArtifact, colorEnabled),
    ...provenanceSection(detail, colorEnabled),
  ];
}
function sectionRule(section: Section, width: number, colorEnabled: boolean): string {
  const label = styled(colorEnabled, ANSI.bold, section.label.toUpperCase());
  const note = section.note ? ` ${styled(colorEnabled, ANSI.dim, section.note)}` : "";
  const used = section.label.length + (section.note ? section.note.length + 1 : 0);
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
    detail ? safeInspectorScalar(detail.kind) : sourceOf(action) ? "codemode" : "tool",
    ...(callCount > 0 ? [formatCount(callCount, "call")] : []),
    ...(action.durationMs === undefined ? [] : [formatDuration(action.durationMs)]),
    ...(detail ? [safeInspectorScalar(detail.executionId)] : []),
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
interface WrappedViewport {
  readonly rows: readonly string[];
  readonly totalRows: number;
  readonly scroll: number;
}
interface PreparedInspectorDocument {
  readonly action: TuiAgentAction | undefined;
  readonly children: readonly TuiAgentAction[];
  readonly detail: TuiExecutionDetail | undefined;
  readonly inspectorStatus: TuiInspectorState["status"];
  readonly inspectorView: TuiInspectorState["view"];
  readonly width: number;
  readonly colorEnabled: boolean;
  readonly rows: readonly string[];
}
let preparedInspectorDocument: PreparedInspectorDocument | undefined;
const sameActionReferences = (left: readonly TuiAgentAction[], right: readonly TuiAgentAction[]): boolean =>
  left.length === right.length && left.every((action, index) => action === right[index]);
function prepareInspectorDocument(
  action: TuiAgentAction | undefined,
  children: readonly TuiAgentAction[],
  inspector: TuiInspectorState,
  width: number,
  colorEnabled: boolean,
): readonly string[] {
  const cached = preparedInspectorDocument;
  if (
    cached &&
    cached.action === action &&
    cached.detail === inspector.detail &&
    cached.inspectorStatus === inspector.status &&
    cached.inspectorView === inspector.view &&
    cached.width === width &&
    cached.colorEnabled === colorEnabled &&
    sameActionReferences(cached.children, children)
  )
    return cached.rows;
  const body = action
    ? [
        ...identityLines(action, children, inspector, colorEnabled),
        ...buildSections(action, children, inspector.detail, width, colorEnabled, inspector.view).flatMap(
          (section) => ["", sectionRule(section, width, colorEnabled), ...section.lines],
        ),
      ]
    : ["This run is no longer available."];
  const rows = body.flatMap((line) => {
    const parts = wrapTextWithAnsi(line, width);
    return parts.length > 0 ? parts : [""];
  });
  preparedInspectorDocument = {
    action,
    children: [...children],
    detail: inspector.detail,
    inspectorStatus: inspector.status,
    inspectorView: inspector.view,
    width,
    colorEnabled,
    rows,
  };
  return rows;
}
/** Slice a prepared document without re-encoding, highlighting, or wrapping its payload. */
function wrappedViewport(
  rows: readonly string[],
  requestedScroll: number,
  visibleRows: number,
): WrappedViewport {
  const maxScroll = Math.max(0, rows.length - visibleRows);
  const scroll = Math.min(requestedScroll, maxScroll);
  return {
    rows: rows.slice(scroll, scroll + visibleRows),
    totalRows: rows.length,
    scroll,
  };
}
export function renderRunInspectorFrame(
  state: NoesisTuiState,
  width: number,
  height: number,
): RenderedRunInspector {
  const inspector = state.inspector;
  if (!inspector || width < 16 || height < 4) return { rows: [], maxScroll: 0 };
  const colorEnabled = state.colorEnabled;
  const actions = timelineActions(state.timeline);
  const action = actions.find((candidate) => candidate.actionId === inspector.actionId);
  const inner = width - 4;
  const children = action ? childActions(actions, action.actionId) : [];
  const documentRows = prepareInspectorDocument(action, children, inspector, inner, colorEnabled);
  // Two rows of chrome: the top and bottom frame edges.
  const visibleRows = Math.max(1, height - 2);
  const viewport = wrappedViewport(documentRows, inspector.scroll, visibleRows);
  const maxScroll = Math.max(0, viewport.totalRows - visibleRows);
  const { rows, scroll } = viewport;
  const status = safeInspectorScalar(inspector.detail?.status ?? action?.status ?? "unknown");
  const title = `${styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "RUN")}${
    action
      ? `${styled(colorEnabled, ANSI.dim, " · ")}${styled(colorEnabled, ANSI.bold, safeInspectorScalar(action.name))}`
      : ""
  }`;
  const position =
    maxScroll > 0
      ? `${String(scroll + 1)}–${String(scroll + rows.length)} of ${String(viewport.totalRows)}`
      : formatCount(viewport.totalRows, "row");
  // The right frame edge doubles as a scrollbar track so the panel shows how much lies below.
  const thumbSize =
    maxScroll > 0 ? Math.max(1, Math.round((visibleRows / viewport.totalRows) * visibleRows)) : 0;
  const thumbStart = maxScroll > 0 ? Math.round((scroll / maxScroll) * (visibleRows - thumbSize)) : 0;
  const dim = (text: string): string => styled(colorEnabled, ANSI.dim, text);
  return {
    maxScroll,
    rows: [
      frameEdge(
        { left: "╭", right: "╮" },
        title,
        styled(colorEnabled, statusColor(status), `${statusGlyph(status)} ${status}`),
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
        dim(inspectorHint(inspector.view)),
        dim(position),
        width,
        colorEnabled,
      ),
    ],
  };
}
export function renderRunInspector(state: NoesisTuiState, width: number, height: number): string[] {
  return [...renderRunInspectorFrame(state, width, height).rows];
}
