import { describe, expect, it } from "vitest";
import { isInteractive } from "../../../src/cli/interactive.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };
const unset = {};

describe("isInteractive", () => {
  it("is true only when both stdin and stdout are terminals and CI is not set", () => {
    expect(isInteractive({}, tty, tty)).toBe(true);
  });

  it.each([
    ["stdout piped", {}, tty, pipe],
    ["stdin piped", {}, pipe, tty],
    ["neither a terminal", {}, pipe, pipe],
    ["isTTY undefined", {}, unset, unset],
  ])("is false when %s", (_name, env, stdin, stdout) => {
    expect(isInteractive(env, stdin, stdout)).toBe(false);
  });

  it.each(["true", "1", "yes", "TRUE", "github"])("is false for CI=%s", (ci) => {
    expect(isInteractive({ CI: ci }, tty, tty)).toBe(false);
  });

  it.each(["", "0", "false", "FALSE"])("treats CI=%j as not CI", (ci) => {
    expect(isInteractive({ CI: ci }, tty, tty)).toBe(true);
  });
});
