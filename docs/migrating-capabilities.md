# Bring back Capabilities from Noesis 0.0.5 and earlier

Noesis stores each learned Capability as one readable Markdown file. The file holds the Capability's guidance, and the Capability can also attach one saved script or workflow. Noesis 0.0.5 and earlier stored Capabilities in a different format. Later versions cannot read that format, so the first time a later version opens your Noesis home, it removes the old Capabilities from its database. Noesis then starts with no learned Capabilities.

The reset does not delete any files, so your old Capability text is still on disk. This guide explains what the reset keeps and removes, where to find the old text, and how to have Noesis recreate each Capability in the current format.

## Who needs this guide

You need this guide if you had learned Capabilities in Noesis 0.0.5 or earlier. You also need it if you ran a development build from the source repository that stored Capabilities as Markdown files before the reset was added.

If you never had learned Capabilities, or you started with a version later than 0.0.5, you do not need this guide.

## What the reset keeps and removes

The reset keeps your sessions and their history, your saved scripts and workflows, your settings, and every file on disk.

The reset removes every learned Capability, along with its revisions, its record of turns it helped or hurt, its feedback, and its pending approvals. It also removes reflections and session reviews that had not finished, and the history of subagents from earlier sessions. Finished reflections stay visible in `/learning`, and the learning report (`noesis learning report`) still counts finished reflections and session reviews.

## Where your old Capability text is

Old Capabilities are under `~/.noesis/definitions/capabilities/`. If you use `--home` or `NOESIS_HOME`, they are under `definitions/capabilities/` in that Noesis home. You may find two kinds of entries:

- Folders named `capability_<id>`. Noesis 0.0.5 and earlier wrote these. Each folder holds one folder per revision. Each revision folder holds `instruction-*.md` files, and sometimes `skills/*/SKILL.md` files. These files contain only the guidance text. They do not record the Capability's name or when it applies.
- Files named `<name>-<id>.md`. Development builds wrote these before the reset. Each file starts with `name`, `when`, and `description` fields, then the guidance, then notes that Noesis wrote below a marker line.

## Recreate your Capabilities

Start Noesis in a project and paste the prompt below. Noesis can make one Capability change per turn, so it recreates one Capability, lists what is left, and waits for you. Reply `next` to recreate the next one, and keep replying until it says nothing is left. You can stop at any time.

If an old Capability has more than one revision folder, Noesis tells you which revision it picked and waits for you to confirm, because the folder names do not show their order.

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

After you recreate a Capability, you can pause it in `/learning` or by asking Noesis, and you can edit its guidance in its Markdown file.
