import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorEnvironment {
  readonly VISUAL?: string;
  readonly EDITOR?: string;
  readonly [name: string]: string | undefined;
}

export interface EditTextInExternalEditorInput {
  readonly content: string;
  readonly configuredCommand?: string;
  readonly environment?: ExternalEditorEnvironment;
  readonly platform?: NodeJS.Platform;
}

export type EditTextInExternalEditorResult =
  | {
      readonly status: "edited";
      readonly command: string;
      readonly content: string;
    }
  | {
      readonly status: "unchanged";
      readonly command: string;
      readonly reason: "editor-exit" | "launch-failed" | "io-failed";
      readonly exitCode?: number | null;
      readonly error?: string;
    };

type EditorProcessResult =
  | { readonly status: "complete"; readonly content: string }
  | {
      readonly status: "failed";
      readonly reason: "editor-exit" | "launch-failed" | "io-failed";
      readonly exitCode?: number | null;
      readonly error?: string;
    };

const nonEmpty = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

export function resolveExternalEditorCommand(
  configuredCommand: string | undefined,
  environment: ExternalEditorEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return (
    nonEmpty(configuredCommand) ??
    nonEmpty(environment.VISUAL) ??
    nonEmpty(environment.EDITOR) ??
    (platform === "win32" ? "notepad" : "nano")
  );
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function parseEditorCommand(
  command: string,
):
  | { readonly status: "complete"; readonly executable: string; readonly args: readonly string[] }
  | { readonly status: "failed"; readonly error: string } {
  const words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      word += character;
      wordStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      wordStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      wordStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (wordStarted) {
        words.push(word);
        word = "";
        wordStarted = false;
      }
      continue;
    }
    word += character;
    wordStarted = true;
  }
  if (escaped || quote)
    return {
      status: "failed",
      error: `invalid editor command: ${escaped ? "trailing escape" : "unterminated quote"}`,
    };
  if (wordStarted) words.push(word);
  const [executable, ...args] = words;
  return executable
    ? { status: "complete", executable, args }
    : { status: "failed", error: "invalid editor command: no executable" };
}

async function runEditor(
  command: string,
  filePath: string,
  environment: ExternalEditorEnvironment,
  platform: NodeJS.Platform,
): Promise<
  | { readonly status: "complete" }
  | {
      readonly status: "failed";
      readonly reason: "editor-exit" | "launch-failed";
      readonly exitCode?: number | null;
      readonly error?: string;
    }
> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (
      result:
        | { readonly status: "complete" }
        | {
            readonly status: "failed";
            readonly reason: "editor-exit" | "launch-failed";
            readonly exitCode?: number | null;
            readonly error?: string;
          },
    ): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const parsed = parseEditorCommand(command);
    if (parsed.status === "failed") {
      settle({
        status: "failed",
        reason: "launch-failed",
        error: parsed.error,
      });
      return;
    }
    const childEnvironment = { ...process.env, ...environment };
    const child = spawn(parsed.executable, [...parsed.args, filePath], {
      env: childEnvironment,
      shell: platform === "win32",
      stdio: "inherit",
    });
    child.once("error", (error) =>
      settle({
        status: "failed",
        reason: "launch-failed",
        error: describeError(error),
      }),
    );
    child.once("close", (exitCode) =>
      settle(
        exitCode === 0
          ? { status: "complete" }
          : {
              status: "failed",
              reason: "editor-exit",
              exitCode,
            },
      ),
    );
  });
}

async function runExternalEditor(
  command: string,
  content: string,
  environment: ExternalEditorEnvironment,
  platform: NodeJS.Platform,
): Promise<EditorProcessResult> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "noesis-editor-"));
    const filePath = join(directory, "prompt.md");
    await writeFile(filePath, content, "utf8");
    const processResult = await runEditor(command, filePath, environment, platform);
    if (processResult.status === "failed") return processResult;
    return {
      status: "complete",
      content: await readFile(filePath, "utf8"),
    };
  } catch (error) {
    return {
      status: "failed",
      reason: "io-failed",
      error: describeError(error),
    };
  } finally {
    if (directory) {
      try {
        await rm(directory, { force: true, recursive: true });
      } catch {
        // Cleanup is best effort; the edited text has already been copied into memory.
      }
    }
  }
}

/** Edit text through a temporary Markdown file without mutating the caller's buffer. */
export async function editTextInExternalEditor(
  input: EditTextInExternalEditorInput,
): Promise<EditTextInExternalEditorResult> {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const command = resolveExternalEditorCommand(input.configuredCommand, environment, platform);
  const result = await runExternalEditor(command, input.content, environment, platform);
  if (result.status === "failed") {
    return {
      status: "unchanged",
      command,
      reason: result.reason,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }
  return { status: "edited", command, content: result.content };
}
