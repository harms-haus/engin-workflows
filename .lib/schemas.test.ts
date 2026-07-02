import { describe, expect, it } from "bun:test";
import {
  RetrospectiveDecisionSchema,
  type FinalReviewFinding,
} from "./schemas";

// ─── Factory helpers ─────────────────────────────────────────────────────────

const finding = (overrides: Partial<FinalReviewFinding> = {}) => ({
  id: "f1",
  severity: "medium" as const,
  file: "src/a.ts",
  title: "t",
  description: "d",
  fixPrompt: "fix",
  ...overrides,
});

// ─── RetrospectiveDecisionSchema ─────────────────────────────────────────────

describe("RetrospectiveDecisionSchema", () => {
  it("parses a well-formed object and returns it", () => {
    const input = {
      terminate: true,
      applicable: true,
      summary: "All clean after fixes",
      findings: [finding()],
      resolvedFindings: [],
      regressions: [],
    };
    const result = RetrospectiveDecisionSchema.parse(input);
    expect(result).toEqual(input);
  });

  it("throws when a required field (terminate) is missing", () => {
    const input = {
      applicable: true,
      summary: "s",
      findings: [],
      resolvedFindings: [],
      regressions: [],
    };
    expect(() => RetrospectiveDecisionSchema.parse(input)).toThrow();
  });

  it("rejects an invalid severity enum value in a finding", () => {
    const input = {
      terminate: true,
      applicable: true,
      summary: "s",
      findings: [finding({ severity: "bogus" } as any)],
      resolvedFindings: [],
      regressions: [],
    };
    expect(() => RetrospectiveDecisionSchema.parse(input)).toThrow();
  });

  it("accepts empty arrays for findings, resolvedFindings, and regressions", () => {
    const input = {
      terminate: false,
      applicable: false,
      summary: "Not applicable",
      findings: [],
      resolvedFindings: [],
      regressions: [],
    };
    const result = RetrospectiveDecisionSchema.parse(input);
    expect(result.findings).toEqual([]);
    expect(result.resolvedFindings).toEqual([]);
    expect(result.regressions).toEqual([]);
  });

  it("strips extra fields (matching FinalReviewResultSchema behavior — no .strict())", () => {
    const input = {
      terminate: true,
      applicable: true,
      summary: "s",
      findings: [],
      resolvedFindings: [],
      regressions: [],
      extraField: "should be stripped",
    };
    const result = RetrospectiveDecisionSchema.parse(input);
    expect(result).not.toHaveProperty("extraField");
  });

  it("round-trips a full object with populated finding arrays", () => {
    const input = {
      terminate: false,
      applicable: true,
      summary: "Two findings remain, one resolved, one regression",
      findings: [
        finding({ id: "f1", severity: "high" as const }),
        finding({ id: "f2", severity: "medium" as const }),
      ],
      resolvedFindings: [finding({ id: "f3", severity: "low" as const })],
      regressions: [finding({ id: "f4", severity: "critical" as const })],
    };
    const result = RetrospectiveDecisionSchema.parse(input);
    expect(result.findings).toHaveLength(2);
    expect(result.resolvedFindings).toHaveLength(1);
    expect(result.regressions).toHaveLength(1);
    expect(result.terminate).toBe(false);
  });
});
