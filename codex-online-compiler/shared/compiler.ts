export type LanguageKey =
  | 'java'
  | 'python'
  | 'c'
  | 'cpp'
  | 'javascript'
  | 'csharp'
  | 'php'
  | 'go'
  | 'ruby'
  | 'kotlin'
  | 'swift'
  | 'rust';

export interface LanguageConfig {
  key: LanguageKey;
  label: string;
  version: string;
  judge0Id: number;
  monacoLanguage: string;
  fileName: string;
  starterCode: string;
}

export type ExecutionVerdict =
  | 'PASS'
  | 'FAIL'
  | 'NOT_TESTED'
  | 'COMPILATION_ERROR'
  | 'RUNTIME_ERROR'
  | 'TIME_LIMIT_EXCEEDED'
  | 'EXECUTION_ERROR';

export interface ExecuteRequest {
  languageKey: LanguageKey;
  sourceCode: string;
  stdin: string;
  expectedOutput: string;
}

export interface ExecuteResponse {
  verdict: ExecutionVerdict;
  statusLabel: string;
  message: string;
  actualOutput: string;
  expectedOutput: string;
  normalizedActual: string;
  normalizedExpected: string;
  stderr: string;
  compileOutput: string;
  time: string | null;
  memory: number | null;
  judge0StatusId: number | null;
  judge0StatusDescription: string;
}

export interface TraceVariableValue {
  name: string;
  type: 'primitive' | 'array' | 'object' | 'pointer' | 'null';
  displayValue: string;
  elements?: Array<{index: number | string; value: string}>;
  properties?: Array<{key: string; value: string}>;
  memoryAddress?: string;
}

export interface TraceStackFrame {
  id: string;
  functionName: string;
  line: number;
  locals: TraceVariableValue[];
  returnValue?: string;
}

export type TraceEventKind =
  | 'line'
  | 'call'
  | 'return'
  | 'condition'
  | 'loop'
  | 'input'
  | 'output'
  | 'exception';

export interface TraceVariableChange {
  name: string;
  scope: string;
  previousValue: string | null;
  newValue: string;
}

export interface ExecutionTraceStep {
  stepIndex: number;
  line: number;
  codeLine: string;
  eventKind: TraceEventKind;
  stack: TraceStackFrame[];
  changedVariables: TraceVariableChange[];
  conditionEval?: {
    expression: string;
    result: boolean;
  };
  loopInfo?: {
    iteration: number;
    header: string;
  };
  ioEvent?: {
    kind: 'stdin' | 'stdout';
    text: string;
  };
  stdoutSoFar: string;
  explanation: {
    whatLineDoes: string;
    whyExecuting: string;
    variableSummary: string;
    whatNext: string;
  };
}

export interface VisualizeRequest {
  languageKey: LanguageKey;
  sourceCode: string;
  stdin: string;
}

export interface VisualizeResponse {
  supported: boolean;
  truncated: boolean;
  totalSteps: number;
  steps: ExecutionTraceStep[];
  finalStdout: string;
  stderr: string;
  compileOutput: string;
  errorType?:
    | 'COMPILATION_ERROR'
    | 'RUNTIME_ERROR'
    | 'TIME_LIMIT_EXCEEDED'
    | 'UNSUPPORTED_LANGUAGE'
    | 'TRACING_UNAVAILABLE';
  errorMessage?: string;
  limitationNote?: string;
  time: string | null;
  memory: number | null;
}

export const TRACE_SUPPORTED_LANGUAGES: LanguageKey[] = [
  'java',
  'python',
  'c',
  'cpp',
  'javascript',
];

export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  {
    key: 'java',
    label: 'Java',
    version: 'JDK 17.0.6',
    judge0Id: 91,
    monacoLanguage: 'java',
    fileName: 'Main.java',
    starterCode: `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        if (sc.hasNextInt()) {
            int a = sc.nextInt();
            int b = sc.hasNextInt() ? sc.nextInt() : 0;
            System.out.println(a + b);
        } else {
            System.out.println("Hello, World!");
        }
    }
}
`,
  },
  {
    key: 'python',
    label: 'Python',
    version: '3.12.5',
    judge0Id: 100,
    monacoLanguage: 'python',
    fileName: 'main.py',
    starterCode: `import sys

def main():
    tokens = sys.stdin.read().split()
    if len(tokens) >= 2:
        a, b = int(tokens[0]), int(tokens[1])
        print(a + b)
    elif len(tokens) == 1:
        print(tokens[0])
    else:
        print("Hello, World!")

if __name__ == "__main__":
    main()
`,
  },
  {
    key: 'c',
    label: 'C',
    version: 'GCC 14.1.0',
    judge0Id: 103,
    monacoLanguage: 'c',
    fileName: 'main.c',
    starterCode: `#include <stdio.h>

int main(void) {
    int a, b;
    if (scanf("%d %d", &a, &b) == 2) {
        printf("%d\\n", a + b);
    } else {
        printf("Hello, World!\\n");
    }
    return 0;
}
`,
  },
  {
    key: 'cpp',
    label: 'C++',
    version: 'GCC 14.1.0',
    judge0Id: 105,
    monacoLanguage: 'cpp',
    fileName: 'main.cpp',
    starterCode: `#include <iostream>
using namespace std;

int main() {
    long long a, b;
    if (cin >> a >> b) {
        cout << (a + b) << "\\n";
    } else {
        cout << "Hello, World!" << "\\n";
    }
    return 0;
}
`,
  },
  {
    key: 'javascript',
    label: 'JavaScript',
    version: 'Node.js 22.08.0',
    judge0Id: 102,
    monacoLanguage: 'javascript',
    fileName: 'main.js',
    starterCode: `const fs = require('fs');

const input = fs.readFileSync(0, 'utf8').trim();
if (input.length > 0) {
  const nums = input.split(/\\s+/).map(Number);
  if (nums.length >= 2 && !Number.isNaN(nums[0]) && !Number.isNaN(nums[1])) {
    console.log(nums[0] + nums[1]);
  } else {
    console.log(input);
  }
} else {
  console.log('Hello, World!');
}
`,
  },
  {
    key: 'csharp',
    label: 'C#',
    version: 'Mono 6.6.0',
    judge0Id: 51,
    monacoLanguage: 'csharp',
    fileName: 'Main.cs',
    starterCode: `using System;

public class Program
{
    public static void Main(string[] args)
    {
        string input = Console.In.ReadToEnd().Trim();
        if (!string.IsNullOrEmpty(input))
        {
            string[] parts = input.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 2 && int.TryParse(parts[0], out int a) && int.TryParse(parts[1], out int b))
            {
                Console.WriteLine(a + b);
                return;
            }
            Console.WriteLine(input);
        }
        else
        {
            Console.WriteLine("Hello, World!");
        }
    }
}
`,
  },
  {
    key: 'php',
    label: 'PHP',
    version: '8.3.11',
    judge0Id: 98,
    monacoLanguage: 'php',
    fileName: 'main.php',
    starterCode: `<?php
$input = trim(stream_get_contents(STDIN));
if ($input !== '') {
    $parts = preg_split('/\\s+/', $input);
    if (count($parts) >= 2 && is_numeric($parts[0]) && is_numeric($parts[1])) {
        echo ((int)$parts[0] + (int)$parts[1]) . "\\n";
    } else {
        echo $input . "\\n";
    }
} else {
    echo "Hello, World!\\n";
}
`,
  },
  {
    key: 'go',
    label: 'Go',
    version: '1.23.5',
    judge0Id: 107,
    monacoLanguage: 'go',
    fileName: 'main.go',
    starterCode: `package main

import (
	"fmt"
)

func main() {
	var a, b int
	n, _ := fmt.Scan(&a, &b)
	if n == 2 {
		fmt.Println(a + b)
	} else {
		fmt.Println("Hello, World!")
	}
}
`,
  },
  {
    key: 'ruby',
    label: 'Ruby',
    version: '2.7.0',
    judge0Id: 72,
    monacoLanguage: 'ruby',
    fileName: 'main.rb',
    starterCode: `input = STDIN.read.strip
if !input.empty?
  parts = input.split
  if parts.length >= 2
    puts parts[0].to_i + parts[1].to_i
  else
    puts input
  end
else
  puts "Hello, World!"
end
`,
  },
  {
    key: 'kotlin',
    label: 'Kotlin',
    version: '2.1.10',
    judge0Id: 111,
    monacoLanguage: 'kotlin',
    fileName: 'Main.kt',
    starterCode: `import java.util.Scanner

fun main() {
    val sc = Scanner(System.\`in\`)
    if (sc.hasNextInt()) {
        val a = sc.nextInt()
        val b = if (sc.hasNextInt()) sc.nextInt() else 0
        println(a + b)
    } else {
        println("Hello, World!")
    }
}
`,
  },
  {
    key: 'swift',
    label: 'Swift',
    version: '5.2.3',
    judge0Id: 83,
    monacoLanguage: 'swift',
    fileName: 'main.swift',
    starterCode: `import Foundation

let data = FileHandle.standardInput.readDataToEndOfFile()
let input = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

if !input.isEmpty {
    let parts = input.split(whereSeparator: { $0.isWhitespace })
    if parts.count >= 2, let a = Int(parts[0]), let b = Int(parts[1]) {
        print(a + b)
    } else {
        print(input)
    }
} else {
    print("Hello, World!")
}
`,
  },
  {
    key: 'rust',
    label: 'Rust',
    version: '1.85.0',
    judge0Id: 108,
    monacoLanguage: 'rust',
    fileName: 'main.rs',
    starterCode: `use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let nums: Vec<i64> = input
        .split_whitespace()
        .filter_map(|s| s.parse::<i64>().ok())
        .collect();

    if nums.len() >= 2 {
        println!("{}", nums[0] + nums[1]);
    } else {
        println!("Hello, World!");
    }
}
`,
  },
];

export const LANGUAGE_MAP: Record<LanguageKey, LanguageConfig> = Object.fromEntries(
  SUPPORTED_LANGUAGES.map((lang) => [lang.key, lang]),
) as Record<LanguageKey, LanguageConfig>;

export function normalizeOutput(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

export function evaluateTestResult(params: {
  executionSucceeded: boolean;
  errorVerdict?: 'COMPILATION_ERROR' | 'RUNTIME_ERROR' | 'TIME_LIMIT_EXCEEDED' | 'EXECUTION_ERROR';
  actualOutput: string;
  expectedOutput: string;
}): {
  verdict: ExecutionVerdict;
  statusLabel: string;
  message: string;
  normalizedActual: string;
  normalizedExpected: string;
} {
  const normalizedActual = normalizeOutput(params.actualOutput);
  const normalizedExpected = normalizeOutput(params.expectedOutput);

  if (!params.executionSucceeded) {
    const verdict = params.errorVerdict ?? 'EXECUTION_ERROR';
    const labelMap: Record<typeof verdict, string> = {
      COMPILATION_ERROR: 'Compilation Error',
      RUNTIME_ERROR: 'Runtime Error',
      TIME_LIMIT_EXCEEDED: 'Time Limit Exceeded',
      EXECUTION_ERROR: 'Execution Error',
    };
    return {
      verdict,
      statusLabel: labelMap[verdict],
      message: `${labelMap[verdict]} occurred during execution.`,
      normalizedActual,
      normalizedExpected,
    };
  }

  if (normalizedExpected.length === 0) {
    return {
      verdict: 'NOT_TESTED',
      statusLabel: 'NOT TESTED',
      message: 'Program executed. Enter expected output to validate test result.',
      normalizedActual,
      normalizedExpected,
    };
  }

  if (normalizedActual === normalizedExpected) {
    return {
      verdict: 'PASS',
      statusLabel: 'PASS',
      message: 'Output Matched Successfully!',
      normalizedActual,
      normalizedExpected,
    };
  }

  return {
    verdict: 'FAIL',
    statusLabel: 'FAIL',
    message:
      normalizedActual.length === 0
        ? 'Program produced no output, which does not match Expected Output.'
        : 'Actual output does not match Expected Output.',
    normalizedActual,
    normalizedExpected,
  };
}
