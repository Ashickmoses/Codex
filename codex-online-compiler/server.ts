import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {
  evaluateTestResult,
  LANGUAGE_MAP,
  SUPPORTED_LANGUAGES,
  type ExecuteRequest,
  type ExecuteResponse,
  type LanguageKey,
  type VisualizeRequest,
} from './shared/compiler.ts';
import {traceExecution, type Judge0RawResult} from './server/tracer.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_JUDGE0_URL = 'https://ce.judge0.com';
const MAX_SOURCE_CHARS = 100_000;
const MAX_IO_CHARS = 100_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 150;

interface Judge0SubmissionResponse {
  token?: string;
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  time?: string | null;
  memory?: number | null;
  status?: {
    id: number;
    description: string;
  };
}

const requestTimestampsByIp = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const existing = requestTimestampsByIp.get(ip) ?? [];
  const recent = existing.filter((ts) => ts > windowStart);

  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    requestTimestampsByIp.set(ip, recent);
    return true;
  }

  recent.push(now);
  requestTimestampsByIp.set(ip, recent);

  if (requestTimestampsByIp.size > 1000) {
    for (const [key, timestamps] of requestTimestampsByIp.entries()) {
      const active = timestamps.filter((ts) => ts > windowStart);
      if (active.length === 0) {
        requestTimestampsByIp.delete(key);
      } else {
        requestTimestampsByIp.set(key, active);
      }
    }
  }

  return false;
}

function resolveJudge0BaseUrl(): string {
  const raw = (process.env.JUDGE0_API_URL || '').trim();
  if (!raw) {
    return DEFAULT_JUDGE0_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Configured JUDGE0_API_URL is invalid.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Configured JUDGE0_API_URL must use HTTP or HTTPS.');
  }

  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

function buildJudge0Headers(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const apiKey = (process.env.JUDGE0_API_KEY || '').trim();
  const apiHost = (process.env.JUDGE0_API_HOST || '').trim();

  if (apiKey) {
    if (apiHost) {
      headers['X-RapidAPI-Key'] = apiKey;
      headers['X-RapidAPI-Host'] = apiHost;
    } else {
      headers['X-Auth-Token'] = apiKey;
    }
  }

  return headers;
}

function decodeBase64(value?: string | null): string {
  if (!value) {
    return '';
  }
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return value;
  }
}

function encodeBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submitToJudge0(params: {
  languageId: number;
  sourceCode: string;
  stdin: string;
}): Promise<Judge0SubmissionResponse> {
  const baseUrl = resolveJudge0BaseUrl();
  const headers = buildJudge0Headers();

  const submitUrl = `${baseUrl}/submissions?base64_encoded=true&wait=true`;
  const payload = {
    source_code: encodeBase64(params.sourceCode),
    language_id: params.languageId,
    stdin: encodeBase64(params.stdin),
    cpu_time_limit: 5,
    wall_time_limit: 10,
    memory_limit: 256000,
    max_file_size: 2048,
  };

  const submitResponse = await fetch(submitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text().catch(() => '');
    throw new Error(
      `Execution service returned HTTP ${submitResponse.status}${errorText ? `: ${errorText.slice(0, 200)}` : ''}`,
    );
  }

  let result = (await submitResponse.json()) as Judge0SubmissionResponse;

  // Poll if Judge0 queued the job asynchronously (status 1 = In Queue, 2 = Processing)
  if (result.token && result.status && result.status.id <= 2) {
    const pollUrl = `${baseUrl}/submissions/${encodeURIComponent(result.token)}?base64_encoded=true`;
    for (let attempt = 0; attempt < 15; attempt++) {
      await sleep(750);
      const pollRes = await fetch(pollUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!pollRes.ok) {
        break;
      }
      result = (await pollRes.json()) as Judge0SubmissionResponse;
      if (!result.status || result.status.id > 2) {
        break;
      }
    }
  }

  return result;
}

function validateExecuteRequest(body: unknown): {
  ok: true;
  data: ExecuteRequest;
} | {
  ok: false;
  error: string;
} {
  if (!body || typeof body !== 'object') {
    return {ok: false, error: 'Request body must be a JSON object.'};
  }

  const record = body as Record<string, unknown>;
  const languageKey = record.languageKey;
  const sourceCode = record.sourceCode;
  const stdin = record.stdin ?? '';
  const expectedOutput = record.expectedOutput ?? '';

  if (typeof languageKey !== 'string' || !(languageKey in LANGUAGE_MAP)) {
    return {ok: false, error: 'Unsupported or invalid programming language.'};
  }

  if (typeof sourceCode !== 'string' || sourceCode.trim().length === 0) {
    return {ok: false, error: 'Source code cannot be empty.'};
  }

  if (sourceCode.length > MAX_SOURCE_CHARS) {
    return {ok: false, error: `Source code exceeds ${MAX_SOURCE_CHARS} character limit.`};
  }

  if (typeof stdin !== 'string' || stdin.length > MAX_IO_CHARS) {
    return {ok: false, error: `Custom input must be a string within ${MAX_IO_CHARS} characters.`};
  }

  if (typeof expectedOutput !== 'string' || expectedOutput.length > MAX_IO_CHARS) {
    return {ok: false, error: `Expected output must be a string within ${MAX_IO_CHARS} characters.`};
  }

  return {
    ok: true,
    data: {
      languageKey: languageKey as LanguageKey,
      sourceCode,
      stdin,
      expectedOutput,
    },
  };
}

async function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({limit: '256kb'}));

  app.get('/api/health', (_req, res) => {
    res.json({ok: true});
  });

  app.get('/api/languages', (_req, res) => {
    res.json({languages: SUPPORTED_LANGUAGES});
  });

  app.post('/api/execute', async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(clientIp)) {
      res.status(429).json({
        error: 'Too many execution requests. Please wait a moment and try again.',
      });
      return;
    }

    const validation = validateExecuteRequest(req.body);
    if (!validation.ok) {
      res.status(400).json({error: validation.error});
      return;
    }

    const {languageKey, sourceCode, stdin, expectedOutput} = validation.data;
    const langConfig = LANGUAGE_MAP[languageKey];

    try {
      const submission = await submitToJudge0({
        languageId: langConfig.judge0Id,
        sourceCode,
        stdin,
      });

      const statusId = submission.status?.id ?? null;
      const statusDescription = submission.status?.description ?? 'Unknown';
      const stdout = decodeBase64(submission.stdout);
      const stderr = decodeBase64(submission.stderr);
      const compileOutput = decodeBase64(submission.compile_output);
      const systemMessage = decodeBase64(submission.message);

      let executionSucceeded = false;
      let errorVerdict:
        | 'COMPILATION_ERROR'
        | 'RUNTIME_ERROR'
        | 'TIME_LIMIT_EXCEEDED'
        | 'EXECUTION_ERROR'
        | undefined;

      if (statusId === 3) {
        executionSucceeded = true;
      } else if (statusId === 5) {
        errorVerdict = 'TIME_LIMIT_EXCEEDED';
      } else if (statusId === 6) {
        errorVerdict = 'COMPILATION_ERROR';
      } else if (statusId !== null && statusId >= 7 && statusId <= 14 && statusId !== 13) {
        errorVerdict = 'RUNTIME_ERROR';
      } else {
        errorVerdict = 'EXECUTION_ERROR';
      }

      const evaluation = evaluateTestResult({
        executionSucceeded,
        errorVerdict,
        actualOutput: stdout,
        expectedOutput,
      });

      const responsePayload: ExecuteResponse = {
        verdict: evaluation.verdict,
        statusLabel: evaluation.statusLabel,
        message: systemMessage && !executionSucceeded ? systemMessage : evaluation.message,
        actualOutput: stdout,
        expectedOutput,
        normalizedActual: evaluation.normalizedActual,
        normalizedExpected: evaluation.normalizedExpected,
        stderr,
        compileOutput,
        time: submission.time ?? null,
        memory: submission.memory ?? null,
        judge0StatusId: statusId,
        judge0StatusDescription: statusDescription,
      };

      res.json(responsePayload);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to reach sandboxed execution service.';
      res.status(502).json({
        error: message,
      });
    }
  });

  app.post('/api/visualize', async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(clientIp)) {
      res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.',
      });
      return;
    }

    const validation = validateExecuteRequest({
      ...(req.body && typeof req.body === 'object' ? req.body : {}),
      expectedOutput: '',
    });
    if (!validation.ok) {
      res.status(400).json({error: validation.error});
      return;
    }

    const {languageKey, sourceCode, stdin} = validation.data as VisualizeRequest;
    const langConfig = LANGUAGE_MAP[languageKey];

    try {
      const traceResult = await traceExecution({
        languageKey,
        languageId: langConfig.judge0Id,
        sourceCode,
        stdin,
        submitToJudge0: async (params): Promise<Judge0RawResult> => {
          const submission = await submitToJudge0(params);
          return {
            stdout: decodeBase64(submission.stdout),
            stderr: decodeBase64(submission.stderr),
            compileOutput: decodeBase64(submission.compile_output),
            message: decodeBase64(submission.message),
            time: submission.time ?? null,
            memory: submission.memory ?? null,
            statusId: submission.status?.id ?? null,
            statusDescription: submission.status?.description ?? 'Unknown',
          };
        },
      });
      res.json(traceResult);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to reach sandboxed tracing service.';
      res.status(502).json({error: message});
    }
  });

  const isDev = process.argv.includes('--dev');
  if (isDev) {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Codex Online Compiler server listening on http://0.0.0.0:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
