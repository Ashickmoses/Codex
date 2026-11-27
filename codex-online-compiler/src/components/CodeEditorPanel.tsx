import Editor, {type Monaco, type OnMount} from '@monaco-editor/react';
import {
  Check,
  ChevronDown,
  Code2,
  Download,
  Eraser,
  RotateCcw,
  Settings,
  X,
} from 'lucide-react';
import type {editor as MonacoEditorType} from 'monaco-editor';
import {useEffect, useMemo, useRef, useState} from 'react';
import type {
  EditorSettings,
  LanguageConfig,
  LanguageKey,
} from '../types/compiler.ts';

interface TraceHighlightState {
  activeLine: number | null;
  completedLines: number[];
}

interface CodeEditorPanelProps {
  languages: LanguageConfig[];
  selectedLanguage: LanguageConfig;
  code: string;
  settings: EditorSettings;
  jumpToLine: {line: number; nonce: number} | null;
  traceHighlight?: TraceHighlightState | null;
  onLanguageChange: (key: LanguageKey) => void;
  onCodeChange: (value: string) => void;
  onSettingsChange: (next: EditorSettings) => void;
  onResetCode: () => void;
  onClearCode: () => void;
  onDownloadCode: () => void;
  onRunShortcut: () => void;
}

export function CodeEditorPanel({
  languages,
  selectedLanguage,
  code,
  settings,
  jumpToLine,
  traceHighlight,
  onLanguageChange,
  onCodeChange,
  onSettingsChange,
  onResetCode,
  onClearCode,
  onDownloadCode,
  onRunShortcut,
}: CodeEditorPanelProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const languageMenuRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const runShortcutRef = useRef(onRunShortcut);

  const lineCount = useMemo(() => (code ? code.split(/\r\n|\r|\n/).length : 0), [code]);

  useEffect(() => {
    runShortcutRef.current = onRunShortcut;
  }, [onRunShortcut]);

  useEffect(() => {
    if (!settingsOpen && !languageMenuOpen) return;
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (settingsOpen && settingsRef.current && !settingsRef.current.contains(target)) {
        setSettingsOpen(false);
      }
      if (
        languageMenuOpen &&
        languageMenuRef.current &&
        !languageMenuRef.current.contains(target)
      ) {
        setLanguageMenuOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
        setLanguageMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [settingsOpen, languageMenuOpen]);

  useEffect(() => {
    if (!jumpToLine || !editorRef.current) return;
    const editor = editorRef.current;
    editor.revealLineInCenter(jumpToLine.line);
    editor.setPosition({lineNumber: jumpToLine.line, column: 1});
    editor.focus();
  }, [jumpToLine]);

  // Synchronize live execution trace line highlighting in Monaco Editor
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;
    const maxLines = model.getLineCount();

    if (
      !traceHighlight ||
      (traceHighlight.activeLine === null && traceHighlight.completedLines.length === 0)
    ) {
      decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
      return;
    }

    const decorations: MonacoEditorType.IModelDeltaDecoration[] = [];

    for (const line of traceHighlight.completedLines) {
      if (line >= 1 && line <= maxLines && line !== traceHighlight.activeLine) {
        decorations.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            className: 'codex-completed-trace-line',
            linesDecorationsClassName: 'codex-completed-trace-gutter',
          },
        });
      }
    }

    if (
      traceHighlight.activeLine !== null &&
      traceHighlight.activeLine >= 1 &&
      traceHighlight.activeLine <= maxLines
    ) {
      decorations.push({
        range: new monaco.Range(traceHighlight.activeLine, 1, traceHighlight.activeLine, 1),
        options: {
          isWholeLine: true,
          className: 'codex-active-trace-line',
          linesDecorationsClassName: 'codex-active-trace-gutter',
        },
      });
      editor.revealLineInCenterIfOutsideViewport(traceHighlight.activeLine);
    }

    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, decorations);
  }, [traceHighlight, code]);

  const handleBeforeMount = (monaco: Monaco) => {
    monaco.editor.defineTheme('codeforge-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        {token: 'comment', foreground: '64748b', fontStyle: 'italic'},
        {token: 'keyword', foreground: '7dd3fc'},
        {token: 'string', foreground: '86efac'},
        {token: 'number', foreground: 'fda4af'},
        {token: 'type', foreground: 'fde68a'},
        {token: 'identifier', foreground: 'e2e8f0'},
      ],
      colors: {
        'editor.background': '#0f1217',
        'editor.foreground': '#e6eaf2',
        'editorLineNumber.foreground': '#475569',
        'editorLineNumber.activeForeground': '#cbd5e1',
        'editor.lineHighlightBackground': '#161b24',
        'editor.selectionBackground': '#2563eb40',
        'editor.inactiveSelectionBackground': '#2563eb22',
        'editorCursor.foreground': '#60a5fa',
        'editorIndentGuide.background1': '#1e2430',
        'editorIndentGuide.activeBackground1': '#334155',
        'editorGutter.background': '#0f1217',
        'minimap.background': '#0f1217',
        'editorBracketMatch.background': '#2563eb33',
        'editorBracketMatch.border': '#60a5fa66',
      },
    });
  };

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      runShortcutRef.current();
    });
  };

  return (
    <section
      aria-label="Source Code Editor"
      className="flex h-full min-h-0 flex-col bg-[#0f1217]"
    >
      {/* Left Panel Header Toolbar */}
      <div className="flex h-13 shrink-0 items-center justify-between gap-3 border-b border-[#222733] bg-[#151921] px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-sm font-bold tracking-tight text-white">
            Codex
          </span>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-[#2a3140]" />

          {/* Custom Dark Language Dropdown */}
          <div className="relative" ref={languageMenuRef}>
            <button
              type="button"
              id="language-select"
              aria-haspopup="listbox"
              aria-expanded={languageMenuOpen}
              aria-label="Programming Language"
              onClick={() => setLanguageMenuOpen((prev) => !prev)}
              className={`inline-flex h-8.5 items-center gap-2 rounded-lg border px-3 text-xs font-semibold whitespace-nowrap transition-all duration-150 focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:outline-none ${
                languageMenuOpen
                  ? 'border-blue-500/60 bg-[#1a202c] text-white shadow-[0_0_0_1px_rgba(59,130,246,0.2)]'
                  : 'border-[#2a3140] bg-[#0e1116] text-gray-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:border-[#3b4559] hover:bg-[#141820]'
              }`}
            >
              <Code2 className="h-3.5 w-3.5 text-blue-400" aria-hidden="true" />
              <span>{selectedLanguage.label}</span>
              <span className="font-mono text-[11px] font-normal text-gray-400">
                {selectedLanguage.version}
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 text-gray-400 transition-transform duration-150 ${
                  languageMenuOpen ? 'rotate-180 text-blue-400' : ''
                }`}
                aria-hidden="true"
              />
            </button>

            {languageMenuOpen && (
              <div
                role="listbox"
                aria-label="Select programming language"
                className="absolute left-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-[#2b3242] bg-[#161a23] p-1.5 shadow-[0_18px_42px_rgba(0,0,0,0.65)]"
              >
                <div className="max-h-80 overflow-y-auto pr-0.5">
                  {languages.map((lang) => {
                    const isSelected = lang.key === selectedLanguage.key;
                    return (
                      <button
                        key={lang.key}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          onLanguageChange(lang.key);
                          setLanguageMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                          isSelected
                            ? 'bg-blue-500/15 text-blue-200'
                            : 'text-gray-200 hover:bg-[#1f2532] hover:text-white'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="font-semibold">{lang.label}</span>
                          <span className="truncate font-mono text-[11px] text-gray-400">
                            {lang.version}
                          </span>
                        </div>
                        {isSelected && (
                          <Check className="h-3.5 w-3.5 shrink-0 text-blue-400" aria-hidden="true" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Unboxed clean file metadata */}
          <div className="hidden items-center gap-2 truncate font-mono text-xs text-gray-400 sm:flex">
            <span className="truncate text-gray-300">{selectedLanguage.fileName}</span>
            <span aria-hidden="true" className="text-gray-600">
              ·
            </span>
            <span className="tabular-nums">{lineCount} lines</span>
          </div>
        </div>

        {/* Editor Actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Editor Settings Popover */}
          <div className="relative" ref={settingsRef}>
            <button
              type="button"
              onClick={() => setSettingsOpen((prev) => !prev)}
              aria-expanded={settingsOpen}
              title="Editor Settings"
              className={`inline-flex h-8.5 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium whitespace-nowrap transition-all duration-150 focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:outline-none ${
                settingsOpen
                  ? 'border-blue-500/60 bg-blue-500/15 text-blue-200'
                  : 'border-[#2a3140] bg-[#1a1f29] text-gray-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:border-[#3b4559] hover:bg-[#212734] hover:text-white'
              }`}
            >
              <Settings className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden xl:inline">Settings</span>
            </button>

            {settingsOpen && (
              <div
                role="dialog"
                aria-label="Editor Settings"
                className="absolute right-0 z-50 mt-2 w-72 rounded-xl border border-[#2b3242] bg-[#161a23] p-4 shadow-[0_18px_42px_rgba(0,0,0,0.65)]"
              >
                <div className="mb-3.5 flex items-center justify-between border-b border-[#242a37] pb-2.5">
                  <span className="text-xs font-semibold text-gray-100">
                    Editor Settings
                  </span>
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(false)}
                    className="rounded-md p-1 text-gray-400 transition-colors hover:bg-[#232936] hover:text-white"
                    aria-label="Close settings"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="space-y-3.5 text-xs">
                  <div className="flex items-center justify-between">
                    <label htmlFor="setting-font-size" className="text-gray-300">
                      Font Size
                    </label>
                    <select
                      id="setting-font-size"
                      value={settings.fontSize}
                      onChange={(e) =>
                        onSettingsChange({...settings, fontSize: Number(e.target.value)})
                      }
                      className="rounded-md border border-[#2d3546] bg-[#0e1116] px-2.5 py-1 font-mono text-gray-100 tabular-nums focus:border-blue-500 focus:outline-none"
                    >
                      {[12, 13, 14, 15, 16, 18, 20].map((size) => (
                        <option key={size} value={size}>
                          {size}px
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-gray-300">Tab Size</span>
                    <div className="flex items-center gap-1 rounded-md border border-[#2a3140] bg-[#0e1116] p-0.5">
                      {[2, 4].map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => onSettingsChange({...settings, tabSize: tab})}
                          className={`rounded px-2.5 py-1 font-mono text-[11px] transition-colors ${
                            settings.tabSize === tab
                              ? 'bg-blue-600 text-white'
                              : 'text-gray-400 hover:text-gray-200'
                          }`}
                        >
                          {tab} sp
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label htmlFor="setting-theme" className="text-gray-300">
                      Editor Theme
                    </label>
                    <select
                      id="setting-theme"
                      value={settings.theme}
                      onChange={(e) =>
                        onSettingsChange({
                          ...settings,
                          theme: e.target.value as EditorSettings['theme'],
                        })
                      }
                      className="rounded-md border border-[#2d3546] bg-[#0e1116] px-2.5 py-1 text-gray-100 focus:border-blue-500 focus:outline-none"
                    >
                      <option value="codeforge-dark">Obsidian Dark</option>
                      <option value="vs-dark">VS Code Dark</option>
                      <option value="hc-black">High Contrast</option>
                    </select>
                  </div>

                  <div className="space-y-2.5 border-t border-[#242a37] pt-3">
                    <label className="flex cursor-pointer items-center justify-between">
                      <span className="text-gray-300">Word Wrap</span>
                      <input
                        type="checkbox"
                        checked={settings.wordWrap === 'on'}
                        onChange={(e) =>
                          onSettingsChange({
                            ...settings,
                            wordWrap: e.target.checked ? 'on' : 'off',
                          })
                        }
                        className="h-4 w-4 accent-blue-500"
                      />
                    </label>

                    <label className="flex cursor-pointer items-center justify-between">
                      <span className="text-gray-300">Minimap</span>
                      <input
                        type="checkbox"
                        checked={settings.minimap}
                        onChange={(e) =>
                          onSettingsChange({...settings, minimap: e.target.checked})
                        }
                        className="h-4 w-4 accent-blue-500"
                      />
                    </label>

                    <label className="flex cursor-pointer items-center justify-between">
                      <span className="text-gray-300">Font Ligatures</span>
                      <input
                        type="checkbox"
                        checked={settings.fontLigatures}
                        onChange={(e) =>
                          onSettingsChange({...settings, fontLigatures: e.target.checked})
                        }
                        className="h-4 w-4 accent-blue-500"
                      />
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onResetCode}
            title="Reset to starter code"
            className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-[#2a3140] bg-[#1a1f29] px-2.5 text-xs font-medium whitespace-nowrap text-gray-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-all duration-150 hover:border-[#3b4559] hover:bg-[#212734] hover:text-white focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:outline-none"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden lg:inline">Reset</span>
          </button>

          <button
            type="button"
            onClick={onClearCode}
            title="Clear editor"
            className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-[#2a3140] bg-[#1a1f29] px-2.5 text-xs font-medium whitespace-nowrap text-gray-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-all duration-150 hover:border-[#3b4559] hover:bg-[#212734] hover:text-white focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:outline-none"
          >
            <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden lg:inline">Clear</span>
          </button>

          <button
            type="button"
            onClick={onDownloadCode}
            title={`Download ${selectedLanguage.fileName}`}
            className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-[#2a3140] bg-[#1a1f29] px-2.5 text-xs font-medium whitespace-nowrap text-gray-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-all duration-150 hover:border-[#3b4559] hover:bg-[#212734] hover:text-white focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:outline-none"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden xl:inline">Download</span>
          </button>
        </div>
      </div>

      {/* Monaco Editor Viewport */}
      <div className="relative min-h-0 flex-1 bg-[#0f1217]">
        <Editor
          height="100%"
          language={selectedLanguage.monacoLanguage}
          value={code}
          theme={settings.theme}
          beforeMount={handleBeforeMount}
          onMount={handleMount}
          onChange={(val) => onCodeChange(val ?? '')}
          loading={
            <div className="flex h-full items-center justify-center bg-[#0f1217] font-mono text-xs text-gray-400">
              Loading editor…
            </div>
          }
          options={{
            fontSize: settings.fontSize,
            tabSize: settings.tabSize,
            wordWrap: settings.wordWrap,
            minimap: {enabled: settings.minimap},
            fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
            fontLigatures: settings.fontLigatures,
            lineNumbers: 'on',
            autoIndent: 'full',
            matchBrackets: 'always',
            autoClosingBrackets: 'always',
            autoClosingQuotes: 'always',
            suggestOnTriggerCharacters: true,
            quickSuggestions: true,
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            padding: {top: 14, bottom: 14},
            renderLineHighlight: 'line',
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            automaticLayout: true,
          }}
        />
      </div>
    </section>
  );
}
