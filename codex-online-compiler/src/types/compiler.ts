import type {
  ExecuteResponse,
  ExecutionTraceStep,
  ExecutionVerdict,
  LanguageConfig,
  LanguageKey,
  TraceEventKind,
  TraceStackFrame,
  TraceVariableChange,
  TraceVariableValue,
  VisualizeResponse,
} from '../../shared/compiler.ts';

export type {
  ExecuteResponse,
  ExecutionTraceStep,
  ExecutionVerdict,
  LanguageConfig,
  LanguageKey,
  TraceEventKind,
  TraceStackFrame,
  TraceVariableChange,
  TraceVariableValue,
  VisualizeResponse,
};

export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  wordWrap: 'on' | 'off';
  minimap: boolean;
  fontLigatures: boolean;
  theme: 'codeforge-dark' | 'vs-dark' | 'hc-black';
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 14,
  tabSize: 4,
  wordWrap: 'off',
  minimap: true,
  fontLigatures: true,
  theme: 'codeforge-dark',
};

export interface TestCaseItem {
  id: string;
  stdin: string;
  expectedOutput: string;
}

export interface TestCaseRunResult {
  status: 'idle' | 'running' | 'completed' | 'error';
  response: ExecuteResponse | null;
  requestError: string | null;
}
