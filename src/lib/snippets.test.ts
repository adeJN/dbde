import { describe, expect, it } from "vitest";
import {
  BUILTIN_SNIPPETS,
  expandSnippet,
  filterSnippets,
  readSnippets,
  snippetError,
  snippetsFor,
  type Snippet,
} from "./snippets";

describe("snippets", () => {
  it("expands placeholders, choices, nested defaults and escapes", () => {
    expect(expandSnippet("SELECT ${2:*} FROM ${1:table};$0")).toBe(
      "SELECT * FROM table;",
    );
    expect(expandSnippet("${1|JOIN,LEFT JOIN|} b")).toBe("JOIN b");
    expect(expandSnippet("${3:idx_${1:t}_${2:c}}")).toBe("idx_t_c");
    expect(expandSnippet("cost \\$5 $1 ${2}")).toBe("cost $5  ");
    expect(expandSnippet("price $ x")).toBe("price $ x");
  });

  it("ships driver-specific built-ins with one prefix per driver", () => {
    for (const driver of ["postgres", "mysql", "sqlite"] as const) {
      const prefixes = snippetsFor(driver, []).map((s) => s.prefix);
      expect(new Set(prefixes).size).toBe(prefixes.length);
      for (const prefix of [
        "sel",
        "ins",
        "upd",
        "del",
        "join",
        "ct",
        "ci",
        "tx",
        "cte",
        "ups",
      ])
        expect(prefixes).toContain(prefix);
    }
    const names = (driver: "postgres" | "mysql" | "sqlite") =>
      snippetsFor(driver, []).map((s) => s.name);
    expect(names("postgres")).toContain("EXPLAIN ANALYZE");
    expect(names("mysql")).toContain("SHOW PROCESSLIST");
    expect(names("sqlite")).not.toContain("SHOW PROCESSLIST");
    expect(
      snippetsFor("mysql", []).find((s) => s.prefix === "ups")!.body,
    ).toContain("ON DUPLICATE KEY UPDATE");
    expect(
      snippetsFor("postgres", []).find((s) => s.prefix === "ups")!.body,
    ).toContain("ON CONFLICT");
    for (const snippet of BUILTIN_SNIPPETS)
      expect(snippetError(snippet), snippet.id).toBe("");
  });

  it("lists user snippets first and respects their driver limits", () => {
    const user: Snippet[] = [
      { id: "u1", name: "Mine", prefix: "mine", body: "SELECT 1" },
      {
        id: "u2",
        name: "PG only",
        prefix: "pgo",
        body: "SELECT 2",
        drivers: ["postgres"],
      },
    ];
    expect(snippetsFor("mysql", user)[0].id).toBe("u1");
    expect(snippetsFor("mysql", user).some((s) => s.id === "u2")).toBe(false);
    expect(snippetsFor("postgres", user).some((s) => s.id === "u2")).toBe(true);
    expect(
      filterSnippets(snippetsFor("postgres", user), "pg only").map((s) => s.id),
    ).toEqual(["u2"]);
  });

  it("validates user snippets and drops stored built-ins", () => {
    expect(snippetError({ name: "", prefix: "a", body: "x" })).toMatch(/name/);
    expect(snippetError({ name: "a", prefix: "1x", body: "x" })).toMatch(
      /prefix/,
    );
    expect(snippetError({ name: "a", prefix: "my-x", body: "x" })).toMatch(
      /prefix/,
    );
    expect(snippetError({ name: "a", prefix: "ok_1", body: " " })).toMatch(
      /body/,
    );
    expect(snippetError({ name: "a", prefix: "ok_1", body: "x" })).toBe("");
    expect(
      readSnippets([
        { id: "u", name: "a", prefix: "a", body: "b", builtin: true },
        { id: "builtin:sel", name: "a", prefix: "a", body: "b" },
        { id: "v", name: "a", prefix: "a", body: "b", drivers: ["oracle"] },
        "junk",
      ]),
    ).toEqual([
      { id: "u", name: "a", prefix: "a", body: "b", builtin: undefined },
    ]);
  });
});
