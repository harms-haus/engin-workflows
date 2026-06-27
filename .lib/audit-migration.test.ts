// ─── SPIR .lib audit-migration contract tests ───────────────────────────────
//
// TEST-FIRST spec for the migration:
//   "remove manual auditLog.append calls + clean up unused
//    structuredOutputEvent / decisionEvent imports"
//
// Before this migration each SPIR phase MANUALLY appended structured_output
// and decision events to the audit log:
//
//     await tracker.auditLog.append(structuredOutputEvent(agentId, output));
//     await tracker.auditLog.append(decisionEvent(agentId, decision, reasoning));
//
// The engine now ships a DEFAULT AUDITOR (`createDefaultAuditor`) that, once
// registered against the threaded `hookRegistry`, appends those SAME events
// automatically — fired by the engine's `runStepTask` / `runMultiStepTask` /
// `LanePool` observe-hook seams (`onStructuredOutput` / `onDecision`). The
// migration therefore:
//
//   1. DELETES every manual `auditLog.append(structuredOutputEvent(…))` and
//      `auditLog.append(decisionEvent(…))` call from the phase files.
//   2. REMOVES the now-unused `structuredOutputEvent` / `decisionEvent` imports
//      from `./helpers` in each phase file (the deferred task-12/task-17 cleanup).
//   3. THREADS `hookRegistry` (alongside the already-present `auditLog`) into
//      every LanePool / runStepTask / runMultiStepTask call so the engine's
//      auditor actually fires.
//   4. REGISTERS the default auditor ONCE at the workflow level (`runSpir`) so
//      BOTH the LanePool and the runStepTask / runMultiStepTask paths benefit.
//
// `errorEvent` is OUT OF SCOPE: the engine's default auditor covers only
// `structured_output` and `decision` events, so the final-review lane-failure
// `error` append (which has no engine equivalent) MUST stay.
//
// These tests pin the SOURCE-LEVEL contract by reading each phase file's text
// (mirroring the source-inspection pattern used in planning.test.ts for the
// prompt-inlining refactor). They need NO engine mock, so they do not collide
// with the per-phase test files' `mock.module('@harms-haus/engin-engine', …)`.
//
// They are RED against the pre-migration source and turn GREEN once the
// migration is applied. The per-phase test files carry the BEHAVIORAL
// counterparts (asserting `tracker.auditLog.append` is no longer invoked with
// structured_output / decision events at runtime).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Read a sibling source file's text (relative to this test file). */
function src(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf-8");
}

const SCOUTING = "./scouting.ts";
const PLANNING = "./planning.ts";
const IMPLEMENTATION = "./implementation.ts";
const FINAL_REVIEW = "./final-review.ts";
const SPIR = "./spir.ts";

/**
 * Assert `file`'s source contains `needle`. Fails with a CONCISE message
 * (just the file + needle) instead of dumping the whole file on mismatch.
 */
function expectContains(file: string, needle: string): void {
  expect(
    src(file).includes(needle),
    `${file} should contain ${JSON.stringify(needle)}`,
  ).toBe(true);
}

/** Assert `file`'s source does NOT contain `needle` (concise failure message). */
function expectNotContains(file: string, needle: string): void {
  expect(
    src(file).includes(needle),
    `${file} should NOT contain ${JSON.stringify(needle)}`,
  ).toBe(false);
}

/** Assert `file`'s source matches `pattern` (concise failure message). */
function expectMatches(file: string, pattern: RegExp): void {
  expect(pattern.test(src(file)), `${file} should match ${pattern}`).toBe(true);
}

/** Assert `file`'s source does NOT match `pattern` (concise failure message). */
function expectNotMatches(file: string, pattern: RegExp): void {
  expect(pattern.test(src(file)), `${file} should NOT match ${pattern}`).toBe(
    false,
  );
}

// ─── (1) Manual auditLog.append calls removed ──────────────────────────────

describe("migration: manual structured_output / decision auditLog.append calls removed", () => {
  it("scouting.ts makes zero manual auditLog.append calls", () => {
    // scouting.ts only ever appended structured_output (coordinator) and
    // decision (scouting-reviewer) — both are removed, so the symbols must
    // disappear entirely (no import, no usage, no append).
    expectNotContains(SCOUTING, "auditLog.append");
    expectNotContains(SCOUTING, "structuredOutputEvent");
    expectNotContains(SCOUTING, "decisionEvent");
  });

  it("planning.ts makes zero manual auditLog.append calls", () => {
    expectNotContains(PLANNING, "auditLog.append");
    expectNotContains(PLANNING, "structuredOutputEvent");
    expectNotContains(PLANNING, "decisionEvent");
  });

  it("final-review.ts drops the structured_output appends but keeps the error append", () => {
    // The two structuredOutputEvent appends (initial review + review-fixes)
    // are gone; decisionEvent was never imported here.
    expectNotContains(FINAL_REVIEW, "structuredOutputEvent");
    expectNotContains(FINAL_REVIEW, "decisionEvent");
    // No structured/decision appends remain …
    expectNotMatches(
      FINAL_REVIEW,
      /auditLog\.append\(\s*structuredOutputEvent/,
    );
    expectNotMatches(FINAL_REVIEW, /auditLog\.append\(\s*decisionEvent/);
    // … but the lane-failure error append MUST stay (no engine equivalent).
    expectMatches(FINAL_REVIEW, /auditLog\.append\(/);
  });
});

// ─── (2) Unused structuredOutputEvent / decisionEvent imports removed ───────

describe("migration: unused structuredOutputEvent / decisionEvent imports removed", () => {
  it("scouting.ts no longer imports structuredOutputEvent or decisionEvent", () => {
    expectNotMatches(SCOUTING, /from\s+["']\.\/helpers["']/);
    expectNotContains(SCOUTING, "structuredOutputEvent");
    expectNotContains(SCOUTING, "decisionEvent");
  });

  it("planning.ts no longer imports structuredOutputEvent or decisionEvent (and drops the task-17 TODO)", () => {
    expectNotMatches(PLANNING, /from\s+["']\.\/helpers["']/);
    expectNotContains(PLANNING, "structuredOutputEvent");
    expectNotContains(PLANNING, "decisionEvent");
    // The deferred-migration TODO is now resolved.
    expectNotContains(PLANNING, "TODO(task-17)");
  });

  it("final-review.ts drops structuredOutputEvent but KEEPS the errorEvent import", () => {
    expectNotContains(FINAL_REVIEW, "structuredOutputEvent");
    // errorEvent is still imported from ./helpers (the lane-failure path).
    expectContains(FINAL_REVIEW, "errorEvent");
    expectMatches(FINAL_REVIEW, /from\s+["']\.\/helpers["']/);
  });
});

// ─── (3) hookRegistry threaded into every engine primitive call ─────────────
//
// Each phase must thread `hookRegistry` (alongside `auditLog`) into its
// LanePool / runStepTask / runMultiStepTask calls so the default auditor's
// observe-hook subscribers actually fire. scouting / implementation /
// final-review currently reference `hookRegistry` nowhere — its appearance is
// the migration signal. planning already threads it (regression guard).

describe("migration: hookRegistry threaded into engine primitive calls", () => {
  it("scouting.ts references hookRegistry (singleSession coordinator/reviewer + scout RunnerPool)", () => {
    expectContains(SCOUTING, "hookRegistry");
  });

  it("final-review.ts references hookRegistry (reviewer runStepTask + fixer LanePool)", () => {
    expectContains(FINAL_REVIEW, "hookRegistry");
  });

  it("implementation.ts references hookRegistry (implementer LanePool)", () => {
    expectContains(IMPLEMENTATION, "hookRegistry");
  });

  it("planning.ts still references hookRegistry (regression guard for runMultiStepTask)", () => {
    expectContains(PLANNING, "hookRegistry");
  });
});

// ─── (3b) Pool constructions carry BOTH auditLog and hookRegistry ──────────
//
// After the B2/B4/B5 migrations, the phase files use RunnerPool instead of
// LanePool. Each RunnerPool construction must thread auditLog (for the
// auditor) and hookRegistry (for the engine's default auditor hooks).

describe("migration: Pool constructions carry auditLog + hookRegistry", () => {
  it("scouting.ts scout RunnerPool is wired with auditLog and hookRegistry", () => {
    // B2 migration: scouting.ts now uses RunnerPool (not LanePool).
    expectContains(SCOUTING, "new RunnerPool");
    expectContains(SCOUTING, "auditLog");
    expectContains(SCOUTING, "hookRegistry");
  });

  it("implementation.ts implementer RunnerPool is wired with auditLog and hookRegistry", () => {
    // B4 migration: implementation.ts uses RunnerPool (not LanePool).
    expectContains(IMPLEMENTATION, "new RunnerPool");
    expectContains(IMPLEMENTATION, "auditLog");
    expectContains(IMPLEMENTATION, "hookRegistry");
  });

  it("final-review.ts fixer RunnerPool is wired with auditLog and hookRegistry", () => {
    // B5 migration: final-review.ts uses RunnerPool (not LanePool).
    expectContains(FINAL_REVIEW, "new RunnerPool");
    expectContains(FINAL_REVIEW, "auditLog");
    expectContains(FINAL_REVIEW, "hookRegistry");
  });
});

// ─── (4) runSpir registers the default auditor at the workflow level ────────
//
// Registering ONCE in runSpir (against the threaded hookRegistry) means BOTH
// the LanePool path AND the runStepTask / runMultiStepTask path benefit — the
// auditor's `onStructuredOutput` / `onDecision` subscribers translate the
// engine's observe-hook fires into durable AuditLog events with no manual
// `auditLog.append` anywhere in the phase files.

describe("migration: runSpir registers the default auditor against the hookRegistry", () => {
  it("spir.ts imports createDefaultAuditor from the engine", () => {
    expectContains(SPIR, "createDefaultAuditor");
  });

  it("spir.ts registers onStructuredOutput + onDecision subscribers (the auditor)", () => {
    expectContains(SPIR, "createDefaultAuditor");
    expectContains(SPIR, "onStructuredOutput");
    expectContains(SPIR, "onDecision");
  });
});
