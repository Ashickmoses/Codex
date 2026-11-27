import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {LANGUAGE_MAP, SUPPORTED_LANGUAGES} from '../shared/compiler.ts';
import {CodeEditorPanel} from './components/CodeEditorPanel.tsx';
import {
  LiveVisualizerPanel,
  type PlaybackSpeed,
} from './components/LiveVisualizerPanel.tsx';
import {TestingPanel} from './components/TestingPanel.tsx';
import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
  type ExecuteResponse,
  type LanguageKey,
  type TestCaseItem,
  type TestCaseRunResult,
  type VisualizeResponse,
} from './types/compiler.ts';

const STORAGE_KEYS = {
  language: 'codeforge.selectedLanguage',
  settings: 'codeforge.editorSettings',
};

const MAX_CONCURRENT_EXECUTIONS = 2;

const SPEED_INTERVAL_MS: Record<PlaybackSpeed, number> = {
  0.5: 1600,
  1: 900,
  2: 450,
  4: 220,
};

function createTestCaseId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readStoredLanguage(): LanguageKey {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEYS.language);
    if (saved && saved in LANGUAGE_MAP) {
      return saved as LanguageKey;
    }
  } catch {
    // Ignore storage read errors
  }
  return 'java';
}

function readStoredSettings(): EditorSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.settings);
    if (!raw) return DEFAULT_EDITOR_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<EditorSettings>;
    return {
      fontSize:
        typeof parsed.fontSize === 'number' && parsed.fontSize >= 12 && parsed.fontSize <= 24
          ? parsed.fontSize
          : DEFAULT_EDITOR_SETTINGS.fontSize,
      tabSize:
        parsed.tabSize === 2 || parsed.tabSize === 4
          ? parsed.tabSize
          : DEFAULT_EDITOR_SETTINGS.tabSize,
      wordWrap:
        parsed.wordWrap === 'on' || parsed.wordWrap === 'off'
          ? parsed.wordWrap
          : DEFAULT_EDITOR_SETTINGS.wordWrap,
      minimap:
        typeof parsed.minimap === 'boolean' ? parsed.minimap : DEFAULT_EDITOR_SETTINGS.minimap,
      fontLigatures:
        typeof parsed.fontLigatures === 'boolean'
          ? parsed.fontLigatures
          : DEFAULT_EDITOR_SETTINGS.fontLigatures,
      theme:
        parsed.theme === 'codeforge-dark' ||
        parsed.theme === 'vs-dark' ||
        parsed.theme === 'hc-black'
          ? parsed.theme
          : DEFAULT_EDITOR_SETTINGS.theme,
    };
  } catch {
    return DEFAULT_EDITOR_SETTINGS;
  }
}

export default function App() {
  const [selectedLangKey, setSelectedLangKey] = useState<LanguageKey>(readStoredLanguage);
  const [codeByLanguage, setCodeByLanguage] = useState<Partial<Record<LanguageKey, string>>>(() => {
    const initialLang = readStoredLanguage();
    return {[initialLang]: LANGUAGE_MAP[initialLang].starterCode};
  });
  const [settings, setSettings] = useState<EditorSettings>(readStoredSettings);

  const [testCases, setTestCases] = useState<TestCaseItem[]>(() => [
    {
      id: createTestCaseId(),
      stdin: '',
      expectedOutput: '',
    },
  ]);
  const [resultsByCaseId, setResultsByCaseId] = useState<Record<string, TestCaseRunResult>>({});
  const [isRunningAll, setIsRunningAll] = useState(false);
  const [progressCount, setProgressCount] = useState({completed: 0, total: 0});

  // Live Visualization state (split-view right pane)
  const [rightPanelMode, setRightPanelMode] = useState<'testing' | 'visualizer'>('testing');
  const [vizCaseIndex, setVizCaseIndex] = useState(0);
  const [isTracing, setIsTracing] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traceData, setTraceData] = useState<VisualizeResponse | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1);

  const [jumpToLine, setJumpToLine] = useState<{line: number; nonce: number} | null>(null);
  const [leftWidthPct, setLeftWidthPct] = useState(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const isRunningRef = useRef(false);
  const selectedLanguage = LANGUAGE_MAP[selectedLangKey];
  const currentCode = codeByLanguage[selectedLangKey] ?? selectedLanguage.starterCode;

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.language, selectedLangKey);
    } catch {
      // Ignore storage write errors
    }
  }, [selectedLangKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
    } catch {
      // Ignore storage write errors
    }
  }, [settings]);

  const handleLanguageChange = (nextKey: LanguageKey) => {
    setSelectedLangKey(nextKey);
    setCodeByLanguage((prev) => ({
      ...prev,
      [nextKey]: prev[nextKey] ?? LANGUAGE_MAP[nextKey].starterCode,
    }));
    setResultsByCaseId({});
    setTraceData(null);
    setTraceError(null);
    setIsPlaying(false);
    setCurrentStepIndex(0);
  };

  const handleCodeChange = (value: string) => {
    setCodeByLanguage((prev) => ({
      ...prev,
      [selectedLangKey]: value,
    }));
  };

  const handleResetCode = () => {
    setCodeByLanguage((prev) => ({
      ...prev,
      [selectedLangKey]: selectedLanguage.starterCode,
    }));
    setTraceData(null);
    setIsPlaying(false);
    setCurrentStepIndex(0);
  };

  const handleClearCode = () => {
    setCodeByLanguage((prev) => ({
      ...prev,
      [selectedLangKey]: '',
    }));
    setTraceData(null);
    setIsPlaying(false);
    setCurrentStepIndex(0);
  };

  const handleDownloadCode = () => {
    const blob = new Blob([currentCode], {type: 'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = selectedLanguage.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleAddTestCase = () => {
    setTestCases((prev) => [
      ...prev,
      {
        id: createTestCaseId(),
        stdin: '',
        expectedOutput: '',
      },
    ]);
  };

  const handleRemoveTestCase = (id: string) => {
    setTestCases((prev) => {
      if (prev.length <= 1) return prev;
      const filtered = prev.filter((tc) => tc.id !== id);
      setVizCaseIndex((currIdx) => Math.min(currIdx, filtered.length - 1));
      return filtered;
    });
    setResultsByCaseId((prev) => {
      const next = {...prev};
      delete next[id];
      return next;
    });
  };

  const handleUpdateTestCase = (
    id: string,
    field: 'stdin' | 'expectedOutput',
    value: string,
  ) => {
    setTestCases((prev) =>
      prev.map((tc) => (tc.id === id ? {...tc, [field]: value} : tc)),
    );
  };

  const executeOneCase = useCallback(
    async (tc: TestCaseItem): Promise<TestCaseRunResult> => {
      try {
        const response = await fetch('/api/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            languageKey: selectedLangKey,
            sourceCode: currentCode,
            stdin: tc.stdin,
            expectedOutput: tc.expectedOutput,
          }),
        });

        const payload = (await response.json().catch(() => null)) as
          | ExecuteResponse
          | {error?: string}
          | null;

        if (!response.ok) {
          const message =
            payload && 'error' in payload && payload.error
              ? payload.error
              : `Execution failed with status ${response.status}.`;
          return {
            status: 'error',
            response: null,
            requestError: message,
          };
        }

        return {
          status: 'completed',
          response: payload as ExecuteResponse,
          requestError: null,
        };
      } catch (err) {
        return {
          status: 'error',
          response: null,
          requestError:
            err instanceof Error ? err.message : 'Network error while executing code.',
        };
      }
    },
    [currentCode, selectedLangKey],
  );

  const runCasesList = useCallback(
    async (casesToRun: TestCaseItem[], clearOtherResults: boolean) => {
      if (isRunningRef.current || casesToRun.length === 0) return;

      if (!currentCode.trim()) {
        const errorState: Record<string, TestCaseRunResult> = {};
        for (const tc of casesToRun) {
          errorState[tc.id] = {
            status: 'error',
            response: null,
            requestError: 'Source code cannot be empty.',
          };
        }
        setResultsByCaseId((prev) => (clearOtherResults ? errorState : {...prev, ...errorState}));
        return;
      }

      isRunningRef.current = true;
      setIsRunningAll(true);
      setProgressCount({completed: 0, total: casesToRun.length});

      setResultsByCaseId((prev) => {
        const next: Record<string, TestCaseRunResult> = clearOtherResults ? {} : {...prev};
        for (const tc of casesToRun) {
          next[tc.id] = {
            status: 'running',
            response: null,
            requestError: null,
          };
        }
        return next;
      });

      let nextIndex = 0;
      const runWorker = async () => {
        while (nextIndex < casesToRun.length) {
          const idx = nextIndex++;
          const tc = casesToRun[idx];
          const caseResult = await executeOneCase(tc);
          setResultsByCaseId((prev) => ({
            ...prev,
            [tc.id]: caseResult,
          }));
          setProgressCount((prev) => ({
            ...prev,
            completed: prev.completed + 1,
          }));
        }
      };

      const workerCount = Math.min(MAX_CONCURRENT_EXECUTIONS, casesToRun.length);
      try {
        await Promise.all(Array.from({length: workerCount}, () => runWorker()));
      } finally {
        isRunningRef.current = false;
        setIsRunningAll(false);
      }
    },
    [currentCode, executeOneCase],
  );

  const handleRunAll = useCallback(() => {
    void runCasesList(testCases, true);
  }, [runCasesList, testCases]);

  const handleRunSingleCase = useCallback(
    (caseId: string) => {
      const target = testCases.find((tc) => tc.id === caseId);
      if (!target) return;
      void runCasesList([target], false);
    },
    [runCasesList, testCases],
  );

  // Trigger real sandboxed execution trace for Live Visualization
  const runVisualizeTrace = useCallback(
    async (caseIdxOverride?: number) => {
      const idx = caseIdxOverride ?? vizCaseIndex;
      const targetCase = testCases[idx] ?? testCases[0];
      const stdinForTrace = targetCase?.stdin ?? '';

      setRightPanelMode('visualizer');
      setIsPlaying(false);
      setCurrentStepIndex(0);
      setTraceError(null);

      if (!currentCode.trim()) {
        setTraceData(null);
        setTraceError('Source code cannot be empty.');
        return;
      }

      setIsTracing(true);
      try {
        const res = await fetch('/api/visualize', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            languageKey: selectedLangKey,
            sourceCode: currentCode,
            stdin: stdinForTrace,
          }),
        });
        const payload = (await res.json().catch(() => null)) as
          | VisualizeResponse
          | {error?: string}
          | null;

        if (!res.ok) {
          const msg =
            payload && 'error' in payload && payload.error
              ? payload.error
              : `Tracing failed with status ${res.status}.`;
          setTraceData(null);
          setTraceError(msg);
          return;
        }

        const data = payload as VisualizeResponse;
        setTraceData(data);
        setCurrentStepIndex(0);
        if (data.steps.length > 0) {
          setIsPlaying(true);
        }
      } catch (err) {
        setTraceData(null);
        setTraceError(
          err instanceof Error ? err.message : 'Network error while tracing execution.',
        );
      } finally {
        setIsTracing(false);
      }
    },
    [currentCode, selectedLangKey, testCases, vizCaseIndex],
  );

  // Auto-advance video-like playback timer
  useEffect(() => {
    if (rightPanelMode !== 'visualizer' || !isPlaying || !traceData || traceData.steps.length === 0) {
      return;
    }
    const intervalMs = SPEED_INTERVAL_MS[playbackSpeed];
    const timer = window.setInterval(() => {
      setCurrentStepIndex((prev) => {
        if (prev >= traceData.steps.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [rightPanelMode, isPlaying, traceData, playbackSpeed]);

  // Compute live Monaco line highlight & completed lines from active trace step
  const traceHighlight = useMemo(() => {
    if (rightPanelMode !== 'visualizer' || !traceData || traceData.steps.length === 0) {
      return null;
    }
    const activeStep = traceData.steps[currentStepIndex];
    if (!activeStep) return null;

    const completedSet = new Set<number>();
    for (let i = 0; i < currentStepIndex; i++) {
      completedSet.add(traceData.steps[i].line);
    }

    return {
      activeLine: activeStep.line,
      completedLines: Array.from(completedSet),
    };
  }, [rightPanelMode, traceData, currentStepIndex]);

  // Global Ctrl + Enter / Cmd + Enter shortcut runs all test cases
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        handleRunAll();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleRunAll]);

  // Resizable split-panel mouse tracking
  useEffect(() => {
    if (!isDraggingSplit) return;

    const handleMouseMove = (event: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((event.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(75, Math.max(25, pct));
      setLeftWidthPct(clamped);
    };

    const handleMouseUp = () => {
      setIsDraggingSplit(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingSplit]);

  return (
    <main
      ref={containerRef}
      style={{
        ['--left-pane-width' as string]: `${leftWidthPct}%`,
        ['--right-pane-width' as string]: `${100 - leftWidthPct}%`,
      }}
      className={`flex h-screen w-screen flex-col overflow-hidden bg-[#0b0d11] md:flex-row ${
        isDraggingSplit ? 'select-none' : ''
      }`}
    >
      {/* Left Panel (Monaco Code Editor with Live Trace Line Sync) */}
      <div className="h-[50vh] w-full shrink-0 md:h-full md:w-[var(--left-pane-width)]">
        <CodeEditorPanel
          languages={SUPPORTED_LANGUAGES}
          selectedLanguage={selectedLanguage}
          code={currentCode}
          settings={settings}
          jumpToLine={jumpToLine}
          traceHighlight={traceHighlight}
          onLanguageChange={handleLanguageChange}
          onCodeChange={handleCodeChange}
          onSettingsChange={setSettings}
          onResetCode={handleResetCode}
          onClearCode={handleClearCode}
          onDownloadCode={handleDownloadCode}
          onRunShortcut={handleRunAll}
        />
      </div>

      {/* Resizable Divider */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize editor and output panels"
        aria-valuenow={Math.round(leftWidthPct)}
        aria-valuemin={25}
        aria-valuemax={75}
        onMouseDown={() => setIsDraggingSplit(true)}
        onDoubleClick={() => setLeftWidthPct(50)}
        title="Drag to resize panels (double-click to reset 50/50)"
        className={`group hidden w-2 shrink-0 cursor-col-resize items-center justify-center border-x border-[#222733] bg-[#131720] transition-colors hover:bg-blue-500/20 md:flex ${
          isDraggingSplit ? 'bg-blue-500/30' : ''
        }`}
      >
        <div
          className={`h-10 w-0.5 rounded-full transition-colors ${
            isDraggingSplit
              ? 'bg-blue-400'
              : 'bg-[#333c4d] group-hover:bg-blue-400/80'
          }`}
        />
      </div>

      {/* Right Panel (Switches cleanly between Test Cases & Live Visualizer) */}
      <div className="min-h-0 flex-1 border-t border-[#222733] md:h-full md:w-[var(--right-pane-width)] md:border-t-0">
        {rightPanelMode === 'visualizer' ? (
          <LiveVisualizerPanel
            language={selectedLanguage}
            testCases={testCases}
            selectedCaseIndex={vizCaseIndex}
            isTracing={isTracing}
            traceError={traceError}
            traceData={traceData}
            currentStepIndex={currentStepIndex}
            isPlaying={isPlaying}
            speed={playbackSpeed}
            onBackToTesting={() => {
              setIsPlaying(false);
              setRightPanelMode('testing');
            }}
            onSelectCaseIndex={(idx) => {
              setVizCaseIndex(idx);
              void runVisualizeTrace(idx);
            }}
            onRetrace={() => void runVisualizeTrace()}
            onPlayPause={() => {
              if (!traceData || traceData.steps.length === 0) return;
              if (!isPlaying && currentStepIndex >= traceData.steps.length - 1) {
                setCurrentStepIndex(0);
                setIsPlaying(true);
              } else {
                setIsPlaying((p) => !p);
              }
            }}
            onNextStep={() => {
              if (!traceData) return;
              setIsPlaying(false);
              setCurrentStepIndex((i) => Math.min(traceData.steps.length - 1, i + 1));
            }}
            onPrevStep={() => {
              setIsPlaying(false);
              setCurrentStepIndex((i) => Math.max(0, i - 1));
            }}
            onRestart={() => {
              setIsPlaying(false);
              setCurrentStepIndex(0);
            }}
            onSeekStep={(idx) => {
              setIsPlaying(false);
              setCurrentStepIndex(idx);
            }}
            onSpeedChange={setPlaybackSpeed}
            onJumpToLine={(line) => setJumpToLine({line, nonce: Date.now()})}
          />
        ) : (
          <TestingPanel
            testCases={testCases}
            resultsByCaseId={resultsByCaseId}
            isRunningAll={isRunningAll}
            progressCount={progressCount}
            onAddTestCase={handleAddTestCase}
            onRemoveTestCase={handleRemoveTestCase}
            onUpdateTestCase={handleUpdateTestCase}
            onRunAll={handleRunAll}
            onRunSingleCase={handleRunSingleCase}
            onVisualize={() => void runVisualizeTrace()}
          />
        )}
      </div>
    </main>
  );
}
