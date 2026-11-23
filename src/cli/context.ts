import { HostSpanError } from "../errors.js";

export interface CliCommandContext {
	argv: readonly string[];
	command: string;
	configPath: string;
	stdout: Pick<NodeJS.WriteStream, "write">;
	stderr: Pick<NodeJS.WriteStream, "write">;
	entryModuleUrl: string;
}

export type CliCommandHandler = (context: CliCommandContext) => Promise<number>;

export function writeJsonResult(
	stdout: CliCommandContext["stdout"],
	value: unknown,
): void {
	stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function cliValidationError(
	message: string,
	details: Record<string, unknown> = {},
): HostSpanError {
	return new HostSpanError("VALIDATION_FAILED", message, false, details);
}
