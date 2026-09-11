# Composer attachments

## Attach and send

- Copy one or more files, then press `Ctrl+V` in the composer to attach the original files with their original filenames and bytes. Any file type accepted by `/attach` is accepted here, within the same limits. Copying image pixels (for example, a screenshot) still attaches a generated `clipboard.png`.
- Use `/attach <path>` for an image or another file. Quote paths containing spaces. This reads a file on the machine running Noesis, not on an SSH client's machine.
- Use `/detach <number>` or `/detach all` to remove attachments.
- Press Enter to send the text and attachments together. An image or file can be sent without text.
- `Alt+Up` restores the newest queued message, including its attachment references.

Normal terminal text paste remains text. Noesis does not inspect pasted paths, execute them, or read the clipboard in the background. Bracketed text pastes stay literal and editable, including text that resembles a snippet marker. Automatic snippet collapsing is deferred until the editor can distinguish owned markers from literal user text. Paths retain their existing spacing.

Attachments appear immediately above the editor. A supported graphics terminal shows the first image in at most two rows, followed by one compact line listing the attachments. Other attachments remain labelled rather than adding more thumbnail rows. Narrow and short terminals use labels only. Attachment labels also appear in queued messages and the transcript.

Preparing or failed attachments block submission until they are ready or removed. Admission failures retain the draft. Attachment submissions wait for session-changing commands to finish rather than risking delivery to the wrong session. `/steer` does not consume current draft attachments; send them normally or remove them first. Already queued attachments can be promoted with `/steer`.

## Terminal and clipboard support

Image rendering and clipboard access are independent capabilities.

| Environment                                             | Preview                                                                  | Clipboard file / image input             |
| ------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| Kitty, Ghostty, WezTerm, Warp                           | Kitty graphics when detected                                             | Local OS clipboard helper                |
| iTerm2                                                  | iTerm2 inline images when detected                                       | macOS clipboard helper                   |
| VS Code, Alacritty, Windows Terminal, unknown terminals | Compact text labels                                                      | Local OS clipboard helper                |
| tmux, GNU Screen                                        | Compact text labels                                                      | Local OS clipboard helper when available |
| SSH                                                     | Graphics only if the terminal is positively identified; otherwise labels | Use `/attach` with a remote file path    |

Copied-file references take precedence over image representations, which can be file icons. macOS reads file URLs or the legacy filename list with `osascript` and AppKit. Windows reads the FileDrop list with Windows PowerShell in STA mode. Linux uses `wl-paste` under Wayland or `xclip` under X11; these optional utilities must be installed. Linux checks advertised `x-special/gnome-copied-files` and `text/uri-list` formats before requesting PNG data. Only local file URLs are accepted; file-manager-specific virtual files and remote URLs are not downloaded. Missing helpers and clipboard failures show `/attach` guidance. An unreadable, invalid, or oversized referenced file fails the whole paste visibly; Noesis never substitutes its icon. Remove the failed draft item with `/detach` before retrying. A backend whose file formats cannot be inspected is not used for image fallback. Helpers run with bounded output and deadlines, without a shell.

`PI_IMAGE_PROTOCOL=none` disables image previews. Graphics overrides do not force image output through unsupported multiplexers. Noesis does not implement sixel or remote clipboard transfer.

The implementation has automated graphics/fallback and clipboard-adapter tests. This is not a claim of physical testing in every terminal or operating system.

## Limits and storage

A message can contain up to 8 files, at most 10 MiB each and 20 MiB combined. The composer accepts PNG, JPEG, GIF, and WebP images within a 16-megapixel and 16,384-pixel per-dimension limit. Other file formats remain file attachments, not native model document input.

Thumbnail decoding runs in a worker, one at a time, outside the editor's event loop. Previews are PNG images no larger than 320 by 160 pixels. Rendering reuses cached previews. Preview failure falls back to a label without discarding the attachment.

Submission saves original bytes as verified artifacts under the Noesis installation. SQLite messages and pending intents hold artifact references rather than base64 copies. Removing a draft item does not delete artifacts from previously submitted messages.

Models with image input receive actual image blocks. Models without it reject image submissions before queue admission. Other files reach the model as explicit artifact paths that tools can read. Noesis does not silently extract, summarize, or truncate file contents.

Retained images are resolved again from verified artifacts on session replay and fork. Retained history has a 20 MiB image-byte limit; exceeding it requires `/compact`. Compaction sees file references and conversation text, not the images themselves. Original artifacts remain available. Context inspection omits image bytes and explicitly does not estimate provider-specific image token usage.
