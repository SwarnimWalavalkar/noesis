import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

test("attachment intent SQL rejects embedded-NUL digests and delivered attachment copies", async () => {
  const sql = await readFile(new URL("../migrations/050_composer_attachments.sql", import.meta.url), "utf8");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    const definition = sql.split("INSERT INTO user_intents_with_attachments")[0];
    if (!definition) throw new Error("Missing migration table definition");
    database.exec(definition);
    const insert = database.prepare(`INSERT INTO user_intents_with_attachments
      (intent_id,session_id,text,attachments_json,content_digest,delivery_mode,status,queue_sequence,target_turn_id,created_at,updated_at,delivered_at)
      VALUES (?,?,?,?,?,'turn',?,?,?,?,?,?)`);
    const digest = "a".repeat(64);
    expect(() =>
      insert.run(
        "nul",
        "session",
        "pending",
        "[]",
        digest + "\0suffix",
        "pending",
        1,
        null,
        "now",
        "now",
        null,
      ),
    ).toThrow("CHECK constraint");
    expect(() =>
      insert.run(
        "retained",
        "session",
        null,
        '[{"artifact":"retained"}]',
        digest,
        "delivered",
        2,
        "turn",
        "now",
        "now",
        "now",
      ),
    ).toThrow("CHECK constraint");
    expect(() =>
      insert.run("cleared", "session", null, "[]", digest, "delivered", 3, "turn", "now", "now", "now"),
    ).not.toThrow();
  } finally {
    database.close();
  }
});
