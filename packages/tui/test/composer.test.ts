import { TuiMainScreen } from "@earendil-works/pi-tui";
import type { ComposerAttachmentInput } from "@noesis/domain";
import { describe, expect, test, vi } from "vitest";
import { createComposer, type DraftAttachment } from "../src/composer.ts";
import { createSafeEditor } from "../src/safe-editor.ts";
import { createTestTerminal } from "./support/test-terminal.ts";

const file: ComposerAttachmentInput = { name: "notes.txt", mimeType: "text/plain", data: "YWJj" };
const settle = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};
const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fixture(
  readPath: (path: string) => Promise<ComposerAttachmentInput> = async () => file,
  send: (text: string, attachments: readonly DraftAttachment[]) => Promise<void> = async () => undefined,
) {
  const editor = createSafeEditor(new TuiMainScreen(createTestTerminal()));
  const notice = vi.fn();
  const submit = vi.fn(send);
  const readClipboard = vi.fn<() => Promise<ComposerAttachmentInput | readonly ComposerAttachmentInput[]>>(
    async () => file,
  );
  const composer = createComposer({
    editor,
    notice,
    submit,
    readPath,
    readClipboard,
    requestRender: () => undefined,
    canSubmit: () => true,
  });
  const ordinary = vi.fn();
  editor.onSubmit = (text) => {
    if (!composer.handleSubmission(text)) ordinary(text);
  };
  const enter = (text: string) => {
    editor.setText(text);
    editor.handleInput?.("\r");
  };
  return { composer, editor, notice, submit, readClipboard, ordinary, enter };
}

describe("attachment composer", () => {
  test("clipboard batches submit together and overflow fails atomically", async () => {
    const f = fixture();
    const second = { ...file, name: "second.pdf", mimeType: "application/pdf" };
    f.readClipboard.mockResolvedValueOnce([file, second]);
    f.composer.handleKey("\u0016");
    f.enter("wait");
    expect(f.submit).not.toHaveBeenCalled();
    await settle();
    f.enter("both");
    await settle();
    expect(f.submit).toHaveBeenCalledWith("both", [file, second]);
    f.readClipboard.mockResolvedValueOnce(Array.from({ length: 9 }, () => file));
    f.composer.handleKey("\u0016");
    await settle();
    expect(f.composer.render(100).join(" ")).toContain("failed");
    f.enter("blocked");
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  test("ordinary paths remain text; explicit attachment-only messages submit", async () => {
    const read = vi.fn(async () => file);
    const f = fixture(read);
    f.enter("/tmp/notes.txt");
    expect(read).not.toHaveBeenCalled();
    expect(f.ordinary).toHaveBeenCalledWith("/tmp/notes.txt");
    f.enter("/attach /tmp/notes.txt");
    await settle();
    expect(read).toHaveBeenCalledWith("/tmp/notes.txt");
    expect(f.composer.render(80).join("\n")).toContain("1 notes.txt");
    f.enter("");
    await settle();
    expect(f.submit).toHaveBeenCalledWith("", [file]);
    expect(f.composer.render(80)).toEqual([]);
  });
  test("pending preparation blocks partial send; cancelled reads cannot reappear", async () => {
    const read = deferred<ComposerAttachmentInput>();
    const f = fixture(async () => read.promise);
    f.enter("/attach slow.png");
    f.enter("inspect this");
    expect(f.editor.getText()).toBe("inspect this");
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.ordinary).not.toHaveBeenCalled();
    f.enter("/detach all");
    read.resolve(file);
    await settle();
    expect(f.composer.render(80)).toEqual([]);
  });
  test("failed preparation remains visible and blocks partial send until removed", async () => {
    const f = fixture(async () => {
      throw new Error("Not readable");
    });
    f.enter("/attach missing");
    await settle();
    expect(f.composer.render(80).join("\n")).toContain("failed");
    f.enter("keep the draft");
    expect(f.editor.getText()).toBe("keep the draft");
    expect(f.ordinary).not.toHaveBeenCalled();
    f.enter("/detach 1");
    expect(f.composer.render(80)).toEqual([]);
  });
  test("admission failure retains bytes and text; pending Enter never duplicates", async () => {
    const admission = deferred<void>();
    const f = fixture(undefined, async () => admission.promise);
    f.enter("/attach notes.txt");
    await settle();
    f.enter("exact draft\nwith context");
    expect(f.editor.getText()).toBe("exact draft\nwith context");
    f.editor.handleInput?.("\r");
    expect(f.submit).toHaveBeenCalledTimes(1);
    admission.reject(new Error("No vision support"));
    await settle();
    expect(f.editor.getText()).toBe("exact draft\nwith context");
    expect(f.composer.render(80).join("\n")).toContain("notes.txt");
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining("draft retained"));
  });
  test("successful admission does not erase edits made while waiting", async () => {
    const admission = deferred<void>();
    const f = fixture(undefined, async () => admission.promise);
    f.enter("/attach notes.txt");
    await settle();
    f.enter("first");
    f.editor.setText("new draft");
    admission.resolve();
    await settle();
    expect(f.editor.getText()).toBe("new draft");
    expect(f.composer.render(80)).toEqual([]);
  });
  test("clipboard is explicit and bounded; fallback is compact and control-safe", async () => {
    const f = fixture();
    expect(f.readClipboard).not.toHaveBeenCalled();
    expect(f.composer.handleKey("x")).toBe(false);
    for (let index = 0; index < 9; index++) f.composer.handleKey("\u0016");
    await settle();
    expect(f.readClipboard).toHaveBeenCalledTimes(8);
    f.composer.restore([{ ...file, name: "evil\u001b[2J\nlabel" }]);
    const rendered = f.composer.render(20, false);
    expect(rendered).toHaveLength(1);
    for (const character of ["\u001b", "\n", "\r"]) expect(rendered[0]).not.toContain(character);
  });
  test("restored immutable references survive attachment-only resubmission", async () => {
    const f = fixture();
    const restored = {
      name: "saved.png",
      mimeType: "image/png",
      artifact: {
        kind: "artifact_file",
        artifactId: "artifact_1",
        path: "attachments/saved.png",
        mediaType: "image/png",
      },
    } as const;
    f.composer.restore([restored]);
    f.enter("");
    await settle();
    expect(f.submit).toHaveBeenCalledWith("", [restored]);
  });
  test("disposal discards late preparation completions", async () => {
    const read = deferred<ComposerAttachmentInput>();
    const f = fixture(async () => read.promise);
    f.enter("/attach pending");
    f.composer.dispose();
    read.resolve(file);
    await settle();
    expect(f.composer.render(80)).toEqual([]);
  });
});

describe("literal pasted snippets", () => {
  test("inserts at cursor and submits full text in order", async () => {
    vi.useFakeTimers();
    try {
      const editor = createSafeEditor(new TuiMainScreen(createTestTerminal()));
      const submit = vi.fn();
      editor.onSubmit = submit;
      editor.setText("beforeafter");
      for (let index = 0; index < 5; index++) editor.handleInput?.("\u001b[D");
      const text = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
      editor.handleInput?.(`\u001b[200~${text}\u001b[201~`);
      await vi.advanceTimersByTimeAsync(100);
      expect(editor.render(80).join("\n")).not.toContain("[paste #1");
      expect(editor.getText()).toBe(`before${text}after`);
      editor.handleInput?.("\r");
      expect(submit).toHaveBeenCalledWith(`before${text}after`);
    } finally {
      vi.useRealTimers();
    }
  });
});

test("literal current and future paste markers never expand, including existing and typed draft text", async () => {
  vi.useFakeTimers();
  try {
    const editor = createSafeEditor(new TuiMainScreen(createTestTerminal()));
    const submit = vi.fn();
    editor.onSubmit = submit;
    const draft = "existing [paste #1 1001 chars] [paste #2] ";
    editor.setText(draft);
    const first = "A".repeat(1001) + " literal [paste #2] [paste #1]";
    const second = "B".repeat(1001) + " literal [paste #1 +20 lines]";
    for (const text of [first, second]) {
      editor.handleInput?.(`\u001b[200~${text}\u001b[201~`);
      await vi.advanceTimersByTimeAsync(100);
    }
    const typed = " typed [paste #1]";
    for (const character of typed) editor.handleInput?.(character);
    const expected = draft + first + second + typed;
    expect(editor.getText()).toBe(expected);
    editor.handleInput?.("\r");
    expect(submit).toHaveBeenCalledWith(expected);
  } finally {
    vi.useRealTimers();
  }
});

test("large literal pastes remain one undoable edit", async () => {
  vi.useFakeTimers();
  try {
    const editor = createSafeEditor(new TuiMainScreen(createTestTerminal()));
    editor.setText("draft [paste #1]");
    editor.handleInput?.(`\u001b[200~${"A".repeat(1001)}\u001b[201~`);
    await vi.advanceTimersByTimeAsync(100);
    editor.handleInput?.("\u001f");
    expect(editor.getText()).toBe("draft [paste #1]");
  } finally {
    vi.useRealTimers();
  }
});
