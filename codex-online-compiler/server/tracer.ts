import * as acorn from 'acorn';
import {
  TRACE_SUPPORTED_LANGUAGES,
  type ExecutionTraceStep,
  type LanguageKey,
  type TraceEventKind,
  type TraceStackFrame,
  type TraceVariableChange,
  type TraceVariableValue,
  type VisualizeResponse,
} from '../shared/compiler.ts';

export const TRACE_MARKER_START = '__CODEX_TRACE_START__';
export const TRACE_MARKER_END = '__CODEX_TRACE_END__';
export const STEP_LINE_PREFIX = '__CODEX_STEP__:';
const MAX_TRACE_STEPS = 300;

export interface Judge0RawResult {
  stdout: string;
  stderr: string;
  compileOutput: string;
  message: string;
  time: string | null;
  memory: number | null;
  statusId: number | null;
  statusDescription: string;
}

export type Judge0SubmitFn = (params: {
  languageId: number;
  sourceCode: string;
  stdin: string;
}) => Promise<Judge0RawResult>;

interface RawTraceEvent {
  line: number;
  eventKind: TraceEventKind;
  stack: TraceStackFrame[];
  conditionEval?: {expression: string; result: boolean};
  loopInfo?: {iteration: number; header: string};
  ioEvent?: {kind: 'stdin' | 'stdout'; text: string};
  stdoutSoFar?: string;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatVarListSummary(stack: TraceStackFrame[]): string {
  if (stack.length === 0) return 'No active variables in scope yet.';
  const top = stack[stack.length - 1];
  if (top.locals.length === 0) {
    return `No local variables in ${top.functionName}.`;
  }
  return top.locals
    .slice(0, 6)
    .map((v) => `${v.name} = ${v.displayValue}`)
    .join(', ');
}

function inferLinePurpose(
  codeLine: string,
  eventKind: TraceEventKind,
  conditionEval?: {expression: string; result: boolean},
  loopInfo?: {iteration: number; header: string},
  ioEvent?: {kind: 'stdin' | 'stdout'; text: string},
  topFrame?: TraceStackFrame,
): {whatLineDoes: string; whyExecuting: string} {
  const trimmed = codeLine.trim();
  const fnName = topFrame?.functionName || 'program';

  if (eventKind === 'exception') {
    return {
      whatLineDoes: `A runtime error occurred while executing "${trimmed}".`,
      whyExecuting: `Execution inside ${fnName} encountered an invalid operation or exception.`,
    };
  }

  if (eventKind === 'call') {
    const args = topFrame?.locals.map((v) => `${v.name}=${v.displayValue}`).join(', ');
    return {
      whatLineDoes: `Enters function "${fnName}"${args ? ` with ${args}` : ''}.`,
      whyExecuting: `A function call pushed a new stack frame for "${fnName}" onto the call stack.`,
    };
  }

  if (eventKind === 'return') {
    const retText =
      topFrame?.returnValue !== undefined ? ` returning ${topFrame.returnValue}` : '';
    return {
      whatLineDoes: `Finishes "${fnName}"${retText}.`,
      whyExecuting: `The return statement completes this function frame and hands control back to the caller.`,
    };
  }

  if (conditionEval) {
    return {
      whatLineDoes: `Evaluates condition "${conditionEval.expression}" → ${conditionEval.result ? 'true' : 'false'}.`,
      whyExecuting: conditionEval.result
        ? 'Because the condition is true, execution enters the matching branch.'
        : 'Because the condition is false, this branch is skipped.',
    };
  }

  if (loopInfo) {
    return {
      whatLineDoes: `Runs loop iteration #${loopInfo.iteration} (${loopInfo.header}).`,
      whyExecuting: `The loop condition remains true, so execution repeats the loop body.`,
    };
  }

  if (ioEvent?.kind === 'stdout') {
    return {
      whatLineDoes: `Outputs ${JSON.stringify(ioEvent.text.trimEnd())} to standard output.`,
      whyExecuting: `Reached output statement inside ${fnName}.`,
    };
  }

  if (
    ioEvent?.kind === 'stdin' ||
    /(Scanner|scanf|cin\s*>>|input\s*\(|sys\.stdin|readFileSync\s*\(\s*0)/i.test(trimmed)
  ) {
    return {
      whatLineDoes: `Reads input data from standard input (stdin).`,
      whyExecuting: `Program requests user/test input during normal flow inside ${fnName}.`,
    };
  }

  if (/^else\b/.test(trimmed)) {
    return {
      whatLineDoes: `Enters the fallback "else" branch.`,
      whyExecuting: `The preceding if/else-if condition evaluated to false.`,
    };
  }

  if (/(=|\+\+|--|\+=|-=|\*=|\/=)/.test(trimmed) && !/^(if|while|for)\b/.test(trimmed)) {
    return {
      whatLineDoes: `Updates variable or array state with "${trimmed}".`,
      whyExecuting: `Sequential execution reached this statement inside ${fnName}.`,
    };
  }

  return {
    whatLineDoes: `Executes "${trimmed || `line`}" inside ${fnName}.`,
    whyExecuting: `Normal top-to-bottom execution flow inside ${fnName}.`,
  };
}

function finalizeTraceSteps(
  rawEvents: RawTraceEvent[],
  sourceCode: string,
  finalStdoutFallback: string,
): ExecutionTraceStep[] {
  const lines = sourceCode.replace(/\r\n/g, '\n').split('\n');
  const prevValuesByFrame = new Map<string, Map<string, string>>();
  let prevStdout = '';

  const steps: ExecutionTraceStep[] = rawEvents.map((ev, index) => {
    const lineIdx = Math.max(1, Math.min(lines.length, ev.line || 1));
    const codeLine = (lines[lineIdx - 1] ?? '').trim();

    const changedVariables: TraceVariableChange[] = [];
    const nextFrameMap = new Map<string, Map<string, string>>();

    for (const frame of ev.stack) {
      const frameKey = `${frame.id}:${frame.functionName}`;
      const prevLocals = prevValuesByFrame.get(frameKey) ?? new Map<string, string>();
      const currLocals = new Map<string, string>();

      for (const local of frame.locals) {
        currLocals.set(local.name, local.displayValue);
        const prevVal = prevLocals.get(local.name);
        if (prevVal !== local.displayValue) {
          changedVariables.push({
            name: local.name,
            scope: frame.functionName,
            previousValue: prevVal ?? null,
            newValue: local.displayValue,
          });
        }
      }

      nextFrameMap.set(frameKey, currLocals);
    }

    prevValuesByFrame.clear();
    for (const [k, v] of nextFrameMap.entries()) {
      prevValuesByFrame.set(k, v);
    }

    const stdoutSoFar = ev.stdoutSoFar !== undefined ? ev.stdoutSoFar : prevStdout;
    let ioEvent = ev.ioEvent;
    if (!ioEvent && stdoutSoFar.length > prevStdout.length) {
      ioEvent = {
        kind: 'stdout',
        text: stdoutSoFar.slice(prevStdout.length),
      };
    }
    prevStdout = stdoutSoFar;

    const topFrame = ev.stack[ev.stack.length - 1];
    const {whatLineDoes, whyExecuting} = inferLinePurpose(
      codeLine,
      ev.eventKind,
      ev.conditionEval,
      ev.loopInfo,
      ioEvent,
      topFrame,
    );

    const changeNote =
      changedVariables.length > 0
        ? `Updated: ${changedVariables
            .slice(0, 4)
            .map((c) => `${c.name}: ${c.previousValue ?? 'unset'} → ${c.newValue}`)
            .join('; ')}. `
        : '';

    return {
      stepIndex: index,
      line: lineIdx,
      codeLine,
      eventKind: ev.eventKind,
      stack: ev.stack,
      changedVariables,
      conditionEval: ev.conditionEval,
      loopInfo: ev.loopInfo,
      ioEvent,
      stdoutSoFar,
      explanation: {
        whatLineDoes,
        whyExecuting,
        variableSummary: `${changeNote}Current scope: ${formatVarListSummary(ev.stack)}`,
        whatNext: '',
      },
    };
  });

  for (let i = 0; i < steps.length; i++) {
    const curr = steps[i];
    const next = steps[i + 1];
    if (!next) {
      curr.explanation.whatNext =
        curr.eventKind === 'exception'
          ? 'Execution stops due to the runtime error.'
          : 'Program finishes execution.';
    } else if (next.eventKind === 'call') {
      const nextFn = next.stack[next.stack.length - 1]?.functionName ?? 'function';
      curr.explanation.whatNext = `Next: Enters "${nextFn}" on line ${next.line}.`;
    } else if (next.eventKind === 'return') {
      const nextFn = next.stack[next.stack.length - 1]?.functionName ?? 'function';
      curr.explanation.whatNext = `Next: Returns from "${nextFn}" on line ${next.line}.`;
    } else {
      curr.explanation.whatNext = `Next: Executes line ${next.line}${next.codeLine ? ` (${next.codeLine})` : ''}.`;
    }
  }

  // Ensure final step reflects full stdout if runtime didn't stream per-line stdout (e.g. C/C++)
  if (steps.length > 0 && finalStdoutFallback && !steps[steps.length - 1].stdoutSoFar) {
    steps[steps.length - 1].stdoutSoFar = finalStdoutFallback;
  }

  return steps;
}

/* ============================================================================
 * 1. PYTHON TRACER (sys.settrace inside Judge0)
 * ========================================================================== */

function buildPythonHarness(sourceCode: string, stdin: string): string {
  const codeB64 = Buffer.from(sourceCode, 'utf8').toString('base64');
  const stdinB64 = Buffer.from(stdin, 'utf8').toString('base64');

  return `import sys, io, json, base64, builtins

_USER_CODE = base64.b64decode("${codeB64}").decode("utf-8")
_USER_STDIN = base64.b64decode("${stdinB64}").decode("utf-8")
_SOURCE_LINES = _USER_CODE.splitlines()
_MAX_STEPS = ${MAX_TRACE_STEPS}
_STEPS = []
_TRUNCATED = False
_LOOP_COUNTS = {}
_REAL_STDERR = sys.__stderr__

class _CodexStdout(io.TextIOBase):
    def __init__(self):
        self.buf = io.StringIO()
    def write(self, s):
        self.buf.write(s)
        sys.__stdout__.write(s)
        return len(s)
    def flush(self):
        sys.__stdout__.flush()
    def getvalue(self):
        return self.buf.getvalue()

_stdout_capture = _CodexStdout()
_stdin_stream = io.StringIO(_USER_STDIN)
sys.stdout = _stdout_capture
sys.stdin = _stdin_stream

_orig_input = builtins.input
_pending_stdin_event = None

def _codex_input(prompt=""):
    global _pending_stdin_event
    if prompt:
        _stdout_capture.write(str(prompt))
    line = _stdin_stream.readline()
    if line == "":
        raise EOFError("EOF when reading a line")
    val = line.rstrip("\\r\\n")
    _pending_stdin_event = {"kind": "stdin", "text": val}
    return val

builtins.input = _codex_input

def _short_repr(val, depth=0):
    if val is None:
        return "None"
    if isinstance(val, bool):
        return "True" if val else "False"
    if isinstance(val, (int, float)):
        return repr(val)
    if isinstance(val, str):
        r = repr(val)
        return r if len(r) <= 48 else r[:45] + "..."
    if depth >= 1:
        if isinstance(val, list):
            return f"list({len(val)})"
        if isinstance(val, dict):
            return f"dict({len(val)})"
        return type(val).__name__
    if isinstance(val, (list, tuple)):
        items = [_short_repr(x, depth + 1) for x in list(val)[:10]]
        suffix = ", ..." if len(val) > 10 else ""
        return ("[" + ", ".join(items) + suffix + "]") if isinstance(val, list) else ("(" + ", ".join(items) + suffix + ")")
    if isinstance(val, dict):
        items = [f"{_short_repr(k, 1)}: {_short_repr(v, 1)}" for k, v in list(val.items())[:6]]
        suffix = ", ..." if len(val) > 6 else ""
        return "{" + ", ".join(items) + suffix + "}"
    s = repr(val)
    return s if len(s) <= 48 else s[:45] + "..."

def _serialize_var(name, val):
    addr = hex(id(val))
    if val is None:
        return {"name": name, "type": "null", "displayValue": "None", "memoryAddress": addr}
    if isinstance(val, (bool, int, float, str)):
        return {"name": name, "type": "primitive", "displayValue": _short_repr(val), "memoryAddress": addr}
    if isinstance(val, (list, tuple, set)):
        seq = list(val)
        elems = [{"index": i, "value": _short_repr(item)} for i, item in enumerate(seq[:24])]
        return {
            "name": name,
            "type": "array",
            "displayValue": _short_repr(val),
            "elements": elems,
            "memoryAddress": addr,
        }
    if isinstance(val, dict):
        props = [{"key": str(k), "value": _short_repr(v)} for k, v in list(val.items())[:16]]
        return {
            "name": name,
            "type": "object",
            "displayValue": _short_repr(val),
            "properties": props,
            "memoryAddress": addr,
        }
    if hasattr(val, "__dict__"):
        props = [{"key": str(k), "value": _short_repr(v)} for k, v in list(val.__dict__.items())[:12] if not str(k).startswith("__")]
        return {
            "name": name,
            "type": "object",
            "displayValue": f"{type(val).__name__} instance",
            "properties": props,
            "memoryAddress": addr,
        }
    return {"name": name, "type": "object", "displayValue": _short_repr(val), "memoryAddress": addr}

def _extract_locals(frame):
    out = []
    for k, v in frame.f_locals.items():
        if k.startswith("__") and k.endswith("__"):
            continue
        if callable(v) or type(v).__name__ == "module" or isinstance(v, type):
            continue
        out.append(_serialize_var(str(k), v))
    return out

def _build_stack(frame, event, arg):
    frames = []
    cur = frame
    while cur is not None:
        if cur.f_code.co_filename == "<user_code>":
            fn_name = cur.f_code.co_name
            if fn_name == "<module>":
                fn_name = "main (module)"
            entry = {
                "id": str(id(cur)),
                "functionName": fn_name,
                "line": cur.f_lineno,
                "locals": _extract_locals(cur),
            }
            if cur is frame and event == "return":
                entry["returnValue"] = _short_repr(arg)
            frames.append(entry)
        cur = cur.f_back
    frames.reverse()
    return frames

class _TraceLimitStop(BaseException):
    pass

_runtime_error = None

def _tracer(frame, event, arg):
    global _TRUNCATED, _pending_stdin_event
    if frame.f_code.co_filename != "<user_code>":
        return None
    if event not in ("call", "line", "return", "exception"):
        return _tracer
    if len(_STEPS) >= _MAX_STEPS:
        _TRUNCATED = True
        sys.settrace(None)
        return None

    lineno = frame.f_lineno
    raw_line = _SOURCE_LINES[lineno - 1].strip() if 1 <= lineno <= len(_SOURCE_LINES) else ""
    kind = event
    loop_info = None
    cond_eval = None

    if event == "line":
        if raw_line.startswith(("for ", "while ")):
            _LOOP_COUNTS[lineno] = _LOOP_COUNTS.get(lineno, 0) + 1
            kind = "loop"
            loop_info = {"iteration": _LOOP_COUNTS[lineno], "header": raw_line.rstrip(":")}
        elif raw_line.startswith(("if ", "elif ")):
            kind = "condition"
            expr = raw_line[3:].rstrip(":").strip() if raw_line.startswith("if ") else raw_line[5:].rstrip(":").strip()
            try:
                res = bool(eval(expr, frame.f_globals, frame.f_locals))
                cond_eval = {"expression": expr, "result": res}
            except Exception:
                pass

    step = {
        "line": lineno,
        "eventKind": kind,
        "stack": _build_stack(frame, event, arg),
        "stdoutSoFar": _stdout_capture.getvalue(),
    }
    if cond_eval is not None:
        step["conditionEval"] = cond_eval
    if loop_info is not None:
        step["loopInfo"] = loop_info
    if _pending_stdin_event is not None:
        step["ioEvent"] = _pending_stdin_event
        _pending_stdin_event = None

    _STEPS.append(step)
    return _tracer

try:
    _compiled = compile(_USER_CODE, "<user_code>", "exec")
    _ns = {"__name__": "__main__", "__builtins__": builtins}
    sys.settrace(_tracer)
    exec(_compiled, _ns, _ns)
except SyntaxError as e:
    sys.settrace(None)
    _runtime_error = {"type": "COMPILATION_ERROR", "message": f"SyntaxError at line {e.lineno}: {e.msg}"}
except Exception as e:
    sys.settrace(None)
    tb = sys.exc_info()[2]
    err_line = 1
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == "<user_code>":
            err_line = tb.tb_lineno
        tb = tb.tb_next
    _runtime_error = {"type": "RUNTIME_ERROR", "message": f"{type(e).__name__} at line {err_line}: {e}"}
finally:
    sys.settrace(None)
    builtins.input = _orig_input

_payload = {
    "steps": _STEPS,
    "truncated": _TRUNCATED,
    "finalStdout": _stdout_capture.getvalue(),
    "error": _runtime_error,
}
_REAL_STDERR.write("\\n${TRACE_MARKER_START}\\n")
_REAL_STDERR.write(json.dumps(_payload))
_REAL_STDERR.write("\\n${TRACE_MARKER_END}\\n")
_REAL_STDERR.flush()
`;
}

async function tracePython(
  sourceCode: string,
  stdin: string,
  submitToJudge0: Judge0SubmitFn,
): Promise<VisualizeResponse> {
  const harness = buildPythonHarness(sourceCode, stdin);
  const raw = await submitToJudge0({
    languageId: 100,
    sourceCode: harness,
    stdin: '',
  });

  if (raw.statusId === 5) {
    return {
      supported: true,
      truncated: false,
      totalSteps: 0,
      steps: [],
      finalStdout: raw.stdout,
      stderr: raw.stderr,
      compileOutput: '',
      errorType: 'TIME_LIMIT_EXCEEDED',
      errorMessage: 'Time Limit Exceeded while tracing Python execution.',
      time: raw.time,
      memory: raw.memory,
    };
  }

  const markerRegex = new RegExp(
    `${escapeRegExp(TRACE_MARKER_START)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(TRACE_MARKER_END)}`,
  );
  const match = raw.stderr.match(markerRegex);
  if (!match?.[1]) {
    return {
      supported: true,
      truncated: false,
      totalSteps: 0,
      steps: [],
      finalStdout: raw.stdout,
      stderr: raw.stderr,
      compileOutput: raw.compileOutput,
      errorType: 'RUNTIME_ERROR',
      errorMessage: raw.stderr || raw.message || 'Failed to trace Python program.',
      time: raw.time,
      memory: raw.memory,
    };
  }

  const parsed = JSON.parse(match[1]) as {
    steps: RawTraceEvent[];
    truncated: boolean;
    finalStdout: string;
    error: {type: 'COMPILATION_ERROR' | 'RUNTIME_ERROR'; message: string} | null;
  };

  const steps = finalizeTraceSteps(parsed.steps, sourceCode, parsed.finalStdout);

  return {
    supported: true,
    truncated: parsed.truncated,
    totalSteps: steps.length,
    steps,
    finalStdout: parsed.finalStdout,
    stderr: parsed.error?.message ?? '',
    compileOutput: '',
    errorType: parsed.error?.type,
    errorMessage: parsed.error?.message,
    time: raw.time,
    memory: raw.memory,
  };
}

/* ============================================================================
 * 2. JAVASCRIPT TRACER (Acorn AST instrumentation + Judge0 Node 22)
 * ========================================================================== */

interface AstNode {
  type: string;
  start: number;
  end: number;
  loc?: {start: {line: number; column: number}; end: {line: number; column: number}};
  [key: string]: unknown;
}

function collectPatternNames(pattern: AstNode | null | undefined, out: Set<string>): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      out.add(String(pattern.name));
      break;
    case 'AssignmentPattern':
      collectPatternNames(pattern.left as AstNode, out);
      break;
    case 'RestElement':
      collectPatternNames(pattern.argument as AstNode, out);
      break;
    case 'ArrayPattern':
      for (const elem of (pattern.elements as Array<AstNode | null>) ?? []) {
        collectPatternNames(elem, out);
      }
      break;
    case 'ObjectPattern':
      for (const prop of (pattern.properties as AstNode[]) ?? []) {
        if (prop.type === 'RestElement') {
          collectPatternNames(prop.argument as AstNode, out);
        } else {
          collectPatternNames(prop.value as AstNode, out);
        }
      }
      break;
  }
}

function collectDeclaredVarsInNodeList(nodes: AstNode[], out: Set<string>): void {
  for (const node of nodes) {
    if (!node) continue;
    if (node.type === 'VariableDeclaration') {
      for (const decl of (node.declarations as AstNode[]) ?? []) {
        collectPatternNames(decl.id as AstNode, out);
      }
    } else if (node.type === 'FunctionDeclaration' && node.id) {
      collectPatternNames(node.id as AstNode, out);
    }
  }
}

function buildSnapshotExpr(varNames: string[]): string {
  if (varNames.length === 0) return '() => ({})';
  const entries = varNames.map((name) => {
    return `${JSON.stringify(name)}: (() => { try { return typeof ${name} === "function" ? undefined : ${name}; } catch { return "__TDZ__"; } })()`;
  });
  return `() => ({ ${entries.join(', ')} })`;
}

function instrumentJsProgram(sourceCode: string): string {
  const ast = acorn.parse(sourceCode, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    locations: true,
  }) as unknown as AstNode;

  const edits: Array<{start: number; end: number; text: string}> = [];

  const getSlice = (node: AstNode) => sourceCode.slice(node.start, node.end);

  function transformFunctionBody(fnNode: AstNode, outerVars: Set<string>): void {
    const fnName =
      (fnNode.id as AstNode | undefined)?.name
        ? String((fnNode.id as AstNode).name)
        : 'anonymous';
    const params = new Set<string>(outerVars);
    for (const p of (fnNode.params as AstNode[]) ?? []) {
      collectPatternNames(p, params);
    }
    const body = fnNode.body as AstNode;
    const line = fnNode.loc?.start.line ?? 1;

    if (body.type === 'BlockStatement') {
      const bodyStmts = (body.body as AstNode[]) ?? [];
      const blockVars = new Set<string>(params);
      collectDeclaredVarsInNodeList(bodyStmts, blockVars);
      const snap = buildSnapshotExpr([...blockVars]);
      edits.push({
        start: body.start + 1,
        end: body.start + 1,
        text: `\n__codexEnter(${JSON.stringify(fnName)}, ${line}, ${snap});\ntry {\n`,
      });
      edits.push({
        start: body.end - 1,
        end: body.end - 1,
        text: `\n} finally { __codexExit(); }\n`,
      });
      transformStatements(bodyStmts, blockVars, fnName);
    } else {
      // Expression-body arrow function
      const snap = buildSnapshotExpr([...params]);
      edits.push({
        start: body.start,
        end: body.end,
        text: `(() => { __codexEnter(${JSON.stringify(fnName)}, ${line}, ${snap}); try { const __r = (${getSlice(body)}); __codexReturn(${line}, __r, ${snap}); return __r; } finally { __codexExit(); } })()`,
      });
    }
  }

  function visitNestedFunctions(node: unknown, visibleVars: Set<string>): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visitNestedFunctions(item, visibleVars);
      return;
    }
    const astNode = node as AstNode;
    if (
      astNode.type === 'FunctionDeclaration' ||
      astNode.type === 'FunctionExpression' ||
      astNode.type === 'ArrowFunctionExpression'
    ) {
      transformFunctionBody(astNode, visibleVars);
      return;
    }
    for (const key of Object.keys(astNode)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
      visitNestedFunctions(astNode[key], visibleVars);
    }
  }

  function transformStatement(stmt: AstNode, visibleVars: Set<string>, fnName: string): void {
    const line = stmt.loc?.start.line ?? 1;
    const snap = buildSnapshotExpr([...visibleVars]);

    switch (stmt.type) {
      case 'FunctionDeclaration': {
        transformFunctionBody(stmt, visibleVars);
        break;
      }
      case 'BlockStatement': {
        const stmts = (stmt.body as AstNode[]) ?? [];
        const innerVars = new Set<string>(visibleVars);
        collectDeclaredVarsInNodeList(stmts, innerVars);
        transformStatements(stmts, innerVars, fnName);
        break;
      }
      case 'VariableDeclaration': {
        visitNestedFunctions(stmt.declarations, visibleVars);
        edits.push({
          start: stmt.end,
          end: stmt.end,
          text: `\n__codexStep(${line}, "line", ${snap});`,
        });
        break;
      }
      case 'ExpressionStatement': {
        visitNestedFunctions(stmt.expression, visibleVars);
        edits.push({
          start: stmt.end,
          end: stmt.end,
          text: `\n__codexStep(${line}, "line", ${snap});`,
        });
        break;
      }
      case 'IfStatement': {
        const testNode = stmt.test as AstNode;
        const testSrc = getSlice(testNode);
        edits.push({
          start: testNode.start,
          end: testNode.end,
          text: `__codexCond(${line}, ${JSON.stringify(testSrc)}, Boolean(${testSrc}), ${snap})`,
        });
        const cons = stmt.consequent as AstNode;
        if (cons.type !== 'BlockStatement') {
          edits.push({start: cons.start, end: cons.start, text: '{ '});
          edits.push({start: cons.end, end: cons.end, text: ' }'});
        }
        transformStatement(cons, visibleVars, fnName);

        const alt = stmt.alternate as AstNode | null;
        if (alt) {
          if (alt.type !== 'BlockStatement' && alt.type !== 'IfStatement') {
            edits.push({start: alt.start, end: alt.start, text: '{ '});
            edits.push({start: alt.end, end: alt.end, text: ' }'});
          }
          transformStatement(alt, visibleVars, fnName);
        }
        break;
      }
      case 'ForStatement':
      case 'WhileStatement':
      case 'DoWhileStatement': {
        const loopVars = new Set<string>(visibleVars);
        if (stmt.type === 'ForStatement' && stmt.init) {
          const initNode = stmt.init as AstNode;
          if (initNode.type === 'VariableDeclaration') {
            for (const d of (initNode.declarations as AstNode[]) ?? []) {
              collectPatternNames(d.id as AstNode, loopVars);
            }
          }
        }
        const loopSnap = buildSnapshotExpr([...loopVars]);
        const headerText = sourceCode
          .slice(stmt.start, (stmt.body as AstNode).start)
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/\{$/, '')
          .trim();

        const body = stmt.body as AstNode;
        const loopCounterCall = `__codexLoop(${line}, ${JSON.stringify(headerText)}, ${loopSnap});`;

        if (body.type === 'BlockStatement') {
          edits.push({
            start: body.start + 1,
            end: body.start + 1,
            text: `\n${loopCounterCall}\n`,
          });
          transformStatement(body, loopVars, fnName);
        } else {
          edits.push({
            start: body.start,
            end: body.start,
            text: `{ ${loopCounterCall} `,
          });
          edits.push({start: body.end, end: body.end, text: ' }'});
          transformStatement(body, loopVars, fnName);
        }
        break;
      }
      case 'ForOfStatement':
      case 'ForInStatement': {
        const loopVars = new Set<string>(visibleVars);
        const left = stmt.left as AstNode;
        if (left.type === 'VariableDeclaration') {
          for (const d of (left.declarations as AstNode[]) ?? []) {
            collectPatternNames(d.id as AstNode, loopVars);
          }
        }
        const loopSnap = buildSnapshotExpr([...loopVars]);
        const headerText = sourceCode
          .slice(stmt.start, (stmt.body as AstNode).start)
          .replace(/\s+/g, ' ')
          .trim();
        const body = stmt.body as AstNode;
        const loopCounterCall = `__codexLoop(${line}, ${JSON.stringify(headerText)}, ${loopSnap});`;
        if (body.type === 'BlockStatement') {
          edits.push({start: body.start + 1, end: body.start + 1, text: `\n${loopCounterCall}\n`});
          transformStatement(body, loopVars, fnName);
        } else {
          edits.push({start: body.start, end: body.start, text: `{ ${loopCounterCall} `});
          edits.push({start: body.end, end: body.end, text: ' }'});
          transformStatement(body, loopVars, fnName);
        }
        break;
      }
      case 'ReturnStatement': {
        const arg = stmt.argument as AstNode | null;
        if (arg) {
          visitNestedFunctions(arg, visibleVars);
          const argSrc = getSlice(arg);
          edits.push({
            start: stmt.start,
            end: stmt.end,
            text: `{ const __codexRet = (${argSrc}); __codexReturn(${line}, __codexRet, ${snap}); return __codexRet; }`,
          });
        } else {
          edits.push({
            start: stmt.start,
            end: stmt.end,
            text: `{ __codexReturn(${line}, undefined, ${snap}); return; }`,
          });
        }
        break;
      }
      case 'TryStatement': {
        if (stmt.block) transformStatement(stmt.block as AstNode, visibleVars, fnName);
        if (stmt.handler) {
          const handler = stmt.handler as AstNode;
          const catchVars = new Set<string>(visibleVars);
          if (handler.param) collectPatternNames(handler.param as AstNode, catchVars);
          transformStatement(handler.body as AstNode, catchVars, fnName);
        }
        if (stmt.finalizer) transformStatement(stmt.finalizer as AstNode, visibleVars, fnName);
        break;
      }
      default:
        break;
    }
  }

  function transformStatements(stmts: AstNode[], visibleVars: Set<string>, fnName: string): void {
    for (const st of stmts) {
      transformStatement(st, visibleVars, fnName);
    }
  }

  const rootStmts = (ast.body as AstNode[]) ?? [];
  const topVars = new Set<string>();
  collectDeclaredVarsInNodeList(rootStmts, topVars);
  transformStatements(rootStmts, topVars, 'main (global)');

  // Apply edits back-to-front
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let instrumented = sourceCode;
  for (const e of edits) {
    instrumented = instrumented.slice(0, e.start) + e.text + instrumented.slice(e.end);
  }
  return instrumented;
}

function buildJsHarness(instrumentedCode: string, stdin: string): string {
  const stdinB64 = Buffer.from(stdin, 'utf8').toString('base64');
  const codeB64 = Buffer.from(instrumentedCode, 'utf8').toString('base64');

  return `
const fs = require('fs');
const util = require('util');
const vm = require('vm');

const __USER_STDIN = Buffer.from("${stdinB64}", "base64").toString("utf8");
const __INSTRUMENTED = Buffer.from("${codeB64}", "base64").toString("utf8");
const __MAX_STEPS = ${MAX_TRACE_STEPS};
const __STEPS = [];
let __TRUNCATED = false;
const __LOOP_COUNTS = new Map();
const __OBJ_IDS = new WeakMap();
let __NEXT_ID = 0x1000;
let __STDOUT = "";
let __PENDING_STDIN = null;

function __addrOf(val) {
  if (val === null || (typeof val !== "object" && typeof val !== "function")) return undefined;
  let id = __OBJ_IDS.get(val);
  if (!id) {
    __NEXT_ID += 16;
    id = "0x" + __NEXT_ID.toString(16);
    __OBJ_IDS.set(val, id);
  }
  return id;
}

function __shortStr(val, depth = 0) {
  if (val === undefined) return "undefined";
  if (val === null) return "null";
  if (typeof val === "string") {
    const j = JSON.stringify(val);
    return j.length <= 44 ? j : j.slice(0, 41) + '..."';
  }
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "bigint") {
    return String(val);
  }
  if (Array.isArray(val)) {
    if (depth >= 1) return "Array(" + val.length + ")";
    const items = val.slice(0, 10).map((x) => __shortStr(x, depth + 1));
    return "[" + items.join(", ") + (val.length > 10 ? ", ..." : "") + "]";
  }
  if (typeof val === "object") {
    if (depth >= 1) return "{...}";
    const keys = Object.keys(val).slice(0, 5);
    const parts = keys.map((k) => k + ": " + __shortStr(val[k], depth + 1));
    return "{ " + parts.join(", ") + (Object.keys(val).length > 5 ? ", ..." : "") + " }";
  }
  return String(val);
}

function __serializeLocals(obj) {
  if (!obj) return [];
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === "__TDZ__" || v === undefined || typeof v === "function") continue;
    const addr = __addrOf(v);
    if (v === null) {
      out.push({ name: k, type: "null", displayValue: "null" });
    } else if (Array.isArray(v)) {
      out.push({
        name: k,
        type: "array",
        displayValue: __shortStr(v),
        elements: v.slice(0, 24).map((el, i) => ({ index: i, value: __shortStr(el, 1) })),
        memoryAddress: addr,
      });
    } else if (typeof v === "object") {
      out.push({
        name: k,
        type: "object",
        displayValue: __shortStr(v),
        properties: Object.keys(v).slice(0, 16).map((pk) => ({ key: pk, value: __shortStr(v[pk], 1) })),
        memoryAddress: addr,
      });
    } else {
      out.push({ name: k, type: "primitive", displayValue: __shortStr(v) });
    }
  }
  return out;
}

const __STACK = [{ id: "root", functionName: "main (global)", line: 1, snapFn: () => ({}) }];

function __snapshotStack(overrideLine, returnVal) {
  return __STACK.map((frame, idx) => {
    let locals = [];
    try { locals = __serializeLocals(frame.snapFn()); } catch {}
    const isTop = idx === __STACK.length - 1;
    const entry = {
      id: frame.id,
      functionName: frame.functionName,
      line: isTop && overrideLine ? overrideLine : frame.line,
      locals,
    };
    if (isTop && returnVal !== undefined) {
      entry.returnValue = __shortStr(returnVal);
    }
    return entry;
  });
}

function __pushStep(step) {
  if (__STEPS.length >= __MAX_STEPS) {
    __TRUNCATED = true;
    return;
  }
  if (__PENDING_STDIN) {
    step.ioEvent = __PENDING_STDIN;
    __PENDING_STDIN = null;
  }
  __STEPS.push(step);
}

let __frameSeq = 1;
function __codexEnter(fnName, line, snapFn) {
  __STACK.push({ id: "f" + (++__frameSeq), functionName: fnName, line, snapFn });
  __pushStep({
    line,
    eventKind: "call",
    stack: __snapshotStack(line),
    stdoutSoFar: __STDOUT,
  });
}

function __codexExit() {
  if (__STACK.length > 1) __STACK.pop();
}

function __codexReturn(line, val, snapFn) {
  if (__STACK.length > 0) {
    __STACK[__STACK.length - 1].snapFn = snapFn;
    __STACK[__STACK.length - 1].line = line;
  }
  __pushStep({
    line,
    eventKind: "return",
    stack: __snapshotStack(line, val === undefined ? "undefined" : val),
    stdoutSoFar: __STDOUT,
  });
}

function __codexStep(line, kind, snapFn) {
  if (__STACK.length > 0) {
    __STACK[__STACK.length - 1].snapFn = snapFn;
    __STACK[__STACK.length - 1].line = line;
  }
  __pushStep({
    line,
    eventKind: kind || "line",
    stack: __snapshotStack(line),
    stdoutSoFar: __STDOUT,
  });
}

function __codexCond(line, expr, result, snapFn) {
  if (__STACK.length > 0) {
    __STACK[__STACK.length - 1].snapFn = snapFn;
    __STACK[__STACK.length - 1].line = line;
  }
  __pushStep({
    line,
    eventKind: "condition",
    stack: __snapshotStack(line),
    conditionEval: { expression: expr, result: Boolean(result) },
    stdoutSoFar: __STDOUT,
  });
  return Boolean(result);
}

function __codexLoop(line, header, snapFn) {
  const count = (__LOOP_COUNTS.get(line) || 0) + 1;
  __LOOP_COUNTS.set(line, count);
  if (__STACK.length > 0) {
    __STACK[__STACK.length - 1].snapFn = snapFn;
    __STACK[__STACK.length - 1].line = line;
  }
  __pushStep({
    line,
    eventKind: "loop",
    stack: __snapshotStack(line),
    loopInfo: { iteration: count, header },
    stdoutSoFar: __STDOUT,
  });
}

const __patchedFs = Object.create(fs);
const __origReadFileSync = fs.readFileSync.bind(fs);
__patchedFs.readFileSync = function(file, ...args) {
  if (file === 0 || file === "/dev/stdin") {
    __PENDING_STDIN = { kind: "stdin", text: __USER_STDIN };
    if (args[0] === "utf8" || args[0] === "utf-8" || (args[0] && args[0].encoding)) {
      return __USER_STDIN;
    }
    return Buffer.from(__USER_STDIN, "utf8");
  }
  return __origReadFileSync(file, ...args);
};

const __patchedConsole = {
  log: (...args) => {
    const line = util.format(...args) + "\\n";
    __STDOUT += line;
    process.stdout.write(line);
  },
  error: (...args) => {
    const line = util.format(...args) + "\\n";
    __STDOUT += line;
    process.stdout.write(line);
  },
  warn: (...args) => {
    const line = util.format(...args) + "\\n";
    __STDOUT += line;
    process.stdout.write(line);
  },
};

const __patchedRequire = (mod) => {
  if (mod === "fs" || mod === "node:fs") return __patchedFs;
  return require(mod);
};

let __runError = null;
try {
  const context = vm.createContext({
    console: __patchedConsole,
    require: __patchedRequire,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    parseInt,
    parseFloat,
    isNaN,
    __codexEnter,
    __codexExit,
    __codexReturn,
    __codexStep,
    __codexCond,
    __codexLoop,
  });
  vm.runInContext(__INSTRUMENTED, context, { timeout: 4000 });
} catch (err) {
  __runError = {
    type: "RUNTIME_ERROR",
    message: err && err.message ? (err.name + ": " + err.message) : String(err),
  };
}

process.stderr.write("\\n${TRACE_MARKER_START}\\n");
process.stderr.write(JSON.stringify({
  steps: __STEPS,
  truncated: __TRUNCATED,
  finalStdout: __STDOUT,
  error: __runError,
}));
process.stderr.write("\\n${TRACE_MARKER_END}\\n");
`;
}

async function traceJavaScript(
  sourceCode: string,
  stdin: string,
  submitToJudge0: Judge0SubmitFn,
): Promise<VisualizeResponse> {
  let instrumented: string;
  try {
    instrumented = instrumentJsProgram(sourceCode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Syntax error in JavaScript code.';
    return {
      supported: true,
      truncated: false,
      totalSteps: 0,
      steps: [],
      finalStdout: '',
      stderr: msg,
      compileOutput: msg,
      errorType: 'COMPILATION_ERROR',
      errorMessage: msg,
      time: null,
      memory: null,
    };
  }

  const harness = buildJsHarness(instrumented, stdin);
  const raw = await submitToJudge0({
    languageId: 102,
    sourceCode: harness,
    stdin: '',
  });

  if (raw.statusId === 5) {
    return {
      supported: true,
      truncated: false,
      totalSteps: 0,
      steps: [],
      finalStdout: raw.stdout,
      stderr: raw.stderr,
      compileOutput: '',
      errorType: 'TIME_LIMIT_EXCEEDED',
      errorMessage: 'Time Limit Exceeded while tracing JavaScript execution.',
      time: raw.time,
      memory: raw.memory,
    };
  }

  const markerRegex = new RegExp(
    `${escapeRegExp(TRACE_MARKER_START)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(TRACE_MARKER_END)}`,
  );
  const match = raw.stderr.match(markerRegex);
  if (!match?.[1]) {
    return {
      supported: true,
      truncated: false,
      totalSteps: 0,
      steps: [],
      finalStdout: raw.stdout,
      stderr: raw.stderr,
      compileOutput: raw.compileOutput,
      errorType: 'RUNTIME_ERROR',
      errorMessage: raw.stderr || 'Failed to capture JavaScript execution trace.',
      time: raw.time,
      memory: raw.memory,
    };
  }

  const parsed = JSON.parse(match[1]) as {
    steps: RawTraceEvent[];
    truncated: boolean;
    finalStdout: string;
    error: {type: 'COMPILATION_ERROR' | 'RUNTIME_ERROR'; message: string} | null;
  };

  const steps = finalizeTraceSteps(parsed.steps, sourceCode, parsed.finalStdout);

  return {
    supported: true,
    truncated: parsed.truncated,
    totalSteps: steps.length,
    steps,
    finalStdout: parsed.finalStdout,
    stderr: parsed.error?.message ?? '',
    compileOutput: '',
    errorType: parsed.error?.type,
    errorMessage: parsed.error?.message,
    time: raw.time,
    memory: raw.memory,
  };
}

/* ============================================================================
 * 3. TOKEN-AWARE BRACE INSTRUMENTER FOR JAVA, C, AND C++
 * ========================================================================== */

interface ScopeVar {
  name: string;
  typeExpr: string;
  isArray: boolean;
  arraySizeHint?: string;
  isParam?: boolean;
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

function computeLineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function getLineNumberAt(offsets: number[], pos: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= pos) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1;
}

/**
 * Masks comments and string/char literals with spaces (preserving \n and exact char indices!)
 * so structural parsing never triggers on text inside comments or quotes.
 */
function maskCommentsAndStrings(source: string): string {
  const chars = source.split('');
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (ch === '/' && next === '/') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < chars.length && chars[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] !== '\n') chars[i] = ' ';
        i++;
      }
      if (i + 1 < chars.length) {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      chars[i] = ' ';
      i++;
      while (i < chars.length) {
        if (chars[i] === '\\') {
          chars[i] = ' ';
          if (i + 1 < chars.length && chars[i + 1] !== '\n') chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        const cur = chars[i];
        if (cur !== '\n') chars[i] = ' ';
        i++;
        if (cur === quote) break;
      }
      continue;
    }
    i++;
  }
  return chars.join('');
}

function findMatchingDelimiter(
  masked: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    if (masked[i] === openChar) depth++;
    else if (masked[i] === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipWhitespace(str: string, pos: number, end: number): number {
  while (pos < end && /\s/.test(str[pos])) pos++;
  return pos;
}

function splitTopLevelParams(paramsText: string): Array<{typeExpr: string; name: string; isArray: boolean}> {
  const result: Array<{typeExpr: string; name: string; isArray: boolean}> = [];
  const trimmed = paramsText.trim();
  if (!trimmed || trimmed === 'void') return result;

  // Split by comma outside < > and ( )
  const parts: string[] = [];
  let depthAngle = 0;
  let depthParen = 0;
  let start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '<') depthAngle++;
    else if (ch === '>' && depthAngle > 0) depthAngle--;
    else if (ch === '(') depthParen++;
    else if (ch === ')' && depthParen > 0) depthParen--;
    else if (ch === ',' && depthAngle === 0 && depthParen === 0) {
      parts.push(trimmed.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(trimmed.slice(start).trim());

  for (const part of parts) {
    if (!part || part === '...') continue;
    // Handle `int arr[]` or `int[] arr` or `const vector<int>& arr` or `int *p`
    const isArray = /\[\s*\]/.test(part);
    const cleaned = part
      .replace(/\[\s*\]/g, '')
      .replace(/=\s*[^,]+$/, '')
      .trim();
    const match = cleaned.match(/^(.*?)([A-Za-z_][A-Za-z0-9_]*)$/);
    if (match) {
      result.push({
        typeExpr: match[1].trim(),
        name: match[2],
        isArray,
      });
    }
  }
  return result;
}

function parseDeclarationVars(
  maskedStmt: string,
  lang: 'java' | 'c' | 'cpp',
): ScopeVar[] {
  const trimmed = maskedStmt.trim();
  if (!trimmed) return [];
  // Ignore return, if, for, while, else, switch, case, break, continue, import, package, using
  if (
    /^(return|if|else|for|while|do|switch|case|default|break|continue|throw|try|catch|finally|import|package|using|typedef|struct|class|enum|public|private|protected)\b/.test(
      trimmed,
    )
  ) {
    return [];
  }

  // Match common variable declaration patterns:
  // e.g. `int a = 10, b = 20;` | `int[] arr = {1, 2};` | `int arr[5] = {1, 2};` | `vector<int> v;` | `long long sum = 0;`
  const typePrefixes =
    lang === 'java'
      ? /(?:final\s+)?(?:(?:ArrayList|LinkedList|List)\s*<[^>]+>|(?:var|int|long|short|byte|double|float|boolean|char|String|Integer|Long|Double|Scanner)\b)(?:\s*\[\s*\])?/
      : /(?:const\s+|static\s+|unsigned\s+|signed\s+)*(?:(?:vector|std::vector)\s*<[^>]+>|(?:auto|int|long\s+long|long|short|double|float|char|bool|size_t|string|std::string)\b)(?:\s*[*&]+)?/;

  const match = trimmed.match(new RegExp(`^(${typePrefixes.source})\\s+([\\s\\S]+);$`));
  if (!match) return [];

  const typeExpr = match[1].trim();
  const declList = match[2];
  const isTypeArray = /\[\s*\]/.test(typeExpr);

  // Split declarators at top-level commas (outside (), {}, [], <>)
  const declarators: string[] = [];
  let pDepth = 0;
  let bDepth = 0;
  let sDepth = 0;
  let aDepth = 0;
  let curStart = 0;
  for (let i = 0; i < declList.length; i++) {
    const ch = declList[i];
    if (ch === '(') pDepth++;
    else if (ch === ')') pDepth--;
    else if (ch === '{') bDepth++;
    else if (ch === '}') bDepth--;
    else if (ch === '[') sDepth++;
    else if (ch === ']') sDepth--;
    else if (ch === '<') aDepth++;
    else if (ch === '>' && aDepth > 0) aDepth--;
    else if (ch === ',' && pDepth === 0 && bDepth === 0 && sDepth === 0 && aDepth === 0) {
      declarators.push(declList.slice(curStart, i).trim());
      curStart = i + 1;
    }
  }
  declarators.push(declList.slice(curStart).trim());

  const vars: ScopeVar[] = [];
  for (const decl of declarators) {
    if (!decl) continue;
    const lhs = decl.split('=')[0].trim();
    const arrMatch = lhs.match(/^\*?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*([^\]]*)\s*\]$/);
    if (arrMatch) {
      vars.push({
        name: arrMatch[1],
        typeExpr,
        isArray: true,
        arraySizeHint: arrMatch[2].trim() || 'auto',
        isParam: false,
      });
      continue;
    }
    const scalarMatch = lhs.match(/^\*?\s*([A-Za-z_][A-Za-z0-9_]*)$/);
    if (scalarMatch) {
      vars.push({
        name: scalarMatch[1],
        typeExpr,
        isArray: isTypeArray || /vector\s*</.test(typeExpr),
        isParam: false,
      });
    }
  }
  return vars;
}

function instrumentJavaSource(sourceCode: string): string {
  const masked = maskCommentsAndStrings(sourceCode);
  const lineOffsets = computeLineOffsets(sourceCode);
  const edits: TextEdit[] = [];

  // Find `public class Main` (or first class) opening brace
  const classMatch = masked.match(/\bclass\s+[A-Za-z_][A-Za-z0-9_]*[^{]*\{/);
  if (!classMatch || classMatch.index === undefined) {
    throw new Error('Could not locate Java class body.');
  }
  const classOpen = classMatch.index + classMatch[0].length - 1;
  const classClose = findMatchingDelimiter(masked, classOpen, '{', '}');
  if (classClose === -1) {
    throw new Error('Unmatched brace in Java class.');
  }

  function snapshotCall(vars: ScopeVar[]): string {
    const filtered = vars.filter((v) => !/\bScanner\b/.test(v.typeExpr));
    if (filtered.length === 0) return 'new String[0]';
    const args = filtered.map((v) => `${JSON.stringify(v.name)}, __CodexTracer.val(${v.name})`);
    return `new String[]{ ${args.join(', ')} }`;
  }

  function instrumentBlock(
    blockOpen: number,
    blockClose: number,
    outerVars: ScopeVar[],
    currentReturnType: string,
  ): void {
    const scopeVars: ScopeVar[] = [...outerVars];
    let pos = blockOpen + 1;

    while (pos < blockClose) {
      pos = skipWhitespace(masked, pos, blockClose);
      if (pos >= blockClose) break;

      if (masked[pos] === '{') {
        const innerClose = findMatchingDelimiter(masked, pos, '{', '}');
        if (innerClose === -1 || innerClose > blockClose) break;
        instrumentBlock(pos, innerClose, scopeVars, currentReturnType);
        pos = innerClose + 1;
        continue;
      }

      const rest = masked.slice(pos, blockClose);

      // `if (...)` / `else if (...)` / `else`
      const ifMatch = rest.match(/^(?:else\s+)?if\s*\(/);
      if (ifMatch) {
        const parenOpen = pos + ifMatch[0].length - 1;
        const parenClose = findMatchingDelimiter(masked, parenOpen, '(', ')');
        if (parenClose === -1) break;
        const line = getLineNumberAt(lineOffsets, pos);
        const condExprRaw = sourceCode.slice(parenOpen + 1, parenClose).trim();
        edits.push({
          start: parenOpen + 1,
          end: parenClose,
          text: `__CodexTracer.cond(${line}, ${JSON.stringify(condExprRaw)}, (${condExprRaw}), ${snapshotCall(scopeVars)})`,
        });

        let bodyStart = skipWhitespace(masked, parenClose + 1, blockClose);
        if (masked[bodyStart] === '{') {
          const bodyClose = findMatchingDelimiter(masked, bodyStart, '{', '}');
          if (bodyClose === -1) break;
          instrumentBlock(bodyStart, bodyClose, scopeVars, currentReturnType);
          pos = bodyClose + 1;
        } else {
          // Single-statement if branch -> wrap in { }
          const semi = findNextStatementEnd(masked, bodyStart, blockClose);
          edits.push({start: bodyStart, end: bodyStart, text: '{ '});
          edits.push({start: semi, end: semi, text: ' }'});
          instrumentSingleStatement(bodyStart, semi, scopeVars, currentReturnType);
          pos = semi;
        }
        continue;
      }

      const elseMatch = rest.match(/^else\b/);
      if (elseMatch) {
        const line = getLineNumberAt(lineOffsets, pos);
        let bodyStart = skipWhitespace(masked, pos + 4, blockClose);
        if (masked[bodyStart] === '{') {
          const bodyClose = findMatchingDelimiter(masked, bodyStart, '{', '}');
          if (bodyClose === -1) break;
          edits.push({
            start: bodyStart + 1,
            end: bodyStart + 1,
            text: `\n__CodexTracer.step(${line}, "line", ${snapshotCall(scopeVars)});\n`,
          });
          instrumentBlock(bodyStart, bodyClose, scopeVars, currentReturnType);
          pos = bodyClose + 1;
        } else {
          const semi = findNextStatementEnd(masked, bodyStart, blockClose);
          edits.push({
            start: bodyStart,
            end: bodyStart,
            text: `{ __CodexTracer.step(${line}, "line", ${snapshotCall(scopeVars)}); `,
          });
          edits.push({start: semi, end: semi, text: ' }'});
          instrumentSingleStatement(bodyStart, semi, scopeVars, currentReturnType);
          pos = semi;
        }
        continue;
      }

      // `for (...)` or `while (...)`
      const loopMatch = rest.match(/^(for|while)\s*\(/);
      if (loopMatch) {
        const parenOpen = pos + loopMatch[0].length - 1;
        const parenClose = findMatchingDelimiter(masked, parenOpen, '(', ')');
        if (parenClose === -1) break;
        const line = getLineNumberAt(lineOffsets, pos);
        const loopVars = [...scopeVars];
        if (loopMatch[1] === 'for') {
          const insideParen = masked.slice(parenOpen + 1, parenClose);
          const firstSemi = insideParen.indexOf(';');
          if (firstSemi !== -1) {
            const initDecl = parseDeclarationVars(insideParen.slice(0, firstSemi + 1), 'java');
            loopVars.push(...initDecl);
          }
        }
        const headerText = sourceCode
          .slice(pos, parenClose + 1)
          .replace(/\s+/g, ' ')
          .trim();
        const bodyStart = skipWhitespace(masked, parenClose + 1, blockClose);
        const loopCall = `__CodexTracer.loop(${line}, ${JSON.stringify(headerText)}, ${snapshotCall(loopVars)});`;

        if (masked[bodyStart] === '{') {
          const bodyClose = findMatchingDelimiter(masked, bodyStart, '{', '}');
          if (bodyClose === -1) break;
          edits.push({start: bodyStart + 1, end: bodyStart + 1, text: `\n${loopCall}\n`});
          instrumentBlock(bodyStart, bodyClose, loopVars, currentReturnType);
          pos = bodyClose + 1;
        } else {
          const semi = findNextStatementEnd(masked, bodyStart, blockClose);
          edits.push({start: bodyStart, end: bodyStart, text: `{ ${loopCall} `});
          edits.push({start: semi, end: semi, text: ' }'});
          instrumentSingleStatement(bodyStart, semi, loopVars, currentReturnType);
          pos = semi;
        }
        continue;
      }

      // Simple statement up to `;`
      const stmtEnd = findNextStatementEnd(masked, pos, blockClose);
      instrumentSingleStatement(pos, stmtEnd, scopeVars, currentReturnType);
      pos = stmtEnd;
    }
  }

  function findNextStatementEnd(maskedText: string, start: number, limit: number): number {
    let pDepth = 0;
    let bDepth = 0;
    for (let i = start; i < limit; i++) {
      const ch = maskedText[i];
      if (ch === '(') pDepth++;
      else if (ch === ')' && pDepth > 0) pDepth--;
      else if (ch === '{') bDepth++;
      else if (ch === '}' && bDepth > 0) bDepth--;
      else if (ch === ';' && pDepth === 0 && bDepth === 0) {
        return i + 1;
      }
    }
    return limit;
  }

  function instrumentSingleStatement(
    start: number,
    end: number,
    scopeVars: ScopeVar[],
    currentReturnType: string,
  ): void {
    const stmtMasked = masked.slice(start, end).trim();
    if (!stmtMasked || stmtMasked === ';') return;
    const line = getLineNumberAt(lineOffsets, start);

    // Check return statement
    const retMatch = stmtMasked.match(/^return\b([\s\S]*);$/);
    if (retMatch) {
      const exprRaw = sourceCode.slice(start, end).trim().replace(/^return\b/, '').replace(/;$/, '').trim();
      if (!exprRaw || currentReturnType === 'void') {
        edits.push({
          start,
          end,
          text: `{ __CodexTracer.ret(${line}, "void", ${snapshotCall(scopeVars)}); return; }`,
        });
      } else {
        edits.push({
          start,
          end,
          text: `return __CodexTracer.retVal(${line}, (${exprRaw}), ${snapshotCall(scopeVars)});`,
        });
      }
      return;
    }

    // Check variable declarations added by this statement
    const newVars = parseDeclarationVars(stmtMasked, 'java');
    for (const nv of newVars) {
      if (!scopeVars.some((existing) => existing.name === nv.name)) {
        scopeVars.push(nv);
      }
    }

    edits.push({
      start: end,
      end,
      text: `\n__CodexTracer.step(${line}, "line", ${snapshotCall(scopeVars)});`,
    });
  }

  // Scan methods inside class body
  let cursor = classOpen + 1;
  while (cursor < classClose) {
    cursor = skipWhitespace(masked, cursor, classClose);
    if (cursor >= classClose) break;

    // Skip class-level field declarations ending in `;` before any `{`
    let nextSemi = -1;
    let nextBrace = -1;
    for (let k = cursor; k < classClose; k++) {
      if (masked[k] === ';' && nextSemi === -1) nextSemi = k;
      if (masked[k] === '{') {
        nextBrace = k;
        break;
      }
    }

    if (nextBrace === -1) break;
    if (nextSemi !== -1 && nextSemi < nextBrace) {
      cursor = nextSemi + 1;
      continue;
    }

    const headerMasked = masked.slice(cursor, nextBrace).trim();
    const bodyClose = findMatchingDelimiter(masked, nextBrace, '{', '}');
    if (bodyClose === -1) break;

    const sigMatch = headerMasked.match(
      /(?:^|\s)([A-Za-z_][A-Za-z0-9_<>\[\]\s]*?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*(?:throws\s+[\s\S]*)?$/,
    );

    if (sigMatch && !/\bclass\b/.test(headerMasked)) {
      const returnType = sigMatch[1].trim().split(/\s+/).pop() || 'void';
      const methodName = sigMatch[2].trim();
      const params = splitTopLevelParams(sigMatch[3]).map<ScopeVar>((p) => ({
        name: p.name,
        typeExpr: p.typeExpr,
        isArray: p.isArray,
      }));
      const line = getLineNumberAt(lineOffsets, cursor);
      const paramSnap = snapshotCall(params);

      edits.push({
        start: nextBrace + 1,
        end: nextBrace + 1,
        text:
          methodName === 'main'
            ? `\n__CodexTracer.initStdout();\n__CodexTracer.enter(${JSON.stringify(methodName)}, ${line}, ${paramSnap});\ntry {\n`
            : `\n__CodexTracer.enter(${JSON.stringify(methodName)}, ${line}, ${paramSnap});\ntry {\n`,
      });
      edits.push({
        start: bodyClose,
        end: bodyClose,
        text:
          methodName === 'main'
            ? `\n} finally { __CodexTracer.exit(); __CodexTracer.flushTrace(); }\n`
            : `\n} finally { __CodexTracer.exit(); }\n`,
      });

      instrumentBlock(nextBrace, bodyClose, params, returnType);
    }

    cursor = bodyClose + 1;
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let instrumented = sourceCode;
  for (const e of edits) {
    instrumented = instrumented.slice(0, e.start) + e.text + instrumented.slice(e.end);
  }

  const tracerClass = `
class __CodexTracer {
    private static final int MAX_STEPS = ${MAX_TRACE_STEPS};
    private static final java.util.List<String> steps = new java.util.ArrayList<>();
    private static final java.util.Deque<Frame> stack = new java.util.ArrayDeque<>();
    private static final java.util.Map<Integer, Integer> loopCounts = new java.util.HashMap<>();
    private static java.io.ByteArrayOutputStream outBuf;
    private static java.io.PrintStream origOut;
    private static java.io.PrintStream origErr;
    private static boolean initialized = false;
    private static boolean truncated = false;
    private static int frameSeq = 0;

    static class Frame {
        String id;
        String name;
        int line;
        String[] vars = new String[0];
        String returnValue;
    }

    public static synchronized void initStdout() {
        if (initialized) return;
        initialized = true;
        origOut = System.out;
        origErr = System.err;
        outBuf = new java.io.ByteArrayOutputStream();
        System.setOut(new java.io.PrintStream(new java.io.OutputStream() {
            @Override public void write(int b) { origOut.write(b); outBuf.write(b); }
            @Override public void write(byte[] b, int off, int len) { origOut.write(b, off, len); outBuf.write(b, off, len); }
            @Override public void flush() { origOut.flush(); }
        }, true));
    }

    public static String val(int v) { return "P:" + v; }
    public static String val(long v) { return "P:" + v; }
    public static String val(double v) { return "P:" + v; }
    public static String val(float v) { return "P:" + v; }
    public static String val(boolean v) { return "P:" + v; }
    public static String val(char v) { return "P:'" + v + "'"; }
    public static String val(String v) { return v == null ? "N:null" : "P:" + jsonStr(v); }
    public static String val(int[] arr) {
        if (arr == null) return "N:null";
        StringBuilder sb = new StringBuilder("A:");
        sb.append("0x").append(Integer.toHexString(System.identityHashCode(arr))).append(":");
        for (int i = 0; i < Math.min(arr.length, 24); i++) {
            if (i > 0) sb.append("\\u001f");
            sb.append(arr[i]);
        }
        return sb.toString();
    }
    public static String val(long[] arr) {
        if (arr == null) return "N:null";
        StringBuilder sb = new StringBuilder("A:");
        sb.append("0x").append(Integer.toHexString(System.identityHashCode(arr))).append(":");
        for (int i = 0; i < Math.min(arr.length, 24); i++) {
            if (i > 0) sb.append("\\u001f");
            sb.append(arr[i]);
        }
        return sb.toString();
    }
    public static String val(double[] arr) {
        if (arr == null) return "N:null";
        StringBuilder sb = new StringBuilder("A:");
        sb.append("0x").append(Integer.toHexString(System.identityHashCode(arr))).append(":");
        for (int i = 0; i < Math.min(arr.length, 24); i++) {
            if (i > 0) sb.append("\\u001f");
            sb.append(arr[i]);
        }
        return sb.toString();
    }
    public static String val(String[] arr) {
        if (arr == null) return "N:null";
        StringBuilder sb = new StringBuilder("A:");
        sb.append("0x").append(Integer.toHexString(System.identityHashCode(arr))).append(":");
        for (int i = 0; i < Math.min(arr.length, 24); i++) {
            if (i > 0) sb.append("\\u001f");
            sb.append(arr[i] == null ? "null" : jsonStr(arr[i]));
        }
        return sb.toString();
    }
    public static String val(java.util.List<?> list) {
        if (list == null) return "N:null";
        StringBuilder sb = new StringBuilder("A:");
        sb.append("0x").append(Integer.toHexString(System.identityHashCode(list))).append(":");
        int limit = Math.min(list.size(), 24);
        for (int i = 0; i < limit; i++) {
            if (i > 0) sb.append("\\u001f");
            Object item = list.get(i);
            sb.append(item == null ? "null" : (item instanceof String ? jsonStr((String) item) : String.valueOf(item)));
        }
        return sb.toString();
    }
    public static String val(Object obj) {
        if (obj == null) return "N:null";
        return "O:0x" + Integer.toHexString(System.identityHashCode(obj)) + ":" + String.valueOf(obj);
    }

    public static synchronized void enter(String fn, int line, String[] vars) {
        Frame f = new Frame();
        f.id = "f" + (++frameSeq);
        f.name = fn;
        f.line = line;
        f.vars = vars;
        stack.addLast(f);
        record(line, "call", null, 0, null);
    }

    public static synchronized void exit() {
        if (!stack.isEmpty()) stack.removeLast();
    }

    public static synchronized void step(int line, String kind, String[] vars) {
        if (!stack.isEmpty()) {
            Frame top = stack.peekLast();
            top.line = line;
            top.vars = vars;
        }
        record(line, kind, null, 0, null);
    }

    public static synchronized boolean cond(int line, String expr, boolean result, String[] vars) {
        if (!stack.isEmpty()) {
            Frame top = stack.peekLast();
            top.line = line;
            top.vars = vars;
        }
        record(line, "condition", expr, result ? 1 : 0, null);
        return result;
    }

    public static synchronized void loop(int line, String header, String[] vars) {
        int c = loopCounts.getOrDefault(line, 0) + 1;
        loopCounts.put(line, c);
        if (!stack.isEmpty()) {
            Frame top = stack.peekLast();
            top.line = line;
            top.vars = vars;
        }
        record(line, "loop", header, c, null);
    }

    public static synchronized void ret(int line, String retStr, String[] vars) {
        if (!stack.isEmpty()) {
            Frame top = stack.peekLast();
            top.line = line;
            top.vars = vars;
            top.returnValue = retStr;
        }
        record(line, "return", null, 0, null);
    }

    public static synchronized <T> T retVal(int line, T value, String[] vars) {
        if (!stack.isEmpty()) {
            Frame top = stack.peekLast();
            top.line = line;
            top.vars = vars;
            top.returnValue = String.valueOf(value);
        }
        record(line, "return", null, 0, null);
        return value;
    }

    private static void record(int line, String kind, String extraStr, int extraNum, String io) {
        if (steps.size() >= MAX_STEPS) { truncated = true; return; }
        StringBuilder sb = new StringBuilder();
        sb.append("{\\"line\\":").append(line);
        sb.append(",\\"eventKind\\":").append(jsonStr(kind));
        if ("condition".equals(kind) && extraStr != null) {
            sb.append(",\\"conditionEval\\":{\\"expression\\":").append(jsonStr(extraStr)).append(",\\"result\\":").append(extraNum == 1).append("}");
        } else if ("loop".equals(kind) && extraStr != null) {
            sb.append(",\\"loopInfo\\":{\\"iteration\\":").append(extraNum).append(",\\"header\\":").append(jsonStr(extraStr)).append("}");
        }
        String outStr = outBuf != null ? outBuf.toString(java.nio.charset.StandardCharsets.UTF_8) : "";
        sb.append(",\\"stdoutSoFar\\":").append(jsonStr(outStr));
        sb.append(",\\"stack\\":[");
        boolean firstFrame = true;
        for (Frame f : stack) {
            if (!firstFrame) sb.append(",");
            firstFrame = false;
            sb.append("{\\"id\\":").append(jsonStr(f.id));
            sb.append(",\\"functionName\\":").append(jsonStr(f.name));
            sb.append(",\\"line\\":").append(f.line);
            if (f.returnValue != null) {
                sb.append(",\\"returnValue\\":").append(jsonStr(f.returnValue));
            }
            sb.append(",\\"locals\\":[");
            for (int i = 0; i + 1 < f.vars.length; i += 2) {
                if (i > 0) sb.append(",");
                sb.append(encodeLocal(f.vars[i], f.vars[i + 1]));
            }
            sb.append("]}");
        }
        sb.append("]}");
        steps.add(sb.toString());
    }

    private static String encodeLocal(String name, String encoded) {
        if (encoded.startsWith("N:")) {
            return "{\\"name\\":" + jsonStr(name) + ",\\"type\\":\\"null\\",\\"displayValue\\":\\"null\\"}";
        }
        if (encoded.startsWith("P:")) {
            return "{\\"name\\":" + jsonStr(name) + ",\\"type\\":\\"primitive\\",\\"displayValue\\":" + jsonStr(encoded.substring(2)) + "}";
        }
        if (encoded.startsWith("A:")) {
            int c1 = encoded.indexOf(':', 2);
            String addr = encoded.substring(2, c1);
            String body = encoded.substring(c1 + 1);
            String[] parts = body.isEmpty() ? new String[0] : body.split("\\u001f", -1);
            StringBuilder elems = new StringBuilder("[");
            StringBuilder disp = new StringBuilder("[");
            for (int i = 0; i < parts.length; i++) {
                if (i > 0) { elems.append(","); disp.append(", "); }
                elems.append("{\\"index\\":").append(i).append(",\\"value\\":").append(jsonStr(parts[i])).append("}");
                if (i < 8) disp.append(parts[i]);
            }
            if (parts.length > 8) disp.append(", ...");
            disp.append("]");
            elems.append("]");
            return "{\\"name\\":" + jsonStr(name) + ",\\"type\\":\\"array\\",\\"displayValue\\":" + jsonStr(disp.toString()) + ",\\"elements\\":" + elems + ",\\"memoryAddress\\":" + jsonStr(addr) + "}";
        }
        if (encoded.startsWith("O:")) {
            int c1 = encoded.indexOf(':', 2);
            String addr = encoded.substring(2, c1);
            String val = encoded.substring(c1 + 1);
            return "{\\"name\\":" + jsonStr(name) + ",\\"type\\":\\"object\\",\\"displayValue\\":" + jsonStr(val) + ",\\"memoryAddress\\":" + jsonStr(addr) + "}";
        }
        return "{\\"name\\":" + jsonStr(name) + ",\\"type\\":\\"primitive\\",\\"displayValue\\":" + jsonStr(encoded) + "}";
    }

    public static synchronized void flushTrace() {
        java.io.PrintStream err = origErr != null ? origErr : System.err;
        err.println("\\n${TRACE_MARKER_START}");
        err.print("{\\"truncated\\":" + truncated + ",\\"steps\\":[");
        for (int i = 0; i < steps.size(); i++) {
            if (i > 0) err.print(",");
            err.print(steps.get(i));
        }
        err.println("]}");
        err.println("${TRACE_MARKER_END}");
        err.flush();
    }

    private static String jsonStr(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') sb.append("\\\\\\"");
            else if (c == '\\\\') sb.append("\\\\\\\\");
            else if (c == '\\n') sb.append("\\\\n");
            else if (c == '\\r') sb.append("\\\\r");
            else if (c == '\\t') sb.append("\\\\t");
            else if (c < 32) sb.append(String.format("\\\\u%04x", (int) c));
            else sb.append(c);
        }
        sb.append("\\"");
        return sb.toString();
    }
}
`;

  return instrumented + '\n' + tracerClass;
}

function instrumentCppSource(sourceCode: string): string {
  const masked = maskCommentsAndStrings(sourceCode);
  const lineOffsets = computeLineOffsets(sourceCode);
  const edits: TextEdit[] = [];

  function snapshotCall(vars: ScopeVar[]): string {
    if (vars.length === 0) return '{}';
    const items = vars.map((v) => `__codex::make_var(${JSON.stringify(v.name)}, ${v.name})`);
    return `{ ${items.join(', ')} }`;
  }

  function findNextStatementEnd(maskedText: string, start: number, limit: number): number {
    let pDepth = 0;
    let bDepth = 0;
    for (let i = start; i < limit; i++) {
      const ch = maskedText[i];
      if (ch === '(') pDepth++;
      else if (ch === ')' && pDepth > 0) pDepth--;
      else if (ch === '{') bDepth++;
      else if (ch === '}' && bDepth > 0) bDepth--;
      else if (ch === ';' && pDepth === 0 && bDepth === 0) return i + 1;
    }
    return limit;
  }

  function instrumentBlock(
    blockOpen: number,
    blockClose: number,
    outerVars: ScopeVar[],
    isVoidFn: boolean,
  ): void {
    const scopeVars: ScopeVar[] = [...outerVars];
    let pos = blockOpen + 1;

    while (pos < blockClose) {
      pos = skipWhitespace(masked, pos, blockClose);
      if (pos >= blockClose) break;

      if (masked[pos] === '{') {
        const innerClose = findMatchingDelimiter(masked, pos, '{', '}');
        if (innerClose === -1 || innerClose > blockClose) break;
        instrumentBlock(pos, innerClose, scopeVars, isVoidFn);
        pos = innerClose + 1;
        continue;
      }

      const rest = masked.slice(pos, blockClose);

      const ifMatch = rest.match(/^(?:else\s+)?if\s*\(/);
      if (ifMatch) {
        const parenOpen = pos + ifMatch[0].length - 1;
        const parenClose = findMatchingDelimiter(masked, parenOpen, '(', ')');
        if (parenClose === -1) break;
        const line = getLineNumberAt(lineOffsets, pos);
        const condExprRaw = sourceCode.slice(parenOpen + 1, parenClose).trim();
        edits.push({
          start: parenOpen + 1,
          end: parenClose,
          text: `__codex::cond(${line}, ${JSON.stringify(condExprRaw)}, static_cast<bool>(${condExprRaw}), ${snapshotCall(scopeVars)})`,
        });
        const bodyStart = skipWhitespace(masked, parenClose + 1, blockClose);
        if (masked[bodyStart] === '{') {
          const bodyClose = findMatchingDelimiter(masked, bodyStart, '{', '}');
          if (bodyClose === -1) break;
          instrumentBlock(bodyStart, bodyClose, scopeVars, isVoidFn);
          pos = bodyClose + 1;
        } else {
          const semi = findNextStatementEnd(masked, bodyStart, blockClose);
          edits.push({start: bodyStart, end: bodyStart, text: '{ '});
          edits.push({start: semi, end: semi, text: ' }'});
          instrumentSingleStatement(bodyStart, semi, scopeVars, isVoidFn);
          pos = semi;
        }
        continue;
      }

      const elseMatch = rest.match(/^else\b/);
      if (elseMatch) {
        const line = getLineNumberAt(lineOffsets, pos);
        const bodyStart = skipWhitespace(masked, pos + 4, blockClose);
        if (masked[bodyStart] === '{') {
          const bodyClose = findMatchingDelimiter(masked, bodyStart, '{', '}');
          if (bodyClose === -1) break;
          edits.push({
            start: bodyStart + 1,
            end: bodyStart + 1,
            text: `\n__codex::step(${line}, "line", ${snapshotCall(scopeVars)});\n`,
          });
          instrumentBlock(bodyStart, bodyClose, scopeVars, isVoidFn);
          pos = bodyClose + 1;
        } else {
          const semi = findNextStatementEnd(masked, bodyStart, blockClose);
          edits.push({
            start: bodyStart,
            end: bodyStart,
            text: `{ __codex::step(${line}, "line", ${snapshotCall(scopeVars)}); `,
          });
          edits.push({start: semi, end: semi, text: ' }'});
          instrumentSingleStatement(bodyStart, semi, scopeVars, isVoidFn);
          pos = semi;
        }
        continue;
      }

      const loopMatch = rest.match(/^(for|while)\s*\(/);
      if (loopMatch) {
        const parenOpen = pos + loopMatch[0].length - 1;
        const parenClose = findMatchingDelimiter(masked, parenOpen, '(', ')');
        if (parenClose === -1) break;
        const line = getLineNumberAt(lineOffsets, pos);
        const loopVars = [...scopeVars];
        if (loopMatch[1] === 'for') {
          const inside = masked.slice(parenOpen + 1, parenClose);
          const firstSemi = inside.indexOf(';');
          if (firstSemi !== -1) {
            loopVars.push(...parseDeclarationVars(inside.slice(0, firstSemi + 1), 'cpp'));
          }
        }
        const headerText = sourceCode
          .slice(pos, parenClose + 1)
          .replace(/\s+/g, ' ')
          .trim();
        const bodyStart = skipWhitespace(masked, parenClose + 1, blockClose);
        const loopCall = `__codex::loop(${line}, ${JSON.stringify(headerText)}, ${snapshotCall(loopVars)});`;
        if (masked[bodyStart] === '{') {
          const bodyClose = findMatchingDelimiter(masked, bodyStart, '{', '}');
          if (bodyClose === -1) break;
          edits.push({start: bodyStart + 1, end: bodyStart + 1, text: `\n${loopCall}\n`});
          instrumentBlock(bodyStart, bodyClose, loopVars, isVoidFn);
          pos = bodyClose + 1;
        } else {
          const semi = findNextStatementEnd(masked, bodyStart, blockClose);
          edits.push({start: bodyStart, end: bodyStart, text: `{ ${loopCall} `});
          edits.push({start: semi, end: semi, text: ' }'});
          instrumentSingleStatement(bodyStart, semi, loopVars, isVoidFn);
          pos = semi;
        }
        continue;
      }

      const stmtEnd = findNextStatementEnd(masked, pos, blockClose);
      instrumentSingleStatement(pos, stmtEnd, scopeVars, isVoidFn);
      pos = stmtEnd;
    }
  }

  function instrumentSingleStatement(
    start: number,
    end: number,
    scopeVars: ScopeVar[],
    isVoidFn: boolean,
  ): void {
    const stmtMasked = masked.slice(start, end).trim();
    if (!stmtMasked || stmtMasked === ';') return;
    const line = getLineNumberAt(lineOffsets, start);

    const retMatch = stmtMasked.match(/^return\b([\s\S]*);$/);
    if (retMatch) {
      const exprRaw = sourceCode.slice(start, end).trim().replace(/^return\b/, '').replace(/;$/, '').trim();
      if (!exprRaw || isVoidFn) {
        edits.push({
          start,
          end,
          text: `{ __codex::ret(${line}, "void", ${snapshotCall(scopeVars)}); return; }`,
        });
      } else {
        edits.push({
          start,
          end,
          text: `{ auto __codex_r = (${exprRaw}); __codex::ret(${line}, __codex::to_str(__codex_r), ${snapshotCall(scopeVars)}); return __codex_r; }`,
        });
      }
      return;
    }

    const newVars = parseDeclarationVars(stmtMasked, 'cpp');
    for (const nv of newVars) {
      if (!scopeVars.some((e) => e.name === nv.name)) scopeVars.push(nv);
    }

    edits.push({
      start: end,
      end,
      text: `\n__codex::step(${line}, "line", ${snapshotCall(scopeVars)});`,
    });
  }

  // Scan top-level functions (skip `#...` lines and `using namespace...;`)
  let cursor = 0;
  let insertionPoint = 0;
  while (cursor < masked.length) {
    cursor = skipWhitespace(masked, cursor, masked.length);
    if (cursor >= masked.length) break;

    if (sourceCode[cursor] === '#') {
      const nl = sourceCode.indexOf('\n', cursor);
      cursor = nl === -1 ? masked.length : nl + 1;
      insertionPoint = cursor;
      continue;
    }

    let nextSemi = -1;
    let nextBrace = -1;
    for (let k = cursor; k < masked.length; k++) {
      if (masked[k] === ';' && nextSemi === -1) nextSemi = k;
      if (masked[k] === '{') {
        nextBrace = k;
        break;
      }
    }

    if (nextBrace === -1) break;
    if (nextSemi !== -1 && nextSemi < nextBrace) {
      const stmtText = masked.slice(cursor, nextSemi + 1);
      if (/\busing\s+namespace\b/.test(stmtText)) {
        insertionPoint = nextSemi + 1;
      }
      cursor = nextSemi + 1;
      continue;
    }

    const headerMasked = masked.slice(cursor, nextBrace).trim();
    const bodyClose = findMatchingDelimiter(masked, nextBrace, '{', '}');
    if (bodyClose === -1) break;

    const sigMatch = headerMasked.match(
      /^([\s\S]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/,
    );

    if (sigMatch && !/^(struct|class|namespace|enum)\b/.test(headerMasked)) {
      const retType = sigMatch[1].trim();
      const fnName = sigMatch[2].trim();
      const isVoidFn = retType === 'void';
      const params = splitTopLevelParams(sigMatch[3]).map<ScopeVar>((p) => ({
        name: p.name,
        typeExpr: p.typeExpr,
        isArray: p.isArray,
      }));
      const line = getLineNumberAt(lineOffsets, cursor);
      const paramSnap = snapshotCall(params);

      edits.push({
        start: nextBrace + 1,
        end: nextBrace + 1,
        text: `\n__codex::FrameGuard __codex_fg(${JSON.stringify(fnName)}, ${line}, ${paramSnap}, ${fnName === 'main' ? 'true' : 'false'});\n`,
      });
      instrumentBlock(nextBrace, bodyClose, params, isVoidFn);
    }

    cursor = bodyClose + 1;
  }

  const cppRuntime = `
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <map>
#include <cstdio>
#include <cstdint>
namespace __codex {
struct VarSnap {
  std::string name;
  std::string type;
  std::string displayValue;
  std::vector<std::string> elements;
  std::string addr;
};
struct FrameSnap {
  std::string id;
  std::string functionName;
  int line;
  std::vector<VarSnap> locals;
  std::string returnValue;
};
inline std::string addr_str(const void* p) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)(std::uintptr_t)p);
  return std::string(buf);
}
inline std::string json_str(const std::string& s) {
  std::string out = "\\"";
  for (unsigned char c : s) {
    if (c == '"') out += "\\\\\\"";
    else if (c == '\\\\') out += "\\\\\\\\";
    else if (c == '\\n') out += "\\\\n";
    else if (c == '\\r') out += "\\\\r";
    else if (c == '\\t') out += "\\\\t";
    else if (c < 32) { char b[8]; std::snprintf(b, sizeof(b), "\\\\u%04x", c); out += b; }
    else out += (char)c;
  }
  out += "\\"";
  return out;
}
template <typename T> inline std::string to_str(const T& v) { std::ostringstream os; os << v; return os.str(); }
inline std::string to_str(bool v) { return v ? "true" : "false"; }
inline std::string to_str(char v) { return std::string("'") + v + "'"; }
inline std::string to_str(const std::string& v) { return json_str(v); }
inline std::string to_str(const char* v) { return v ? json_str(std::string(v)) : "nullptr"; }
template <typename T> inline std::string to_str(const std::vector<T>& vec) {
  std::string s = "[";
  for (size_t i = 0; i < vec.size() && i < 8; ++i) { if (i) s += ", "; s += to_str(vec[i]); }
  if (vec.size() > 8) s += ", ...";
  return s + "]";
}
template <typename T> inline VarSnap make_var(const std::string& name, const T& v) {
  return {name, "primitive", to_str(v), {}, addr_str(&v)};
}
template <typename T> inline VarSnap make_var(const std::string& name, const std::vector<T>& vec) {
  std::vector<std::string> els;
  for (size_t i = 0; i < vec.size() && i < 24; ++i) els.push_back(to_str(vec[i]));
  return {name, "array", to_str(vec), els, addr_str(&vec)};
}
template <typename T, size_t N> inline VarSnap make_var(const std::string& name, const T (&arr)[N]) {
  std::vector<std::string> els;
  std::string disp = "[";
  for (size_t i = 0; i < N && i < 24; ++i) {
    std::string sv = to_str(arr[i]);
    els.push_back(sv);
    if (i < 8) { if (i) disp += ", "; disp += sv; }
  }
  if (N > 8) disp += ", ...";
  disp += "]";
  return {name, "array", disp, els, addr_str(arr)};
}
template <typename T> inline VarSnap make_var(const std::string& name, T* ptr) {
  return {name, "pointer", ptr ? addr_str((const void*)ptr) : "nullptr", {}, addr_str(&ptr)};
}
inline VarSnap make_var(const std::string& name, const char* ptr) {
  return {name, "primitive", ptr ? json_str(std::string(ptr)) : "nullptr", {}, addr_str(&ptr)};
}

inline std::vector<FrameSnap>& stack() { static std::vector<FrameSnap> s; return s; }
inline std::vector<std::string>& steps() { static std::vector<std::string> st; return st; }
inline std::map<int, int>& loop_counts() { static std::map<int, int> m; return m; }
inline bool& truncated() { static bool t = false; return t; }
inline int& frame_seq() { static int q = 0; return q; }

inline void record(int line, const std::string& kind, const std::string& extraStr = "", int extraNum = 0) {
  if (steps().size() >= ${MAX_TRACE_STEPS}) { truncated() = true; return; }
  std::ostringstream os;
  os << "{\\"line\\":" << line << ",\\"eventKind\\":" << json_str(kind);
  if (kind == "condition") {
    os << ",\\"conditionEval\\":{\\"expression\\":" << json_str(extraStr) << ",\\"result\\":" << (extraNum ? "true" : "false") << "}";
  } else if (kind == "loop") {
    os << ",\\"loopInfo\\":{\\"iteration\\":" << extraNum << ",\\"header\\":" << json_str(extraStr) << "}";
  }
  os << ",\\"stack\\":[";
  const auto& st = stack();
  for (size_t i = 0; i < st.size(); ++i) {
    if (i) os << ",";
    const auto& f = st[i];
    os << "{\\"id\\":" << json_str(f.id) << ",\\"functionName\\":" << json_str(f.functionName) << ",\\"line\\":" << f.line;
    if (!f.returnValue.empty()) os << ",\\"returnValue\\":" << json_str(f.returnValue);
    os << ",\\"locals\\":[";
    for (size_t j = 0; j < f.locals.size(); ++j) {
      if (j) os << ",";
      const auto& v = f.locals[j];
      os << "{\\"name\\":" << json_str(v.name) << ",\\"type\\":" << json_str(v.type)
         << ",\\"displayValue\\":" << json_str(v.displayValue) << ",\\"memoryAddress\\":" << json_str(v.addr);
      if (v.type == "array") {
        os << ",\\"elements\\":[";
        for (size_t k = 0; k < v.elements.size(); ++k) {
          if (k) os << ",";
          os << "{\\"index\\":" << k << ",\\"value\\":" << json_str(v.elements[k]) << "}";
        }
        os << "]";
      }
      os << "}";
    }
    os << "]}";
  }
  os << "]}";
  steps().push_back(os.str());
}

inline void step(int line, const std::string& kind, const std::vector<VarSnap>& vars) {
  if (!stack().empty()) { stack().back().line = line; stack().back().locals = vars; }
  record(line, kind);
}
inline bool cond(int line, const std::string& expr, bool res, const std::vector<VarSnap>& vars) {
  if (!stack().empty()) { stack().back().line = line; stack().back().locals = vars; }
  record(line, "condition", expr, res ? 1 : 0);
  return res;
}
inline void loop(int line, const std::string& hdr, const std::vector<VarSnap>& vars) {
  int c = ++loop_counts()[line];
  if (!stack().empty()) { stack().back().line = line; stack().back().locals = vars; }
  record(line, "loop", hdr, c);
}
inline void ret(int line, const std::string& rv, const std::vector<VarSnap>& vars) {
  if (!stack().empty()) { stack().back().line = line; stack().back().locals = vars; stack().back().returnValue = rv; }
  record(line, "return");
}
inline void flush_trace() {
  std::fprintf(stderr, "\\n${TRACE_MARKER_START}\\n{\\"truncated\\":%s,\\"steps\\":[", truncated() ? "true" : "false");
  for (size_t i = 0; i < steps().size(); ++i) {
    if (i) std::fprintf(stderr, ",");
    std::fprintf(stderr, "%s", steps()[i].c_str());
  }
  std::fprintf(stderr, "]}\\n${TRACE_MARKER_END}\\n");
  std::fflush(stderr);
}
struct FrameGuard {
  bool isMain;
  FrameGuard(const std::string& fn, int line, const std::vector<VarSnap>& vars, bool mainFlag) : isMain(mainFlag) {
    stack().push_back({"f" + std::to_string(++frame_seq()), fn, line, vars, ""});
    record(line, "call");
  }
  ~FrameGuard() {
    if (!stack().empty()) stack().pop_back();
    if (isMain) flush_trace();
  }
};
} // namespace __codex
`;

  edits.push({start: insertionPoint, end: insertionPoint, text: cppRuntime});
  edits.sort((a, b) => b.start - a.start || b.end - a.end);

  let instrumented = sourceCode;
  for (const e of edits) {
    instrumented = instrumented.slice(0, e.start) + e.text + instrumented.slice(e.end);
  }
  return instrumented;
}

function instrumentCSource(sourceCode: string): string {
  const masked = maskCommentsAndStrings(sourceCode);
  const lineOffsets = computeLineOffsets(sourceCode);
  const edits: TextEdit[] = [];

  function buildCVarPushExpr(v: ScopeVar): string {
    if (v.isArray && v.arraySizeHint && !v.isParam) {
      if (/\bchar\b/.test(v.typeExpr)) {
        return `__codex_push_s(${JSON.stringify(v.name)}, ${v.name}, &${v.name})`;
      }
      if (/\b(double|float)\b/.test(v.typeExpr)) {
        return `__codex_push_arr_d(${JSON.stringify(v.name)}, ${v.name}, (int)(sizeof(${v.name})/sizeof((${v.name})[0])))`;
      }
      if (/\blong\b/.test(v.typeExpr)) {
        return `__codex_push_arr_l(${JSON.stringify(v.name)}, ${v.name}, (int)(sizeof(${v.name})/sizeof((${v.name})[0])))`;
      }
      return `__codex_push_arr_i(${JSON.stringify(v.name)}, ${v.name}, (int)(sizeof(${v.name})/sizeof((${v.name})[0])))`;
    }
    return v.isArray
      ? `__codex_push_ptr(${JSON.stringify(v.name)}, (const void*)${v.name}, &${v.name})`
      : `__codex_push_any(${JSON.stringify(v.name)}, ${v.name}, &${v.name})`;
  }

  function emitSnapshotStmt(
    line: number,
    kind: string,
    vars: ScopeVar[],
    extraStr = '',
    extraNum = 0,
    retValExpr?: string,
  ): string {
    const calls = vars.map((v) => `${buildCVarPushExpr(v)};`);
    if (retValExpr) {
      calls.push(`__codex_set_ret(${retValExpr});`);
    }
    return `__codex_begin_vars(${line}); ${calls.join(' ')} __codex_record(${line}, ${JSON.stringify(kind)}, ${JSON.stringify(extraStr)}, ${extraNum});`;
  }

  function findNextStatementEnd(maskedText: string, start: number, limit: number): number {
    let pDepth = 0;
    let bDepth = 0;
    for (let i = start; i < limit; i++) {
      const ch = maskedText[i];
      if (ch === '(') pDepth++;
      else if (ch === ')' && pDepth > 0) pDepth--;
      else if (ch === '{') bDepth++;
      else if (ch === '}' && bDepth > 0) bDepth--;
      else if (ch === ';' && pDepth === 0 && bDepth === 0) return i + 1;
    }
    return limit;
  }

  function instrumentBlock(
    blockOpen: number,
    blockClose: number,
    outerVars: ScopeVar[],
    retType: string,
    isMainFn: boolean,
  ): void {
    const scopeVars: ScopeVar[] = [...outerVars];
    let pos = blockOpen + 1;

    while (pos < blockClose) {
      pos = skipWhitespace(masked, pos, blockClose);
      if (pos >= blockClose) break;

      if (masked[pos] === '{') {
        const innerClose = findMatchingDelimiter(masked, pos, '{', '}');
        if (innerClose === -1 || innerClose > blockClose) break;
        instrumentBlock(pos, innerClose, scopeVars, retType, isMainFn);
        pos = innerClose + 1;
        continue;
      }

      const rest = masked.slice(pos, blockClose);

      const ifMatch = rest.match(/^(?:else\s+)?if\s*\(/);
      if (ifMatch) {
        const parenOpen = pos + ifMatch[0].length - 1;
        const parenClose = findMatchingDelimiter(masked, parenOpen, '(', ')');
        if (parenClose === -1) break;
        const line = getLineNumberAt(lineOffsets, pos);
        const condExprRaw = sourceCode.slice(parenOpen + 1, parenClose).trim();
        const varPushCalls = scopeVars.map((v) => buildCVarPushExpr(v)).join(', ');
        const prefixComma = varPushCalls ? `__codex_begin_vars(${line}), ${varPushCalls}, ` : `__codex_begin_vars(${line}), `;
        edits.push({
          start: parenOpen + 1,
          end: parenClose,
          text: `(${prefixComma}__codex_cond(${line}, ${JSON.stringify(condExprRaw)}, !!(${condExprRaw})))`,
        });

        const bodyStart = skipWhitespace(masked, parenClose + 1, blockClose);
        if (masked[bodyStart] === '{') {
          const bodyClose = findMatchingDelimiter(masked, bodyStart, '{', '}');
          if (bodyClose === -1) break;
          instrumentBlock(bodyStart, bodyClose, scopeVars, retType, isMainFn);
          pos = bodyClose + 1;
        } else {
          const semi = findNextStatementEnd(masked, bodyStart, blockClose);
          edits.push({start: bodyStart, end: bodyStart, text: '{ '});
          edits.push({start: semi, end: semi, text: ' }'});
          instrumentSingleStatement(bodyStart, semi, scopeVars, retType, isMainFn);
          pos = semi;
        }
        continue;
      }

      const elseMatch = rest.match(/^else\b/);
      if (elseMatch) {
        const line = getLineNumberAt(lineOffsets, pos);
        const bodyStart = skipWhitespace(masked, pos + 4, blockClose);
        const stepCode = emitSnapshotStmt(line, 'line', scopeVars);
        if (masked[bodyStart] === '{') {
          const bodyClose = findMatchingDelimiter(masked, bodyStart, '{', '}');
          if (bodyClose === -1) break;
          edits.push({start: bodyStart + 1, end: bodyStart + 1, text: `\n${stepCode}\n`});
          instrumentBlock(bodyStart, bodyClose, scopeVars, retType, isMainFn);
          pos = bodyClose + 1;
        } else {
          const semi = findNextStatementEnd(masked, bodyStart, blockClose);
          edits.push({start: bodyStart, end: bodyStart, text: `{ ${stepCode} `});
          edits.push({start: semi, end: semi, text: ' }'});
          instrumentSingleStatement(bodyStart, semi, scopeVars, retType, isMainFn);
          pos = semi;
        }
        continue;
      }

      const loopMatch = rest.match(/^(for|while)\s*\(/);
      if (loopMatch) {
        const parenOpen = pos + loopMatch[0].length - 1;
        const parenClose = findMatchingDelimiter(masked, parenOpen, '(', ')');
        if (parenClose === -1) break;
        const line = getLineNumberAt(lineOffsets, pos);
        const loopVars = [...scopeVars];
        if (loopMatch[1] === 'for') {
          const inside = masked.slice(parenOpen + 1, parenClose);
          const firstSemi = inside.indexOf(';');
          if (firstSemi !== -1) {
            loopVars.push(...parseDeclarationVars(inside.slice(0, firstSemi + 1), 'c'));
          }
        }
        const headerText = sourceCode
          .slice(pos, parenClose + 1)
          .replace(/\s+/g, ' ')
          .trim();
        const bodyStart = skipWhitespace(masked, parenClose + 1, blockClose);
        const loopCode = emitSnapshotStmt(line, 'loop', loopVars, headerText, 0);
        if (masked[bodyStart] === '{') {
          const bodyClose = findMatchingDelimiter(masked, bodyStart, '{', '}');
          if (bodyClose === -1) break;
          edits.push({start: bodyStart + 1, end: bodyStart + 1, text: `\n${loopCode}\n`});
          instrumentBlock(bodyStart, bodyClose, loopVars, retType, isMainFn);
          pos = bodyClose + 1;
        } else {
          const semi = findNextStatementEnd(masked, bodyStart, blockClose);
          edits.push({start: bodyStart, end: bodyStart, text: `{ ${loopCode} `});
          edits.push({start: semi, end: semi, text: ' }'});
          instrumentSingleStatement(bodyStart, semi, loopVars, retType, isMainFn);
          pos = semi;
        }
        continue;
      }

      const stmtEnd = findNextStatementEnd(masked, pos, blockClose);
      instrumentSingleStatement(pos, stmtEnd, scopeVars, retType, isMainFn);
      pos = stmtEnd;
    }
  }

  function instrumentSingleStatement(
    start: number,
    end: number,
    scopeVars: ScopeVar[],
    retType: string,
    isMainFn: boolean,
  ): void {
    const stmtMasked = masked.slice(start, end).trim();
    if (!stmtMasked || stmtMasked === ';') return;
    const line = getLineNumberAt(lineOffsets, start);

    const retMatch = stmtMasked.match(/^return\b([\s\S]*);$/);
    if (retMatch) {
      const exprRaw = sourceCode.slice(start, end).trim().replace(/^return\b/, '').replace(/;$/, '').trim();
      if (!exprRaw || retType === 'void') {
        const rec = emitSnapshotStmt(line, 'return', scopeVars, '', 0, '"void"');
        edits.push({
          start,
          end,
          text: `{ ${rec} __codex_exit(${isMainFn ? 1 : 0}); return; }`,
        });
      } else {
        const rec = emitSnapshotStmt(line, 'return', scopeVars, '', 0, '__codex_fmt_any(__codex_r)');
        edits.push({
          start,
          end,
          text: `{ ${retType} __codex_r = (${exprRaw}); ${rec} __codex_exit(${isMainFn ? 1 : 0}); return __codex_r; }`,
        });
      }
      return;
    }

    const newVars = parseDeclarationVars(stmtMasked, 'c');
    for (const nv of newVars) {
      if (!scopeVars.some((e) => e.name === nv.name)) scopeVars.push(nv);
    }

    edits.push({
      start: end,
      end,
      text: `\n${emitSnapshotStmt(line, 'line', scopeVars)}`,
    });
  }

  let cursor = 0;
  let insertionPoint = 0;
  while (cursor < masked.length) {
    cursor = skipWhitespace(masked, cursor, masked.length);
    if (cursor >= masked.length) break;

    if (sourceCode[cursor] === '#') {
      const nl = sourceCode.indexOf('\n', cursor);
      cursor = nl === -1 ? masked.length : nl + 1;
      insertionPoint = cursor;
      continue;
    }

    let nextSemi = -1;
    let nextBrace = -1;
    for (let k = cursor; k < masked.length; k++) {
      if (masked[k] === ';' && nextSemi === -1) nextSemi = k;
      if (masked[k] === '{') {
        nextBrace = k;
        break;
      }
    }

    if (nextBrace === -1) break;
    if (nextSemi !== -1 && nextSemi < nextBrace) {
      cursor = nextSemi + 1;
      continue;
    }

    const headerMasked = masked.slice(cursor, nextBrace).trim();
    const bodyClose = findMatchingDelimiter(masked, nextBrace, '{', '}');
    if (bodyClose === -1) break;

    const sigMatch = headerMasked.match(
      /^([\s\S]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/,
    );

    if (sigMatch && !/^(struct|enum|typedef|union)\b/.test(headerMasked)) {
      const retType = sigMatch[1].trim();
      const fnName = sigMatch[2].trim();
      const params = splitTopLevelParams(sigMatch[3]).map<ScopeVar>((p) => ({
        name: p.name,
        typeExpr: p.typeExpr,
        isArray: p.isArray,
        isParam: true,
      }));
      const line = getLineNumberAt(lineOffsets, cursor);
      const isMainFn = fnName === 'main';
      const enterVars = params
        .map((p) =>
          p.isArray
            ? `__codex_push_ptr(${JSON.stringify(p.name)}, (const void*)${p.name}, &${p.name});`
            : `__codex_push_any(${JSON.stringify(p.name)}, ${p.name}, &${p.name});`,
        )
        .join(' ');

      edits.push({
        start: nextBrace + 1,
        end: nextBrace + 1,
        text: `\n__codex_enter(${JSON.stringify(fnName)}, ${line}); ${enterVars} __codex_record(${line}, "call", "", 0);\n`,
      });
      if (retType === 'void' || isMainFn) {
        edits.push({
          start: bodyClose,
          end: bodyClose,
          text: `\n__codex_exit(${isMainFn ? 1 : 0});\n`,
        });
      }

      instrumentBlock(nextBrace, bodyClose, params, retType, isMainFn);
    }

    cursor = bodyClose + 1;
  }

  const cRuntime = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

typedef struct { char name[64]; char type[24]; char disp[256]; char addr[32]; int is_arr; int arr_len; char elems[24][64]; } __CodexVar;
typedef struct { char id[24]; char fn[64]; int line; char ret[128]; __CodexVar vars[24]; int var_count; } __CodexFrame;

static __CodexFrame __codex_stack[64];
static int __codex_sp = 0;
static int __codex_seq = 0;
static int __codex_step_count = 0;
static int __codex_truncated = 0;
static int __codex_loop_lines[256];
static int __codex_loop_counts[256];
static int __codex_loop_n = 0;
static char* __codex_steps[${MAX_TRACE_STEPS}];

static void __codex_json_escape(FILE* out, const char* s) {
  fputc('"', out);
  for (const unsigned char* p = (const unsigned char*)s; *p; p++) {
    if (*p == '"') fputs("\\\\\\"", out);
    else if (*p == '\\\\') fputs("\\\\\\\\", out);
    else if (*p == '\\n') fputs("\\\\n", out);
    else if (*p == '\\r') fputs("\\\\r", out);
    else if (*p == '\\t') fputs("\\\\t", out);
    else if (*p < 32) fprintf(out, "\\\\u%04x", *p);
    else fputc(*p, out);
  }
  fputc('"', out);
}

static void __codex_json_buf(char** buf, size_t* cap, size_t* len, const char* s) {
  size_t add = strlen(s);
  if (*len + add + 1 >= *cap) {
    *cap = (*cap + add + 1024) * 2;
    *buf = (char*)realloc(*buf, *cap);
  }
  memcpy(*buf + *len, s, add);
  *len += add;
  (*buf)[*len] = '\\0';
}

static void __codex_json_str_buf(char** buf, size_t* cap, size_t* len, const char* s) {
  __codex_json_buf(buf, cap, len, "\\"");
  char ch[16];
  for (const unsigned char* p = (const unsigned char*)s; *p; p++) {
    if (*p == '"') __codex_json_buf(buf, cap, len, "\\\\\\"");
    else if (*p == '\\\\') __codex_json_buf(buf, cap, len, "\\\\\\\\");
    else if (*p == '\\n') __codex_json_buf(buf, cap, len, "\\\\n");
    else if (*p == '\\r') __codex_json_buf(buf, cap, len, "\\\\r");
    else if (*p == '\\t') __codex_json_buf(buf, cap, len, "\\\\t");
    else if (*p < 32) { snprintf(ch, sizeof(ch), "\\\\u%04x", *p); __codex_json_buf(buf, cap, len, ch); }
    else { ch[0] = (char)*p; ch[1] = '\\0'; __codex_json_buf(buf, cap, len, ch); }
  }
  __codex_json_buf(buf, cap, len, "\\"");
}

static void __codex_enter(const char* fn, int line) {
  if (__codex_sp >= 64) return;
  __CodexFrame* f = &__codex_stack[__codex_sp++];
  snprintf(f->id, sizeof(f->id), "f%d", ++__codex_seq);
  snprintf(f->fn, sizeof(f->fn), "%s", fn);
  f->line = line;
  f->ret[0] = '\\0';
  f->var_count = 0;
}

static void __codex_begin_vars(int line) {
  if (__codex_sp <= 0) return;
  __codex_stack[__codex_sp - 1].line = line;
  __codex_stack[__codex_sp - 1].var_count = 0;
}

static void __codex_push_fmt(const char* name, const char* type, const char* disp, const void* addr) {
  if (__codex_sp <= 0) return;
  __CodexFrame* f = &__codex_stack[__codex_sp - 1];
  if (f->var_count >= 24) return;
  __CodexVar* v = &f->vars[f->var_count++];
  snprintf(v->name, sizeof(v->name), "%s", name);
  snprintf(v->type, sizeof(v->type), "%s", type);
  snprintf(v->disp, sizeof(v->disp), "%s", disp);
  snprintf(v->addr, sizeof(v->addr), "0x%llx", (unsigned long long)(uintptr_t)addr);
  v->is_arr = 0;
  v->arr_len = 0;
}

static void __codex_push_i(const char* n, long long x, const void* a) { char b[64]; snprintf(b, sizeof(b), "%lld", x); __codex_push_fmt(n, "primitive", b, a); }
static void __codex_push_u(const char* n, unsigned long long x, const void* a) { char b[64]; snprintf(b, sizeof(b), "%llu", x); __codex_push_fmt(n, "primitive", b, a); }
static void __codex_push_d(const char* n, double x, const void* a) { char b[64]; snprintf(b, sizeof(b), "%g", x); __codex_push_fmt(n, "primitive", b, a); }
static void __codex_push_c(const char* n, char x, const void* a) { char b[16]; snprintf(b, sizeof(b), "'%c'", x); __codex_push_fmt(n, "primitive", b, a); }
static void __codex_push_s(const char* n, const char* x, const void* a) { __codex_push_fmt(n, "primitive", x ? x : "NULL", a); }
static void __codex_push_ptr(const char* n, const void* p, const void* a) { char b[64]; if (p) snprintf(b, sizeof(b), "0x%llx", (unsigned long long)(uintptr_t)p); else snprintf(b, sizeof(b), "NULL"); __codex_push_fmt(n, "pointer", b, a); }

#define __codex_push_any(name, val, addr) _Generic((val), \\
  char: __codex_push_c, \\
  signed char: __codex_push_i, \\
  short: __codex_push_i, \\
  int: __codex_push_i, \\
  long: __codex_push_i, \\
  long long: __codex_push_i, \\
  unsigned short: __codex_push_u, \\
  unsigned int: __codex_push_u, \\
  unsigned long: __codex_push_u, \\
  unsigned long long: __codex_push_u, \\
  float: __codex_push_d, \\
  double: __codex_push_d, \\
  char*: __codex_push_s, \\
  const char*: __codex_push_s, \\
  default: __codex_push_ptr \\
)(name, val, addr)

static char __codex_ret_tmp[128];
static const char* __codex_fmt_i(long long x) { snprintf(__codex_ret_tmp, sizeof(__codex_ret_tmp), "%lld", x); return __codex_ret_tmp; }
static const char* __codex_fmt_d(double x) { snprintf(__codex_ret_tmp, sizeof(__codex_ret_tmp), "%g", x); return __codex_ret_tmp; }
static const char* __codex_fmt_s(const char* x) { snprintf(__codex_ret_tmp, sizeof(__codex_ret_tmp), "%s", x ? x : "NULL"); return __codex_ret_tmp; }
static const char* __codex_fmt_p(const void* p) { snprintf(__codex_ret_tmp, sizeof(__codex_ret_tmp), "0x%llx", (unsigned long long)(uintptr_t)p); return __codex_ret_tmp; }
#define __codex_fmt_any(val) _Generic((val), \\
  int: __codex_fmt_i, long: __codex_fmt_i, long long: __codex_fmt_i, \\
  float: __codex_fmt_d, double: __codex_fmt_d, \\
  char*: __codex_fmt_s, const char*: __codex_fmt_s, default: __codex_fmt_p)(val)

static void __codex_push_arr_i(const char* name, const int* arr, int len) {
  if (__codex_sp <= 0) return;
  __CodexFrame* f = &__codex_stack[__codex_sp - 1];
  if (f->var_count >= 24) return;
  __CodexVar* v = &f->vars[f->var_count++];
  snprintf(v->name, sizeof(v->name), "%s", name);
  snprintf(v->type, sizeof(v->type), "array");
  snprintf(v->addr, sizeof(v->addr), "0x%llx", (unsigned long long)(uintptr_t)arr);
  v->is_arr = 1;
  v->arr_len = len > 24 ? 24 : (len < 0 ? 0 : len);
  v->disp[0] = '['; v->disp[1] = '\\0';
  for (int i = 0; i < v->arr_len; i++) {
    snprintf(v->elems[i], sizeof(v->elems[i]), "%d", arr[i]);
    if (i < 8) {
      if (i > 0) strncat(v->disp, ", ", sizeof(v->disp) - strlen(v->disp) - 1);
      strncat(v->disp, v->elems[i], sizeof(v->disp) - strlen(v->disp) - 1);
    }
  }
  if (len > 8) strncat(v->disp, ", ...", sizeof(v->disp) - strlen(v->disp) - 1);
  strncat(v->disp, "]", sizeof(v->disp) - strlen(v->disp) - 1);
}

static void __codex_push_arr_l(const char* name, const long long* arr, int len) {
  if (__codex_sp <= 0) return;
  __CodexFrame* f = &__codex_stack[__codex_sp - 1];
  if (f->var_count >= 24) return;
  __CodexVar* v = &f->vars[f->var_count++];
  snprintf(v->name, sizeof(v->name), "%s", name);
  snprintf(v->type, sizeof(v->type), "array");
  snprintf(v->addr, sizeof(v->addr), "0x%llx", (unsigned long long)(uintptr_t)arr);
  v->is_arr = 1;
  v->arr_len = len > 24 ? 24 : (len < 0 ? 0 : len);
  v->disp[0] = '['; v->disp[1] = '\\0';
  for (int i = 0; i < v->arr_len; i++) {
    snprintf(v->elems[i], sizeof(v->elems[i]), "%lld", arr[i]);
    if (i < 8) {
      if (i > 0) strncat(v->disp, ", ", sizeof(v->disp) - strlen(v->disp) - 1);
      strncat(v->disp, v->elems[i], sizeof(v->disp) - strlen(v->disp) - 1);
    }
  }
  if (len > 8) strncat(v->disp, ", ...", sizeof(v->disp) - strlen(v->disp) - 1);
  strncat(v->disp, "]", sizeof(v->disp) - strlen(v->disp) - 1);
}

static void __codex_push_arr_d(const char* name, const double* arr, int len) {
  if (__codex_sp <= 0) return;
  __CodexFrame* f = &__codex_stack[__codex_sp - 1];
  if (f->var_count >= 24) return;
  __CodexVar* v = &f->vars[f->var_count++];
  snprintf(v->name, sizeof(v->name), "%s", name);
  snprintf(v->type, sizeof(v->type), "array");
  snprintf(v->addr, sizeof(v->addr), "0x%llx", (unsigned long long)(uintptr_t)arr);
  v->is_arr = 1;
  v->arr_len = len > 24 ? 24 : (len < 0 ? 0 : len);
  v->disp[0] = '['; v->disp[1] = '\\0';
  for (int i = 0; i < v->arr_len; i++) {
    snprintf(v->elems[i], sizeof(v->elems[i]), "%g", arr[i]);
    if (i < 8) {
      if (i > 0) strncat(v->disp, ", ", sizeof(v->disp) - strlen(v->disp) - 1);
      strncat(v->disp, v->elems[i], sizeof(v->disp) - strlen(v->disp) - 1);
    }
  }
  if (len > 8) strncat(v->disp, ", ...", sizeof(v->disp) - strlen(v->disp) - 1);
  strncat(v->disp, "]", sizeof(v->disp) - strlen(v->disp) - 1);
}

static void __codex_set_ret(const char* rv) {
  if (__codex_sp > 0) snprintf(__codex_stack[__codex_sp - 1].ret, 128, "%s", rv);
}

static int __codex_loop_inc(int line) {
  for (int i = 0; i < __codex_loop_n; i++) {
    if (__codex_loop_lines[i] == line) return ++__codex_loop_counts[i];
  }
  if (__codex_loop_n < 256) {
    __codex_loop_lines[__codex_loop_n] = line;
    __codex_loop_counts[__codex_loop_n] = 1;
    __codex_loop_n++;
    return 1;
  }
  return 1;
}

static void __codex_record(int line, const char* kind, const char* extraStr, int extraNum) {
  if (__codex_step_count >= ${MAX_TRACE_STEPS}) { __codex_truncated = 1; return; }
  size_t cap = 1024, len = 0;
  char* buf = (char*)malloc(cap);
  buf[0] = '\\0';
  char num[64];
  snprintf(num, sizeof(num), "{\\"line\\":%d,\\"eventKind\\":", line);
  __codex_json_buf(&buf, &cap, &len, num);
  __codex_json_str_buf(&buf, &cap, &len, kind);
  if (strcmp(kind, "condition") == 0) {
    __codex_json_buf(&buf, &cap, &len, ",\\"conditionEval\\":{\\"expression\\":");
    __codex_json_str_buf(&buf, &cap, &len, extraStr);
    snprintf(num, sizeof(num), ",\\"result\\":%s}", extraNum ? "true" : "false");
    __codex_json_buf(&buf, &cap, &len, num);
  } else if (strcmp(kind, "loop") == 0) {
    int it = __codex_loop_inc(line);
    snprintf(num, sizeof(num), ",\\"loopInfo\\":{\\"iteration\\":%d,\\"header\\":", it);
    __codex_json_buf(&buf, &cap, &len, num);
    __codex_json_str_buf(&buf, &cap, &len, extraStr);
    __codex_json_buf(&buf, &cap, &len, "}");
  }
  __codex_json_buf(&buf, &cap, &len, ",\\"stack\\":[");
  for (int i = 0; i < __codex_sp; i++) {
    if (i) __codex_json_buf(&buf, &cap, &len, ",");
    __CodexFrame* f = &__codex_stack[i];
    __codex_json_buf(&buf, &cap, &len, "{\\"id\\":");
    __codex_json_str_buf(&buf, &cap, &len, f->id);
    __codex_json_buf(&buf, &cap, &len, ",\\"functionName\\":");
    __codex_json_str_buf(&buf, &cap, &len, f->fn);
    snprintf(num, sizeof(num), ",\\"line\\":%d", f->line);
    __codex_json_buf(&buf, &cap, &len, num);
    if (f->ret[0]) {
      __codex_json_buf(&buf, &cap, &len, ",\\"returnValue\\":");
      __codex_json_str_buf(&buf, &cap, &len, f->ret);
    }
    __codex_json_buf(&buf, &cap, &len, ",\\"locals\\":[");
    for (int j = 0; j < f->var_count; j++) {
      if (j) __codex_json_buf(&buf, &cap, &len, ",");
      __CodexVar* v = &f->vars[j];
      __codex_json_buf(&buf, &cap, &len, "{\\"name\\":");
      __codex_json_str_buf(&buf, &cap, &len, v->name);
      __codex_json_buf(&buf, &cap, &len, ",\\"type\\":");
      __codex_json_str_buf(&buf, &cap, &len, v->type);
      __codex_json_buf(&buf, &cap, &len, ",\\"displayValue\\":");
      __codex_json_str_buf(&buf, &cap, &len, v->disp);
      __codex_json_buf(&buf, &cap, &len, ",\\"memoryAddress\\":");
      __codex_json_str_buf(&buf, &cap, &len, v->addr);
      if (v->is_arr) {
        __codex_json_buf(&buf, &cap, &len, ",\\"elements\\":[");
        for (int k = 0; k < v->arr_len; k++) {
          if (k) __codex_json_buf(&buf, &cap, &len, ",");
          snprintf(num, sizeof(num), "{\\"index\\":%d,\\"value\\":", k);
          __codex_json_buf(&buf, &cap, &len, num);
          __codex_json_str_buf(&buf, &cap, &len, v->elems[k]);
          __codex_json_buf(&buf, &cap, &len, "}");
        }
        __codex_json_buf(&buf, &cap, &len, "]");
      }
      __codex_json_buf(&buf, &cap, &len, "}");
    }
    __codex_json_buf(&buf, &cap, &len, "]}");
  }
  __codex_json_buf(&buf, &cap, &len, "]}");
  __codex_steps[__codex_step_count++] = buf;
}

static int __codex_cond(int line, const char* expr, int res) {
  __codex_record(line, "condition", expr, res);
  return res;
}

static void __codex_exit(int is_main) {
  if (__codex_sp > 0) __codex_sp--;
  if (is_main) {
    fprintf(stderr, "\\n${TRACE_MARKER_START}\\n{\\"truncated\\":%s,\\"steps\\":[", __codex_truncated ? "true" : "false");
    for (int i = 0; i < __codex_step_count; i++) {
      if (i) fputc(',', stderr);
      fputs(__codex_steps[i], stderr);
      free(__codex_steps[i]);
    }
    fprintf(stderr, "]}\\n${TRACE_MARKER_END}\\n");
    fflush(stderr);
  }
}
`;

  edits.push({start: insertionPoint, end: insertionPoint, text: cRuntime});
  edits.sort((a, b) => b.start - a.start || b.end - a.end);

  let instrumented = sourceCode;
  for (const e of edits) {
    instrumented = instrumented.slice(0, e.start) + e.text + instrumented.slice(e.end);
  }
  return instrumented;
}

async function traceCompiledBraceLanguage(
  languageKey: 'java' | 'c' | 'cpp',
  languageId: number,
  sourceCode: string,
  stdin: string,
  submitToJudge0: Judge0SubmitFn,
): Promise<VisualizeResponse> {
  let instrumentedCode: string;
  try {
    if (languageKey === 'java') instrumentedCode = instrumentJavaSource(sourceCode);
    else if (languageKey === 'cpp') instrumentedCode = instrumentCppSource(sourceCode);
    else instrumentedCode = instrumentCSource(sourceCode);
  } catch (err) {
    // Verify raw compilation/execution on Judge0 so real syntax errors are surfaced cleanly
    const rawFallback = await submitToJudge0({languageId, sourceCode, stdin});
    if (rawFallback.statusId === 6) {
      return {
        supported: true,
        truncated: false,
        totalSteps: 0,
        steps: [],
        finalStdout: rawFallback.stdout,
        stderr: rawFallback.stderr,
        compileOutput: rawFallback.compileOutput,
        errorType: 'COMPILATION_ERROR',
        errorMessage: rawFallback.compileOutput || rawFallback.stderr || 'Compilation Error',
        time: rawFallback.time,
        memory: rawFallback.memory,
      };
    }
    return {
      supported: true,
      truncated: false,
      totalSteps: 0,
      steps: [],
      finalStdout: rawFallback.stdout,
      stderr: rawFallback.stderr,
      compileOutput: rawFallback.compileOutput,
      errorType: 'TRACING_UNAVAILABLE',
      limitationNote:
        err instanceof Error
          ? `Accurate line-by-line tracing could not parse this construct (${err.message}). Your program still ran cleanly above.`
          : 'Accurate line-by-line tracing is unavailable for this syntax construct.',
      time: rawFallback.time,
      memory: rawFallback.memory,
    };
  }

  const raw = await submitToJudge0({
    languageId,
    sourceCode: instrumentedCode,
    stdin,
  });

  if (raw.statusId === 5) {
    return {
      supported: true,
      truncated: false,
      totalSteps: 0,
      steps: [],
      finalStdout: raw.stdout,
      stderr: raw.stderr,
      compileOutput: '',
      errorType: 'TIME_LIMIT_EXCEEDED',
      errorMessage: 'Time Limit Exceeded while tracing program execution.',
      time: raw.time,
      memory: raw.memory,
    };
  }

  // If instrumented code failed to compile, run raw user code to distinguish real syntax errors from instrumenter limitations!
  if (raw.statusId === 6) {
    const rawFallback = await submitToJudge0({languageId, sourceCode, stdin});
    if (rawFallback.statusId === 6) {
      return {
        supported: true,
        truncated: false,
        totalSteps: 0,
        steps: [],
        finalStdout: rawFallback.stdout,
        stderr: rawFallback.stderr,
        compileOutput: rawFallback.compileOutput,
        errorType: 'COMPILATION_ERROR',
        errorMessage: rawFallback.compileOutput || rawFallback.stderr || 'Compilation Error',
        time: rawFallback.time,
        memory: rawFallback.memory,
      };
    }
    if (rawFallback.statusId !== 3) {
      return {
        supported: true,
        truncated: false,
        totalSteps: 0,
        steps: [],
        finalStdout: rawFallback.stdout,
        stderr: rawFallback.stderr,
        compileOutput: rawFallback.compileOutput,
        errorType: 'RUNTIME_ERROR',
        errorMessage: rawFallback.stderr || rawFallback.statusDescription,
        time: rawFallback.time,
        memory: rawFallback.memory,
      };
    }
    return {
      supported: true,
      truncated: false,
      totalSteps: 0,
      steps: [],
      finalStdout: rawFallback.stdout,
      stderr: rawFallback.stderr,
      compileOutput: '',
      errorType: 'TRACING_UNAVAILABLE',
      limitationNote:
        'Accurate line-by-line instrumentation is not available for an advanced syntax feature in this program (such as complex macros, non-standard array types, or unsupported declarations). Your program compiled and ran normally.',
      time: rawFallback.time,
      memory: rawFallback.memory,
    };
  }

  const markerRegex = new RegExp(
    `${escapeRegExp(TRACE_MARKER_START)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(TRACE_MARKER_END)}`,
  );
  const match = raw.stderr.match(markerRegex);
  if (!match?.[1]) {
    if (raw.statusId !== 3) {
      return {
        supported: true,
        truncated: false,
        totalSteps: 0,
        steps: [],
        finalStdout: raw.stdout,
        stderr: raw.stderr,
        compileOutput: raw.compileOutput,
        errorType: 'RUNTIME_ERROR',
        errorMessage: raw.stderr || raw.statusDescription || 'Runtime Error',
        time: raw.time,
        memory: raw.memory,
      };
    }
    return {
      supported: true,
      truncated: false,
      totalSteps: 0,
      steps: [],
      finalStdout: raw.stdout,
      stderr: raw.stderr,
      compileOutput: '',
      errorType: 'TRACING_UNAVAILABLE',
      limitationNote:
        'Execution finished without emitting trace events (ensure execution passes through main).',
      time: raw.time,
      memory: raw.memory,
    };
  }

  const parsed = JSON.parse(match[1]) as {
    truncated: boolean;
    steps: RawTraceEvent[];
  };
  const steps = finalizeTraceSteps(parsed.steps, sourceCode, raw.stdout);

  const cleanStderr = raw.stderr.replace(markerRegex, '').trim();
  const isRuntimeError = raw.statusId !== null && raw.statusId !== 3;

  return {
    supported: true,
    truncated: parsed.truncated,
    totalSteps: steps.length,
    steps,
    finalStdout: raw.stdout,
    stderr: cleanStderr,
    compileOutput: '',
    errorType: isRuntimeError ? 'RUNTIME_ERROR' : undefined,
    errorMessage: isRuntimeError ? cleanStderr || raw.statusDescription : undefined,
    time: raw.time,
    memory: raw.memory,
  };
}

export async function traceExecution(params: {
  languageKey: LanguageKey;
  languageId: number;
  sourceCode: string;
  stdin: string;
  submitToJudge0: Judge0SubmitFn;
}): Promise<VisualizeResponse> {
  if (!TRACE_SUPPORTED_LANGUAGES.includes(params.languageKey)) {
    return {
      supported: false,
      truncated: false,
      totalSteps: 0,
      steps: [],
      finalStdout: '',
      stderr: '',
      compileOutput: '',
      errorType: 'UNSUPPORTED_LANGUAGE',
      limitationNote: `Live line-by-line execution tracing is supported for Java, Python, C, C++, and JavaScript. Switch to one of those languages to trace variables, memory, and call stacks live.`,
      time: null,
      memory: null,
    };
  }

  if (params.languageKey === 'python') {
    return tracePython(params.sourceCode, params.stdin, params.submitToJudge0);
  }
  if (params.languageKey === 'javascript') {
    return traceJavaScript(params.sourceCode, params.stdin, params.submitToJudge0);
  }
  if (params.languageKey === 'java' || params.languageKey === 'c' || params.languageKey === 'cpp') {
    return traceCompiledBraceLanguage(
      params.languageKey,
      params.languageId,
      params.sourceCode,
      params.stdin,
      params.submitToJudge0,
    );
  }

  return {
    supported: false,
    truncated: false,
    totalSteps: 0,
    steps: [],
    finalStdout: '',
    stderr: '',
    compileOutput: '',
    errorType: 'UNSUPPORTED_LANGUAGE',
    limitationNote: 'Live line-by-line execution tracing is supported for Java, Python, C, C++, and JavaScript.',
    time: null,
    memory: null,
  };
}
