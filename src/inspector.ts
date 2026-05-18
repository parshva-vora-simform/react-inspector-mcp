import * as fs from "fs";
import * as path from "path";
import * as parser from "@babel/parser";
import * as t from "@babel/types";
import { glob } from "glob";
import { Finding, InspectionReport, InspectionResult, InspectDirectoryInput, InspectFileInput } from "./types";
import {
  ruleInlineCallback,
  ruleMissingMemo,
  ruleHeavyComputation,
  ruleObjectLiteralProp,
  ruleMissingUseCallback,
  ruleContextValueNotMemoized,
  ruleAnonymousComponent,
  ruleUseEffectMissingDeps,
  ruleStateUpdateInRender,
  ruleLargeComponent,
} from "./rules";

// ─── parser ───────────────────────────────────────────────────────────────

function parseSource(code: string, filePath: string): t.File {
  const ext = path.extname(filePath).toLowerCase();
  const plugins: parser.ParserPlugin[] = [
    "jsx",
    "classProperties",
    "classPrivateProperties",
    "classPrivateMethods",
    "decorators-legacy",
    "exportDefaultFrom",
    "dynamicImport",
    "optionalChaining",
    "nullishCoalescingOperator",
    "objectRestSpread",
  ];

  if (ext === ".ts" || ext === ".tsx") {
    plugins.push("typescript");
  }

  try {
    return parser.parse(code, {
      sourceType: "module",
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      plugins,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Parse error in ${filePath}: ${message}`);
  }
}

// ─── single-file inspector ────────────────────────────────────────────────

export function inspectCode(code: string, filePath: string): InspectionResult {
  const findings: Finding[] = [];
  const lines = code.split("\n");

  let ast: t.File;
  try {
    ast = parseSource(code, filePath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      file: filePath,
      findings: [
        {
          rule: "parse-error",
          severity: "error",
          message: `Could not parse file: ${message}`,
          suggestion: "Ensure the file is valid JavaScript/TypeScript with JSX.",
          file: filePath,
          line: 0,
          column: 0,
        },
      ],
      summary: { errors: 1, warnings: 0, infos: 0, total: 1 },
      score: 0,
    };
  }

  // Run all rules
  const allRules = [
    ruleStateUpdateInRender,       // errors first
    ruleContextValueNotMemoized,
    ruleInlineCallback,
    ruleMissingMemo,
    ruleHeavyComputation,
    ruleObjectLiteralProp,
    ruleMissingUseCallback,
    ruleUseEffectMissingDeps,
    ruleAnonymousComponent,
    ruleLargeComponent,
  ];

  for (const rule of allRules) {
    try {
      rule(ast, lines, filePath, findings);
    } catch {
      // Rule crash should never break the whole inspection
    }
  }

  // Deduplicate: same rule + line + column
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.rule}:${f.line}:${f.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const errors = unique.filter((f) => f.severity === "error").length;
  const warnings = unique.filter((f) => f.severity === "warning").length;
  const infos = unique.filter((f) => f.severity === "info").length;

  // Score: start at 100, deduct per finding
  const score = Math.max(
    0,
    100 - errors * 20 - warnings * 8 - infos * 2
  );

  return {
    file: filePath,
    findings: unique,
    summary: { errors, warnings, infos, total: unique.length },
    score,
  };
}

export function inspectFile(input: InspectFileInput): InspectionResult {
  const { filePath, content } = input;

  let code: string;
  if (content !== undefined) {
    code = content;
  } else {
    if (!fs.existsSync(filePath)) {
      return {
        file: filePath,
        findings: [
          {
            rule: "file-not-found",
            severity: "error",
            message: `File not found: ${filePath}`,
            suggestion: "Check the file path and try again.",
            file: filePath,
            line: 0,
            column: 0,
          },
        ],
        summary: { errors: 1, warnings: 0, infos: 0, total: 1 },
        score: 0,
      };
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return {
        file: filePath,
        findings: [
          {
            rule: "not-a-file",
            severity: "error",
            message: `Path is not a file: ${filePath}`,
            suggestion: "Use inspect_directory for directories.",
            file: filePath,
            line: 0,
            column: 0,
          },
        ],
        summary: { errors: 1, warnings: 0, infos: 0, total: 1 },
        score: 0,
      };
    }

    // Guard against huge files (> 2 MB)
    if (stat.size > 2 * 1024 * 1024) {
      return {
        file: filePath,
        findings: [
          {
            rule: "file-too-large",
            severity: "info",
            message: `File is ${(stat.size / 1024).toFixed(0)} KB — skipped to avoid excessive memory usage.`,
            suggestion: "Consider splitting the file.",
            file: filePath,
            line: 0,
            column: 0,
          },
        ],
        summary: { errors: 0, warnings: 0, infos: 1, total: 1 },
        score: 50,
      };
    }

    code = fs.readFileSync(filePath, "utf-8");
  }

  return inspectCode(code, filePath);
}

// ─── directory inspector ──────────────────────────────────────────────────────

export async function inspectDirectory(
  input: InspectDirectoryInput
): Promise<InspectionReport> {
  const {
    directoryPath,
    include = ["**/*.tsx", "**/*.jsx", "**/*.ts", "**/*.js"],
    exclude = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/*.test.*", "**/*.spec.*", "**/*.d.ts"],
    maxFiles = 200,
  } = input;

  if (!fs.existsSync(directoryPath)) {
    throw new Error(`Directory not found: ${directoryPath}`);
  }

  const stat = fs.statSync(directoryPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${directoryPath}`);
  }

  // Collect matching files
  let files: string[] = [];
  for (const pattern of include) {
    const matches = await glob(pattern, {
      cwd: directoryPath,
      ignore: exclude,
      absolute: true,
    });
    files.push(...matches);
  }

  // Deduplicate
  files = [...new Set(files)];

  if (files.length === 0) {
    return buildReport([]);
  }

  if (files.length > maxFiles) {
    files = files.slice(0, maxFiles);
  }

  const results = files.map((f) => inspectFile({ filePath: f }));
  return buildReport(results);
}

// ─── report builder ───────────────────────────────────────────────────────

function buildReport(results: InspectionResult[]): InspectionReport {
  const allFindings = results.flatMap((r) => r.findings);
  const totalFindings = allFindings.length;

  const overallScore =
    results.length === 0
      ? 100
      : Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);

  // Top issues: errors first, then warnings, sorted by line
  const topIssues = [...allFindings]
    .sort((a, b) => {
      const sev: Record<string, number> = { error: 0, warning: 1, info: 2 };
      return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3);
    })
    .slice(0, 10);

  const prReviewSummary = buildPRSummary(results, overallScore, topIssues);

  return { files: results, totalFindings, overallScore, topIssues, prReviewSummary };
}

function buildPRSummary(
  results: InspectionResult[],
  score: number,
  topIssues: Finding[]
): string {
  const totalErrors = results.reduce((s, r) => s + r.summary.errors, 0);
  const totalWarnings = results.reduce((s, r) => s + r.summary.warnings, 0);
  const totalInfos = results.reduce((s, r) => s + r.summary.infos, 0);

  const emoji = score >= 85 ? "✅" : score >= 60 ? "⚠️" : "❌";
  const verdict =
    score >= 85
      ? "Good — no critical performance issues found."
      : score >= 60
      ? "Needs attention — some render performance issues detected."
      : "Requires changes — high-impact performance issues present.";

  let summary = `## ${emoji} React Performance Inspector Report\n\n`;
  summary += `**Overall Score: ${score}/100** — ${verdict}\n\n`;
  summary += `| Severity | Count |\n|---|---|\n`;
  summary += `| 🔴 Error | ${totalErrors} |\n`;
  summary += `| 🟡 Warning | ${totalWarnings} |\n`;
  summary += `| 🔵 Info | ${totalInfos} |\n\n`;

  if (topIssues.length > 0) {
    summary += `### Top Issues\n\n`;
    for (const issue of topIssues) {
      const sevIcon =
        issue.severity === "error"
          ? "🔴"
          : issue.severity === "warning"
          ? "🟡"
          : "🔵";
      summary += `${sevIcon} **[${issue.rule}]** \`${issue.file}:${issue.line}\`\n`;
      summary += `> ${issue.message}\n`;
      summary += `> 💡 ${issue.suggestion}\n\n`;
    }
  }

  const worstFile = [...results].sort((a, b) => a.score - b.score)[0];
  if (worstFile && worstFile.findings.length > 0) {
    summary += `### Most Affected File\n\`${worstFile.file}\` — Score: ${worstFile.score}/100 (${worstFile.summary.total} findings)\n`;
  }

  return summary;
}
