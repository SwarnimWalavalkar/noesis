import codecs
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import unicodedata
import urllib.request


class VirtualScreen:
    def __init__(self, columns: int, rows: int):
        self.columns = columns
        self.rows = rows
        self.grid = [[" "] * columns for _ in range(rows)]
        self.row = 0
        self.column = 0
        self.state = "text"
        self.sequence = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def resize(self, columns: int, rows: int) -> None:
        resized = [[" "] * columns for _ in range(rows)]
        for row in range(min(rows, self.rows)):
            for column in range(min(columns, self.columns)):
                resized[row][column] = self.grid[row][column]
        self.columns = columns
        self.rows = rows
        self.grid = resized
        self.row = min(self.row, rows - 1)
        self.column = min(self.column, columns - 1)

    def feed(self, data: bytes) -> None:
        for character in self.decoder.decode(data):
            if self.state == "text":
                if character == "\x1b":
                    self.state = "escape"
                elif character == "\r":
                    self.column = 0
                elif character == "\n":
                    self._line_feed()
                elif character >= " ":
                    self._write(character)
            elif self.state == "escape":
                if character == "[":
                    self.state = "csi"
                    self.sequence = ""
                elif character == "]":
                    self.state = "osc"
                elif character == "_":
                    self.state = "apc"
                else:
                    self.state = "text"
            elif self.state == "csi":
                if "@" <= character <= "~":
                    self._csi(self.sequence, character)
                    self.state = "text"
                else:
                    self.sequence += character
            elif self.state in ("osc", "apc"):
                if character == "\x07":
                    self.state = "text"
                elif character == "\x1b":
                    self.state = "string_escape"
            elif self.state == "string_escape":
                self.state = "text" if character == "\\" else "osc"

    def text(self) -> str:
        return "\n".join("".join(line).rstrip() for line in self.grid).rstrip()

    def _line_feed(self) -> None:
        self.row += 1
        if self.row >= self.rows:
            self.grid.pop(0)
            self.grid.append([" "] * self.columns)
            self.row = self.rows - 1

    def _write(self, character: str) -> None:
        width = 2 if unicodedata.east_asian_width(character) in ("W", "F") else 1
        if unicodedata.combining(character):
            width = 0
        if self.column >= self.columns:
            self.column = 0
            self._line_feed()
        if width and self.column < self.columns:
            self.grid[self.row][self.column] = character
            if width == 2 and self.column + 1 < self.columns:
                self.grid[self.row][self.column + 1] = ""
        self.column += width

    def _csi(self, raw: str, final: str) -> None:
        clean = raw.lstrip("?><!")
        values = (
            [int(value) if value.isdigit() else 0 for value in clean.split(";")]
            if clean
            else [0]
        )
        amount = values[0] or 1
        if final == "A":
            self.row = max(0, self.row - amount)
        elif final == "B":
            self.row = min(self.rows - 1, self.row + amount)
        elif final == "C":
            self.column = min(self.columns - 1, self.column + amount)
        elif final == "D":
            self.column = max(0, self.column - amount)
        elif final == "G":
            self.column = min(self.columns - 1, max(0, amount - 1))
        elif final in ("H", "f"):
            self.row = min(self.rows - 1, max(0, (values[0] or 1) - 1))
            self.column = min(
                self.columns - 1, max(0, (values[1] if len(values) > 1 else 1) - 1)
            )
        elif final == "K":
            mode = values[0]
            start = 0 if mode in (1, 2) else self.column
            end = self.columns if mode in (0, 2) else self.column + 1
            for column in range(start, end):
                self.grid[self.row][column] = " "
        elif final == "J" and values[0] in (2, 3):
            self.grid = [[" "] * self.columns for _ in range(self.rows)]
            self.row = 0
            self.column = 0


URL_ROW = re.compile(r"[A-Za-z0-9:/?&=._~%+\-]+")


def extract_oauth_state(screen: "VirtualScreen") -> "str | None":
    """Recover the authorization state from the rendered screen.

    Onboarding renders the sign-in URL as column-aligned chunks, so the raw byte stream carries
    line breaks inside the URL. Rejoining the contiguous URL rows of the grid restores it.
    """
    url = ""
    for row in (line.strip() for line in screen.text().split("\n")):
        if not url:
            if row.startswith("https://auth.openai.com"):
                url = row
            continue
        if not URL_ROW.fullmatch(row):
            break
        url += row
    match = re.search(r"[?&]state=([A-Za-z0-9_\-]+)", url)
    return match.group(1) if match else None


def main() -> int:
    action = sys.argv[1]
    columns = int(sys.argv[2])
    rows = int(sys.argv[3])
    command = sys.argv[4:]
    followup_writes = []
    onboarding_writes = []
    oauth_callback_pending = False
    if action == "quit-lf":
        exit_input = b"/quit\n"
        ready_marker = b"? help"
    elif action == "ctrl-c":
        exit_input = b"\x03"
        ready_marker = b"? help"
    elif action in ("first-launch-quit-lf", "first-launch-ctrl-c"):
        exit_input = b"/quit\n" if action == "first-launch-quit-lf" else b"\x03"
        ready_marker = "● IDLE".encode()
        onboarding_writes = [
            (b"Choose an AI provider", b"\x1b[B\r"),
            (b"OpenRouter model ID", b"\r"),
            (b"Choose a reasoning level", b"\r"),
            (b"Authenticate and create this configuration?", b"\r"),
            (b"Enter OpenRouter API key", b"test-openrouter-key\r"),
        ]
    elif action in ("first-launch-oauth-quit-lf", "first-launch-oauth-ctrl-c"):
        exit_input = b"/quit\n" if action == "first-launch-oauth-quit-lf" else b"\x03"
        ready_marker = "● IDLE".encode()
        onboarding_writes = [
            (b"Choose an AI provider", b"\r"),
            (b"Choose a Codex model", b"\r"),
            (b"Choose a reasoning level", b"\r"),
            (b"Authenticate and create this configuration?", b"\r"),
            (b"Select OpenAI Codex login method:", b"\r"),
        ]
        oauth_callback_pending = True
    elif action == "picker-cancel":
        exit_input = b"\x1b"
        ready_marker = b"resume a session"
    elif action == "picker-select-quit":
        exit_input = b"\r"
        ready_marker = b"resume a session"
    elif action == "prompt-quit":
        exit_input = b"show the polished shell\r"
        ready_marker = b"? help"
    elif action in ("completed-turn-quit-lf", "completed-turn-ctrl-c"):
        exit_input = b"No, keep this research brief concise.\r"
        ready_marker = b"? help"
    elif action == "backspace-del-quit":
        exit_input = b"abc\x7f\r"
        ready_marker = b"? help"
    elif action == "backspace-bs-quit":
        exit_input = b"abc\x08\r"
        ready_marker = b"? help"
    elif action == "backspace-grapheme-quit":
        exit_input = "a👨‍👩‍👧‍👦".encode() + b"\x7f\r"
        ready_marker = b"? help"
    elif action == "resize-main-quit":
        exit_input = b""
        ready_marker = "███╗   ██╗ ██████╗".encode()
    elif action == "resize-picker-cancel":
        exit_input = b""
        ready_marker = b"resume a session"
    elif action == "mixed-resize-quit":
        mixed = "\n".join(
            [
                "# Mixed response",
                "",
                "A live paragraph with **strong text**, `inline code`, and a [link](https://example.com).",
                "",
                "- first item",
                "  - nested item",
                "> quoted evidence",
                "```ts",
                "const answer = 42;",
                " ".join(f"filler-{index}" for index in range(60)),
                "```",
                "Inline $x_i^2$ and \\(y = mx+b\\).",
                "$$",
                "\\sum_{i=1}^{n} i",
                "$$",
                "| name | value |",
                "| --- | ---: |",
                "| alpha | 42 |",
                "MIXED-END",
            ]
        )
        exit_input = b"\x1b[200~" + mixed.encode() + b"\x1b[201~"
        followup_writes = [(0.175, b"\r", "genuine-enter")]
        ready_marker = b"? help"
    elif action == "paste-controls-quit":
        hostile = "Unicode 界面\tline\n\x1b[2J\x07\u009b31m\u009dtitle\u009c\x7f end"
        exit_input = b"\x1b[200~" + hostile.encode() + b"\x1b[201~"
        followup_writes = [(0.175, b"\r", "genuine-enter")]
        ready_marker = b"? help"
    elif action == "fragmented-hostile-paste-quit":
        exit_input = b"\x1b[20"
        hostile_tail = "0~safe\x1b[201~\rBAD\x1b[2J\x07\u009b31m\x7f\x1b[201~".encode()
        followup_writes = [
            (0.025, hostile_tail, "hostile-tail"),
            (0.175, b"\r", "genuine-enter"),
        ]
        ready_marker = b"? help"
    else:
        raise ValueError(f"Unknown PTY exit action: {action}")

    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, os.environ)

    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    output = b""
    sent_exit = False
    next_write_at = None
    last_write_label = None
    deadline = time.monotonic() + 5
    child_finished = False
    screen = VirtualScreen(columns, rows)
    try:
        while time.monotonic() < deadline:
            if (
                sent_exit
                and followup_writes
                and next_write_at is not None
                and time.monotonic() >= next_write_at
            ):
                _, next_input, label = followup_writes.pop(0)
                if (
                    label == "genuine-enter"
                    and b"Controlled Pi completion for:" in output
                ):
                    os.write(sys.stdout.fileno(), b"\n__NOESIS_PREMATURE_SUBMIT__\n")
                os.write(master, next_input)
                last_write_label = label
                next_write_at = (
                    time.monotonic() + followup_writes[0][0]
                    if followup_writes
                    else None
                )
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    chunk = b""
                if chunk:
                    output += chunk
                    screen.feed(chunk)
                    os.write(sys.stdout.fileno(), chunk)
                    if onboarding_writes and onboarding_writes[0][0] in output:
                        _, onboarding_input = onboarding_writes.pop(0)
                        os.write(master, onboarding_input)
                        output = b""
                    elif (
                        oauth_callback_pending
                        and b"Complete login in your browser" in output
                    ):
                        state = extract_oauth_state(screen)
                        if state:
                            callback = (
                                "http://127.0.0.1:1455/auth/callback?code=test-code&state="
                                + state
                            ).encode()
                            with urllib.request.urlopen(
                                callback.decode(), timeout=1
                            ) as response:
                                callback_page = response.read()
                                callback_headers = "\n".join(
                                    f"{name}: {response.headers.get(name, '')}"
                                    for name in (
                                        "Cache-Control",
                                        "Content-Security-Policy",
                                        "Referrer-Policy",
                                        "X-Content-Type-Options",
                                    )
                                ).encode()
                            os.write(
                                sys.stdout.fileno(),
                                b"\n__NOESIS_OAUTH_CALLBACK_PAGE__\n"
                                + callback_page
                                + b"\n__NOESIS_OAUTH_CALLBACK_HEADERS__\n"
                                + callback_headers
                                + b"\n__NOESIS_OAUTH_CALLBACK_END__\n",
                            )
                            oauth_callback_pending = False
                            output = b""
                    elif not sent_exit and ready_marker in output:
                        if action == "resize-main-quit":
                            os.write(sys.stdout.fileno(), b"\n__NOESIS_RESIZED__\n")
                            fcntl.ioctl(
                                master,
                                termios.TIOCSWINSZ,
                                struct.pack("HHHH", 9, 50, 0, 0),
                            )
                            screen.resize(50, 9)
                            os.kill(pid, signal.SIGWINCH)
                        elif action == "resize-picker-cancel":
                            os.write(sys.stdout.fileno(), b"\n__NOESIS_RESIZED__\n")
                            fcntl.ioctl(
                                master,
                                termios.TIOCSWINSZ,
                                struct.pack("HHHH", 7, 46, 0, 0),
                            )
                            screen.resize(46, 7)
                            os.kill(pid, signal.SIGWINCH)
                        else:
                            os.write(master, exit_input)
                            if followup_writes:
                                next_write_at = time.monotonic() + followup_writes[0][0]
                        sent_exit = True
                        output = b""
                    elif (
                        action == "picker-select-quit"
                        and sent_exit
                        and "● IDLE".encode() in output
                    ):
                        os.write(master, b"/quit\n")
                        action = "picker-selected"
                    elif (
                        action
                        in (
                            "prompt-quit",
                            "backspace-del-quit",
                            "backspace-bs-quit",
                            "backspace-grapheme-quit",
                        )
                        and sent_exit
                        and b"Controlled Pi completion for:" in output
                        and "● IDLE".encode() in output
                        and b"ctx   0%" in output
                    ):
                        os.write(master, b"/quit\n")
                        action = "prompt-selected"
                    elif (
                        action in ("completed-turn-quit-lf", "completed-turn-ctrl-c")
                        and sent_exit
                        and b"Controlled Pi completion for:" in output
                        and "● IDLE".encode() in output
                    ):
                        os.write(
                            master,
                            b"/quit\n"
                            if action == "completed-turn-quit-lf"
                            else b"\x03",
                        )
                        action = "completed-turn-finished"
                    elif (
                        action == "paste-controls-quit"
                        and sent_exit
                        and b"Controlled Pi completion for:" in output
                        and "● IDLE".encode() in output
                    ):
                        os.write(master, b"/quit\n")
                        action = "paste-controls-finished"
                    elif (
                        action == "fragmented-hostile-paste-quit"
                        and sent_exit
                        and last_write_label == "genuine-enter"
                        and b"Controlled Pi completion for:" in output
                        and "● IDLE".encode() in output
                    ):
                        os.write(master, b"/quit\n")
                        action = "fragmented-hostile-paste-finished"
                    elif (
                        action == "resize-main-quit"
                        and sent_exit
                        and b"? help" in output
                    ):
                        os.write(master, b"/quit\n")
                        action = "main-resized"
                    elif (
                        action == "resize-picker-cancel"
                        and sent_exit
                        and b"resume a session" in output
                    ):
                        os.write(master, b"\x1b")
                        action = "picker-resized"
                    elif (
                        action == "mixed-resize-quit"
                        and sent_exit
                        and last_write_label == "genuine-enter"
                        and "● IDLE".encode() in output
                        and b"ctx   0%" in output
                        and b"1t" in output
                        and b"MIXED-END" in output
                    ):
                        os.write(sys.stdout.fileno(), b"\n__NOESIS_MIXED_RESIZED__\n")
                        fcntl.ioctl(
                            master,
                            termios.TIOCSWINSZ,
                            struct.pack("HHHH", 22, 70, 0, 0),
                        )
                        screen.resize(70, 22)
                        os.kill(pid, signal.SIGWINCH)
                        action = "mixed-resized"
                        output = b""
                    elif (
                        action == "mixed-resized"
                        and "● IDLE".encode() in output
                        and b"MIXED-END" in output
                    ):
                        os.write(sys.stdout.fileno(), b"\n__NOESIS_FINAL_SCREEN__\n")
                        os.write(sys.stdout.fileno(), screen.text().encode())
                        os.write(
                            sys.stdout.fileno(), b"\n__NOESIS_FINAL_SCREEN_END__\n"
                        )
                        os.write(master, b"/quit\n")
                        action = "mixed-finished"
            finished, status = os.waitpid(pid, os.WNOHANG)
            if finished:
                child_finished = True
                return os.waitstatus_to_exitcode(status)
    finally:
        if not child_finished:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
    return 124


if __name__ == "__main__":
    raise SystemExit(main())
