export type Severity = "error" | "warning" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  suggestion: string;
  file: string;
  line: number;
  column: number;
  component?: string;
  codeSnippet?: string;
}

export interface InspectionResult {
  file: string;
  findings: Finding[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    total: number;
  };
  score: number; // 0–100, higher is better
}

export interface InspectionReport {
  files: InspectionResult[];
  totalFindings: number;
  overallScore: number;
  topIssues: Finding[];
  prReviewSummary: string;
}

export interface InspectFileInput {
  filePath: string;
  content?: string; // optional: pass raw code instead of reading disk
}

export interface InspectDirectoryInput {
  directoryPath: string;
  include?: string[]; // glob patterns, default ["**/*.tsx","**/*.jsx","**/*.ts","**/*.js"]
  exclude?: string[]; // glob patterns
  maxFiles?: number;
}
