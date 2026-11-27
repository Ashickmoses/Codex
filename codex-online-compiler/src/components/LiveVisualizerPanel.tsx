import {AnimatePresence, motion} from 'motion/react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  GitBranch,
  Layers,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipBack,
  SkipForward,
  Terminal,
  XCircle,
} from 'lucide-react';
import {useMemo} from 'react';
import type {
  ExecutionTraceStep,
  LanguageConfig,
  TestCaseItem,
  TraceVariableValue,
  VisualizeResponse,
} from '../types/compiler.ts';

export type PlaybackSpeed = 0.5 | 1 | 2 | 4;

interface LiveVisualizerPanelProps {
  language: LanguageConfig;
  testCases: TestCaseItem[];
  selectedCaseIndex: number;
  isTracing: boolean;
  traceError: string | null;
  traceData: VisualizeResponse | null;
  currentStepIndex: number;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  onBackToTesting: () => void;
  onSelectCaseIndex: (index: number) => void;
  onRetrace: () => void;
  onPlayPause: () => void;
  onNextStep: () => void;
  onPrevStep: () => void;
  onRestart: () => void;
  onSeekStep: (index: number) => void;
  onSpeedChange: (speed: PlaybackSpeed) => void;
  onJumpToLine: (line: number) => void;
}

const SPEED_OPTIONS: PlaybackSpeed[] = [0.5, 1, 2, 4];

function EventBadge({step}: {step: ExecutionTraceStep}) {
  if (step.conditionEval) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
          step.conditionEval.result
            ? 'border-emerald-500/40 bg-emerald-500/12 text-emerald-300'
            : 'border-rose-500/40 bg-rose-500/12 text-rose-300'
        }`}
      >
        {step.conditionEval.result ? (
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        ) : (
          <XCircle className="h-3 w-3" aria-hidden="true" />
        )}
        Condition: {step.conditionEval.result ? 'true' : 'false'}
      </span>
    );
  }

  if (step.loopInfo) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/12 px-2 py-0.5 text-[11px] font-semibold text-violet-300 tabular-nums">
        Loop Iteration #{step.loopInfo.iteration}
      </span>
    );
  }

  if (step.eventKind === 'call') {
    return (
      <span className="inline-flex items-center rounded-md border border-blue-500/40 bg-blue-500/15 px-2 py-0.5 text-[11px] font-semibold text-blue-300">
        Function Call
      </span>
    );
  }

  if (step.eventKind === 'return') {
    return (
      <span className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
        Return
      </span>
    );
  }

  if (step.ioEvent?.kind === 'stdin') {
    return (
      <span className="inline-flex items-center rounded-md border border-cyan-500/40 bg-cyan-500/15 px-2 py-0.5 text-[11px] font-semibold text-cyan-300">
        Input (stdin)
      </span>
    );
  }

  if (step.ioEvent?.kind === 'stdout') {
    return (
      <span className="inline-flex items-center rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
        Output (stdout)
      </span>
    );
  }

  return (
    <span className="inline-flex items-center rounded-md border border-slate-600/50 bg-slate-800/60 px-2 py-0.5 text-[11px] font-medium text-slate-300">
      Execute Line
    </span>
  );
}

function VariableCard({
  variable,
  changeInfo,
}: {
  variable: TraceVariableValue;
  changeInfo?: {previousValue: string | null; newValue: string};
}) {
  const isChanged = Boolean(changeInfo);

  return (
    <motion.div
      layout
      initial={{opacity: 0.5, y: 4}}
      animate={{opacity: 1, y: 0}}
      transition={{duration: 0.18, ease: [0.16, 1, 0.3, 1]}}
      className={`rounded-lg border p-2.5 transition-colors ${
        isChanged
          ? 'border-blue-500/55 bg-blue-500/10 shadow-[0_0_16px_rgba(59,130,246,0.12)]'
          : 'border-[#232936] bg-[#0b0d12]'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-xs font-semibold text-gray-100">{variable.name}</span>
          {isChanged && (
            <span className="rounded bg-blue-500/20 px-1.5 py-0.5 font-mono text-[10px] font-medium text-blue-300">
              {changeInfo?.previousValue ? `${changeInfo.previousValue} → ` : 'new → '}
              {changeInfo?.newValue}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px]">
          {variable.memoryAddress && (
            <span className="text-gray-500 tabular-nums" title="Memory address / reference ID">
              {variable.memoryAddress}
            </span>
          )}
          <span className="text-gray-400">{variable.type}</span>
        </div>
      </div>

      {/* Array Index Visualization */}
      {variable.type === 'array' && variable.elements ? (
        <div className="mt-2 overflow-x-auto pb-1">
          {variable.elements.length === 0 ? (
            <span className="font-mono text-xs text-gray-500">[ ] (empty array)</span>
          ) : (
            <div className="inline-flex items-stretch gap-1">
              {variable.elements.map((el) => (
                <div
                  key={el.index}
                  className="flex min-w-[40px] flex-col overflow-hidden rounded border border-[#2a3140] bg-[#131720] text-center"
                >
                  <div className="border-b border-[#232936] bg-[#181d28] px-1.5 py-0.5 font-mono text-[10px] text-gray-400 tabular-nums">
                    [{el.index}]
                  </div>
                  <div className="px-2 py-1 font-mono text-xs font-medium text-emerald-300">
                    {el.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : variable.type === 'object' && variable.properties && variable.properties.length > 0 ? (
        <div className="mt-2 space-y-1 border-t border-[#1e2430] pt-1.5">
          {variable.properties.map((prop) => (
            <div
              key={prop.key}
              className="flex items-center justify-between gap-2 font-mono text-[11px]"
            >
              <span className="text-gray-400">{prop.key}:</span>
              <span className="truncate text-cyan-300">{prop.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1.5 font-mono text-xs font-medium break-all text-cyan-300">
          {variable.displayValue}
        </div>
      )}
    </motion.div>
  );
}

export function LiveVisualizerPanel({
  language,
  testCases,
  selectedCaseIndex,
  isTracing,
  traceError,
  traceData,
  currentStepIndex,
  isPlaying,
  speed,
  onBackToTesting,
  onSelectCaseIndex,
  onRetrace,
  onPlayPause,
  onNextStep,
  onPrevStep,
  onRestart,
  onSeekStep,
  onSpeedChange,
  onJumpToLine,
}: LiveVisualizerPanelProps) {
  const steps = traceData?.steps ?? [];
  const activeStep = steps[currentStepIndex] ?? null;
  const progressPct =
    steps.length > 1 ? Math.round((currentStepIndex / (steps.length - 1)) * 100) : steps.length === 1 ? 100 : 0;

  const activeStdinTokens = useMemo(() => {
    const raw = testCases[selectedCaseIndex]?.stdin ?? '';
    return raw.trim() ? raw.trim().split(/\s+/) : [];
  }, [testCases, selectedCaseIndex]);

  const changedLookup = useMemo(() => {
    const map = new Map<string, {previousValue: string | null; newValue: string}>();
    if (!activeStep) return map;
    for (const c of activeStep.changedVariables) {
      map.set(`${c.scope}:${c.name}`, {
        previousValue: c.previousValue,
        newValue: c.newValue,
      });
    }
    return map;
  }, [activeStep]);

  return (
    <section
      aria-label="Live Code Execution Visualization"
      className="flex h-full min-h-0 flex-col bg-[#11141b]"
    >
      {/* Top Toolbar */}
      <div className="flex h-13 shrink-0 items-center justify-between gap-2 border-b border-[#222733] bg-[#151921] px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onBackToTesting}
            className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-[#2a3140] bg-[#1a1f29] px-2.5 text-xs font-medium whitespace-nowrap text-gray-200 transition-colors hover:border-[#3b4559] hover:bg-[#212734] hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Test Cases</span>
          </button>

          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-[#2a3140]" />

          <div className="flex min-w-0 items-center gap-2">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-blue-400" aria-hidden="true" />
            <span className="truncate text-xs font-semibold text-gray-100">
              Live Visualizer
            </span>
            <span aria-hidden="true" className="hidden text-gray-600 sm:inline">
              ·
            </span>
            <span className="hidden font-mono text-[11px] text-gray-400 sm:inline">
              {language.label}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {testCases.length > 1 && (
            <select
              aria-label="Select test case input for visualization"
              value={selectedCaseIndex}
              onChange={(e) => onSelectCaseIndex(Number(e.target.value))}
              className="h-8 rounded-lg border border-[#2a3140] bg-[#0e1116] px-2 text-xs text-gray-200 focus:border-blue-500 focus:outline-none"
            >
              {testCases.map((tc, idx) => (
                <option key={tc.id} value={idx} className="bg-[#151921]">
                  Case #{idx + 1} Input
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={onRetrace}
            disabled={isTracing}
            className="inline-flex h-8.5 items-center gap-1.5 rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-3 text-xs font-semibold whitespace-nowrap text-white shadow-[0_2px_10px_rgba(37,99,235,0.3)] transition-all hover:from-blue-400 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isTracing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>{isTracing ? 'Tracing…' : 'Trace Execution'}</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-[#0f1218] p-3.5">
        {isTracing ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-[#222733] bg-[#141820] p-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-blue-400" aria-hidden="true" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-gray-100">
                Capturing live execution trace…
              </p>
              <p className="text-xs text-gray-400">
                Running your {language.label} code line by line in the Judge0 sandbox to record real
                variables, memory, and call stack frames.
              </p>
            </div>
          </div>
        ) : traceError ? (
          <div className="rounded-xl border border-red-500/35 bg-[#141820] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-red-400">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <span>Visualization Request Failed</span>
            </div>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-red-300">
              {traceError}
            </pre>
          </div>
        ) : !traceData ? (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-[#222733] bg-[#141820] p-6 text-xs text-gray-400">
            Click Trace Execution to inspect your program step by step.
          </div>
        ) : !traceData.supported || traceData.errorType === 'TRACING_UNAVAILABLE' ? (
          <div className="space-y-3 rounded-xl border border-amber-500/35 bg-[#141820] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {traceData.errorType === 'UNSUPPORTED_LANGUAGE'
                  ? `Live Tracing Not Available for ${language.label}`
                  : 'Tracing Limitation Encountered'}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-gray-300">
              {traceData.limitationNote ||
                'Accurate line-by-line tracing is unavailable for this code.'}
            </p>
            {traceData.finalStdout && (
              <div className="rounded-lg border border-[#232936] bg-[#0b0d12] p-3">
                <div className="mb-1 text-[11px] font-semibold text-gray-400">
                  Actual Program Output
                </div>
                <pre className="whitespace-pre-wrap font-mono text-xs text-gray-100">
                  {traceData.finalStdout}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Error Banner if compilation or runtime error occurred */}
            {traceData.errorType && (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-red-400">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {traceData.errorType === 'COMPILATION_ERROR'
                      ? 'Compilation Error'
                      : traceData.errorType === 'TIME_LIMIT_EXCEEDED'
                        ? 'Time Limit Exceeded'
                        : 'Runtime Error'}
                  </span>
                </div>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs text-red-200">
                  {traceData.errorMessage || traceData.compileOutput || traceData.stderr}
                </pre>
                {steps.length > 0 && (
                  <p className="mt-2 text-[11px] text-red-300/90">
                    Showing the {steps.length} execution steps recorded right up to the error.
                  </p>
                )}
              </div>
            )}

            {steps.length > 0 && activeStep && (
              <>
                {/* Video-Like Playback Controls */}
                <div className="rounded-xl border border-[#222733] bg-[#141820] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={onRestart}
                        title="Restart from Step 1"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#2a3140] bg-[#1a1f29] text-gray-300 transition-colors hover:border-[#3b4559] hover:text-white"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={onPrevStep}
                        disabled={currentStepIndex <= 0}
                        title="Previous Step"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#2a3140] bg-[#1a1f29] text-gray-300 transition-colors hover:border-[#3b4559] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <SkipBack className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>

                      <button
                        type="button"
                        onClick={onPlayPause}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
                      >
                        {isPlaying ? (
                          <>
                            <Pause className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                            <span>Pause</span>
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                            <span>{currentStepIndex >= steps.length - 1 ? 'Replay' : 'Play'}</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={onNextStep}
                        disabled={currentStepIndex >= steps.length - 1}
                        title="Next Step"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#2a3140] bg-[#1a1f29] text-gray-300 transition-colors hover:border-[#3b4559] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <SkipForward className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>

                    {/* Speed Selector */}
                    <div
                      role="group"
                      aria-label="Execution speed"
                      className="flex items-center gap-1 rounded-lg border border-[#262c38] bg-[#0b0d12] p-0.5"
                    >
                      {SPEED_OPTIONS.map((spd) => (
                        <button
                          key={spd}
                          type="button"
                          onClick={() => onSpeedChange(spd)}
                          className={`rounded-md px-2 py-1 font-mono text-[11px] font-medium tabular-nums transition-colors ${
                            speed === spd
                              ? 'bg-blue-600 text-white'
                              : 'text-gray-400 hover:text-gray-200'
                          }`}
                        >
                          {spd}x
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Progress Scrubber & Counter */}
                  <div className="mt-3 flex items-center gap-3">
                    <input
                      type="range"
                      aria-label="Execution step scrubber"
                      min={0}
                      max={Math.max(0, steps.length - 1)}
                      value={currentStepIndex}
                      onChange={(e) => onSeekStep(Number(e.target.value))}
                      className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-[#242a37] accent-blue-500"
                    />
                    <span className="shrink-0 font-mono text-[11px] text-gray-300 tabular-nums">
                      Step {currentStepIndex + 1} / {steps.length} ({progressPct}%)
                    </span>
                  </div>

                  {traceData.truncated && (
                    <p className="mt-2 text-[11px] text-amber-300">
                      Trace capped at {steps.length} steps to keep playback responsive.
                    </p>
                  )}
                </div>

                {/* Current Line & Beginner-Friendly Step Explanation */}
                <motion.div
                  key={activeStep.stepIndex}
                  initial={{opacity: 0.7, y: 3}}
                  animate={{opacity: 1, y: 0}}
                  transition={{duration: 0.16, ease: [0.16, 1, 0.3, 1]}}
                  className="rounded-xl border border-[#222733] bg-[#141820] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onJumpToLine(activeStep.line)}
                      className="inline-flex items-center gap-2 font-mono text-xs font-semibold text-blue-400 hover:text-blue-300 tabular-nums"
                    >
                      <span>Executing Line {activeStep.line}</span>
                    </button>
                    <EventBadge step={activeStep} />
                  </div>

                  {activeStep.codeLine && (
                    <div className="mt-2 rounded-lg border border-[#232936] bg-[#0b0d12] px-3 py-2 font-mono text-xs text-gray-100">
                      {activeStep.codeLine}
                    </div>
                  )}

                  <div className="mt-3 space-y-1.5 text-xs leading-relaxed">
                    <p className="text-gray-100">
                      <span className="font-semibold text-blue-300">What it does: </span>
                      {activeStep.explanation.whatLineDoes}
                    </p>
                    <p className="text-gray-300">
                      <span className="font-semibold text-gray-200">Why: </span>
                      {activeStep.explanation.whyExecuting}
                    </p>
                    <p className="text-gray-300">
                      <span className="font-semibold text-gray-200">Variables: </span>
                      {activeStep.explanation.variableSummary}
                    </p>
                    <p className="text-gray-400">
                      <span className="font-semibold text-gray-300">Next: </span>
                      {activeStep.explanation.whatNext}
                    </p>
                  </div>
                </motion.div>

                {/* Visual Animation Stage: Call Stack + Variables/Memory + Arrays */}
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
                  {/* Call Stack & Recursion Visualization */}
                  <div className="rounded-xl border border-[#222733] bg-[#141820] p-3 xl:col-span-5">
                    <div className="mb-2.5 flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-200">
                        <Layers className="h-3.5 w-3.5 text-blue-400" aria-hidden="true" />
                        <span>Call Stack &amp; Recursion</span>
                      </div>
                      <span className="font-mono text-[11px] text-gray-400 tabular-nums">
                        {activeStep.stack.length}{' '}
                        {activeStep.stack.length === 1 ? 'frame' : 'frames'}
                      </span>
                    </div>

                    <div className="space-y-2">
                      <AnimatePresence initial={false}>
                        {[...activeStep.stack].reverse().map((frame, revIdx) => {
                          const isTop = revIdx === 0;
                          return (
                            <motion.div
                              key={frame.id}
                              layout
                              initial={{opacity: 0, scale: 0.96, y: -6}}
                              animate={{opacity: 1, scale: 1, y: 0}}
                              exit={{opacity: 0, scale: 0.96, y: -6}}
                              transition={{duration: 0.18, ease: [0.16, 1, 0.3, 1]}}
                              className={`rounded-lg border p-2.5 ${
                                isTop
                                  ? 'border-blue-500/50 bg-blue-500/10'
                                  : 'border-[#232936] bg-[#0b0d12]'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate font-mono text-xs font-semibold text-gray-100">
                                  {frame.functionName}()
                                </span>
                                <span className="shrink-0 font-mono text-[11px] text-gray-400 tabular-nums">
                                  Line {frame.line}
                                </span>
                              </div>
                              {frame.returnValue !== undefined && (
                                <div className="mt-1.5 inline-block rounded border border-amber-500/35 bg-amber-500/12 px-2 py-0.5 font-mono text-[11px] text-amber-300">
                                  returns {frame.returnValue}
                                </div>
                              )}
                            </motion.div>
                          );
                        })}
                      </AnimatePresence>
                    </div>
                  </div>

                  {/* Variables, Memory & Array Grid */}
                  <div className="rounded-xl border border-[#222733] bg-[#141820] p-3 xl:col-span-7">
                    <div className="mb-2.5 flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-200">
                        Variables, Arrays &amp; Memory
                      </span>
                      {activeStep.changedVariables.length > 0 && (
                        <span className="font-mono text-[11px] text-blue-300 tabular-nums">
                          {activeStep.changedVariables.length} updated
                        </span>
                      )}
                    </div>

                    <div className="space-y-3">
                      {activeStep.stack.length === 0 ? (
                        <div className="rounded-lg border border-[#232936] bg-[#0b0d12] p-3 text-xs text-gray-500">
                          No active stack frame.
                        </div>
                      ) : (
                        [...activeStep.stack].reverse().map((frame) => (
                          <div key={`vars-${frame.id}`} className="space-y-2">
                            {activeStep.stack.length > 1 && (
                              <div className="font-mono text-[11px] font-medium text-gray-400">
                                {frame.functionName}() scope
                              </div>
                            )}
                            {frame.locals.length === 0 ? (
                              <div className="rounded-lg border border-[#232936] bg-[#0b0d12] px-3 py-2 text-xs text-gray-500">
                                No local variables in {frame.functionName} yet.
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {frame.locals.map((v) => (
                                  <VariableCard
                                    key={`${frame.id}-${v.name}`}
                                    variable={v}
                                    changeInfo={changedLookup.get(`${frame.functionName}:${v.name}`)}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                {/* Live Input / Output Stream */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-[#222733] bg-[#141820] p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-200">
                        Input Stream (stdin)
                      </span>
                      {activeStep.ioEvent?.kind === 'stdin' && (
                        <span className="font-mono text-[11px] text-cyan-300">
                          Read: {JSON.stringify(activeStep.ioEvent.text)}
                        </span>
                      )}
                    </div>
                    <div className="min-h-[54px] rounded-lg border border-[#232936] bg-[#0b0d12] p-2.5 font-mono text-xs text-gray-200">
                      {activeStdinTokens.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {activeStdinTokens.map((tok, i) => (
                            <span
                              key={`${tok}-${i}`}
                              className="rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-cyan-300"
                            >
                              {tok}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="font-sans text-gray-500">(no custom input provided)</span>
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-[#222733] bg-[#141820] p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-200">
                        <Terminal className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                        <span>Live Output (stdout)</span>
                      </div>
                      {activeStep.ioEvent?.kind === 'stdout' && (
                        <span className="font-mono text-[11px] text-emerald-400">
                          +{JSON.stringify(activeStep.ioEvent.text.trimEnd())}
                        </span>
                      )}
                    </div>
                    <pre className="min-h-[54px] overflow-auto rounded-lg border border-[#232936] bg-[#0b0d12] p-2.5 whitespace-pre-wrap font-mono text-xs text-emerald-200">
                      {activeStep.stdoutSoFar.length > 0
                        ? activeStep.stdoutSoFar
                        : '(no output emitted yet)'}
                    </pre>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
