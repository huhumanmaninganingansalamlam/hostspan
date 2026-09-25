export function processEnvironment(overrides: Record<string, string>): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  // This flag boots HostSpan's embedded runtime, not programs launched by users.
  if (process.versions.electron) delete inherited.ELECTRON_RUN_AS_NODE;
  return { ...inherited, ...overrides };
}
