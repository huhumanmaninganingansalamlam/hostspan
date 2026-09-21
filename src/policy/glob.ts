function escapeRegexChar(value: string): string {
  return /[\^$+?.()|{}[]]/.test(value) ? `\\${value}` : value;
}

export function policyGlobRegex(glob: string): RegExp {
  const normalized = glob.replaceAll("\\", "/");
  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    if (char === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegexChar(char);
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesPolicyGlob(path: string, glob: string): boolean {
  return policyGlobRegex(glob).test(path.replaceAll("\\", "/"));
}

export function matchesAnyPolicyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesPolicyGlob(path, glob));
}
