import { describe, expect, it } from "vitest";
import { EX_USAGE, UsageError, parseArgs } from "../src/cli/args.js";

describe("parseArgs", () => {
  it("parses every flag and passes the command through verbatim", () => {
    const parsed = parseArgs([
      "--tdd-phase=red",
      "--format",
      "json",
      "--max-clusters",
      "3",
      "--context-lines=4",
      "--scope-id",
      "s01",
      "--no-jev",
      "--retry-flakes",
      "--",
      "vitest",
      "run",
      "--reporter=verbose",
    ]);
    expect(parsed).toEqual({
      kind: "run",
      options: {
        tddPhase: "red",
        format: "json",
        maxClusters: 3,
        contextLines: 4,
        scopeId: "s01",
        noJev: true,
        retryFlakes: true,
      },
      command: ["vitest", "run", "--reporter=verbose"],
    });
  });

  it("applies defaults when no flags are given", () => {
    const parsed = parseArgs(["--", "true"]);
    expect(parsed).toMatchObject({
      kind: "run",
      options: { tddPhase: "none", format: "compact-md", maxClusters: 5, contextLines: 2 },
      command: ["true"],
    });
  });

  it("recognises --help and --version", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });

  it("rejects an unknown flag with EX_USAGE", () => {
    expect(() => parseArgs(["--wat"])).toThrow(UsageError);
    try {
      parseArgs(["--wat"]);
    } catch (error) {
      expect((error as UsageError).exitCode).toBe(EX_USAGE);
    }
  });

  it("rejects a missing -- delimiter", () => {
    expect(() => parseArgs(["vitest", "run"])).toThrow(/--/);
  });

  it("rejects maxClusters above 15", () => {
    expect(() => parseArgs(["--max-clusters", "16", "--", "true"])).toThrow(/max-clusters/);
  });

  it("rejects a missing flag value", () => {
    expect(() => parseArgs(["--format", "--", "true"])).toThrow(/format/);
  });

  it("rejects an invalid enum value", () => {
    expect(() => parseArgs(["--tdd-phase", "blue", "--", "true"])).toThrow(/tdd-phase/);
  });
});
