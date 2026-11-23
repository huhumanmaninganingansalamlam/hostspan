export function readOption(
	args: readonly string[],
	name: string,
): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

export function hasFlag(args: readonly string[], name: string): boolean {
	return args.includes(name);
}

export interface NamedOptionSpecification {
	field: string;
	parse?: (value: string) => unknown;
}

export interface ParseNamedOptionsOptions {
	startIndex: number;
	specifications: Readonly<Record<string, NamedOptionSpecification>>;
	passthrough?: readonly string[];
	invalidOption: (option: string) => Error;
}

export function parseNamedOptions(
	args: readonly string[],
	options: ParseNamedOptionsOptions,
): Record<string, unknown> {
	const parsed: Record<string, unknown> = {};
	const passthrough = new Set(options.passthrough ?? []);
	for (let index = options.startIndex; index < args.length; index += 2) {
		const option = args[index] ?? "";
		const value = args[index + 1];
		const specification = options.specifications[option];
		if (
			(!specification && !passthrough.has(option)) ||
			value === undefined ||
			value.startsWith("--") ||
			(specification && specification.field in parsed)
		) {
			throw options.invalidOption(option);
		}
		if (specification)
			parsed[specification.field] = specification.parse
				? specification.parse(value)
				: value;
	}
	return parsed;
}
