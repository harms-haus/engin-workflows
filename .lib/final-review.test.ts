// ─── Final Review Phase Tests (kb-31: E5 migration) ────────────────────────
//
// Tests for final-review.ts: the migrated per-lane multi-dimensional review
// that uses TaskGraph + SessionScheduler + singleSession + linearRunner
// instead of the legacy TaskTracker + RunnerPool pattern.
//
// Each reviewer lane runs via `runSingleSessionStructured` (which calls
// `runSession` directly). Fixer tasks are added to a per-lane TaskGraph and
// driven by a per-lane SessionScheduler whose runner factory is a linearRunner
// of singleSession runners (one per fixer step, built from config.fixerSteps).
//
// The old symbols (RunnerPool, TaskTracker, LanePool, runStepTask) MUST be
// absent from the production code — these tests assert the NEW path
// (TaskGraph, SessionScheduler) is used instead.
// ────────────────────────────────────────────────────────────────────────────

import {
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from "bun:test";
import { createEnginMock } from "./engin-mock";
import type {
  FinalReviewResult,
  FinalReviewFinding,
  FinalReviewSeverity,
} from "./schemas";

// ─── Mock @harms-haus/engin-engine (SessionPlan contract) ────────────────
//
// We mock the ENTIRE module via createEnginMock(), then override the symbols
// the migrated final-review.ts uses:
//   - TaskGraph (replaces TaskTracker — constructed per-lane for fixers)
//   - SessionScheduler (replaces RunnerPool)
//   - singleSession / linearRunner (build fixer runner factories)
//   - AuditLog (constructed by the phase for lane error logging)
//   - runSession (drives review sessions via runSingleSessionStructured)
//   - getDiff (returns a mock diff)

mock.module("@harms-haus/engin-engine", () => ({
  ...createEnginMock(),
  // singleSession(spec) → SessionPlanFactory (() => SessionPlanRunner).
  // Production code calls singleSession(spec)() so the mock must return
  // a callable that yields a SessionPlanRunner.
  singleSession: jest.fn().mockImplementation((spec: Record<string, unknown>) =>
    jest.fn(() => ({
      plan: async function* () {
        yield [spec];
      },
      execute: jest.fn().mockResolvedValue({ mode: "text", text: "" }),
    })),
  ),
  // linearRunner(children) → SessionPlanFactory (() => SessionPlanRunner).
  linearRunner: jest.fn().mockImplementation((_children: unknown[]) =>
    jest.fn(() => ({
      plan: async function* () {
        yield [];
      },
      execute: jest.fn().mockResolvedValue({ mode: "text", text: "" }),
    })),
  ),
  // TaskGraph: replaces TaskTracker. Constructed per-lane for fixer tasks.
  TaskGraph: jest.fn().mockImplementation(() => ({
    addTask: jest.fn(),
    getTask: jest.fn().mockReturnValue(undefined),
    getAllTasks: jest.fn().mockReturnValue([]),
    setTaskStatus: jest.fn(),
    failDeadlockedTasks: jest.fn(),
  })),
  // SessionScheduler: replaces RunnerPool. Drives fixer tasks through the gate.
  SessionScheduler: jest.fn().mockImplementation(() => ({
    run: jest
      .fn()
      .mockResolvedValue({ completedTasks: 0, failedTasks: 0 }),
  })),
  // AuditLog: constructed by the phase for lane error logging.
  AuditLog: jest.fn().mockImplementation(() => ({
    append: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Import the engine to get the ACTUAL mock instances used by the implementation
const engineModule = await import("@harms-haus/engin-engine");

// References to the shared mock instances (read from the cached engine module)
type Spy = ReturnType<typeof mock>;
const mockRunSession = engineModule.runSession as unknown as Spy;
const mockSingleSession = engineModule.singleSession as unknown as Spy;
const mockLinearRunner = engineModule.linearRunner as unknown as Spy;
const mockTaskGraph = engineModule.TaskGraph as unknown as Spy;
const mockSessionScheduler = engineModule.SessionScheduler as unknown as Spy;
const mockAuditLog = engineModule.AuditLog as unknown as Spy;

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
  mockSingleSession.mockClear();
  mockRunSession.mockClear();
  mockLinearRunner.mockClear();
  mockTaskGraph.mockClear();
  mockSessionScheduler.mockClear();
  mockAuditLog.mockClear();

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

  // SessionScheduler.run succeeds by default
  mockSessionScheduler.mockImplementation(() => ({
    run: jest
      .fn()
      .mockResolvedValue({ completedTasks: 0, failedTasks: 0 }),
  }));

  // AuditLog returns an appendable mock
  mockAuditLog.mockImplementation(() => ({
    append: jest.fn().mockResolvedValue(undefined),
  }));
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. CLEAN ASSESSMENT
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — clean assessment", () => {
  it("returns true when all reviewers are clean", async () => {
    const result = await finalReviewPhase(
      null as never,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
    );
    expect(result).toBe(true);
  });

  it("does NOT manually append structured_output for reviewer results (the default auditor handles it)", async () => {
    await finalReviewPhase(null as never, ["/profiles"], "/cwd", "/work", 5);

    // The AuditLog constructed by the phase should NOT receive a
    // structured_output event from the phase body itself (the engine's
    // default auditor handles that via the hook registry).
    const auditInstances = mockAuditLog.mock.results;
    for (const result of auditInstances) {
      const append = (result.value as any).append as ReturnType<typeof jest.fn>;
      if (append && typeof append.mock === "object") {
        expect(append).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: "structured_output" }),
        );
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CLEAN LANES SKIP FIXERS
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — clean lanes skip fixer path", () => {
  it("does NOT construct a TaskGraph or SessionScheduler when all lanes are clean", async () => {
    await finalReviewPhase(null as never, ["/profiles"], "/cwd", "/work", 5);

    expect(mockTaskGraph).not.toHaveBeenCalled();
    expect(mockSessionScheduler).not.toHaveBeenCalled();
    expect(mockLinearRunner).not.toHaveBeenCalled();
    expect(mockSingleSession).not.toHaveBeenCalled();
  });

  it("runs exactly one review session per reviewer (5 for defaults)", async () => {
    await finalReviewPhase(null as never, ["/profiles"], "/cwd", "/work", 5);

    const reviewerSessions = mockRunSession.mock.calls.filter(
      (c: any) =>
        typeof c[0]?.spec?.profile === "string" &&
        c[0].spec.profile.endsWith("-reviewer"),
    );
    expect(reviewerSessions).toHaveLength(EXPECTED_REVIEWER_COUNT);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. FIXER PATH: TaskGraph + SessionScheduler (replaces RunnerPool)
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — fixer TaskGraph + SessionScheduler", () => {
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

  it("constructs a TaskGraph when there are actionable findings", async () => {
    setupEfficiencyFindings();

    await finalReviewPhase(null as never, ["/profiles"], "/cwd", "/work", 5);

    expect(mockTaskGraph).toHaveBeenCalled();
  });

  it("constructs a SessionScheduler when there are actionable findings", async () => {
    setupEfficiencyFindings();

    await finalReviewPhase(null as never, ["/profiles"], "/cwd", "/work", 5);

    expect(mockSessionScheduler).toHaveBeenCalled();
  });

  it("adds fixer tasks to the per-lane TaskGraph via addTask", async () => {
    setupEfficiencyFindings();

    await finalReviewPhase(null as never, ["/profiles"], "/cwd", "/work", 5);

    // Each TaskGraph mock instance has an addTask spy. Collect all addTask calls.
    const allAddTaskCalls = mockTaskGraph.mock.results.flatMap(
      (r: any) => r.value.addTask.mock.calls,
    );
    // One finding → one fixer task per fix round (up to MAX_FIX_ROUNDS).
    expect(allAddTaskCalls.length).toBeGreaterThan(0);
    // Each call has (task, runnerFactory) — the task has a fixer id pattern.
    for (const call of allAddTaskCalls) {
      const task = call[0];
      expect(task.id).toMatch(/^fixer-/);
      expect(task.phaseId).toBe("review");
    }
  });

  it("builds runner factory via linearRunner of singleSession runners (one per fixer step)", async () => {
    setupEfficiencyFindings();

    await finalReviewPhase(null as never, ["/profiles"], "/cwd", "/work", 5);

    // linearRunner is called to wrap fixer steps into a SessionPlanFactory.
    expect(mockLinearRunner).toHaveBeenCalled();
    // singleSession is called to build each step's runner.
    expect(mockSingleSession).toHaveBeenCalled();

    // linearRunner receives an array of SessionPlanRunner children.
    const children = mockLinearRunner.mock.calls[0][0] as unknown[];
    expect(Array.isArray(children)).toBe(true);
    // Each child should be a SessionPlanRunner (object with plan/execute).
    for (const child of children) {
      expect(typeof child).toBe("object");
      expect(child).toHaveProperty("plan");
      expect(child).toHaveProperty("execute");
    }
  });

  it("SessionScheduler receives graph, gate, profiles, and phaseId", async () => {
    setupEfficiencyFindings();

    await finalReviewPhase(null as never, ["/profiles"], "/cwd", "/work", 5);

    const schedulerOpts = mockSessionScheduler.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(schedulerOpts).toHaveProperty("graph");
    expect(schedulerOpts).toHaveProperty("gate");
    expect(schedulerOpts).toHaveProperty("profiles");
    expect(schedulerOpts.phaseId).toBe("review");
    expect(schedulerOpts).toHaveProperty("auditLog");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. PER-LANE LOOP BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — per-lane loop behavior", () => {
  it("returns true when all lanes are clean", async () => {
    const result = await finalReviewPhase(
      null as never,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
    );
    expect(result).toBe(true);
  });

  it("returns false if ANY lane stays dirty (even if others are clean)", async () => {
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
      null as never,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
    );
    expect(result).toBe(false);
  });

  it("gives up on a lane after MAX_FIX_ROUNDS and returns false", async () => {
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

    await finalReviewPhase(null as never, ["/profiles"], "/cwd", "/work", 5);

    // A lane that never resolves triggers MAX_FIX_ROUNDS fixer attempts.
    // Each attempt constructs a TaskGraph + SessionScheduler.
    expect(mockTaskGraph).toHaveBeenCalledTimes(MAX_FIX_ROUNDS);
    expect(mockSessionScheduler).toHaveBeenCalledTimes(MAX_FIX_ROUNDS);
  });

  it("a clean lane does NOT trigger any fixer or review-fixes pass", async () => {
    await finalReviewPhase(null as never, ["/profiles"], "/cwd", "/work", 5);

    // Only 5 review sessions ran (one per reviewer), no fixer or review-fixes.
    const reviewerSessions = mockRunSession.mock.calls.filter(
      (c: any) =>
        typeof c[0]?.spec?.profile === "string" &&
        c[0].spec.profile.endsWith("-reviewer"),
    );
    expect(reviewerSessions).toHaveLength(5);
    expect(mockTaskGraph).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. REVIEWER HISTORY IS PASSED ON RE-REVIEW
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — passes full prior-pass history to reviewers", () => {
  it("initial-review prompts contain NO history; verify prompts DO", async () => {
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

    await finalReviewPhase(null as never, ["/profiles"], "/cwd", "/work", 5);

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
// 6. CUSTOM REVIEWER SET
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — custom finalReviewers", () => {
  it("runs exactly the supplied reviewers (not the defaults)", async () => {
    const custom = [
      { profileId: "a-reviewer", dimension: "a", label: "A" },
      { profileId: "b-reviewer", dimension: "b", label: "B" },
    ];

    await finalReviewPhase(
      null as never,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
      undefined,
      undefined,
      undefined,
      custom,
    );

    // Only 2 runSession calls (one per custom reviewer via runSingleSessionStructured)
    expect(mockRunSession).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. PURE HELPERS (unchanged by migration)
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

// ═══════════════════════════════════════════════════════════════════════════
// 8. LANE ISOLATION (one flaky reviewer must not abort the run)
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — lane isolation on reviewer failure", () => {
  it("a throwing reviewer does NOT abort the run; the lane is not-clean and the others still run", async () => {
    // Make one reviewer throw in its runSession call
    mockRunSession.mockImplementation(async (sctx: any) => {
      if (sctx.spec.profile === "ui-ux-reviewer") {
        throw new Error("Failed to produce structured output");
      }
      const dimension = sctx.spec.profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    });

    const result = await finalReviewPhase(
      null as never,
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
    const onError = jest.fn();
    const onStatus = { onError } as never;

    // Capture the AuditLog instance's append calls
    const auditAppendSpy = jest.fn().mockResolvedValue(undefined);
    mockAuditLog.mockImplementation(() => ({
      append: auditAppendSpy,
    }));

    mockRunSession.mockImplementation(async (sctx: any) => {
      if (sctx.spec.profile === "security-reviewer") {
        throw new Error("boom: no JSON");
      }
      const dimension = sctx.spec.profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    });

    const result = await finalReviewPhase(
      null as never,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
      undefined,
      onStatus,
    );
    expect(result).toBe(false);

    // Lane error is logged via auditLog.append
    const failures = auditAppendSpy.mock.calls
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
// 9. NOT-APPLICABLE DIMENSIONS
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — not-applicable dimensions", () => {
  it("a not-applicable dimension is treated as clean (no actionable findings)", async () => {
    mockRunSession.mockImplementation(async (sctx: any) => {
      if (sctx.spec.profile === "ui-ux-reviewer") {
        return {
          mode: "structured",
          data: makeNotApplicable("ui-ux"),
        };
      }
      const dimension = sctx.spec.profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    });

    const result = await finalReviewPhase(
      null as never,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
    );

    // Not-applicable → no actionable findings → clean lane → phase returns true
    expect(result).toBe(true);
    // No fixer path triggered
    expect(mockTaskGraph).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. FIXER RUNNER FACTORY DETAILS
// ═══════════════════════════════════════════════════════════════════════════

describe("finalReviewPhase — fixer runner factory from fixerSteps", () => {
  it("singleSession is called with the fixer step's profileId and the finding's fixPrompt", async () => {
    mockRunSession.mockImplementation(async (sctx: any) => {
      if (sctx.spec.profile === "efficiency-reviewer") {
        return {
          mode: "structured",
          data: makeResultWithFindings("efficiency", [
            makeFinding("high", { fixPrompt: "SPECIFIC-FIX-INSTRUCTION" }),
          ]),
        };
      }
      const dimension = sctx.spec.profile.replace(/-reviewer$/, "");
      return { mode: "structured", data: makeCleanResult(dimension) };
    });

    const customSteps = [
      { name: "fix", profileId: "custom-fixer", isReadOnly: false },
    ];

    await finalReviewPhase(
      null as never,
      ["/profiles"],
      "/cwd",
      "/work",
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      customSteps,
    );

    // singleSession is called for fixer step construction
    expect(mockSingleSession).toHaveBeenCalled();
    const spec = mockSingleSession.mock.calls[0][0] as Record<string, unknown>;
    expect(spec.profile).toBe("custom-fixer");
    expect(spec.prompt as string).toContain("SPECIFIC-FIX-INSTRUCTION");
    expect(spec.role).toBe("fix");
  });
});
