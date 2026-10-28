import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

test("subagent lineage SQL admits foreground and nested origins but rejects forged parents", async () => {
  const sql = await readFile(
    new URL("../migrations/052_nested_subagent_lineage.sql", import.meta.url),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);
      CREATE TABLE foreground_turns (turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE codemode_executions (execution_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT);
      CREATE TABLE sub_agents (
        agent_id TEXT PRIMARY KEY, child_session_id TEXT NOT NULL, project_id TEXT NOT NULL,
        origin_session_id TEXT NOT NULL, origin_turn_id TEXT NOT NULL, origin_execution_id TEXT NOT NULL,
        parent_agent_id TEXT, status TEXT NOT NULL
      );
      CREATE TRIGGER sub_agent_lineage_insert BEFORE INSERT ON sub_agents BEGIN SELECT 1; END;
    `);
    database.exec(sql);
    const subagent = JSON.stringify({ kind: "subagent" });
    const session = database.prepare("INSERT INTO sessions VALUES (?, ?)");
    session.run("foreground", "{}");
    for (const id of ["parent-session", "child-session", "forged-session", "closed-session", "closed-child"])
      session.run(id, subagent);
    database.prepare("INSERT INTO foreground_turns VALUES ('turn', 'foreground')").run();
    const execution = database.prepare("INSERT INTO codemode_executions VALUES (?, ?, ?)");
    execution.run("foreground-execution", "foreground", "turn");
    execution.run("parent-execution", "parent-session", null);
    execution.run("closed-execution", "closed-session", null);
    const insert = database.prepare("INSERT INTO sub_agents VALUES (?, ?, 'project', ?, ?, ?, ?, ?)");

    insert.run("parent", "parent-session", "foreground", "turn", "foreground-execution", null, "running");
    insert.run("closed", "closed-session", "foreground", "turn", "foreground-execution", null, "closed");
    expect(() =>
      insert.run(
        "orphan",
        "forged-session",
        "foreground",
        "turn",
        "foreground-execution",
        "parent",
        "running",
      ),
    ).toThrow("lineage is invalid");
    expect(() =>
      insert.run(
        "wrong-turn",
        "forged-session",
        "parent-session",
        "task",
        "parent-execution",
        "parent",
        "running",
      ),
    ).toThrow("lineage is invalid");
    expect(() =>
      insert.run("late", "closed-child", "closed-session", "turn", "closed-execution", "closed", "running"),
    ).toThrow("lineage is invalid");
    expect(() =>
      insert.run("child", "child-session", "parent-session", "turn", "parent-execution", "parent", "running"),
    ).not.toThrow();
  } finally {
    database.close();
  }
});
