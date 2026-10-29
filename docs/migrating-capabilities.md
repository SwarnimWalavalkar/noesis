# Bring back your Capabilities after the reset

This release changes how Noesis stores learned Capabilities. Each Capability is now one readable Markdown file with its guidance and, at most, one saved script or workflow. Older Capabilities used a different format that this release cannot read, so the upgrade resets them. After you upgrade, Noesis starts with no learned Capabilities, and pending reflections and session reviews are dropped. Your sessions, saved Programs, and settings are not affected.

Your old Capability text is still on disk. The upgrade does not delete any files. You can find it under `~/.noesis/definitions/capabilities/`, or under `definitions/capabilities/` in your Noesis home if you use `--home` or `NOESIS_HOME`. There are two kinds of entries:

- Older Capabilities are folders named `capability_<id>`. Each folder holds one folder per revision, and each revision folder holds `instruction-*.md` files and sometimes `skills/*/SKILL.md` files. These files contain only the guidance text. They do not record the name or when the Capability applies.
- Newer Capabilities are files named `<name>-<id>.md`. Each file starts with `name`, `when`, and `description` fields, then the guidance, then notes that Noesis wrote below a marker line.

## Recreate them with Noesis

Start Noesis in a project and paste the prompt below. Noesis can publish one Capability decision per turn, so it recreates one Capability, lists what is left, and waits. Reply `next` to recreate the next one, and keep replying until it says nothing is left. You can stop at any time. Later, you can pause a recreated Capability in `/learning` or by asking Noesis, and you can edit its guidance in its file.

```text
Load the `noesis` skill. I want to bring back my learned Capabilities from the previous format.

1. Use `config.inspect` to find my Noesis home. With the shell, list everything under `<home>/definitions/capabilities/`, including subfolders.
2. Read each distinct Capability's latest guidance:
   - For each folder named `capability_<id>`, pick its newest revision folder by modification time (`ls -t`). Revision folder names do not show their order, so if a folder holds more than one revision folder, tell me which one you picked and wait for me to confirm before recreating it. Read every `instruction-*.md` file in it, and every `skills/*/SKILL.md` file if there are any. Join them into one guidance text.
   - For each `<name>-<id>.md` file, take `name`, `when`, and `description` from the frontmatter. The guidance is the text between the closing `---` of the frontmatter and the line that starts with `<!-- Noesis writes everything below this line`.
3. Skip any Capability whose guidance repeats or nearly repeats another one. Prefer the `.md` file, because it has a name and a `when` text. Use `capabilities.inspect` to skip anything that already exists in my current Capabilities with the same name or the same guidance.
4. Recreate the first remaining Capability with one `capabilities.refine` call. Ask `noesis.describe("capabilities.refine")` for the exact schema first. Use a `create` decision:
   - `name`: the original name. For an old folder with no name, write a short name from the guidance.
   - `applicability`: the original `when` text, or one line that says when the guidance applies.
   - `description`: the original description, or one line that sums up the guidance.
   - `effects`: one `instruction` effect whose `content` is the guidance, unchanged.
   - `summary`: "Migrated from the previous Capability format."
   - `rationale` and `anticipatedEffect`: one short sentence each.
   - `scope`: `global`, unless the guidance names a saved script or workflow of this project. In that case use `current_project` and also attach that saved Program as a `program` effect if `programs` lists it.
   - `activationMode`: `relevant`, unless the guidance clearly must apply to every turn. Then use `always`, but only if the guidance is at most 2,000 characters.
   - `consequence`: `ordinary`, with a `consequenceDescription` that says only model guidance changes.
   - `evidence`: kind `explicit_request`, quote my exact words "I want to bring back my learned Capabilities from the previous format.", and a `wouldOtherwise` that says I would have to repeat this guidance.
5. Report what you recreated and what you skipped, with the reason for each skip. List the Capabilities that are still left. When I reply `next`, repeat steps 3 to 5 for the next one.
```

## What the upgrade removed

The upgrade removed every learned Capability, its revisions, its track record of helped and hurt results, its feedback, and its pending gates. It also removed reflections and session reviews that had not finished, and the history of earlier subagents. Finished reflections stay visible in `/learning`, and the learning report still counts finished reflections and session reviews.
