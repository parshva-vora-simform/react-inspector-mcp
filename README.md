# React Performance Inspector MCP

A **Model Context Protocol (MCP) server** that acts as a senior React performance reviewer.  
It statically analyses your React / TypeScript codebase for silent re-render regressions and provides actionable, line-level findings — ready to drop into a PR review.

---

## What it detects

| Rule | Severity | What it catches |
|---|---|---|
| `state-update-in-render` | 🔴 Error | setState called in component body → infinite loop |
| `context-value-not-memoized` | 🔴 Error | Inline object/array as `<Context.Provider value>` |
| `inline-callback` | 🟡 Warning | `onClick={() => …}` inline arrow functions |
| `missing-memo` | 🟡 Warning | Components not wrapped in `React.memo` |
| `heavy-computation-in-render` | 🟡 Warning | `.sort()`, `.filter()`, `.reduce()` without `useMemo` |
| `object-literal-prop` | 🟡 Warning | `style={{ … }}` / `data={[…]}` inline literals |
| `missing-use-callback` | 🟡 Warning | Handlers passed as props without `useCallback` |
| `use-effect-missing-deps` | 🟡 Warning | `useEffect` / `useLayoutEffect` with no dep array |
| `anonymous-component` | 🔵 Info | Anonymous default export (`export default () => …`) |
| `large-component` | 🔵 Info | Components longer than 150 lines |

---

## Project structure

```
react-inspector-mcp/
├── src/
│   ├── index.ts        # MCP server (stdio transport)
│   ├── cli.ts          # Standalone CLI
│   ├── inspector.ts    # File / directory inspection engine
│   ├── rules.ts        # All 10 AST-based rule implementations
│   └── types.ts        # Shared TypeScript types
├── dist/               # Compiled output (after build)
├── package.json
└── tsconfig.json
```

---

## Step-by-step setup

### Prerequisites

- **Node.js** 18 or higher
- **npm** 9 or higher

```bash
node -v   # should print v18.x or above
npm -v    # should print 9.x or above
```

---

### Step 1 — Clone the project

```bash
git clone https://github.com/parshva-vora-simform/react-inspector-mcp.git
cd react-inspector-mcp
```

---

### Step 2 — Install dependencies

```bash
npm install
```

---

### Step 3 — Build

```bash
npm run build
```

This compiles TypeScript to `dist/`. You only need to re-run this after changing source files.

---

### Step 4 — Add to your MCP client config

After a successful build, register the server in your AI client. Pick the one you use:

---

#### VS Code (GitHub Copilot Chat)

Open **VS Code Settings JSON** (`Ctrl+Shift+P` → `Open User Settings (JSON)`) and add:

```jsonc
{
  "mcp": {
    "servers": {
      "react-inspector": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/react-inspector-mcp/dist/index.js"]
      }
    }
  }
}
```

Then:
1. Save `settings.json`
2. Open Copilot Chat (`Ctrl+Alt+I`)
3. Type `List all react-inspector rules` — if you see a table of rules, the server is connected

---

#### Claude Desktop

Open the config file for your OS:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Add this inside the file:

```json
{
  "mcpServers": {
    "react-inspector": {
      "command": "node",
      "args": ["/absolute/path/to/react-inspector-mcp/dist/index.js"]
    }
  }
}
```

Then:
1. Save the file
2. **Fully quit and relaunch** Claude Desktop
3. Start a new chat and type `List react-inspector rules` — you should see all 10 rules

---

#### Cursor

Open `~/.cursor/mcp.json` (create it if it doesn't exist) and add:

```json
{
  "mcpServers": {
    "react-inspector": {
      "command": "node",
      "args": ["/absolute/path/to/react-inspector-mcp/dist/index.js"]
    }
  }
}
```

Restart Cursor. The tools will be available in Cursor's Agent mode.

---

#### Any other MCP-compatible client

```
Transport : stdio
Command   : node
Args      : ["/absolute/path/to/react-inspector-mcp/dist/index.js"]
```

---

> **Path note:** Replace `/absolute/path/to/react-inspector-mcp` with the actual path where you cloned the repo.

---

### Step 5 — Try the CLI (optional)

> You can skip this step if you're going straight to the MCP client. The CLI is useful for quick checks without any AI client.

```bash
# Inspect a single file
node dist/cli.js inspect ./src/components/Dashboard.tsx

# Inspect an entire directory
node dist/cli.js inspect ./src

# Output raw JSON (for CI / scripting)
node dist/cli.js inspect ./src --json > report.json

# Inspect a code snippet
node dist/cli.js snippet "function Foo({ items }) { return <ul onClick={() => {}} />; }"

# List all rules
node dist/cli.js rules

# Explain a rule
node dist/cli.js explain inline-callback
node dist/cli.js explain context-value-not-memoized
```

---

### Step 6 — Use the MCP in your AI client

Once the server is configured and your client is restarted, you can start asking naturally.

#### Verify the server is connected

```
List all react-inspector rules
```

You should see a table of all 10 rules. That confirms the MCP is live.

---

#### Inspect a directory (most common)

```
Inspect /path/to/my-app/src for React performance issues
```

```
Review the src/components folder for re-render problems and give me a PR summary
```

---

#### Inspect a single file

```
Analyse /path/to/my-app/src/components/Dashboard.tsx for performance anti-patterns
```

---

#### Inspect pasted code

```
Check this component for performance issues:

function UserList({ users }) {
  const filtered = users.filter(u => u.active);
  return (
    <ul>
      {filtered.map(u => (
        <li key={u.id} onClick={() => select(u)}>{u.name}</li>
      ))}
    </ul>
  );
}
```

---

#### Learn about a specific rule

```
Explain the context-value-not-memoized rule
```

---

#### Use as a PR reviewer

```
Act as a senior React reviewer. Inspect this code and tell me what would cause silent re-render regressions.
```

---

## Available MCP tools

| Tool | What it does |
|---|---|
| `inspect_file` | Analyse a single `.tsx` / `.jsx` / `.ts` / `.js` file |
| `inspect_directory` | Recursively scan a directory, return per-file scores + PR markdown |
| `inspect_code_snippet` | Analyse raw code passed as a string |
| `explain_rule` | Get detailed explanation + examples for any rule |
| `list_rules` | List all 10 rules with severity levels |

---

## Example output

```
──────────────────────────────────────────────────────────────────────
File : /src/Dashboard.tsx
Score: 52/100   Findings: 4 (🔴1 🟡3 🔵0)
──────────────────────────────────────────────────────────────────────

  🔴 ERROR   [state-update-in-render] line 8
  `setData()` is called directly in the render body of `Dashboard`.
  💡 Move state updates into event handlers or `useEffect`.

  🟡 WARNING [inline-callback] line 22
  Inline callback on prop `onClick` creates a new function reference on every render.
  💡 Wrap with `useCallback` to stabilise the reference.
```

---

## Scoring

Each file starts at **100 points**:

- 🔴 Error → **−20 points**
- 🟡 Warning → **−8 points**
- 🔵 Info → **−2 points**

| Score | Verdict |
|---|---|
| 85–100 | ✅ Good |
| 60–84 | ⚠️ Needs attention |
| 0–59 | ❌ Requires changes |

---

## Edge cases handled

- Parse errors → reported as a finding, other files continue
- Files > 2 MB → skipped with an info finding
- File / directory not found → clear error message
- Rule crashes → caught per-rule, others still run
- Duplicate findings → deduplicated by rule + line + column
- Already-memoized code → not flagged
- `.d.ts` and test files → excluded by default

---

## Development

```bash
npx tsc --watch          # watch mode
npx ts-node src/cli.ts inspect ./src   # run from source
```

---

## License

MIT
