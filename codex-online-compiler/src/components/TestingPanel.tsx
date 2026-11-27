import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  GitBranch,
  Loader2,
  MinusCircle,
  Play,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react';
import {useState} from 'react';
import type {
  ExecuteResponse,
  TestCaseItem,
  TestCaseRunResult,
} from '../types/compiler.ts';

interface TestingPanelProps {
  testCases: TestCaseItem[];
  resultsByCaseId: Record<string, TestCaseRunResult>;
  isRunningAll: boolean;
  progressCount: {completed: number; total: number};
  onAddTestCase: () => void;
  onRemoveTestCase: (id: string) => void;
  onUpdateTestCase: (
    id: string,
    field: 'stdin' | 'expectedOutput',
    value: string,
  ) => void;
  onRunAll: () => void;
  onRunSingleCase: (id: string) => void;
  onVisualize: () => void;
}

function CaseStatusBadge({runResult}: {runResult: TestCaseRunResult | undefined}) {
  if (!runResult || runResult.status === 'idle') {
    return null;
  }

  if (runResult.status === 'running') {
    return (
      <span className="inline-flex h-6 items-center gap-1 rounded-md border border-blue-500/35 bg-blue-500/12 px-2 text-[11px] font-semibold whitespace-nowrap text-blue-300">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Running
      </span>
    );
  }

  if (runResult.status === 'error' && runResult.requestError) {
    return (
      <span className="inline-flex h-6 items-center gap-1 rounded-md border border-red-500/40 bg-red-500/15 px-2 text-[11px] font-semibold whitespace-nowrap text-red-400">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        Error
      </span>
    );
  }

  const res = runResult.response;
  if (!res) return null;

  switch (res.verdict) {
    case 'PASS':
      return (
        <span className="inline-flex h-6 items-center gap-1 rounded-md border border-emerald-500/45 bg-emerald-500/15 px-2 text-[11px] font-semibold whitespace-nowrap text-emerald-400">
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          PASS
        </span>
      );
    case 'FAIL':
      return (
        <span className="inline-flex h-6 items-center gap-1 rounded-md border border-red-500/45 bg-red-500/15 px-2 text-[11px] font-semibold whitespace-nowrap text-red-400">
          <XCircle className="h-3 w-3" aria-hidden="true" />
          FAIL
        </span>
      );
    case 'NOT_TESTED':
      return (
        <span className="inline-flex h-6 items-center gap-1 rounded-md border border-slate-600/60 bg-slate-700/35 px-2 text-[11px] font-semibold whitespace-nowrap text-slate-300">
          <MinusCircle className="h-3 w-3" aria-hidden="true" />
          NOT TESTED
        </span>
      );
    case 'TIME_LIMIT_EXCEEDED':
      return (
        <span className="inline-flex h-6 items-center gap-1 rounded-md border border-amber-500/45 bg-amber-500/15 px-2 text-[11px] font-semibold whitespace-nowrap text-amber-300">
          <Clock className="h-3 w-3" aria-hidden="true" />
          Time Limit Exceeded
        </span>
      );
    default:
      return (
        <span className="inline-flex h-6 items-center gap-1 rounded-md border border-red-500/45 bg-red-500/15 px-2 text-[11px] font-semibold whitespace-nowrap text-red-400">
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          {res.statusLabel}
        </span>
      );
  }
}

function OverallStatusBadge({
  summary,
  isRunningAny,
  progressCount,
}: {
  summary: {
    total: number;
    passed: number;
    failed: number;
    notTested: number;
    hasCompilationError: boolean;
    hasRuntimeError: boolean;
    hasTimeout: boolean;
    hasExecutedAny: boolean;
    executionStatus: string;
  };
  isRunningAny: boolean;
  progressCount: {completed: number; total: number};
}) {
  if (isRunningAny) {
    return (
      <span
        data-testid="run-status-indicator"
        className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-blue-500/35 bg-blue-500/12 px-3 text-xs font-semibold whitespace-nowrap text-blue-300 tabular-nums"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Running {progressCount.total > 1 ? `${progressCount.completed}/${progressCount.total}` : '…'}
      </span>
    );
  }

  if (!summary.hasExecutedAny) {
    return null;
  }

  if (summary.hasCompilationError && summary.passed === 0) {
    return (
      <span
        data-testid="run-status-indicator"
        className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-red-500/45 bg-red-500/15 px-3 text-xs font-semibold whitespace-nowrap text-red-400"
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        Compilation Error
      </span>
    );
  }

  if (summary.failed === 0 && summary.passed > 0 && summary.notTested === 0) {
    return (
      <span
        data-testid="run-status-indicator"
        className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-emerald-500/45 bg-emerald-500/15 px-3 text-xs font-semibold tracking-wide whitespace-nowrap text-emerald-400 shadow-[0_0_16px_rgba(16,185,129,0.14)] tabular-nums"
      >
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
        PASS {summary.total > 1 ? `(${summary.passed}/${summary.total})` : ''}
      </span>
    );
  }

  if (summary.failed > 0) {
    const label =
      summary.hasRuntimeError && summary.passed === 0 && summary.failed === 1
        ? 'Runtime Error'
        : summary.hasTimeout && summary.passed === 0 && summary.failed === 1
          ? 'Time Limit Exceeded'
          : summary.total > 1
            ? `FAIL (${summary.passed}/${summary.total})`
            : 'FAIL';

    return (
      <span
        data-testid="run-status-indicator"
        className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-red-500/45 bg-red-500/15 px-3 text-xs font-semibold tracking-wide whitespace-nowrap text-red-400 shadow-[0_0_16px_rgba(239,68,68,0.14)] tabular-nums"
      >
        <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </span>
    );
  }

  return (
    <span
      data-testid="run-status-indicator"
      className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-slate-600/60 bg-slate-700/35 px-3 text-xs font-semibold tracking-wide whitespace-nowrap text-slate-300"
    >
      <MinusCircle className="h-3.5 w-3.5" aria-hidden="true" />
      NOT TESTED
    </span>
  );
}

function extractCopyText(runResult: TestCaseRunResult): string {
  if (runResult.requestError) return runResult.requestError;
  const result = runResult.response;
  if (!result) return '';
  if (result.verdict === 'COMPILATION_ERROR') {
    return result.compileOutput || result.stderr || result.message;
  }
  if (result.verdict === 'RUNTIME_ERROR' || result.verdict === 'TIME_LIMIT_EXCEEDED') {
    return [result.actualOutput, result.stderr, result.compileOutput].filter(Boolean).join('\n');
  }
  return result.actualOutput || result.stderr || '';
}

function CaseActualOutputBody({
  runResult,
}: {
  runResult: TestCaseRunResult;
}) {
  if (runResult.status === 'running') {
    return (
      <div className="flex items-center gap-2 py-2 text-gray-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" aria-hidden="true" />
        <span>Executing in sandbox…</span>
      </div>
    );
  }

  if (runResult.status === 'error' && runResult.requestError) {
    return (
      <div className="space-y-1.5">
        <div className="font-sans text-xs font-semibold text-red-400">Request Failed</div>
        <pre className="whitespace-pre-wrap text-red-300">{runResult.requestError}</pre>
      </div>
    );
  }

  const result: ExecuteResponse | null = runResult.response;
  if (!result) {
    return (
      <div className="font-sans text-xs text-gray-500">
        Waiting to execute this test case.
      </div>
    );
  }

  if (result.verdict === 'COMPILATION_ERROR') {
    return (
      <div className="space-y-2">
        <div className="inline-flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 font-sans text-xs font-semibold text-red-400">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Compilation Error</span>
        </div>
        <pre className="whitespace-pre-wrap text-red-300">
          {result.compileOutput || result.stderr || result.message}
        </pre>
      </div>
    );
  }

  if (
    result.verdict === 'RUNTIME_ERROR' ||
    result.verdict === 'TIME_LIMIT_EXCEEDED' ||
    result.verdict === 'EXECUTION_ERROR'
  ) {
    return (
      <div className="space-y-2">
        <div
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-sans text-xs font-semibold ${
            result.verdict === 'TIME_LIMIT_EXCEEDED'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
              : 'border-red-500/30 bg-red-500/10 text-red-400'
          }`}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          <span>
            {result.statusLabel}
            {result.judge0StatusDescription ? ` — ${result.judge0StatusDescription}` : ''}
          </span>
        </div>
        {result.actualOutput && (
          <div>
            <div className="mb-1 font-sans text-[11px] font-medium text-gray-400">Stdout</div>
            <pre className="whitespace-pre-wrap text-gray-200">{result.actualOutput}</pre>
          </div>
        )}
        {(result.stderr || result.compileOutput || result.message) && (
          <pre className="whitespace-pre-wrap text-red-300">
            {result.stderr || result.compileOutput || result.message}
          </pre>
        )}
      </div>
    );
  }

  if (result.verdict === 'PASS') {
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1.5 font-sans text-xs font-semibold text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Output Matched Successfully!</span>
        </div>
        <pre className="whitespace-pre-wrap text-gray-100">
          {result.actualOutput.length > 0 ? result.actualOutput : '(empty output)'}
        </pre>
        {result.stderr && (
          <div className="border-t border-[#222733] pt-2">
            <div className="mb-1 font-sans text-[11px] font-medium text-amber-300">Stderr</div>
            <pre className="whitespace-pre-wrap text-amber-200/90">{result.stderr}</pre>
          </div>
        )}
      </div>
    );
  }

  if (result.verdict === 'FAIL') {
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 rounded-lg border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 font-sans text-xs font-semibold text-red-400">
          <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{result.message}</span>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-red-500/20 bg-[#12161e] p-2.5">
            <div className="mb-1 font-sans text-[11px] font-semibold text-red-400">
              Actual Output
            </div>
            <pre className="whitespace-pre-wrap text-gray-100">
              {result.actualOutput.length > 0 ? result.actualOutput : '(no output)'}
            </pre>
          </div>
          <div className="rounded-lg border border-emerald-500/20 bg-[#12161e] p-2.5">
            <div className="mb-1 font-sans text-[11px] font-semibold text-emerald-400">
              Expected Output
            </div>
            <pre className="whitespace-pre-wrap text-gray-100">{result.expectedOutput}</pre>
          </div>
        </div>

        {result.stderr && (
          <div className="border-t border-[#222733] pt-2">
            <div className="mb-1 font-sans text-[11px] font-medium text-amber-300">Stderr</div>
            <pre className="whitespace-pre-wrap text-amber-200/90">{result.stderr}</pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="rounded-lg border border-slate-600/40 bg-slate-800/35 px-2.5 py-1.5 font-sans text-xs text-slate-300">
        NOT TESTED — Enter Expected Output above to validate automatically.
      </div>
      <pre className="whitespace-pre-wrap text-gray-100">
        {result.actualOutput.length > 0 ? result.actualOutput : '(program produced no output)'}
      </pre>
      {result.stderr && (
        <div className="border-t border-[#222733] pt-2">
          <div className="mb-1 font-sans text-[11px] font-medium text-amber-300">Stderr</div>
          <pre className="whitespace-pre-wrap text-amber-200/90">{result.stderr}</pre>
        </div>
      )}
    </div>
  );
}

export function TestingPanel({
  testCases,
  resultsByCaseId,
  isRunningAll,
  progressCount,
  onAddTestCase,
  onRemoveTestCase,
  onUpdateTestCase,
  onRunAll,
  onRunSingleCase,
  onVisualize,
}: TestingPanelProps) {
  const [copiedCaseId, setCopiedCaseId] = useState<string | null>(null);

  const isRunningAny =
    isRunningAll || Object.values(resultsByCaseId).some((r) => r.status === 'running');

  const summary = (() => {
    const total = testCases.length;
    let passed = 0;
    let failed = 0;
    let notTested = 0;
    let hasCompilationError = false;
    let hasRuntimeError = false;
    let hasTimeout = false;
    let hasExecutedAny = false;

    for (const tc of testCases) {
      const r = resultsByCaseId[tc.id];
      if (!r || r.status === 'idle') continue;
      if (r.status === 'running') {
        hasExecutedAny = true;
        continue;
      }
      hasExecutedAny = true;
      if (r.status === 'error') {
        failed++;
        continue;
      }
      const verdict = r.response?.verdict;
      if (verdict === 'PASS') {
        passed++;
      } else if (verdict === 'NOT_TESTED') {
        notTested++;
      } else if (verdict) {
        failed++;
        if (verdict === 'COMPILATION_ERROR') hasCompilationError = true;
        if (verdict === 'RUNTIME_ERROR') hasRuntimeError = true;
        if (verdict === 'TIME_LIMIT_EXCEEDED') hasTimeout = true;
      }
    }

    let executionStatus = 'Ready';
    if (isRunningAny) {
      executionStatus =
        progressCount.total > 1
          ? `Executing (${progressCount.completed}/${progressCount.total})…`
          : 'Executing…';
    } else if (!hasExecutedAny) {
      executionStatus = 'Not Run';
    } else if (hasCompilationError && passed === 0) {
      executionStatus = 'Compilation Error';
    } else if (failed === 0 && passed > 0 && notTested === 0) {
      executionStatus = 'All Passed';
    } else if (failed > 0 && passed > 0) {
      executionStatus = 'Partial Pass';
    } else if (failed > 0) {
      if (hasRuntimeError && !hasTimeout) executionStatus = 'Runtime Error';
      else if (hasTimeout && !hasRuntimeError) executionStatus = 'Time Limit Exceeded';
      else executionStatus = 'Failed';
    } else if (notTested > 0) {
      executionStatus = 'Not Tested';
    }

    return {
      total,
      passed,
      failed,
      notTested,
      hasCompilationError,
      hasRuntimeError,
      hasTimeout,
      hasExecutedAny,
      executionStatus,
    };
  })();

  const handleCopyCaseOutput = async (caseId: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCaseId(caseId);
      window.setTimeout(() => {
        setCopiedCaseId((prev) => (prev === caseId ? null : prev));
      }, 1800);
    } catch {
      // Clipboard API unavailable
    }
  };

  const activeResultsList = testCases
    .map((tc, index) => ({
      testCase: tc,
      index,
      runResult: resultsByCaseId[tc.id],
    }))
    .filter((entry) => entry.runResult && entry.runResult.status !== 'idle');

  return (
    <section
      aria-label="Test Cases, Input, Expected Output, and Execution Results"
      className="flex h-full min-h-0 flex-col bg-[#11141b]"
    >
      {/* Right Panel Top Toolbar */}
      <div className="flex h-13 shrink-0 items-center justify-between gap-2.5 border-b border-[#222733] bg-[#151921] px-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onRunAll}
            disabled={isRunningAny}
            title="Run All Test Cases (Ctrl + Enter)"
            className="inline-flex h-8.5 items-center gap-2 rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-4 text-xs font-semibold whitespace-nowrap text-white shadow-[0_2px_10px_rgba(37,99,235,0.35),inset_0_1px_0_rgba(255,255,255,0.22)] transition-all duration-150 hover:from-blue-400 hover:to-blue-500 active:translate-y-px focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunningAny ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
            )}
            <span>{isRunningAny ? 'Running…' : 'Run'}</span>
            <kbd className="ml-0.5 hidden rounded bg-blue-950/50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-blue-100 sm:inline">
              Ctrl+↵
            </kbd>
          </button>

          <OverallStatusBadge
            summary={summary}
            isRunningAny={isRunningAny}
            progressCount={progressCount}
          />
        </div>

        <button
          type="button"
          onClick={onVisualize}
          className="inline-flex h-8.5 shrink-0 items-center gap-1.5 rounded-lg border border-[#2a3140] bg-[#1a1f29] px-3 text-xs font-medium whitespace-nowrap text-gray-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-all duration-150 hover:border-[#3b4559] hover:bg-[#212734] hover:text-white focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:outline-none"
        >
          <GitBranch className="h-3.5 w-3.5 text-blue-400" aria-hidden="true" />
          <span>Visualize Code</span>
        </button>
      </div>

      {/* Scrollable Body: Test Cases + Final Summary + Actual Outputs */}
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto bg-[#0f1218] p-3.5">
        {/* Test Cases Controls Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold text-gray-200">Test Cases</span>
            <span aria-hidden="true" className="text-gray-600">
              ·
            </span>
            <span className="font-mono text-gray-400 tabular-nums">{testCases.length}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRunAll}
              disabled={isRunningAny}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/12 px-3 text-xs font-semibold whitespace-nowrap text-blue-300 transition-colors hover:bg-blue-500/20 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRunningAny ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="h-3 w-3 fill-current" aria-hidden="true" />
              )}
              <span>Run All Test Cases</span>
            </button>

            <button
              type="button"
              onClick={onAddTestCase}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#2a3140] bg-[#1a1f29] px-3 text-xs font-medium whitespace-nowrap text-gray-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors hover:border-[#3b4559] hover:bg-[#212734] focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:outline-none"
            >
              <span>Add Test Case</span>
              <Plus className="h-3.5 w-3.5 text-blue-400" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Multiple Test Case Input / Expected Output Pairs */}
        <div className="space-y-3">
          {testCases.map((tc, index) => {
            const runResult = resultsByCaseId[tc.id];
            const isCaseRunning = runResult?.status === 'running';
            return (
              <div
                key={tc.id}
                data-testid={`test-case-card-${index + 1}`}
                className="rounded-xl border border-[#222733] bg-[#141820] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
              >
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xs font-semibold text-gray-200 tabular-nums">
                      Test Case #{index + 1}
                    </span>
                    <CaseStatusBadge runResult={runResult} />
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onRunSingleCase(tc.id)}
                      disabled={isRunningAny}
                      title={`Run Test Case #${index + 1}`}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-[#2a3140] bg-[#1a1f29] px-2 text-[11px] font-medium text-gray-300 transition-colors hover:border-[#3b4559] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {isCaseRunning ? (
                        <Loader2 className="h-3 w-3 animate-spin text-blue-400" aria-hidden="true" />
                      ) : (
                        <Play className="h-2.5 w-2.5 fill-current text-blue-400" aria-hidden="true" />
                      )}
                      <span>Run</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onRemoveTestCase(tc.id)}
                      disabled={testCases.length <= 1 || isRunningAny}
                      title={
                        testCases.length <= 1
                          ? 'At least one test case is required'
                          : `Remove Test Case #${index + 1}`
                      }
                      aria-label={`Remove Test Case ${index + 1}`}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-[#2a3140] bg-[#1a1f29] px-2 text-[11px] font-medium text-gray-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                      <span className="hidden sm:inline">Remove</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {/* A. Custom Input Box */}
                  <div className="flex flex-col">
                    <div className="mb-1.5 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <label
                          htmlFor={`input-${tc.id}`}
                          className="text-xs font-medium text-gray-300"
                        >
                          Input
                        </label>
                        <span aria-hidden="true" className="text-gray-600">
                          ·
                        </span>
                        <span className="font-mono text-[11px] text-gray-500">stdin</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => onUpdateTestCase(tc.id, 'stdin', '')}
                        disabled={tc.stdin.length === 0}
                        className="text-[11px] text-gray-400 transition-colors hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        Clear
                      </button>
                    </div>
                    <textarea
                      id={`input-${tc.id}`}
                      value={tc.stdin}
                      onChange={(e) => onUpdateTestCase(tc.id, 'stdin', e.target.value)}
                      placeholder="Enter Input Here"
                      rows={3}
                      spellCheck={false}
                      className="min-h-[76px] w-full resize-y rounded-lg border border-[#232936] bg-[#0b0d12] p-2.5 font-mono text-xs leading-relaxed text-gray-100 placeholder-gray-500 transition-colors focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 focus:outline-none"
                    />
                  </div>

                  {/* B. Sample Output Box (Expected Output) */}
                  <div className="flex flex-col">
                    <div className="mb-1.5 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <label
                          htmlFor={`expected-${tc.id}`}
                          className="text-xs font-medium text-gray-300"
                        >
                          Sample Output
                        </label>
                        <span aria-hidden="true" className="text-gray-600">
                          ·
                        </span>
                        <span className="text-[11px] text-gray-500">Expected Output</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => onUpdateTestCase(tc.id, 'expectedOutput', '')}
                        disabled={tc.expectedOutput.length === 0}
                        className="text-[11px] text-gray-400 transition-colors hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        Clear
                      </button>
                    </div>
                    <textarea
                      id={`expected-${tc.id}`}
                      value={tc.expectedOutput}
                      onChange={(e) => onUpdateTestCase(tc.id, 'expectedOutput', e.target.value)}
                      placeholder="Enter Expected Output Here"
                      rows={3}
                      spellCheck={false}
                      className="min-h-[76px] w-full resize-y rounded-lg border border-[#232936] bg-[#0b0d12] p-2.5 font-mono text-xs leading-relaxed text-gray-100 placeholder-gray-500 transition-colors focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Final Summary Bar */}
        <div
          data-testid="execution-summary-panel"
          className="rounded-xl border border-[#222733] bg-[#141820] px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
        >
          <div className="mb-2 text-xs font-semibold text-gray-200">Execution Summary</div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div className="rounded-lg border border-[#232936] bg-[#0b0d12] px-3 py-2">
              <div className="text-[11px] text-gray-400">Total Test Cases</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-gray-100 tabular-nums">
                {summary.total}
              </div>
            </div>
            <div className="rounded-lg border border-[#232936] bg-[#0b0d12] px-3 py-2">
              <div className="text-[11px] text-gray-400">Passed</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-emerald-400 tabular-nums">
                {summary.passed}
              </div>
            </div>
            <div className="rounded-lg border border-[#232936] bg-[#0b0d12] px-3 py-2">
              <div className="text-[11px] text-gray-400">Failed</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-red-400 tabular-nums">
                {summary.failed}
              </div>
            </div>
            <div className="rounded-lg border border-[#232936] bg-[#0b0d12] px-3 py-2">
              <div className="text-[11px] text-gray-400">Execution Status</div>
              <div
                className={`mt-0.5 truncate text-xs font-semibold ${
                  isRunningAny
                    ? 'text-blue-300'
                    : summary.executionStatus === 'All Passed'
                      ? 'text-emerald-400'
                      : summary.failed > 0
                        ? 'text-red-400'
                        : 'text-gray-200'
                }`}
                title={summary.executionStatus}
              >
                {summary.executionStatus}
              </div>
            </div>
          </div>
        </div>

        {/* C. Actual Output Section (Per Test Case) */}
        <div
          data-testid="actual-output-panel"
          className="flex min-h-[170px] flex-1 flex-col rounded-xl border border-[#222733] bg-[#141820] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
        >
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-200">Actual Output</span>
            {activeResultsList.length > 0 && (
              <span className="font-mono text-[11px] text-gray-400 tabular-nums">
                {activeResultsList.length} / {testCases.length} cases
              </span>
            )}
          </div>

          {activeResultsList.length === 0 ? (
            <div className="flex min-h-[115px] flex-1 items-center justify-center rounded-lg border border-[#232936] bg-[#0b0d12] p-4 font-sans text-xs text-gray-500">
              Click Run or Run All Test Cases (Ctrl + Enter) to execute your code.
            </div>
          ) : (
            <div className="space-y-3">
              {activeResultsList.map(({testCase, index, runResult}) => {
                const copyText = extractCopyText(runResult);
                const res = runResult.response;
                return (
                  <div
                    key={testCase.id}
                    data-testid={`actual-output-case-${index + 1}`}
                    className="rounded-lg border border-[#232936] bg-[#0b0d12] p-3 font-mono text-xs leading-relaxed"
                  >
                    <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-[#1d222e] pb-2 font-sans">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-gray-200 tabular-nums">
                          Test Case #{index + 1}
                        </span>
                        <CaseStatusBadge runResult={runResult} />
                        {res &&
                          runResult.status === 'completed' &&
                          (res.time !== null || res.memory !== null) && (
                            <span className="font-mono text-[11px] text-gray-400 tabular-nums">
                              {res.time !== null ? `Time: ${res.time}s` : ''}
                              {res.time !== null && res.memory !== null ? ' · ' : ''}
                              {res.memory !== null ? `Memory: ${res.memory} KB` : ''}
                            </span>
                          )}
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleCopyCaseOutput(testCase.id, copyText)}
                        disabled={!copyText || runResult.status === 'running'}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-gray-400 transition-colors hover:bg-[#1f2532] hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        {copiedCaseId === testCase.id ? (
                          <>
                            <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" />
                            <span className="text-emerald-400">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" aria-hidden="true" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </div>

                    <CaseActualOutputBody runResult={runResult} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
