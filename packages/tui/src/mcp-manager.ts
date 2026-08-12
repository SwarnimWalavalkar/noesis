import { Input, matchesKey, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  type McpCapabilityItem,
  mcpConnectionLines,
  mcpLiveActionsAvailable,
  mcpManagerHint,
  mcpOAuthActionsAvailable,
  mcpPromptItems,
  mcpResourceItems,
  mcpServerIdentity,
  mcpServerOptions,
  mcpStatusColor,
  mcpStatusGlyph,
  mcpTemplateItems,
  mcpToolItems,
  parseMcpArguments,
  safeMcpLines,
  safeMcpScalar,
  validateMcpRemoteUrl,
} from "./mcp-manager-model.ts";
import type {
  NoesisTuiRuntime,
  TuiMcpMutationIntent,
  TuiMcpMutationResult,
  TuiMcpScope,
  TuiMcpServerDetail,
  TuiMcpServerSummary,
} from "./runtime-port.ts";
import type {
  McpChoiceScreen as ChoiceScreen,
  McpCollectionScreen as CollectionScreen,
  McpConfirmScreen as ConfirmScreen,
  McpScreen,
  McpServerScreen as ServerScreen,
  McpTextScreen as TextScreen,
} from "./mcp-manager-screen.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

const PAGE_STEP = 8;

export interface McpManagerOverlay extends Component {
  readonly dispose: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}

export interface CreateMcpManagerOverlayOptions {
  readonly runtime: Required<Pick<NoesisTuiRuntime, "listMcpServers" | "inspectMcpServer" | "mutateMcp">>;
  readonly colorEnabled: boolean;
  readonly height: () => number;
  readonly mutationsEnabled: () => boolean;
  readonly requestRender: () => void;
  readonly close: () => void;
}

export function createMcpManagerOverlay(options: CreateMcpManagerOverlayOptions): McpManagerOverlay {
  const { runtime } = options;
  let disposed = false;
  let generation = 0;
  let servers: readonly TuiMcpServerSummary[] = Object.freeze([]);
  let screen: McpScreen = { kind: "list" };
  let cursor = 0;
  let scroll = 0;
  let busy = "Loading MCP servers…";
  let notice: string | undefined;
  let activeMutation: { readonly controller?: AbortController; readonly promise: Promise<void> } | undefined;
  let disposePromise: Promise<void> | undefined;

  const render = (): void => {
    if (!disposed) options.requestRender();
  };

  const moveTo = (next: McpScreen, selected = 0): void => {
    screen = next;
    cursor = selected;
    scroll = 0;
    render();
  };

  const reportError = (error: unknown): void => {
    busy = "";
    notice = error instanceof Error ? error.message : String(error);
    render();
  };

  const refresh = async (): Promise<void> => {
    const request = ++generation;
    busy = "Refreshing MCP servers…";
    render();
    try {
      const next = await runtime.listMcpServers();
      if (disposed || generation !== request) return;
      servers = Object.freeze([...next]);
      busy = "";
      cursor = Math.min(cursor, Math.max(0, servers.length + 2));
      render();
    } catch (error) {
      if (!disposed && generation === request) reportError(error);
    }
  };

  const inspect = async (summary: Pick<TuiMcpServerSummary, "scope" | "name">): Promise<void> => {
    const request = ++generation;
    busy = `Inspecting ${safeMcpScalar(summary.name)}…`;
    render();
    try {
      const detail = await runtime.inspectMcpServer(summary.scope, summary.name);
      if (disposed || generation !== request) return;
      busy = "";
      if (!detail) {
        notice = `${summary.scope} server ${safeMcpScalar(summary.name)} no longer exists.`;
        moveTo({ kind: "list" });
        await refresh();
        return;
      }
      moveTo({ kind: "server", detail });
    } catch (error) {
      if (!disposed && generation === request) reportError(error);
    }
  };

  const mutate = async (
    intent: TuiMcpMutationIntent,
    target?: Pick<TuiMcpServerSummary, "scope" | "name">,
  ): Promise<void> => {
    if (!options.mutationsEnabled()) {
      notice = "MCP changes are available after the active turn finishes.";
      render();
      return;
    }
    const request = ++generation;
    const controller = intent.type === "authenticate" ? new AbortController() : undefined;
    busy = `${intent.type.replaceAll("-", " ")}…`;
    notice = undefined;
    render();
    const promise = (async (): Promise<void> => {
      try {
        const result: TuiMcpMutationResult = await runtime.mutateMcp(intent, controller?.signal);
        if (disposed || generation !== request) return;
        notice = result.browserUrl ? `${result.message}\n${result.browserUrl}` : result.message;
        servers = Object.freeze([...(await runtime.listMcpServers())]);
        if (disposed || generation !== request) return;
        busy = "";
        if (target) {
          const detail = await runtime.inspectMcpServer(target.scope, target.name);
          if (disposed || generation !== request) return;
          if (detail) moveTo({ kind: "server", detail });
          else moveTo({ kind: "list" });
        } else {
          moveTo({ kind: "list" });
        }
      } catch (error) {
        if (!disposed && generation === request) reportError(error);
      } finally {
        if (activeMutation?.controller === controller) activeMutation = undefined;
      }
    })();
    activeMutation = { ...(controller ? { controller } : {}), promise };
    await promise;
  };

  const input = (
    title: string,
    prompt: string,
    initial: string,
    back: McpScreen,
    submit: (value: string) => void,
  ): void => {
    const field = new Input();
    field.focused = true;
    field.setValue(safeMcpScalar(initial));
    if (initial) field.handleInput("\u0005");
    field.onSubmit = submit;
    field.onEscape = () => moveTo(back);
    moveTo({ kind: "input", title, prompt, input: field, back, submit });
  };

  const choose = (
    title: string,
    prompt: string,
    choices: ChoiceScreen["choices"],
    back: McpScreen,
    select: (id: string) => void,
  ): void => moveTo({ kind: "choice", title, prompt, choices, back, select });

  const validName = (value: string): string | undefined => {
    const name = value.trim();
    if (!name) {
      notice = "Server name cannot be empty.";
      render();
      return undefined;
    }
    return name;
  };

  const beginAddLocal = (back: McpScreen): void => {
    choose(
      "Add local server",
      "Where should this server be available?",
      [
        { id: "project", label: "Project", description: "Only this project" },
        { id: "global", label: "Global", description: "Every project" },
      ],
      back,
      (scope) => {
        const selectedScope: TuiMcpScope = scope === "global" ? "global" : "project";
        input("Add local server", "Server name", "", back, (rawName) => {
          const name = validName(rawName);
          if (!name) return;
          input("Add local server", "Executable", "npx", back, (rawExecutable) => {
            const executable = rawExecutable.trim();
            if (!executable) {
              notice = "Executable cannot be empty.";
              render();
              return;
            }
            input("Add local server", "Arguments as a JSON array", "[]", back, (rawArguments) => {
              const argumentsResult = parseMcpArguments(rawArguments);
              if (!argumentsResult.ok) {
                notice = argumentsResult.error;
                render();
                return;
              }
              void mutate({
                type: "add-local",
                scope: selectedScope,
                name,
                command: Object.freeze([executable, ...argumentsResult.value]),
              });
            });
          });
        });
      },
    );
  };

  const beginAddRemote = (back: McpScreen): void => {
    choose(
      "Add remote server",
      "Where should this server be available?",
      [
        { id: "project", label: "Project", description: "Only this project" },
        { id: "global", label: "Global", description: "Every project" },
      ],
      back,
      (scope) => {
        const selectedScope: TuiMcpScope = scope === "global" ? "global" : "project";
        input("Add remote server", "Server name", "", back, (rawName) => {
          const name = validName(rawName);
          if (!name) return;
          input("Add remote server", "Streamable HTTP URL", "https://", back, (rawUrl) => {
            const url = rawUrl.trim();
            const urlError = validateMcpRemoteUrl(url);
            if (urlError) {
              notice = urlError;
              render();
              return;
            }
            choose(
              "Add remote server",
              "Use MCP OAuth for this server?",
              [
                { id: "yes", label: "Yes", description: "Authenticate in the browser when needed" },
                { id: "no", label: "No", description: "Use ambient or configured credentials" },
              ],
              back,
              (oauth) =>
                void mutate({
                  type: "add-remote",
                  scope: selectedScope,
                  name,
                  url,
                  oauth: oauth === "yes",
                }),
            );
          });
        });
      },
    );
  };

  const beginEdit = (detail: TuiMcpServerDetail): void => {
    const back: ServerScreen = { kind: "server", detail };
    if (detail.config.type === "local") {
      const [currentExecutable = "", ...currentArguments] = detail.config.command;
      input("Edit local server", "Executable", currentExecutable, back, (rawExecutable) => {
        const executable = rawExecutable.trim();
        if (!executable) {
          notice = "Executable cannot be empty.";
          render();
          return;
        }
        input(
          "Edit local server",
          "Arguments as a JSON array",
          JSON.stringify(currentArguments),
          back,
          (rawArguments) => {
            const argumentsResult = parseMcpArguments(rawArguments);
            if (!argumentsResult.ok) {
              notice = argumentsResult.error;
              render();
              return;
            }
            void mutate(
              {
                type: "edit-local",
                scope: detail.scope,
                name: detail.name,
                command: Object.freeze([executable, ...argumentsResult.value]),
              },
              detail,
            );
          },
        );
      });
      return;
    }
    const remoteConfig = detail.config;
    input("Edit remote server", "Streamable HTTP URL", remoteConfig.url, back, (rawUrl) => {
      const url = rawUrl.trim();
      const urlError = validateMcpRemoteUrl(url);
      if (urlError) {
        notice = urlError;
        render();
        return;
      }
      choose(
        "Edit remote server",
        "Use MCP OAuth for this server?",
        remoteConfig.oauth
          ? [
              { id: "yes", label: "Keep OAuth enabled" },
              { id: "no", label: "Disable OAuth" },
            ]
          : [
              { id: "no", label: "Keep OAuth disabled" },
              { id: "yes", label: "Enable OAuth" },
            ],
        back,
        (oauth) =>
          void mutate(
            {
              type: "edit-remote",
              scope: detail.scope,
              name: detail.name,
              url,
              oauth: oauth === "yes",
            },
            detail,
          ),
      );
    });
  };

  const collection = (title: string, items: readonly McpCapabilityItem[], detail: TuiMcpServerDetail): void =>
    moveTo({ kind: "collection", title, items, detail });

  const openServerOption = (detail: TuiMcpServerDetail, id: string): void => {
    const serverScreen: ServerScreen = { kind: "server", detail };
    if ((id === "authenticate" || id === "logout") && detail.type !== "remote") return;
    if (id === "tools") {
      collection(`${safeMcpScalar(detail.name)} · tools`, mcpToolItems(detail), detail);
      return;
    }
    if (id === "prompts") {
      collection(`${safeMcpScalar(detail.name)} · prompts`, mcpPromptItems(detail), detail);
      return;
    }
    if (id === "resources") {
      collection(`${safeMcpScalar(detail.name)} · resources`, mcpResourceItems(detail), detail);
      return;
    }
    if (id === "templates") {
      collection(`${safeMcpScalar(detail.name)} · resource templates`, mcpTemplateItems(detail), detail);
      return;
    }
    if (id === "instructions") {
      moveTo({
        kind: "text",
        title: `${safeMcpScalar(detail.name)} · server instructions`,
        lines: detail.instructions ? detail.instructions.split("\n") : ["No server instructions."],
        back: serverScreen,
      });
      return;
    }
    if (id === "connection") {
      moveTo({
        kind: "text",
        title: `${safeMcpScalar(detail.name)} · connection`,
        lines: mcpConnectionLines(detail),
        back: serverScreen,
      });
      return;
    }
    if (id === "errors") {
      moveTo({
        kind: "text",
        title: `${safeMcpScalar(detail.name)} · recent errors`,
        lines:
          detail.recentErrors.length === 0
            ? ["No recent errors."]
            : detail.recentErrors.flatMap((error) => [
                `${error.occurredAt ?? "unknown time"}${error.operation ? ` · ${error.operation}` : ""}`,
                error.message,
                "",
              ]),
        back: serverScreen,
      });
      return;
    }
    if (id === "authenticate") {
      void mutate({ type: "authenticate", scope: detail.scope, name: detail.name }, detail);
      return;
    }
    if (id === "logout") {
      void mutate({ type: "logout", scope: detail.scope, name: detail.name }, detail);
      return;
    }
    if (id === "toggle") {
      void mutate(
        { type: "set-enabled", scope: detail.scope, name: detail.name, enabled: !detail.enabled },
        detail,
      );
      return;
    }
    if (id === "reconnect") {
      void mutate({ type: "reconnect", scope: detail.scope, name: detail.name }, detail);
      return;
    }
    if (id === "edit") {
      beginEdit(detail);
      return;
    }
    if (id === "remove") {
      moveTo({
        kind: "confirm",
        title: `Remove ${safeMcpScalar(detail.name)}`,
        prompt: `Remove the ${detail.scope} server entry? This cannot be undone from Noesis.`,
        back: serverScreen,
        confirm: () => void mutate({ type: "remove", scope: detail.scope, name: detail.name }),
      });
    }
  };

  const navigate = (delta: number, count: number): void => {
    cursor = Math.max(0, Math.min(Math.max(0, count - 1), cursor + delta));
    render();
  };

  const listEntries = (): readonly { readonly kind: "server" | "action"; readonly id: string }[] => [
    ...servers.map((server) => ({ kind: "server" as const, id: mcpServerIdentity(server) })),
    ...(options.mutationsEnabled()
      ? [
          { kind: "action" as const, id: "add-local" },
          { kind: "action" as const, id: "add-remote" },
          { kind: "action" as const, id: "reload" },
        ]
      : []),
  ];

  const handleList = (data: string): void => {
    const entries = listEntries();
    if (matchesKey(data, "escape")) {
      options.close();
      return;
    }
    if (matchesKey(data, "up")) {
      navigate(-1, entries.length);
      return;
    }
    if (matchesKey(data, "down")) {
      navigate(1, entries.length);
      return;
    }
    if (data === "l" && options.mutationsEnabled()) {
      beginAddLocal(screen);
      return;
    }
    if (data === "r" && options.mutationsEnabled()) {
      beginAddRemote(screen);
      return;
    }
    if (data === "g" && options.mutationsEnabled()) {
      void refresh();
      return;
    }
    if (!matchesKey(data, "enter")) return;
    const selected = entries[cursor];
    if (!selected) return;
    if (selected.id === "add-local") {
      beginAddLocal(screen);
      return;
    }
    if (selected.id === "add-remote") {
      beginAddRemote(screen);
      return;
    }
    if (selected.id === "reload") {
      void mutate({ type: "reload" });
      return;
    }
    const server = servers.find((candidate) => mcpServerIdentity(candidate) === selected.id);
    if (server) void inspect(server);
  };

  const handleServer = (data: string, detail: TuiMcpServerDetail): void => {
    const mutationsEnabled = options.mutationsEnabled();
    const entries = mcpServerOptions(detail, mutationsEnabled);
    if (matchesKey(data, "escape")) {
      moveTo({ kind: "list" });
      return;
    }
    if (matchesKey(data, "up")) {
      navigate(-1, entries.length);
      return;
    }
    if (matchesKey(data, "down")) {
      navigate(1, entries.length);
      return;
    }
    if (data === "a" && mcpOAuthActionsAvailable(detail, mutationsEnabled)) {
      openServerOption(detail, "authenticate");
      return;
    }
    if (data === "l" && mcpOAuthActionsAvailable(detail, mutationsEnabled)) {
      openServerOption(detail, "logout");
      return;
    }
    if (data === "e" && mutationsEnabled) {
      openServerOption(detail, "toggle");
      return;
    }
    if (data === "r" && mcpLiveActionsAvailable(detail, mutationsEnabled)) {
      openServerOption(detail, "reconnect");
      return;
    }
    if (data === "d" && mutationsEnabled) {
      openServerOption(detail, "edit");
      return;
    }
    if (data === "x" && mutationsEnabled) {
      openServerOption(detail, "remove");
      return;
    }
    if (!matchesKey(data, "enter")) return;
    const selected = entries[cursor];
    if (selected) openServerOption(detail, selected.id);
  };

  const handleCollection = (data: string, collectionScreen: CollectionScreen): void => {
    if (matchesKey(data, "escape")) {
      moveTo({ kind: "server", detail: collectionScreen.detail });
      return;
    }
    if (matchesKey(data, "up")) {
      navigate(-1, collectionScreen.items.length);
      return;
    }
    if (matchesKey(data, "down")) {
      navigate(1, collectionScreen.items.length);
      return;
    }
    if (!matchesKey(data, "enter")) return;
    const selected = collectionScreen.items[cursor];
    if (selected)
      moveTo({
        kind: "text",
        title: `${collectionScreen.title} · ${selected.label}`,
        lines: selected.lines,
        back: collectionScreen,
      });
  };

  const handleText = (data: string, textScreen: TextScreen): void => {
    if (matchesKey(data, "escape")) {
      moveTo(textScreen.back);
      return;
    }
    if (matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
    else if (matchesKey(data, "down")) scroll += 1;
    else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - PAGE_STEP);
    else if (matchesKey(data, "pageDown")) scroll += PAGE_STEP;
    else return;
    render();
  };

  const handleChoice = (data: string, choiceScreen: ChoiceScreen): void => {
    if (matchesKey(data, "escape")) {
      moveTo(choiceScreen.back);
      return;
    }
    if (matchesKey(data, "up")) {
      navigate(-1, choiceScreen.choices.length);
      return;
    }
    if (matchesKey(data, "down")) {
      navigate(1, choiceScreen.choices.length);
      return;
    }
    const shortcut = /^[1-9]$/.test(data) ? choiceScreen.choices[Number(data) - 1] : undefined;
    if (shortcut) {
      choiceScreen.select(shortcut.id);
      return;
    }
    if (!matchesKey(data, "enter")) return;
    const selected = choiceScreen.choices[cursor];
    if (selected) choiceScreen.select(selected.id);
  };

  const handleConfirm = (data: string, confirmScreen: ConfirmScreen): void => {
    if (matchesKey(data, "escape") || data.toLowerCase() === "n") {
      moveTo(confirmScreen.back);
      return;
    }
    if (matchesKey(data, "enter") || data.toLowerCase() === "y") confirmScreen.confirm();
  };

  const listRows = (
    rows: readonly { readonly label: string; readonly description?: string }[],
    width: number,
    maxRows: number,
  ): readonly string[] => {
    const visibleRows = Math.max(1, Math.floor(maxRows / 2));
    const start = Math.max(0, Math.min(cursor - visibleRows + 1, Math.max(0, rows.length - visibleRows)));
    return rows.slice(start, start + visibleRows).flatMap((row, index) => {
      const selected = start + index === cursor;
      return [
        elideText(
          `${styled(options.colorEnabled, selected ? `${ANSI.bold}${ANSI.cyan}` : ANSI.dim, selected ? "›" : " ")} ${styled(options.colorEnabled, selected ? ANSI.bold : "", row.label)}`,
          width,
        ),
        ...(row.description
          ? [elideText(`  ${styled(options.colorEnabled, ANSI.dim, row.description)}`, width)]
          : []),
      ];
    });
  };

  const renderList = (width: number, maxRows: number): readonly string[] => {
    const serverRows = servers.map((server) => {
      const counts = server.capabilityCounts;
      const count = counts.tools + counts.prompts + counts.resources + counts.resourceTemplates;
      return {
        label: `${styled(options.colorEnabled, mcpStatusColor(server.status), mcpStatusGlyph(server.status))} ${safeMcpScalar(server.name)}  ${styled(options.colorEnabled, ANSI.dim, server.scope)}${server.shadowed ? " · overridden" : ""}`,
        description: `${server.type} · ${server.shadowed ? "inactive" : server.status.replaceAll("_", " ")} · ${String(count)} capabilities${server.lastError ? ` · ${safeMcpScalar(server.lastError)}` : ""}`,
      };
    });
    return listRows(
      [
        ...serverRows,
        ...(options.mutationsEnabled()
          ? [
              { label: "+ Add local server", description: "Run a local stdio command" },
              { label: "+ Add remote server", description: "Connect over Streamable HTTP" },
              { label: "↻ Reload", description: "Reload configuration and discovery" },
            ]
          : []),
      ],
      width,
      maxRows,
    );
  };

  const renderServer = (detail: TuiMcpServerDetail, width: number, maxRows: number): readonly string[] => {
    const counts = detail.capabilityCounts;
    return [
      elideText(
        `${styled(options.colorEnabled, mcpStatusColor(detail.status), mcpStatusGlyph(detail.status))} ${detail.shadowed ? "overridden · inactive" : detail.status.replaceAll("_", " ")} · ${detail.scope} · ${detail.type} · ${detail.enabled ? "enabled" : "disabled"}`,
        width,
      ),
      styled(
        options.colorEnabled,
        ANSI.dim,
        `${String(counts.tools)} tools · ${String(counts.prompts)} prompts · ${String(counts.resources)} resources · ${String(counts.resourceTemplates)} templates`,
      ),
      "",
      ...listRows(mcpServerOptions(detail, options.mutationsEnabled()), width, Math.max(1, maxRows - 3)),
    ];
  };

  const renderScreen = (width: number, maxRows: number): readonly string[] => {
    if (screen.kind === "list") return renderList(width, maxRows);
    if (screen.kind === "server") return renderServer(screen.detail, width, maxRows);
    if (screen.kind === "collection") {
      if (screen.items.length === 0)
        return [styled(options.colorEnabled, ANSI.dim, "Nothing published here yet.")];
      return listRows(screen.items, width, maxRows);
    }
    if (screen.kind === "text") {
      const wrapped = safeMcpLines(screen.lines).flatMap((line) =>
        line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""],
      );
      const boundedScroll = Math.min(scroll, Math.max(0, wrapped.length - maxRows));
      return wrapped.slice(boundedScroll, boundedScroll + maxRows);
    }
    if (screen.kind === "input")
      return [...wrapTextWithAnsi(safeTerminalText(screen.prompt), width), "", ...screen.input.render(width)];
    if (screen.kind === "choice")
      return [
        ...wrapTextWithAnsi(safeTerminalText(screen.prompt), width),
        "",
        ...listRows(screen.choices, width, Math.max(1, maxRows - 2)),
      ];
    return [
      ...wrapTextWithAnsi(safeTerminalText(screen.prompt), width),
      "",
      styled(options.colorEnabled, ANSI.red, "Enter / y confirm"),
      styled(options.colorEnabled, ANSI.dim, "Esc / n cancel"),
    ];
  };

  const title = (): string => {
    if (screen.kind === "list") return "MCP servers";
    if (screen.kind === "server") return `MCP · ${safeMcpScalar(screen.detail.name)}`;
    return safeMcpScalar(screen.title);
  };

  const hint = (): string => {
    return mcpManagerHint({
      screenKind: screen.kind,
      ...(screen.kind === "server" ? { detail: screen.detail } : {}),
      mutationsEnabled: options.mutationsEnabled(),
      busy: Boolean(busy),
      cancellable: Boolean(activeMutation?.controller),
    });
  };

  const component: McpManagerOverlay = {
    dispose() {
      disposePromise ??= (async () => {
        disposed = true;
        generation += 1;
        const mutation = activeMutation;
        mutation?.controller?.abort(new Error("MCP management closed"));
        await mutation?.promise.catch(() => undefined);
        if (activeMutation === mutation) activeMutation = undefined;
      })();
      return disposePromise;
    },
    refresh,
    invalidate() {},
    handleInput(data) {
      if (busy) {
        if (matchesKey(data, "escape")) {
          const controller = activeMutation?.controller;
          if (controller) {
            busy = "Cancelling MCP operation…";
            controller.abort(new Error("MCP operation cancelled"));
            render();
          } else {
            options.close();
          }
        }
        return;
      }
      notice = undefined;
      if (screen.kind === "list") return handleList(data);
      if (screen.kind === "server") return handleServer(data, screen.detail);
      if (screen.kind === "collection") return handleCollection(data, screen);
      if (screen.kind === "text") return handleText(data, screen);
      if (screen.kind === "input") return screen.input.handleInput(data);
      if (screen.kind === "choice") return handleChoice(data, screen);
      return handleConfirm(data, screen);
    },
    render(outerWidth) {
      const width = Math.max(16, outerWidth - 4);
      const height = Math.max(8, options.height() - 4);
      const noticeLines = notice
        ? safeTerminalText(notice)
            .split("\n")
            .flatMap((line) => wrapTextWithAnsi(line, width))
            .slice(0, 4)
        : [];
      const bodyRows = Math.max(1, height - 5 - noticeLines.length);
      const body = busy
        ? [styled(options.colorEnabled, ANSI.cyan, safeTerminalText(busy))]
        : renderScreen(width, bodyRows);
      return [
        styled(options.colorEnabled, ANSI.dim, `╭─ ${"─".repeat(Math.max(0, outerWidth - 4))}╮`),
        elideText(`│ ${styled(options.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, title())}`, outerWidth),
        ...(noticeLines.length > 0
          ? noticeLines.map((line) =>
              elideText(`│ ${styled(options.colorEnabled, ANSI.yellow, line)}`, outerWidth),
            )
          : []),
        ...body.slice(0, bodyRows).map((line) => elideText(`│ ${line}`, outerWidth)),
        elideText(`│ ${styled(options.colorEnabled, ANSI.dim, hint())}`, outerWidth),
        styled(options.colorEnabled, ANSI.dim, `╰─ ${"─".repeat(Math.max(0, outerWidth - 4))}╯`),
      ];
    },
  };

  void refresh();
  return component;
}
