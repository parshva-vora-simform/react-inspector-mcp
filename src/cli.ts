#!/usr/bin/env node
import * as path from "path";
import * as fs from "fs";
import { inspectFile, inspectDirectory, inspectCode } from "./inspector";
import { InspectionReport, InspectionResult } from "./types";

function printUsage(): void {
  console.log(`
React Performance Inspector — CLI

Usage:
  react-inspector-mcp inspect <path>          Inspect a file or directory
  react-inspector-mcp inspect <path> --json   Output raw JSON
  react-inspector-mcp snippet <code>          Inspect a code snippet string
  react-inspector-mcp rules                   List all rules
  react-inspector-mcp explain <rule-id>       Explain a rule

Examples:
  react-inspector-mcp inspect ./src
  react-inspector-mcp inspect ./src/App.tsx
  react-inspector-mcp inspect ./src --json > report.json
`);
}

const RULE_DOCS: Record<string, string> = {
  "inline-callback": "Arrow functions / function expressions passed as JSX props create new references on every render.",
  "missing-memo": "Functional components not wrapped in React.memo re-render whenever the parent does.",
  "heavy-computation-in-render": ".sort / .filter / .reduce etc. called directly in the render path run on every render. Wrap with useMemo.",
  "object-literal-prop": "Object/array literals in JSX props produce new references every render.",
  "missing-use-callback": "Handlers defined inside a component and passed as props should be wrapped in useCallback.",
  "context-value-not-memoized": "Inline objects as Context.Provider value force all consumers to re-render. Use useMemo.",
  "anonymous-component": "Anonymous default-export components appear as 'Anonymous' in React DevTools.",
  "use-effect-missing-deps": "useEffect without a dependency array runs after every render.",
  "state-update-in-render": "Calling setState directly in the component body causes an infinite re-render loop.",
  "large-component": "Components >150 lines are hard to optimise. Consider splitting.",
};

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  const jsonFlag = rest.includes("--json");
  const cleanArgs = rest.filter((a) => a !== "--json");

  if (command === "rules") {
    console.log("\nAvailable Rules:\n");
    for (const [id, desc] of Object.entries(RULE_DOCS)) {
      console.log(`  ${id.padEnd(35)} ${desc}`);
    }
    console.log();
    return;
  }

  if (command === "explain") {
    const ruleId = cleanArgs[0];
    if (!ruleId) { console.error("Usage: react-inspector-mcp explain <rule-id>"); process.exit(1); }
    const desc = RULE_DOCS[ruleId];
    if (!desc) { console.error(`Unknown rule: "${ruleId}". Run 'rules' to see all.`); process.exit(1); }
    console.log(`\n[${ruleId}]\n${desc}\n`);
    return;
  }

  if (command === "snippet") {
    const code = cleanArgs.join(" ");
    if (!code.trim()) { console.error("Provide code as a quoted string argument."); process.exit(1); }
    const result = inspectCode(code, "snippet.tsx");
    if (jsonFlag) { console.log(JSON.stringify(result, null, 2)); } else { printFileResult(result); }
    return;
  }

  if (command === "inspect") {
    const targetPath = cleanArgs[0];
    if (!targetPath) { console.error("Usage: react-inspector-mcp inspect <path>"); process.exit(1); }
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) { console.error(`Path not found: ${resolved}`); process.exit(1); }
    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
      const result = inspectFile({ filePath: resolved });
      if (jsonFlag) { console.log(JSON.stringify(result, null, 2)); } else { printFileResult(result); }
    } else if (stat.isDirectory()) {
      const report = await inspectDirectory({ directoryPath: resolved });
      if (jsonFlag) { console.log(JSON.stringify(report, null, 2)); } else { printReport(report); }
    } else {
      console.error("Path is neither a file nor a directory.");
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: "${command}"`);
  printUsage();
  process.exit(1);
}

function sevLabel(sev: string): string {
  return sev === "error" ? "🔴 ERROR  " : sev === "warning" ? "🟡 WARNING" : "🔵 INFO   ";
}

function printFileResult(result: InspectionResult): void {
  const { file, findings, summary, score } = result;
  console.log(`\n${"\u2500".repeat(70)}`);
  console.log(`File : ${file}`);
  console.log(`Score: ${score}/100   Findings: ${summary.total} (🔴${summary.errors} 🟡${summary.warnings} 🔵${summary.infos})`);
  console.log("\u2500".repeat(70));
  if (findings.length === 0) { console.log("  ✅ No issues found."); return; }
  for (const f of findings) {
    console.log(`\n  ${sevLabel(f.severity)} [${f.rule}] line ${f.line}`);
    console.log(`  ${f.message}`);
    console.log(`  💡 ${f.suggestion}`);
    if (f.codeSnippet) { console.log(`\n  ${f.codeSnippet.replace(/\n/g, "\n  ")}`); }
  }
  console.log();
}

function printReport(report: InspectionReport): void {
  console.log("\n" + "\u2550".repeat(70));
  console.log(" React Performance Inspector Report");
  console.log("\u2550".repeat(70));
  console.log(`\n  Overall Score : ${report.overallScore}/100`);
  console.log(`  Total Findings: ${report.totalFindings}`);
  console.log(`  Files Scanned : ${report.files.length}`);
  if (report.topIssues.length > 0) {
    console.log("\n  Top Issues:");
    for (const issue of report.topIssues) {
      console.log(`    ${sevLabel(issue.severity)} [${issue.rule}] ${path.basename(issue.file)}:${issue.line}`);
      console.log(`      ${issue.message}`);
    }
  }
  console.log("\n  Per-File Breakdown:");
  for (const r of report.files.sort((a, b) => a.score - b.score)) {
    if (r.summary.total === 0) continue;
    console.log(`    ${r.score.toString().padStart(3)}/100  ${path.relative(process.cwd(), r.file)}  (🔴${r.summary.errors} 🟡${r.summary.warnings} 🔵${r.summary.infos})`);
  }
  console.log("\n" + "\u2550".repeat(70));
  console.log("\nPR Review Summary (Markdown):\n");
  console.log(report.prReviewSummary);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
