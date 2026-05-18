import * as parser from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { Finding, Severity } from "./types";

/**
 * All individual rule checkers.
 * Each receives the AST root and the source lines array,
 * and pushes findings into the shared array.
 */

// ─── helpers ──────────────────────────────────────────────────────────────

function getLine(node: t.Node): number {
  return node.loc?.start.line ?? 0;
}

function getColumn(node: t.Node): number {
  return node.loc?.start.column ?? 0;
}

function snippet(lines: string[], lineNum: number, context = 0): string {
  const start = Math.max(0, lineNum - 1 - context);
  const end = Math.min(lines.length, lineNum + context);
  return lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join("\n");
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

// ─── rule implementations ──────────────────────────────────────────────

/**
 * RULE: inline-callback
 * Detects arrow functions or function expressions passed directly as JSX props.
 * e.g. <Button onClick={() => doSomething()} />
 */
export function ruleInlineCallback(
  ast: t.File,
  lines: string[],
  file: string,
  findings: Finding[]
): void {
  traverse(ast, {
    JSXAttribute(path) {
      const value = path.node.value;
      if (!value) return;

      let fnNode: t.Node | null = null;

      if (t.isJSXExpressionContainer(value)) {
        const expr = value.expression;
        if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) {
          fnNode = expr;
        }
      }

      if (!fnNode) return;

      const propName =
        t.isJSXIdentifier(path.node.name) ? path.node.name.name : "unknown";

      // Only flag event-handler-like props (on*, render*, children as fn)
      if (
        !/^(on[A-Z]|render[A-Z]?|children)/.test(propName) &&
        propName !== "children"
      ) {
        return;
      }

      const line = getLine(fnNode);
      findings.push({
        rule: "inline-callback",
        severity: "warning",
        message: `Inline ${propName === "children" ? "render prop" : "callback"} on prop \`${propName}\` creates a new function reference on every render.`,
        suggestion:
          "Extract the function outside the component or wrap it with `useCallback` to stabilise the reference and prevent unnecessary child re-renders.",
        file,
        line,
        column: getColumn(fnNode),
        codeSnippet: snippet(lines, line, 1),
      });
    },
  });
}

/**
 * RULE: missing-memo
 * Flags exported functional components that are not wrapped in React.memo
 * and receive non-primitive props (objects/arrays/functions in the parent).
 */
export function ruleMissingMemo(
  ast: t.File,
  lines: string[],
  file: string,
  findings: Finding[]
): void {
  const memoWrapped = new Set<string>();
  const components = new Map<string, t.Node>();

  // First pass: collect React.memo() calls
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      const isMemo =
        (t.isIdentifier(callee) && callee.name === "memo") ||
        (t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object) &&
          callee.object.name === "React" &&
          t.isIdentifier(callee.property) &&
          callee.property.name === "memo");

      if (!isMemo) return;

      // The argument to memo() is the component
      const arg = path.node.arguments[0];
      if (t.isIdentifier(arg)) {
        memoWrapped.add(arg.name);
      }

      // Also handle: const Foo = React.memo(function Foo() {})
      const parent = path.parent;
      if (
        t.isVariableDeclarator(parent) &&
        t.isIdentifier(parent.id)
      ) {
        memoWrapped.add(parent.id.name);
      }
    },
  });

  // Second pass: find functional components
  traverse(ast, {
    // Arrow function or function declaration assigned to PascalCase variable
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;
      const name = path.node.id.name;
      if (!isComponentName(name)) return;
      if (memoWrapped.has(name)) return;

      const init = path.node.init;
      if (
        !init ||
        (!t.isArrowFunctionExpression(init) && !t.isFunctionExpression(init))
      )
        return;

      // Check it returns JSX
      if (!returnsJSX(init)) return;

      components.set(name, path.node.id);
    },

    FunctionDeclaration(path) {
      const id = path.node.id;
      if (!id) return;
      if (!isComponentName(id.name)) return;
      if (memoWrapped.has(id.name)) return;
      if (!returnsJSX(path.node)) return;

      components.set(id.name, id);
    },
  });

  for (const [name, node] of components) {
    const line = getLine(node);
    findings.push({
      rule: "missing-memo",
      severity: "warning",
      message: `Component \`${name}\` is not wrapped in \`React.memo\`. It will re-render every time its parent re-renders, even when its props have not changed.`,
      suggestion: `Wrap with \`export default React.memo(${name})\` or \`const ${name} = React.memo(function ${name}(props) { … })\`.`,
      file,
      line,
      column: getColumn(node),
      component: name,
      codeSnippet: snippet(lines, line),
    });
  }
}

/** Helper: does a function node contain a JSX return? */
function returnsJSX(
  node:
    | t.ArrowFunctionExpression
    | t.FunctionExpression
    | t.FunctionDeclaration
): boolean {
  let found = false;

  const body = node.body;

  // Arrow with implicit return: () => <div />
  if (t.isJSXElement(body) || t.isJSXFragment(body)) return true;

  if (t.isBlockStatement(body)) {
    try {
      traverse(t.file(t.program([t.expressionStatement(node as t.Expression)])), {
        ReturnStatement(p) {
          if (
            p.node.argument &&
            (t.isJSXElement(p.node.argument) ||
              t.isJSXFragment(p.node.argument))
          ) {
            found = true;
            p.stop();
          }
        },
      });
    } catch {
      // Fallback: treat as component if name starts uppercase
      return true;
    }
  }

  return found;
}

/**
 * RULE: heavy-computation-in-render
 * Detects expensive operations (.sort, .filter, .map, .reduce, .forEach combined)
 * called directly in component body without useMemo.
 */
export function ruleHeavyComputation(
  ast: t.File,
  lines: string[],
  file: string,
  findings: Finding[]
): void {
  const heavyMethods = new Set(["sort", "filter", "reduce", "flat", "flatMap"]);

  traverse(ast, {
    // Look for component function bodies
    FunctionDeclaration(path) {
      if (!path.node.id || !isComponentName(path.node.id.name)) return;
      checkFunctionBody(path as NodePath<t.Function>, lines, file, findings, heavyMethods);
    },
    ArrowFunctionExpression(path) {
      const parent = path.parent;
      if (
        t.isVariableDeclarator(parent) &&
        t.isIdentifier(parent.id) &&
        isComponentName(parent.id.name)
      ) {
        checkFunctionBody(path as NodePath<t.Function>, lines, file, findings, heavyMethods);
      }
    },
  });
}

function checkFunctionBody(
  path: NodePath<t.Function>,
  lines: string[],
  file: string,
  findings: Finding[],
  heavyMethods: Set<string>
): void {
  // We flag method chains that are NOT inside a useMemo / useCallback call
  path.traverse({
    CallExpression(innerPath) {
      const callee = innerPath.node.callee;
      if (!t.isMemberExpression(callee)) return;
      if (!t.isIdentifier(callee.property)) return;

      const methodName = callee.property.name;
      if (!heavyMethods.has(methodName)) return;

      // Check if we're inside a useMemo / useCallback already
      let inMemo = false;
      let parent: NodePath | null = innerPath.parentPath;
      while (parent) {
        if (t.isCallExpression(parent.node)) {
          const c = parent.node.callee;
          if (
            (t.isIdentifier(c) &&
              (c.name === "useMemo" || c.name === "useCallback")) ||
            (t.isMemberExpression(c) &&
              t.isIdentifier(c.property) &&
              (c.property.name === "useMemo" ||
                c.property.name === "useCallback"))
          ) {
            inMemo = true;
            break;
          }
        }
        parent = parent.parentPath;
      }

      if (inMemo) return;

      const line = getLine(innerPath.node);
      findings.push({
        rule: "heavy-computation-in-render",
        severity: "warning",
        message: `\`.${methodName}()\` is called directly in the render path without \`useMemo\`. This computation runs on every render.`,
        suggestion: `Wrap the expression in \`useMemo(() => array.${methodName}(…), [deps])\` so it only recalculates when dependencies change.`,
        file,
        line,
        column: getColumn(innerPath.node),
        codeSnippet: snippet(lines, line, 1),
      });
    },
  });
}

/**
 * RULE: object-literal-prop
 * Detects object/array literals passed as JSX props, which create new references each render.
 * e.g. <Chart style={{ color: "red" }} data={[1, 2, 3]} />
 */
export function ruleObjectLiteralProp(
  ast: t.File,
  lines: string[],
  file: string,
  findings: Finding[]
): void {
  traverse(ast, {
    JSXAttribute(path) {
      const value = path.node.value;
      if (!t.isJSXExpressionContainer(value)) return;

      const expr = value.expression;
      if (
        !t.isObjectExpression(expr) &&
        !t.isArrayExpression(expr)
      )
        return;

      const propName = t.isJSXIdentifier(path.node.name)
        ? path.node.name.name
        : "unknown";
      const type = t.isObjectExpression(expr) ? "object" : "array";
      const line = getLine(expr);

      findings.push({
        rule: "object-literal-prop",
        severity: "warning",
        message: `${type === "object" ? "Object" : "Array"} literal passed as prop \`${propName}\` creates a new reference on every render.`,
        suggestion: `Move the ${type} outside the component, or memoize it with \`useMemo\` / \`useRef\` if it depends on state/props.`,
        file,
        line,
        column: getColumn(expr),
        codeSnippet: snippet(lines, line, 1),
      });
    },
  });
}

/**
 * RULE: missing-use-callback
 * Detects handler functions defined inside a component that are passed as props
 * but not wrapped in useCallback.
 */
export function ruleMissingUseCallback(
  ast: t.File,
  lines: string[],
  file: string,
  findings: Finding[]
): void {
  traverse(ast, {
    FunctionDeclaration: checkComponentForHandlers,
    ArrowFunctionExpression: checkComponentForHandlers,
  });

  function checkComponentForHandlers(
    path: NodePath<t.FunctionDeclaration | t.ArrowFunctionExpression>
  ): void {
    // Determine if this is a component
    let componentName: string | null = null;
    if (t.isFunctionDeclaration(path.node) && path.node.id) {
      componentName = path.node.id.name;
    } else if (t.isArrowFunctionExpression(path.node)) {
      const parent = path.parent;
      if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
        componentName = parent.id.name;
      }
    }

    if (!componentName || !isComponentName(componentName)) return;

    // Collect locally defined handler variables (function or arrow)
    const localHandlers = new Set<string>();

    path.traverse({
      VariableDeclarator(innerPath) {
        if (!t.isIdentifier(innerPath.node.id)) return;
        const init = innerPath.node.init;
        if (!init) return;

        // Skip if already wrapped in useCallback
        if (
          t.isCallExpression(init) &&
          (
            (t.isIdentifier(init.callee) && init.callee.name === "useCallback") ||
            (t.isMemberExpression(init.callee) &&
              t.isIdentifier(init.callee.property) &&
              init.callee.property.name === "useCallback")
          )
        ) {
          return;
        }

        if (
          t.isArrowFunctionExpression(init) ||
          t.isFunctionExpression(init)
        ) {
          localHandlers.add(innerPath.node.id.name);
        }
      },
    });

    if (localHandlers.size === 0) return;

    // Find JSX attributes that reference these handlers
    path.traverse({
      JSXAttribute(innerPath) {
        const value = innerPath.node.value;
        if (!t.isJSXExpressionContainer(value)) return;
        if (!t.isIdentifier(value.expression)) return;

        const handlerName = value.expression.name;
        if (!localHandlers.has(handlerName)) return;

        const propName = t.isJSXIdentifier(innerPath.node.name)
          ? innerPath.node.name.name
          : "unknown";
        if (!/^on[A-Z]/.test(propName)) return;

        const line = getLine(value.expression);
        findings.push({
          rule: "missing-use-callback",
          severity: "warning",
          message: `Handler \`${handlerName}\` is defined inside \`${componentName}\` and passed as \`${propName}\` without \`useCallback\`. A new function is created on every render.`,
          suggestion: `Wrap \`${handlerName}\` with \`useCallback\` and declare its dependency array to stabilise the reference.`,
          file,
          line,
          column: getColumn(value.expression),
          component: componentName ?? undefined,
          codeSnippet: snippet(lines, line, 1),
        });
      },
    });
  }
}

/**
 * RULE: context-value-not-memoized
 * Detects <Context.Provider value={…}> where the value is an inline object/array.
 */
export function ruleContextValueNotMemoized(
  ast: t.File,
  lines: string[],
  file: string,
  findings: Finding[]
): void {
  traverse(ast, {
    JSXOpeningElement(path) {
      const name = path.node.name;

      // Match <Something.Provider>
      if (!t.isJSXMemberExpression(name)) return;
      if (
        !t.isJSXIdentifier(name.property) ||
        name.property.name !== "Provider"
      )
        return;

      const valueAttr = path.node.attributes.find(
        (attr) =>
          t.isJSXAttribute(attr) &&
          t.isJSXIdentifier(attr.name) &&
          attr.name.name === "value"
      ) as t.JSXAttribute | undefined;

      if (!valueAttr) return;

      const val = valueAttr.value;
      if (!t.isJSXExpressionContainer(val)) return;

      const expr = val.expression;
      if (!t.isObjectExpression(expr) && !t.isArrayExpression(expr)) return;

      const contextName = t.isJSXIdentifier(name.object)
        ? name.object.name
        : "Context";
      const line = getLine(expr);

      findings.push({
        rule: "context-value-not-memoized",
        severity: "error",
        message: `\`<${contextName}.Provider value={…}>\` receives an inline ${t.isObjectExpression(expr) ? "object" : "array"}, causing ALL consumers to re-render on every provider render.`,
        suggestion:
          "Memoize the context value with `useMemo` and ensure the dependency array is correct.",
        file,
        line,
        column: getColumn(expr),
        codeSnippet: snippet(lines, line, 1),
      });
    },
  });
}

/**
 * RULE: anonymous-component
 * Detects components exported as anonymous functions/arrows (breaks React DevTools, memoization).
 */
export function ruleAnonymousComponent(
  ast: t.File,
  lines: string[],
  file: string,
  findings: Finding[]
): void {
  traverse(ast, {
    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      if (
        (t.isArrowFunctionExpression(decl) ||
          (t.isFunctionExpression(decl) && !decl.id)) &&
        returnsJSX(decl as t.ArrowFunctionExpression)
      ) {
        const line = getLine(decl);
        findings.push({
          rule: "anonymous-component",
          severity: "info",
          message:
            "Default export is an anonymous component function. React DevTools will show it as `Anonymous`.",
          suggestion:
            "Name the function: `export default function MyComponent() { … }` or assign to a named const before exporting.",
          file,
          line,
          column: getColumn(decl),
          codeSnippet: snippet(lines, line),
        });
      }
    },
  });
}

/**
 * RULE: use-effect-missing-deps
 * Detects useEffect / useLayoutEffect called with no dependency array at all
 * (runs on every render — often unintentional).
 */
export function ruleUseEffectMissingDeps(
  ast: t.File,
  lines: string[],
  file: string,
  findings: Finding[]
): void {
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      const isEffect =
        (t.isIdentifier(callee) &&
          (callee.name === "useEffect" || callee.name === "useLayoutEffect")) ||
        (t.isMemberExpression(callee) &&
          t.isIdentifier(callee.property) &&
          (callee.property.name === "useEffect" ||
            callee.property.name === "useLayoutEffect"));

      if (!isEffect) return;

      const args = path.node.arguments;
      // Missing 2nd argument entirely means no dep array
      if (args.length < 2) {
        const line = getLine(path.node);
        const hookName =
          t.isIdentifier(callee)
            ? callee.name
            : t.isMemberExpression(callee) && t.isIdentifier(callee.property)
            ? callee.property.name
            : "useEffect";

        findings.push({
          rule: "use-effect-missing-deps",
          severity: "warning",
          message: `\`${hookName}\` is called without a dependency array, so it runs after every render.`,
          suggestion:
            "Add an explicit dependency array `[]` for mount-only effects, or list the values the effect depends on.",
          file,
          line,
          column: getColumn(path.node),
          codeSnippet: snippet(lines, line, 1),
        });
      }
    },
  });
}

/**
 * RULE: state-update-in-render
 * Detects setState calls directly in component body (outside effects/handlers).
 */
export function ruleStateUpdateInRender(
  ast: t.File,
  lines: string[],
  file: string,
  findings: Finding[]
): void {
  traverse(ast, {
    FunctionDeclaration: checkForStateInBody,
    ArrowFunctionExpression: checkForStateInBody,
  });

  function checkForStateInBody(
    path: NodePath<t.FunctionDeclaration | t.ArrowFunctionExpression>
  ): void {
    let componentName: string | null = null;
    if (t.isFunctionDeclaration(path.node) && path.node.id) {
      componentName = path.node.id.name;
    } else if (t.isArrowFunctionExpression(path.node)) {
      const parent = path.parent;
      if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
        componentName = parent.id.name;
      }
    }
    if (!componentName || !isComponentName(componentName)) return;

    // Collect useState setter names
    const setters = new Set<string>();
    path.traverse({
      VariableDeclarator(inner) {
        if (!t.isArrayPattern(inner.node.id)) return;
        const elements = inner.node.id.elements;
        if (elements.length < 2) return;
        const setter = elements[1];
        if (setter && t.isIdentifier(setter) && /^set[A-Z]/.test(setter.name)) {
          setters.add(setter.name);
        }
      },
    });

    if (setters.size === 0) return;

    // Flag setter calls that are direct children of the component body
    const body = path.node.body;
    if (!t.isBlockStatement(body)) return;

    for (const stmt of body.body) {
      traverseStatement(stmt, setters, componentName, lines, file, findings);
    }
  }

  function traverseStatement(
    stmt: t.Statement,
    setters: Set<string>,
    componentName: string,
    lines: string[],
    file: string,
    findings: Finding[]
  ): void {
    if (t.isExpressionStatement(stmt)) {
      const expr = stmt.expression;
      if (
        t.isCallExpression(expr) &&
        t.isIdentifier(expr.callee) &&
        setters.has(expr.callee.name)
      ) {
        const line = getLine(expr);
        findings.push({
          rule: "state-update-in-render",
          severity: "error",
          message: `\`${expr.callee.name}()\` is called directly in the render body of \`${componentName}\`, causing an infinite re-render loop.`,
          suggestion:
            "Move state updates into event handlers or `useEffect` with appropriate dependencies.",
          file,
          line,
          column: getColumn(expr),
          component: componentName,
          codeSnippet: snippet(lines, line, 1),
        });
      }
    }
  }
}

/**
 * RULE: large-component
 * Flags components longer than 150 lines — they are likely doing too much.
 */
export function ruleLargeComponent(
  ast: t.File,
  lines: string[],
  file: string,
  findings: Finding[]
): void {
  const THRESHOLD = 150;

  traverse(ast, {
    FunctionDeclaration(path) {
      const id = path.node.id;
      if (!id || !isComponentName(id.name)) return;
      checkLength(path.node, id.name, lines, file, findings, THRESHOLD);
    },
    ArrowFunctionExpression(path) {
      const parent = path.parent;
      if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
        const name = parent.id.name;
        if (!isComponentName(name)) return;
        checkLength(path.node, name, lines, file, findings, THRESHOLD);
      }
    },
  });

  function checkLength(
    node: t.Function,
    name: string,
    lines: string[],
    file: string,
    findings: Finding[],
    threshold: number
  ): void {
    const start = node.loc?.start.line ?? 0;
    const end = node.loc?.end.line ?? 0;
    const length = end - start;
    if (length > threshold) {
      findings.push({
        rule: "large-component",
        severity: "info",
        message: `Component \`${name}\` is ${length} lines long (threshold: ${threshold}). Large components are harder to optimise and test.`,
        suggestion:
          "Consider splitting into smaller sub-components or custom hooks to improve readability and enable targeted memoization.",
        file,
        line: start,
        column: 0,
        component: name,
      });
    }
  }
}
