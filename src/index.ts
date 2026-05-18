#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { inspectFile, inspectDirectory, inspectCode } from "./inspector";

const InspectFileSchema = z.object({
  filePath: z.string().min(1, "filePath must be a non-empty string"),
  content: z.string().optional(),
});

const InspectDirectorySchema = z.object({
  directoryPath: z.string().min(1, "directoryPath must be a non-empty string"),
  include: z.array(z.string()).optional().default(["**/*.tsx", "**/*.jsx", "**/*.ts", "**/*.js"]),
  exclude: z.array(z.string()).optional().default(["**/node_modules/**", "**/dist/**", "**/build/**", "**/*.test.*", "**/*.spec.*", "**/*.d.ts"]),
  maxFiles: z.number().int().min(1).max(500).optional().default(200),
});

const InspectCodeSchema = z.object({
  code: z.string().min(1, "code must be a non-empty string"),
  fileName: z.string().optional().default("snippet.tsx"),
});

const TOOLS = [
  {
    name: "inspect_file",
    description: "Analyse a single React/TypeScript file for performance anti-patterns such as inline callbacks, missing React.memo, heavy computations in render, object literal props, missing useCallback, non-memoized context values, infinite re-render risks, missing useEffect deps, anonymous components, and oversized components. Returns structured findings with severity, line numbers, and actionable suggestions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filePath: { type: "string", description: "Absolute or relative path to the file to inspect." },
        content: { type: "string", description: "Optional: pass the raw source code directly instead of reading from disk." },
      },
      required: ["filePath"],
    },
  },
  {
    name: "inspect_directory",
    description: "Recursively analyse all React/TypeScript files in a directory for performance anti-patterns. Returns a consolidated report with per-file findings, an overall performance score (0–100), top issues sorted by severity, and a PR-review-ready markdown summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        directoryPath: { type: "string", description: "Absolute or relative path to the directory to scan." },
        include: { type: "array", items: { type: "string" }, description: "Glob patterns to include." },
        exclude: { type: "array", items: { type: "string" }, description: "Glob patterns to exclude." },
        maxFiles: { type: "number", description: "Maximum number of files to analyse (default: 200, max: 500)." },
      },
      required: ["directoryPath"],
    },
  },
  {
    name: "inspect_code_snippet",
    description: "Analyse a raw code snippet (string) for React performance anti-patterns. Useful for analysing code pasted directly into the chat.",
    inputSchema: {
      type: "object" as const,
      properties: {
        code: { type: "string", description: "The React/JSX/TSX source code to analyse." },
        fileName: { type: "string", description: "Optional virtual filename hint (e.g. 'MyComponent.tsx')." },
      },
      required: ["code"],
    },
  },
  {
    name: "explain_rule",
    description: "Get a detailed explanation of a specific performance rule, including why it matters, common examples, and how to fix it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        rule: { type: "string", description: "Rule name. One of: inline-callback, missing-memo, heavy-computation-in-render, object-literal-prop, missing-use-callback, context-value-not-memoized, anonymous-component, use-effect-missing-deps, state-update-in-render, large-component." },
      },
      required: ["rule"],
    },
  },
  {
    name: "list_rules",
    description: "List all available performance inspection rules with their severity levels and a short description.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

const RULE_DOCS: Record<string, { title: string; why: string; example: string; fix: string }> = {
  "inline-callback": {
    title: "Inline Callback",
    why: "Arrow functions or function expressions defined inline in JSX props create a brand-new function object on every render. If the child component uses `React.memo` or `PureComponent`, this breaks the shallow-equality check and forces an unnecessary re-render of the child.",
    example: `// ❌ Bad\n<Button onClick={() => handleClick(id)} />\n\n// ✅ Good\nconst handleClick = useCallback(() => doClick(id), [id]);\n<Button onClick={handleClick} />`,
    fix: "Extract the function and wrap it in `useCallback` with the correct dependency array.",
  },
  "missing-memo": {
    title: "Missing React.memo",
    why: "Without `React.memo`, a functional component re-renders whenever its parent re-renders, even if its own props are identical.",
    example: `// ❌ Bad\nexport function Avatar({ url }: Props) { return <img src={url} />; }\n\n// ✅ Good\nexport const Avatar = React.memo(function Avatar({ url }: Props) {\n  return <img src={url} />;\n});`,
    fix: "Wrap the component with `React.memo`.",
  },
  "heavy-computation-in-render": {
    title: "Heavy Computation in Render",
    why: "Calling `.sort()`, `.filter()`, `.reduce()` etc. directly in the render path runs the computation on every render.",
    example: `// ❌ Bad\nconst sorted = items.sort((a, b) => a.name.localeCompare(b.name));\n\n// ✅ Good\nconst sorted = useMemo(\n  () => [...items].sort((a, b) => a.name.localeCompare(b.name)),\n  [items]\n);`,
    fix: "Wrap expensive derivations in `useMemo` and list their inputs as dependencies.",
  },
  "object-literal-prop": {
    title: "Object / Array Literal Prop",
    why: "An object or array literal in JSX is recreated on each render, giving a new reference every time.",
    example: `// ❌ Bad\n<Chart style={{ color: 'red' }} data={[1, 2, 3]} />\n\n// ✅ Good\nconst CHART_STYLE = { color: 'red' };\nconst data = useMemo(() => [1, 2, 3], []);`,
    fix: "Move static literals outside the component. Memoize dynamic objects/arrays with `useMemo`.",
  },
  "missing-use-callback": {
    title: "Missing useCallback for Handler",
    why: "A handler function defined inside a component body is recreated on every render.",
    example: `// ❌ Bad\nconst handleSubmit = (e) => { e.preventDefault(); submit(data); };\n<Form onSubmit={handleSubmit} />\n\n// ✅ Good\nconst handleSubmit = useCallback((e) => {\n  e.preventDefault();\n  submit(data);\n}, [data]);`,
    fix: "Wrap the handler in `useCallback` and declare all values it closes over in the dependency array.",
  },
  "context-value-not-memoized": {
    title: "Context Value Not Memoized",
    why: "Every time the Provider's parent re-renders, a new object reference is passed as `value`, causing every context consumer to re-render.",
    example: `// ❌ Bad\n<AuthContext.Provider value={{ user, logout }}>\n\n// ✅ Good\nconst ctxValue = useMemo(() => ({ user, logout }), [user, logout]);\n<AuthContext.Provider value={ctxValue}>`,
    fix: "Memoize the context value object with `useMemo`.",
  },
  "anonymous-component": {
    title: "Anonymous Component Export",
    why: "Exporting an anonymous function as the default component means React DevTools shows it as `Anonymous`.",
    example: `// ❌ Bad\nexport default () => <div>Hello</div>;\n\n// ✅ Good\nexport default function Hello() { return <div>Hello</div>; }`,
    fix: "Always name component functions.",
  },
  "use-effect-missing-deps": {
    title: "useEffect Without Dependency Array",
    why: "Omitting the dependency array makes `useEffect` run after every single render.",
    example: `// ❌ Bad\nuseEffect(() => { fetchData(); });\n\n// ✅ Good\nuseEffect(() => { fetchData(); }, []);`,
    fix: "Add an explicit dependency array.",
  },
  "state-update-in-render": {
    title: "State Update in Render Body",
    why: "Calling a state setter directly in the component body causes an infinite re-render loop.",
    example: `// ❌ Bad\nfunction Counter() {\n  const [count, setCount] = useState(0);\n  setCount(count + 1); // infinite loop!\n  return <span>{count}</span>;\n}`,
    fix: "Move state updates into event handlers or `useEffect` with correct dependencies.",
  },
  "large-component": {
    title: "Oversized Component",
    why: "Components larger than ~150 lines are often doing too many things.",
    example: `// ❌ Bad\nfunction Dashboard() { /* 300 lines of everything */ }\n\n// ✅ Good\nfunction Dashboard() {\n  return <><Sidebar /><MainContent /><NotificationPanel /></>;\n}`,
    fix: "Extract logical sections into sub-components or custom hooks.",
  },
};

const ALL_RULES_SUMMARY = Object.entries(RULE_DOCS).map(([id, doc]) => ({
  id,
  title: doc.title,
  severity: new Set(["state-update-in-render", "context-value-not-memoized"]).has(id)
    ? "error"
    : new Set(["anonymous-component", "large-component"]).has(id)
    ? "info"
    : "warning",
}));

const server = new Server(
  { name: "react-inspector-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "inspect_file": {
        const input = InspectFileSchema.parse(args);
        const result = inspectFile(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "inspect_directory": {
        const input = InspectDirectorySchema.parse(args);
        const report = await inspectDirectory(input);
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      }
      case "inspect_code_snippet": {
        const input = InspectCodeSchema.parse(args);
        const result = inspectCode(input.code, input.fileName);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "explain_rule": {
        const ruleArg = z.object({ rule: z.string().min(1) }).parse(args);
        const doc = RULE_DOCS[ruleArg.rule];
        if (!doc) {
          return { content: [{ type: "text", text: `Unknown rule: "${ruleArg.rule}". Available: ${Object.keys(RULE_DOCS).join(", ")}` }], isError: true };
        }
        const text = [`## ${doc.title}`, "", `### Why it matters`, doc.why, "", `### Example`, "```tsx", doc.example, "```", "", `### How to fix`, doc.fix].join("\n");
        return { content: [{ type: "text", text }] };
      }
      case "list_rules": {
        const rows = ALL_RULES_SUMMARY.map((r) => `| \`${r.id}\` | ${r.title} | ${r.severity === "error" ? "🔴 Error" : r.severity === "warning" ? "🟡 Warning" : "🔵 Info"} |`).join("\n");
        const text = ["## Available Inspection Rules", "", "| Rule ID | Description | Default Severity |", "|---|---|---|", rows].join("\n");
        return { content: [{ type: "text", text }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error in tool "${name}": ${message}` }], isError: true };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("React Performance Inspector MCP server started");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
