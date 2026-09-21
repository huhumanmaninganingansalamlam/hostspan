import { statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

function windowsPathExt(env) {
  const value = env.PATHEXT || env.Pathext || ".COM;.EXE;.BAT;.CMD";
  return value
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function executableFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveWindowsProgram(program, cwd, env) {
  const pathValue = env.PATH || env.Path || env.path || "";
  const extensions = windowsPathExt(env);
  const hasExtension = extname(program) !== "";
  const explicitPath = isAbsolute(program) || /[\\/]/.test(program);
  const roots = explicitPath ? [cwd] : pathValue.split(delimiter).filter(Boolean);
  for (const root of roots) {
    const base = explicitPath ? (isAbsolute(program) ? program : resolve(cwd, program)) : join(root, program);
    const candidates = hasExtension ? [base] : [base, ...extensions.map((extension) => `${base}${extension}`)];
    for (const candidate of candidates) {
      if (executableFile(candidate)) return candidate;
    }
  }
  throw new Error(`File not found: ${program}`);
}

export function quoteWindowsCmdArgument(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new Error("Windows .cmd/.bat arguments may not contain CR or LF characters.");
  }
  // cmd.exe expands %NAME% even inside quotes. Split literal percent signs out
  // of quoted segments and escape them with ^ so arguments remain argv data
  // rather than becoming shell interpolation. Quoting every segment also
  // neutralizes &, |, (), ^, whitespace, and the other command metacharacters.
  return text
    .split("%")
    .map((segment) => `"${segment.replaceAll('"', '""')}"`)
    .join("^%");
}

export function resolveWindowsCommand(program, argv, cwd, env) {
  const resolved = resolveWindowsProgram(program, cwd, env);
  const extension = extname(resolved).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return {
      program: resolved,
      argv,
      ptyArgv: argv,
      windowsVerbatimArguments: false,
    };
  }
  const command = [quoteWindowsCmdArgument(resolved), ...argv.map((item) => quoteWindowsCmdArgument(String(item)))].join(" ");
  const wrapped = `"${command}"`;
  return {
    program: env.ComSpec || env.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
    // With /S, cmd.exe needs an extra outer quote pair when the command itself
    // starts with a quoted executable/script path. Child-process spawning must
    // then preserve this already-escaped command line verbatim, while node-pty
    // accepts the raw command-line tail as a string.
    argv: ["/d", "/s", "/c", wrapped],
    ptyArgv: `/d /s /c ${wrapped}`,
    windowsVerbatimArguments: true,
  };
}
