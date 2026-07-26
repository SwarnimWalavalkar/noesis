"""Render the current terminal grid of an interactive Noesis command.

Development aid for eyeballing TUI layout: it drives a real PTY, optionally sends keystrokes
after matching markers, and prints the resulting screen instead of the raw byte stream.
"""

import os
import fcntl
import pty
import select
import struct
import sys
import termios
import time

from pty_quit import VirtualScreen


def main() -> int:
    columns = int(sys.argv[1])
    rows = int(sys.argv[2])
    seconds = float(sys.argv[3])
    script = sys.argv[4]
    command = sys.argv[5:]

    writes = []
    if script:
        for step in script.split("|"):
            marker, _, keys = step.partition(">")
            writes.append(
                (marker.encode(), keys.encode().decode("unicode_escape").encode())
            )

    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, os.environ)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    screen = VirtualScreen(columns, rows)
    seen = b""
    deadline = time.monotonic() + seconds
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.05)
            if not readable:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            screen.feed(chunk)
            seen += chunk
            if writes and writes[0][0] in seen:
                _, keys = writes.pop(0)
                os.write(master, keys)
                seen = b""
    finally:
        try:
            os.kill(pid, 9)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass

    sys.stdout.write(screen.text())
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
