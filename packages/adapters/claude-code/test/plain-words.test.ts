// plainWords decides whether an unjoined worktree's Bash command can be THE join (see
// unjoinedAllows): it must return undefined for every spelling a shell would rewrite, so that an
// expansion, an operator or a quoting trick can never be read as the literal join command.
import { describe, expect, it } from "vitest";
import { plainWords } from "../src/cli";

describe("plainWords", () => {
  it("splits bare, single-quoted and double-quoted words", () => {
    expect(plainWords("weft install --dir /a/b")).toEqual(["weft", "install", "--dir", "/a/b"]);
    expect(plainWords(`a 'b c' "d e"`)).toEqual(["a", "b c", "d e"]);
    expect(plainWords(`'' ""`)).toEqual(["", ""]);
    expect(plainWords("  a\tb  ")).toEqual(["a", "b"]);
    expect(plainWords("")).toEqual([]);
  });

  it.each([
    ["; (command separator)", "weft install --dir /a; rm -rf /a"],
    ["& (background / &&)", "weft install --dir /a && rm x"],
    ["| (pipe / ||)", "weft install --dir /a | tee x"],
    ["` (command substitution)", "weft install --dir `pwd`"],
    ["$ (variable)", "weft install --dir $PWD"],
    ["$ inside double quotes", `weft install --dir "$HOME/x"`],
    ["$ inside single quotes (still refused)", "weft install --task '$x'"],
    ["${...} expansion", "weft install --dir ${HOME:-/x}"],
    ["$(...) substitution", "weft install --task $(id -u)"],
    ["< (redirect in)", "weft install --dir /a < f"],
    ["> (redirect out)", "weft install --dir /a > f"],
    ["( (subshell)", "(weft install --dir /a)"],
    [") (subshell end)", "weft install --dir /a)"],
    ["\\n (second line)", "weft install --dir /a\nrm x"],
    ["\\r (carriage return)", "weft install --dir /a\rrm x"],
    ["\\ (escape)", "weft install --dir /a\\ b"],
    ["\\ inside quotes", `weft install --dir "/a\\"b"`],
  ])("refuses %s", (_what, command) => {
    expect(plainWords(command)).toBeUndefined();
  });

  it.each([
    ["an unbalanced single quote", "weft install --dir '/a"],
    ["an unbalanced double quote", `weft install --dir "/a`],
    ["a trailing lone quote", "weft install '"],
    ["a quote glued to a bare word", "weft install --dir /a'b'"],
    ["a bare word glued to a closing quote", "weft install --dir 'a'b"],
    ["two quoted parts in one word", `weft install --dir 'a'"b"`],
    ["mixed quotes inside one word", `weft install --task "a'b`],
  ])("refuses %s", (_what, command) => {
    expect(plainWords(command)).toBeUndefined();
  });
});
