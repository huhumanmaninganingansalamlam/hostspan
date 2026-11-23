import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const slash = (path) => path.split(sep).join("/");
const isInside = (child, parent) => child === parent || child.startsWith(parent + sep);
const issue = (code, path, message, remediation) => ({ code, path, message, remediation });

export function collectMarkdownLinks(paths) {
  const links = [];
  for (const path of paths) {
    const contents = readFileSync(path, "utf8");
    const lines = contents.split(/\r?\n/);
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)) {
        links.push({ path, line: i + 1, target: match[1] });
      }
      for (const match of line.matchAll(/<img\s+[^>]*src=["']([^"']+)["']/gi)) {
        links.push({ path, line: i + 1, target: match[1] });
      }
    }
  }
  return links;
}

function headingSlugs(markdown) {
  const slugs = new Set();
  const occurrences = new Map();
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    let slug = match[1].toLowerCase().replace(/<[^>]*>/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[`*_~]/g, "").replace(/[^\p{L}\p{N}\-\s]/gu, "").trim().replace(/\s+/g, "-");
    const count = occurrences.get(slug) || 0;
    occurrences.set(slug, count + 1);
    if (count) slug += "-" + count;
    slugs.add(slug);
  }
  return slugs;
}

export function validateRepositoryLinks(links, rootDir) {
  const problems = [];
  const root = resolve(rootDir);
  const cachedHeads = new Map();
  for (const link of links) {
    if (/^(https?:|mailto:|data:|tel:|\/\/)/i.test(link.target)) continue;
    let pathPart = link.target;
    let fragment = "";
    const separator = pathPart.indexOf("#");
    if (separator >= 0) {
      fragment = pathPart.slice(separator + 1);
      pathPart = pathPart.slice(0, separator);
    }
    try {
      pathPart = decodeURIComponent(pathPart);
      fragment = decodeURIComponent(fragment).toLowerCase();
    } catch {
      problems.push(issue("BAD_DOC_URL", slash(relative(root, link.path)) + ":" + link.line,
        "Invalid percent encoding in link " + link.target + ".",
        "Use a valid relative Markdown path/anchor."));
      continue;
    }
    if (/^[a-z]+:/i.test(pathPart) || pathPart.startsWith("//")) continue;
    const dest = resolve(dirname(link.path), pathPart || basename(link.path));
    const where = slash(relative(root, link.path)) + ":" + link.line;
    if (!isInside(dest, root)) {
      problems.push(issue("DOC_LINK_ESCAPE", where, "Link escapes repository root: " + link.target + ".",
        "Use a repository-relative document link."));
    } else if (!existsSync(dest)) {
      problems.push(issue("BROKEN_DOC_LINK", where, "Missing target: " + link.target + ".",
        "Repair the destination path or remove the obsolete link."));
    } else if (fragment && extname(dest).toLowerCase() === ".md") {
      if (!cachedHeads.has(dest)) cachedHeads.set(dest, headingSlugs(readFileSync(dest, "utf8")));
      if (!cachedHeads.get(dest).has(fragment)) {
        problems.push(issue("BROKEN_DOC_ANCHOR", where, "Missing Markdown heading #" + fragment + " in " + slash(relative(root, dest)) + ".",
          "Link to an existing heading or update the anchor after a heading rename."));
      }
    }
  }
  return problems;
}

export function collectCurrentDocs(rootDir) {
  const files = ["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md"];
  if (existsSync(join(rootDir, "docs"))) {
    for (const name of readdirSync(join(rootDir, "docs")).sort()) {
      if (name.toLowerCase().endsWith(".md")) files.push("docs/" + name);
    }
  }
  return files.filter((path) => existsSync(join(rootDir, path))).map((path) => join(rootDir, path));
}

export function validateCurrentContractReferences(rootDir) {
  const problems = [];
  const read = (name) => readFileSync(join(rootDir, name), "utf8");
  let version, packageVersion;
  try {
    const source = read("src/version.ts");
    version = source.match(/export\s+const\s+TOOLSET_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
    const declaredServer = source.match(/export\s+const\s+SERVER_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
    packageVersion = JSON.parse(read("package.json")).version;
    if (!version || declaredServer !== packageVersion) {
      problems.push(issue("CURRENT_CONTRACT_DRIFT", "src/version.ts",
        "Public toolset/version source is absent or differs from package.json.",
        "Use the shipped registry/version as the single source of truth."));
      return problems;
    }
  } catch {
    problems.push(issue("CURRENT_CONTRACT_DRIFT", "package.json",
      "Missing package.json or src/version.ts contract declaration.",
      "Restore canonical source version and package metadata."));
    return problems;
  }
  for (const path of ["README.md", "AGENTS.md", "docs/ARCHITECTURE.md"]) {
    let content;
    try { content = read(path); }
    catch {
      problems.push(issue("MISSING_CANONICAL_DOC", path, "Canonical navigation document missing.",
        "Restore this current-implementation navigation source."));
      continue;
    }
    if (!content.includes(version) || !content.includes(packageVersion)) {
      problems.push(issue("STALE_CURRENT_CONTRACT", path,
        "Missing current " + version + " / " + packageVersion + " in current implementation doc.",
        "Update only this current navigation page; leave historical release notes unchanged."));
    }
  }
  for (const [path, maxLines] of [["AGENTS.md", 120], ["README.md", 120]]) {
    if (!existsSync(join(rootDir, path))) continue;
    const lines = read(path).split(/\r?\n/).length;
    if (lines > maxLines) problems.push(issue("DOC_SIZE_BUDGET", path,
      lines + " lines exceed reviewed " + maxLines + "-line navigation budget.",
      "Move operating/security details to canonical deep docs and link instead of duplicating."));
  }
  if (existsSync(join(rootDir, "docs/MCP_V4_DESIGN.md")) &&
      !read("docs/MCP_V4_DESIGN.md").includes("PROPOSAL — NOT SHIPPED")) {
    problems.push(issue("FUTURE_CONTRACT_UNMARKED", "docs/MCP_V4_DESIGN.md",
      "Future MCP v4 draft is not prominently identified as unshipped.",
      "Place an explicit PROPOSAL — NOT SHIPPED banner and link the current registry."));
  }
  return problems;
}

export function formatDocumentationViolations(problems) {
  return problems.map((p) => "[" + p.code + "] " + p.path + " — " + p.message + "\n  Fix: " + p.remediation).join("\n");
}

function option(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error("Missing value after " + flag);
  return args[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(option(process.argv.slice(2), "--root", ownRoot));
    const docs = collectCurrentDocs(root);
    const links = collectMarkdownLinks(docs);
    const problems = [
      ...validateRepositoryLinks(links, root),
      ...validateCurrentContractReferences(root),
    ];
    if (problems.length) {
      console.error(formatDocumentationViolations(problems));
      console.error("Documentation guard failed: " + problems.length + " violation(s).");
      process.exitCode = 1;
    } else {
      console.log("Documentation guard passed: " + docs.length + " documents, " + links.length + " internal/external links checked.");
    }
  } catch (error) {
    console.error("[DOC_CHECK_ERROR] " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  }
}
