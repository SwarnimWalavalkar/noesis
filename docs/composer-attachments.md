# Composer attachments

## Attach and send

- Copy one or more files, then press `Ctrl+V` in the composer to attach the original files with their original filenames and bytes. Any local regular file type accepted by `/attach` is accepted here, including empty and large files. Copying image pixels (for example, a screenshot) still attaches a generated `clipboard.png`.
- Use `/attach <path>` for an image or another file. Quote paths containing spaces. This reads a file on the machine running Noesis, not on an SSH client's machine.
- Use `/attachments <page>` to inspect every draft attachment, eight metadata entries per page.
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

Copied-file references take precedence over image representations, which can be file icons. macOS reads file URLs or the legacy filename list with `osascript` and AppKit. Windows reads the FileDrop list with Windows PowerShell in STA mode. Linux uses `wl-paste` under Wayland or `xclip` under X11; these optional utilities must be installed. Linux checks advertised `x-special/gnome-copied-files` and `text/uri-list` formats before requesting PNG data. Only local file URLs are accepted; file-manager-specific virtual files and remote URLs are not downloaded. Missing helpers and clipboard failures show `/attach` guidance. An unreadable or invalid referenced file fails the whole paste visibly; Noesis never substitutes its icon. Remove the failed draft item with `/detach` before retrying. A backend whose file formats cannot be inspected is not used for image fallback. File-reference probes have bounded metadata output; clipboard pixel output is streamed to an owned temporary file with backpressure. Helpers have deadlines and run without a shell. Temporary images survive pending admission and are cleaned up after detach, cancellation, or settled submission.

`PI_IMAGE_PROTOCOL=none` disables image previews. Graphics overrides do not force image output through unsupported multiplexers. Noesis does not implement sixel or remote clipboard transfer.

The implementation has automated graphics/fallback and clipboard-adapter tests. This is not a claim of physical testing in every terminal or operating system.

## Storage and bounded viewing

There is no attachment-count, individual-file-size, or aggregate-file-size admission cap. Empty regular files are allowed. Legacy in-memory API payloads are syntax-validated without full decoding, then decoded in bounded chunks to a staging file. Copied files and `/attach` remain path-backed in the draft; Noesis reads only a small header until submission. The selected file identity is checked before and during streamed immutable import. Changes, missing files, cancellation, and storage errors leave the draft unsent rather than silently substituting bytes. Retry-safe artifact paths avoid duplicating already imported originals.

SQLite messages and pending intents hold artifact references, not base64 copies. Queue restoration and generic-file history replay validate authoritative metadata without reopening all original contents. Original source files may be moved or deleted after successful admission. Large lists are represented by a bounded prompt summary plus a complete immutable JSONL manifest; the model can page or search that manifest and use existing bounded `files.read`/search tools for originals. No files are silently omitted, extracted, summarized, or truncated during storage admission.

Preview and inline model image projection are separate optional views, not attachment admission. PNG/JPEG/GIF/WebP previews use a serialized cancellable worker, a 16-megapixel/16,384-pixel dimension safety bound, and at most 320×160 output pixels. Queued preview jobs and retained payload bytes are bounded; obsolete jobs are cancelled. Unsafe or oversized images remain original-file attachments with a label instead of a preview.

Models with image support receive images that fit the inline working-set budget (at most eight inline image blocks, 10 MiB per image; 20 MiB shared by current input and retained history), and fit a conservative dimension-based context allowance. This allowance is not an estimate of provider billing. If an image cannot be safely inlined or the model lacks image support, Noesis explicitly tells the user and model; its original artifact path remains available. Exceeding an inline budget does not reject a file or require deleting attachments. These are execution-memory/projection bounds, not file admission caps.

Compaction retains file references and conversation text rather than binary images. Context inspection omits encoded image bytes and does not claim provider-specific image token estimates. Removing a draft item does not delete artifacts from previously admitted messages.

If a later file in a batch fails, earlier successful imports remain registered artifacts with activity provenance and session relationships; they are not silently deleted. Identical retries reuse their identities. Admission does not create a message until the full batch succeeds. Metadata-only restoration checks existence/type/length without rehashing every large generic file; digest verification occurs when an artifact is explicitly read for a bounded inline view.

Import cancellation stops preparation and streaming before publication. Once an immutable file is published, its metadata registration completes before cancellation is observed by the next batch step; this prevents deleting a path another request may reuse. This is a completion boundary, not a claim of filesystem/SQLite crash atomicity.
