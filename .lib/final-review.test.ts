// ─── Final Review Phase Tests (kb-16: B5 migration) ────────────────────────
//
// Tests for final-review.ts: the migrated per-lane multi-dimensional review
// that uses RunnerPool + singleSession + linearRunner instead of the old
// runStepTask + LanePool pattern.
//
// Each reviewer lane runs as a task submitted to a RunnerPool. The pool's
// getRunnerForTask returns singleSession(reviewSpec) for review passes.
// Fixer tasks use a separate RunnerPool whose getRunnerForTask returns a
// linearRunner of singleSession wrappers (one per fixer step).
//
// The old runStepTask and LanePool imports MUST be absent; runStepTask MUST
// never be called and LanePool MUST never be constructed.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, jest, mock, beforeEach } from "bun:test";
import { createEnginMock } from "./engin-mock";
import type {
  FinalReviewResult,
  FinalReviewFinding,
  FinalReviewSeverity,
} from "./schemas";

// ─── Mock @harms-haus/engin (new pool-based pattern) ─────────────────────
//
// We mock via createEnginMock() then override with per-test spies for:
//   - RunnerPool (replaces LanePool)
//   - singleSession (replaces runStepTask for review passes)
//   - linearRunner (wraps fixer step sessions)
//   - getDiff / TaskTracker (unchanged usage)
//
// The old symbols (runStepTask, LanePool) are STILL provided in the mock
// because the production code has NOT been migrated yet — removing them
// would crash the import. The assertions below verify they are NEVER called.

// ── RunnerPool mock ──────────────────────────────────────────────────────
const mockPoolRun =
  jest.fn<() => Promise<{ completedTasks: number; failedTasks: number }>>();
mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });

const MockRunnerPool =
  jest.fn<(...args: unknown[]) => { run: typeof mockPoolRun }>();
(MockRunnerPool as unknown as ReturnType<typeof jest.fn>).mockImplementation(
  () => ({
    run: mockPoolRun,
  }),
);

// ── singleSession mock ───────────────────────────────────────────────────
// singleSession(spec) returns a Runner (async function). The runner calls
// ctx.runSession so that runSingleSessionStructured can capture the structured
// SessionResult via its wrapped runSession.
const mockSingleSession =
  jest.fn<(spec: any) => (ctx: any) => Promise<unknown>>();
mockSingleSession.mockImplementation((spec: any) => {
  return async (ctx: any) => {
    await ctx.runSession({
      spec: {
        id: `${ctx.task?.id ?? "test"}/${spec.role}#${spec.attempt ?? 1}`,
        profile: spec.profile,
        prompt: spec.prompt,
        ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
        outputMode: spec.outputMode ?? "text",
        ...(spec.isReadOnly !== undefined
          ? { isReadOnly: spec.isReadOnly }
          : {}),
        runnerRole: spec.role,
        attempt: spec.attempt ?? 1,
      },
      sessionBaseDir: ctx.sessionBaseDir,
      cwd: ctx.cwd,
      phaseId: ctx.phaseId,
      agentId: ctx.agentId,
      profiles: ctx.profiles,
      signal: ctx.signal ?? new AbortController().signal,
      activeSessions: ctx.activeSessions ?? new Set(),
    });
    return { status: "completed" };
  };
});

// ── runSession mock ──────────────────────────────────────────────────────
// runSession is the session primitive called inside the singleSession runner.
// Tests override this to control the structured data that reviewers produce.
const mockRunSession = jest.fn().mockResolvedValue({ mode: "text", text: "" });

// ── linearRunner mock ────────────────────────────────────────────────────
// linearRunner(children: Runner[]) returns a Runner.
const mockLinearRunner =
  jest.fn<(...args: unknown[]) => (...args: unknown[]) => Promise<unknown>>();
const mockLinearRunnerResult = jest
  .fn<() => Promise<{ status: string }>>()
  .mockResolvedValue({ status: "completed" });
mockLinearRunner.mockReturnValue(mockLinearRunnerResult);

// ── Old-symbol stubs (needed for pre-migration production code import) ───
// Default implementation: return a clean result so old code doesn't crash.
const mockRunStepTask = jest.fn<(opts: any) => Promise<unknown>>();

const mockGetDiff = jest
  .fn<() => string>()
  .mockReturnValue("MOCK-DIFF-CONTENT");
const mockAddTask = jest.fn<(task: any) => void>();
const mockGetAllTasks =
  jest.fn<() => { id: string; status: string; result?: unknown }[]>();
const MockTaskTracker = jest.fn().mockImplementation(() => ({
  addTask: mockAddTask,
  getAllTasks: mockGetAllTasks,
}));
const MockLanePool = jest.fn().mockImplementation(() => ({
  run: jest.fn().mockResolvedValue({ completedTasks: 0, failedTasks: 0 }),
}));

// Default mock implementation: return clean result so tests that assert
// new behavior can run without old-code crashes.
mockRunStepTask.mockImplementation(async (opts: any) => {
  const dimension = (opts.profileId as string).replace(/-reviewer$/, "");
  return {
    dimension,
    applicable: true,
    notApplicableReason: "",
    summary: "No issues found",
    findings: [],
  } satisfies FinalReviewResult;
});

mock.module("@harms-haus/engin-engine", () => ({
  ...createEnginMock(),
  // New pool-based exports (the target)
  RunnerPool: MockRunnerPool,
  singleSession: mockSingleSession,
  linearRunner: mockLinearRunner,
  runSession: mockRunSession,
  // Old exports — still provided so pre-migration source can import,
  // but assertions verify they are never called by finalReviewPhase.
  runStepTask: mockRunStepTask,
  LanePool: MockLanePool,
  TaskTracker: MockTaskTracker,
  getDiff: mockGetDiff,
}));

// Dynamic import to ensure mock is applied first
const { finalReviewPhase, DEFAULT_FINAL_REVIEWERS, isActionableSeverity } =
  await import("./final-review");
const { FinalReviewResultSchema } = await import("./schemas");

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_DIMENSIONS = [
  "efficiency",
  "code-quality",
  "ui-ux",
  "security",
  "documentation",
] as const;
const DEFAULT_PROFILE_IDS = DEFAULT_DIMENSIONS.map((d) => `${d}-reviewer`);
const EXPECTED_REVIEWER_COUNT = DEFAULT_FINAL_REVIEWERS.length; // 5
const MAX_FIX_ROUNDS = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockTracker() {
  return {
    auditLog: {
      append: jest.fn().mockResolvedValue(undefined),
    },
  } as never;
}

function makeCleanResult(dimension: string): FinalReviewResult {
  return {
    dimension,
    applicable: true,
    notApplicableReason: "",
    summary: "No issues found",
    findings: [],
  };
}

function makeNotApplicable(
  dimension: string,
  reason = "Not relevant to these changes",
): FinalReviewResult {
  return {
    dimension,
    applicable: false,
    notApplicableReason: reason,
    summary: "Dimension not applicable",
    findings: [],
  };
}

function makeFinding(
  severity: FinalReviewSeverity,
  overrides: Partial<FinalReviewFinding> = {},
): FinalReviewFinding {
  return {
    id: overrides.id ?? `finding-${severity}`,
    severity,
    file: overrides.file ?? "src/main.ts",
    title: overrides.title ?? `${severity} issue`,
    description:
      overrides.description ?? "A problem was found that needs fixing.",
    fixPrompt: overrides.fixPrompt ?? "Apply the targeted fix to src/main.ts.",
    ...overrides,
  };
}

function makeResultWithFindings(
  dimension: string,
  findings: FinalReviewFinding[],
): FinalReviewResult {
  return {
    dimension,
    applicable: true,
    notApplicableReason: "",
    summary: `${findings.length} finding(s)`,
    findings,
  };
}

function dimensionOfProfileId(profileId: string): string {
  return profileId.replace(/-reviewer$/, "");
}

beforeEach(() => {
  // Reset all mocks
  MockRunnerPool.mockClear();
  mockPoolRun.mockClear();
  mockSingleSession.mockClear();
  mockRunSession.mockClear();
  mockLinearRunner.mockClear();
  mockLinearRunnerResult.mockClear();
  mockRunStepTask.mockClear();
  MockLanePool.mockClear();
  mockAddTask.mockClear();
  mockGetAllTasks.mockClear();
  mockGetDiff.mockClear();
  MockTaskTracker.mockClear();

  // Default: mockRunSession returns clean structured results for reviewer
  // profiles, so all lanes finish clean by default.
  mockRunSession.mockImplementation(async (sctx: any) => {
    const profile = sctx.spec?.profile;
    if (
      profile &&
      typeof profile === "string" &&
      profile.endsWith("-reviewer")
    ) {
      const dimension = profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    }
    return { mode: "text", text: "" };
  });

  // Default: mockRunStepTask returns clean result per reviewer (kept for
  // completeness; the migrated code must never call it).
  mockRunStepTask.mockImplementation(async (opts: any) => {
    const dimension = (opts.profileId as string).replace(/-reviewer$/, "");
    return makeCleanResult(dimension);
  });

  // Pool run succeeds by default
  mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
  mockLinearRunnerResult.mockResolvedValue({ status: "completed" });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. OLD SYMBOLS ARE NOT USED
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — old symbols not used", () => {
  it("does NOT call runStepTask (old reviewer path is gone)", async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/work", 5);
    // runStepTask must NOT be called by the migrated code.
    // FAILS with current code (calls runStepTask 5 times).
    expect(mockRunStepTask).not.toHaveBeenCalled();
  });

  it("does NOT construct a LanePool even when there are actionable findings", async () => {
    const tracker = makeMockTracker();
    // Make first lane return findings so the code would normally
    // construct a fixer pool.
    mockRunSession.mockImplementation(async (sctx: any) => {
      if (sctx.spec.profile === "efficiency-reviewer") {
        return {
          mode: "structured",
          data: makeResultWithFindings("efficiency", [makeFinding("critical")]),
        };
      }
      const dimension = sctx.spec.profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    });

    await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/work", 5);
    // LanePool must NOT be constructed even when fixers are needed.
    expect(MockLanePool).not.toHaveBeenCalled();
  });
});

// NOTE: The reviewer-level RunnerPool that these tests previously asserted
// was removed in the kb-16 cleanup — it was dead code (zero tasks added).
// Reviewer passes now run via runSingleSessionStructured directly, without
// a wrapping RunnerPool. The fixer RunnerPool is still constructed per-lane
// when there are actionable findings and is tested below.

// ═══════════════════════════════════════════════════════════════════════════
// 3. CLEAN ASSESSMENT
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — clean assessment", () => {
  it("returns true when all reviewers are clean", async () => {
    const tracker = makeMockTracker();
    // With mocked runStepTask returning clean results, old code returns true.
    // After migration, RunnerPool + singleSession should also return true.
    // (Expected: true, actual with OLD code: true)
    const result = await finalReviewPhase(
      tracker,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
    );
    // This test MUST pass to preserve the contract.
    expect(result).toBe(true);
  });

  it("does NOT manually append structured_output for reviewer results (the default auditor handles it)", async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const tracker = { auditLog: { append } } as never;
    await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/work", 5);

    // The audit migration deleted manual structured_output appends.
    // With the engine mocked here no auditor fires, so append must
    // NOT receive a structured_output event.
    expect(append).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "structured_output" }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. FIXER RUNNERPOOL (replaces LanePool)
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — fixer RunnerPool replaces LanePool", () => {
  // Shared setup: one lane returns findings so fixers are triggered.
  function setupEfficiencyFindings() {
    mockRunSession.mockImplementation(async (sctx: any) => {
      if (sctx.spec.profile === "efficiency-reviewer") {
        return {
          mode: "structured",
          data: makeResultWithFindings("efficiency", [makeFinding("critical")]),
        };
      }
      const dimension = sctx.spec.profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    });
  }

  it("does NOT use LanePool for fixers — uses RunnerPool with getRunnerForTask returning linearRunner", async () => {
    const tracker = makeMockTracker();
    setupEfficiencyFindings();

    await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/work", 5);

    // LanePool must NOT be constructed
    expect(MockLanePool).not.toHaveBeenCalled();
    // RunnerPool should be constructed (at least once for reviewers,
    // and a second time for fixers)
    expect(MockRunnerPool).toHaveBeenCalled();
  });

  it("creates fixer tasks and submits them to a RunnerPool with linearRunner per fixerStep", async () => {
    const tracker = makeMockTracker();
    setupEfficiencyFindings();

    await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/work", 5);

    // linearRunner is called to wrap fixer steps.
    expect(mockLinearRunner).toHaveBeenCalled();
  });

  it("linearRunner is called with an array of runners from singleSession (one per fixer step)", async () => {
    const tracker = makeMockTracker();
    setupEfficiencyFindings();

    await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/work", 5);

    expect(mockLinearRunner).toHaveBeenCalled();
    const children = mockLinearRunner.mock.calls[0][0] as unknown[];
    expect(Array.isArray(children)).toBe(true);
    // Each child should be a runner (function) created by singleSession
    for (const child of children) {
      expect(typeof child).toBe("function");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. PER-LANE LOOP BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — per-lane loop behavior", () => {
  it("returns true when all lanes are clean", async () => {
    const tracker = makeMockTracker();
    const result = await finalReviewPhase(
      tracker,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
    );
    expect(result).toBe(true);
  });

  it("returns false if ANY lane stays dirty (even if others are clean)", async () => {
    const tracker = makeMockTracker();
    // One lane returns findings but never resolves (exhausts MAX_FIX_ROUNDS)
    mockRunSession.mockImplementation(async (sctx: any) => {
      if (sctx.spec.profile === "efficiency-reviewer") {
        return {
          mode: "structured",
          data: makeResultWithFindings("efficiency", [makeFinding("critical")]),
        };
      }
      const dimension = sctx.spec.profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    });

    const result = await finalReviewPhase(
      tracker,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
    );
    expect(result).toBe(false);
  });

  it("gives up on a lane after MAX_FIX_ROUNDS and returns false", async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockImplementation(async (sctx: any) => {
      if (sctx.spec.profile === "efficiency-reviewer") {
        return {
          mode: "structured",
          data: makeResultWithFindings("efficiency", [makeFinding("critical")]),
        };
      }
      const dimension = sctx.spec.profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    });

    const result = await finalReviewPhase(
      tracker,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
    );
    expect(result).toBe(false);
  });

  it("a clean lane does NOT trigger any fixer or review-fixes pass", async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/work", 5);
    // When migrated, clean lanes should not add fixer tasks to the pool.
    // Only 5 review sessions ran (one per reviewer), no fixer or review-fixes.
    const reviewerSessions = mockRunSession.mock.calls.filter(
      (c: any) =>
        typeof c[0]?.spec?.profile === "string" &&
        c[0].spec.profile.endsWith("-reviewer"),
    );
    expect(reviewerSessions).toHaveLength(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. REVIEWER HISTORY IS PASSED ON RE-REVIEW
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — passes full prior-pass history to reviewers", () => {
  it("initial-review prompts contain NO history; verify prompts DO", async () => {
    const tracker = makeMockTracker();
    // One lane returns a finding so it triggers a review-fixes pass.
    mockRunSession.mockImplementation(async (sctx: any) => {
      if (sctx.spec.profile === "efficiency-reviewer") {
        return {
          mode: "structured",
          data: makeResultWithFindings("efficiency", [makeFinding("critical")]),
        };
      }
      const dimension = sctx.spec.profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    });

    await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/work", 5);

    // After migration: initial-review sessions have no "PRIOR REVIEW HISTORY"
    // in their prompt; verify sessions do.
    const allCalls = mockRunSession.mock.calls.map((c: any) => c[0]);
    const prompts = allCalls.map((c: any) => c.spec.prompt as string);
    const initialPrompts = prompts.filter(
      (p) => !p.includes("PRIOR REVIEW HISTORY"),
    );
    const verifyPrompts = prompts.filter((p) =>
      p.includes("PRIOR REVIEW HISTORY"),
    );

    // Initial calls should have no history
    expect(initialPrompts.length).toBeGreaterThan(0);
    // Verify call should have history
    expect(verifyPrompts.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. CUSTOM REVIEWER SET
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — custom finalReviewers", () => {
  it("runs exactly the supplied reviewers (not the defaults)", async () => {
    const tracker = makeMockTracker();
    const custom = [
      { profileId: "a-reviewer", dimension: "a", label: "A" },
      { profileId: "b-reviewer", dimension: "b", label: "B" },
    ];

    await finalReviewPhase(
      tracker,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
      undefined,
      undefined,
      undefined,
      custom,
    );

    // With migrated code, only 2 runSession calls (one per custom reviewer via runSingleSessionStructured)
    expect(mockRunSession).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. PURE HELPERS (unchanged by migration)
// ═══════════════════════════════════════════════════════════════════════════

describe("isActionableSeverity", () => {
  it("returns true for medium, high, critical", () => {
    expect(isActionableSeverity("medium")).toBe(true);
    expect(isActionableSeverity("high")).toBe(true);
    expect(isActionableSeverity("critical")).toBe(true);
  });

  it("returns false for low", () => {
    expect(isActionableSeverity("low")).toBe(false);
  });
});

describe("DEFAULT_FINAL_REVIEWERS", () => {
  it("contains the five expected reviewers", () => {
    const byDim = Object.fromEntries(
      DEFAULT_FINAL_REVIEWERS.map((r) => [r.dimension, r]),
    );
    expect(Object.keys(byDim).sort()).toEqual([
      "code-quality",
      "documentation",
      "efficiency",
      "security",
      "ui-ux",
    ]);
    expect(byDim.efficiency.profileId).toBe("efficiency-reviewer");
    expect(byDim["code-quality"].profileId).toBe("code-quality-reviewer");
    expect(byDim["ui-ux"].profileId).toBe("ui-ux-reviewer");
    expect(byDim.security.profileId).toBe("security-reviewer");
    expect(byDim.documentation.profileId).toBe("documentation-reviewer");
  });
});

// NOTE: The reviewer-level RunnerPool sessionBaseDir assertion was removed
// in the kb-16 cleanup — the dead reviewer RunnerPool was removed. Fixer
// RunnerPools per-lane still receive sessionBaseDir (tested in the fixer
// pool section above).

// ═══════════════════════════════════════════════════════════════════════════
// 10. LANE ISOLATION (one flaky reviewer must not abort the run)
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — lane isolation on reviewer failure", () => {
  it("a throwing reviewer does NOT abort the run; the lane is not-clean and the others still run", async () => {
    const tracker = makeMockTracker();
    // Make one reviewer throw in its runSession call
    mockRunSession.mockImplementation(async (sctx: any) => {
      if (sctx.spec.profile === "ui-ux-reviewer") {
        throw new Error("Failed to produce structured output");
      }
      const dimension = sctx.spec.profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    });

    const result = await finalReviewPhase(
      tracker,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
    );
    expect(result).toBe(false);
    // Other reviewers still ran (all 5 lanes attempted their session; one threw)
    expect(mockRunSession).toHaveBeenCalledTimes(EXPECTED_REVIEWER_COUNT);
  });

  it("audit-logs the lane failure as an error event and fires onError", async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const tracker = { auditLog: { append } } as never;
    const onError = jest.fn();
    const onStatus = { onError } as never;

    mockRunSession.mockImplementation(async (sctx: any) => {
      if (sctx.spec.profile === "security-reviewer") {
        throw new Error("boom: no JSON");
      }
      const dimension = sctx.spec.profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    });

    const result = await finalReviewPhase(
      tracker,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
      undefined,
      onStatus,
    );
    expect(result).toBe(false);

    // Lane error is logged
    const failures = append.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e.type === "error");
    expect(failures).toHaveLength(1);
    expect(failures[0].agentId).toBe("security-reviewer");
    expect(failures[0].error).toContain("boom: no JSON");

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].agentId).toBe("security-reviewer");
    expect(onError.mock.calls[0][0].phaseId).toBe("review");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. RESUME VIA REPLAY — singleSession sessions are persisted
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — resume via replay", () => {
  it("uses deterministic session IDs via singleSession so persisted sessions can be replayed", async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/work", 5);

    // FAILS: old code does not call singleSession.
    expect(mockSingleSession).toHaveBeenCalled();
    // After migration, singleSession is called with a `role` that follows
    // the deterministic ID convention: `${taskId}/${role}#${attempt}`.
    for (const call of mockSingleSession.mock.calls) {
      const spec = call[0] as Record<string, unknown>;
      expect(spec).toHaveProperty("role");
      expect(typeof spec.role).toBe("string");
      expect((spec.role as string).length).toBeGreaterThan(0);
    }
  });
});
