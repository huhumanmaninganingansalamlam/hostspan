import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const posix = (p) => p.split(sep).join("/");
const isInside = (path, dir) => path === dir || path.startsWith(dir + sep);
const problem = (code, path, message, remediation) => ({ code, path, message, remediation });

export function collectSourceModules(rootDir) {
  const sourceDir = resolve(rootDir, "src");
  const modules = [];
  function visit(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const absolute = join(dir, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { visit(absolute); continue; }
      if (!stat.isFile() || extname(name) !== ".ts" || name.endsWith(".d.ts")) continue;
      const source = readFileSync(absolute, "utf8");
      modules.push({
        path: posix(relative(resolve(rootDir), absolute)),
        absolute,
        source,
        lines: source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0),
        ast: ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true),
      });
    }
  }
  visit(sourceDir);
  return modules;
}

export function collectRelativeImportEdges(modules, rootDir) {
  const sourceDir = resolve(rootDir, "src");
  const edges = [];
  for (const module of modules) {
    const record = (specifier, node) => {
      if (!specifier?.startsWith(".")) return;
      let destination = resolve(dirname(module.absolute), specifier);
      if (destination.endsWith(".js")) destination = destination.slice(0, -3) + ".ts";
      if (!isInside(destination, sourceDir)) return;
      edges.push({
        from: module.path,
        to: posix(relative(resolve(rootDir), destination)),
        specifier,
        line: module.ast.getLineAndCharacterOfPosition(node.getStart(module.ast)).line + 1,
      });
    };
    function traverse(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        record(node.moduleSpecifier.text, node);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        record(node.arguments[0].text, node);
      }
      ts.forEachChild(node, traverse);
    }
    traverse(module.ast);
  }
  return edges;
}

export function validateDependencyPolicy(edges, policy) {
  const violations = [];
  for (const edge of edges) {
    const source = edge.from.split("/")[1];
    const dest = edge.to.split("/")[1];
    for (const forbidden of policy.forbiddenImports || []) {
      if (forbidden.from.includes(source) && forbidden.to.includes(dest)) {
        violations.push(problem(
          "FORBIDDEN_IMPORT", edge.from + ":" + edge.line,
          edge.specifier + " crosses forbidden " + source + " -> " + dest + " ownership: " + forbidden.reason,
          "Depend on the owning domain contract or let runtime/adapters compose the interaction.",
        ));
        break;
      }
    }
  }
  return violations;
}

function exactFunctionSize(module, symbol) {
  const sizes = [];
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
      const name = node.name.getText(module.ast);
      const owner = ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent)
        ? node.parent.name?.text + "." + name : name;
      if (owner === symbol) {
        const first = module.ast.getLineAndCharacterOfPosition(node.getStart(module.ast)).line + 1;
        const last = module.ast.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        sizes.push({ lines: last - first + 1, first, last });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(module.ast);
  return sizes;
}

export function validateFileBudgets(modules, policy) {
  const violations = [];
  const byPath = new Map(modules.map((module) => [module.path, module]));
  for (const module of modules) {
    const reviewed = policy.fileBudgets?.[module.path];
    const max = reviewed?.maxLines ?? policy.maxNewTypeScriptLines ?? 400;
    if (reviewed && (!reviewed.owner || !reviewed.reason || !reviewed.reviewTrigger)) {
      violations.push(problem("UNREVIEWED_FILE_EXCEPTION", module.path,
        "File budget has no concrete owner, reason and review trigger.",
        "Document all three fields or remove the exception."));
    }
    if (module.lines > max) violations.push(problem("FILE_BUDGET", module.path,
      "File has " + module.lines + " lines; reviewed maximum is " + max + ".",
      "Extract an owned responsibility with focused tests, or justify a narrow reviewed budget."));
  }
  for (const path of Object.keys(policy.fileBudgets || {})) {
    if (path.includes("*")) {
      violations.push(problem("BROAD_FILE_EXCEPTION", path,
        "Glob file budget exceptions cannot be reviewed precisely.",
        "Declare the exact cohesive file, owner, reason and review trigger."));
    }
    if (!byPath.has(path)) {
      violations.push(problem("STALE_FILE_EXCEPTION", path,
        "File budget exception points to a missing source file.",
        "Remove stale exceptions after a refactor or update the exact owned path."));
    }
  }
  for (const rule of policy.functionBudgets || []) {
    const module = byPath.get(rule.path);
    if (!module) {
      violations.push(problem("MISSING_FUNCTION_OWNER", rule.path, "Composition file is missing.",
        "Correct the exact owned file path in the policy."));
      continue;
    }
    const matches = exactFunctionSize(module, rule.symbol);
    if (matches.length !== 1) {
      violations.push(problem("MISSING_FUNCTION_OWNER", rule.path, "Expected exactly one " + rule.symbol + " declaration, got " + matches.length + ".",
        "Update the function owner rule to its actual, unique symbol."));
      continue;
    }
    if (matches[0].lines > rule.maxLines) violations.push(problem("FUNCTION_BUDGET", rule.path + ":" + matches[0].first,
      rule.symbol + " has " + matches[0].lines + " lines; maximum " + rule.maxLines + ".",
      "Keep entrypoints as orchestration roots and extract business behavior into typed owners."));
  }
  return violations;
}

function exported(node) {
  return Boolean(node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword));
}

function rawRecord(node) {
  let found = false;
  function visit(child) {
    if (ts.isIndexSignatureDeclaration(child)) found = true;
    if (ts.isTypeReferenceNode(child) && child.typeName.getText() === "Record" && child.typeArguments?.length === 2 &&
        child.typeArguments[0].kind === ts.SyntaxKind.StringKeyword &&
        child.typeArguments[1].kind === ts.SyntaxKind.UnknownKeyword) found = true;
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

export function validateBoundaryTypes(modules, policy) {
  const violations = [];
  const byPath = new Map(modules.map((module) => [module.path, module]));
  for (const rule of policy.boundaryTypeRules || []) {
    const module = byPath.get(rule.path);
    if (!module) {
      violations.push(problem("MISSING_TYPED_BOUNDARY", rule.path, "Boundary source file missing.",
        "Restore the named exported type or update its exact owner in policy."));
      continue;
    }
    const candidates = module.ast.statements.filter((node) => {
      if (!exported(node)) return false;
      if (rule.kind === "interface" && !ts.isInterfaceDeclaration(node)) return false;
      if (rule.kind === "type" && !ts.isTypeAliasDeclaration(node)) return false;
      if (rule.kind === "function" && !ts.isFunctionDeclaration(node)) return false;
      return node.name?.text === rule.symbol;
    });
    if (candidates.length !== 1) {
      violations.push(problem("MISSING_TYPED_BOUNDARY", rule.path,
        "Expected one exported " + rule.kind + " " + rule.symbol + ", found " + candidates.length + ".",
        "Export one finite named shape at the approved boundary."));
      continue;
    }
    const node = candidates[0];
    if (rawRecord(node)) violations.push(problem("UNTYPED_BOUNDARY", rule.path,
      rule.symbol + " contains a raw Record<string, unknown> or index signature.",
      "Introduce finite, explicit fields; keep unknown only at validated external parse boundaries."));
    if (ts.isFunctionDeclaration(node) && !node.type) {
      violations.push(problem("UNTYPED_BOUNDARY", rule.path,
        rule.symbol + " has no declared return type.",
        "Give this exported parser/auth/composition boundary an explicit return shape."));
    }
  }
  return violations;
}

export function validateDoubleAssertions(modules, policy) {
  const violations = [];
  const matching = new Map();
  for (const module of modules) {
    function visit(node) {
      // Detect actual TypeScript assertions, not prose, comments, or string literals.
      if (ts.isAsExpression(node) && ts.isAsExpression(node.expression) &&
          node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) {
        const expression = node.getText(module.ast);
        const exceptions = (policy.doubleAssertionExceptions || []).filter(
          (entry) => entry.path === module.path && expression.includes(entry.needle)
        );
        const line = module.ast.getLineAndCharacterOfPosition(node.getStart(module.ast)).line + 1;
        if (exceptions.length !== 1) {
          violations.push(problem("UNREVIEWED_DOUBLE_ASSERTION", module.path + ":" + line,
            "Unsafe as unknown as cast has no exact, reviewed adapter exception.",
            "Validate the boundary shape or record a narrow platform-adapter exception with owner and removal trigger."));
        } else matching.set(exceptions[0].path + "#" + exceptions[0].needle, true);
      }
      ts.forEachChild(node, visit);
    }
    visit(module.ast);
  }
  for (const exception of policy.doubleAssertionExceptions || []) {
    if (!exception.owner || !exception.reason || !exception.reviewTrigger ||
        exception.path.includes("*") || exception.needle.includes("*")) {
      violations.push(problem("UNREVIEWED_DOUBLE_ASSERTION", exception.path,
        "Exception needs a precise path, expression, owner, reason and review trigger.",
        "Restrict the exception to one reviewed platform-adapter seam."));
    }
    if (!matching.get(exception.path + "#" + exception.needle)) {
      violations.push(problem("STALE_DOUBLE_ASSERTION_EXCEPTION", exception.path,
        "No matching cast for " + exception.needle + ".",
        "Remove obsolete exception instead of accumulating blanket suppressions."));
    }
  }
  return violations;
}

export function validateProductHygiene(rootDir, policy) {
  const violations = [];
  const hygiene = policy.hygiene || {};
  const ignore = existsSync(join(rootDir, ".gitignore")) ? readFileSync(join(rootDir, ".gitignore"), "utf8").split(/\r?\n/).map((x) => x.trim()) : [];
  for (const pattern of hygiene.requiredGitignore || []) {
    if (!ignore.includes(pattern)) violations.push(problem("MISSING_IGNORE", ".gitignore",
      "Missing required generated/private output rule: " + pattern,
      "Ignore this exact generated directory and keep QA evidence outside product Git."));
  }
  const ignored = new Set((hygiene.allowedRootFileNames || []).map((s) => s.toLowerCase()));
  if (!existsSync(rootDir)) return violations;
  for (const name of readdirSync(rootDir)) {
    const abs = join(rootDir, name);
    const stat = lstatSync(abs);
    if (!stat.isFile() || ignored.has(name.toLowerCase())) continue;
    if ((hygiene.forbiddenProductRootSuffixes || []).some((suffix) => name.toLowerCase().endsWith(suffix))) {
      violations.push(problem("PRODUCT_ROOT_ARTIFACT", name,
        "Binary, database, or private QA artifact in the product root.",
        "Preserve/hash valuable evidence outside product Git, then remove only this unwanted root copy."));
    }
  }
  return violations;
}

export function formatArchitectureViolations(violations) {
  return violations.map((v) => "[" + v.code + "] " + v.path + " — " + v.message + "\n  Fix: " + v.remediation).join("\n");
}

export function inspectArchitecture(rootDir, policy) {
  const modules = collectSourceModules(rootDir);
  const edges = collectRelativeImportEdges(modules, rootDir);
  return [
    ...validateDependencyPolicy(edges, policy),
    ...validateFileBudgets(modules, policy),
    ...validateBoundaryTypes(modules, policy),
    ...validateDoubleAssertions(modules, policy),
    ...validateProductHygiene(rootDir, policy),
  ];
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error("Missing " + name + " value.");
  return args[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(option(process.argv.slice(2), "--root", ownRoot));
    const config = resolve(option(process.argv.slice(2), "--policy", join(root, ".quality", "architecture-policy.json")));
    const policy = JSON.parse(readFileSync(config, "utf8"));
    if (policy.schema_version !== 1) throw new Error("Unsupported architecture policy version.");
    const violations = inspectArchitecture(root, policy);
    if (violations.length) {
      console.error(formatArchitectureViolations(violations));
      console.error("Architecture guard failed: " + violations.length + " violation(s).");
      process.exitCode = 1;
    } else {
      console.log("Architecture guard passed: " + collectSourceModules(root).length + " TS modules, zero violations.");
    }
  } catch (error) {
    console.error("[ARCHITECTURE_CHECK_ERROR] " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  }
}
