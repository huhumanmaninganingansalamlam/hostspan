import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const created: string[] = [];

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "hostspan-guardrails-"));
	created.push(root);
	return root;
}

function put(root: string, file: string, contents: string): void {
	const absolute = join(root, file);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function run(
	script: "check-architecture.mjs" | "check-docs.mjs",
	root: string,
) {
	const candidate = spawnSync(
		process.execPath,
		[join(repoRoot, "scripts", script), "--root", root],
		{
			encoding: "utf8",
			timeout: 20_000,
			windowsHide: true,
		},
	);
	if (candidate.error) throw candidate.error;
	return {
		code: candidate.status,
		output: (candidate.stdout || "") + (candidate.stderr || ""),
	};
}

interface FixturePolicy {
	schema_version: number;
	forbiddenImports: Array<{ from: string[]; to: string[]; reason: string }>;
	maxNewTypeScriptLines: number;
	fileBudgets: Record<
		string,
		{ maxLines: number; owner: string; reason: string; reviewTrigger: string }
	>;
	functionBudgets: Array<{
		path: string;
		symbol: string;
		maxLines: number;
		owner: string;
	}>;
	boundaryTypeRules: Array<{
		path: string;
		symbol: string;
		kind: "type" | "interface" | "function";
	}>;
	doubleAssertionExceptions: Array<{
		path: string;
		needle: string;
		owner: string;
		reason: string;
		reviewTrigger: string;
	}>;
	hygiene: {
		requiredGitignore: string[];
		forbiddenProductRootSuffixes: string[];
		allowedRootFileNames: string[];
	};
}

const basePolicy = (): FixturePolicy => ({
	schema_version: 1,
	forbiddenImports: [
		{
			from: ["files"],
			to: ["cli", "desktop", "mcp", "runtime"],
			reason: "Files own data, not adapters.",
		},
	],
	maxNewTypeScriptLines: 400,
	fileBudgets: {},
	functionBudgets: [],
	boundaryTypeRules: [],
	doubleAssertionExceptions: [],
	hygiene: {
		requiredGitignore: [],
		forbiddenProductRootSuffixes: [],
		allowedRootFileNames: [],
	},
});

function archFixture() {
	const root = fixture();
	const policy = basePolicy();
	put(root, ".quality/architecture-policy.json", JSON.stringify(policy));
	put(root, "src/files/cache.ts", "export const cache = 1;\n");
	return { root, policy };
}

function setPolicy(root: string, policy: ReturnType<typeof basePolicy>) {
	put(root, ".quality/architecture-policy.json", JSON.stringify(policy));
}

function docFixture() {
	const root = fixture();
	put(root, "package.json", JSON.stringify({ version: "0.13.2" }));
	put(
		root,
		"src/version.ts",
		[
			'export const SERVER_VERSION = "0.13.2";',
			'export const TOOLSET_VERSION = "hostspan-v3.5";',
		].join("\n"),
	);
	put(
		root,
		"README.md",
		"# HostSpan\n\nVersion 0.13.2 / hostspan-v3.5. See [Architecture](docs/ARCHITECTURE.md).\n",
	);
	put(root, "AGENTS.md", "# Agent map\n\n0.13.2 / hostspan-v3.5.\n");
	put(
		root,
		"docs/ARCHITECTURE.md",
		"# Architecture\n\nCurrent 0.13.2 / hostspan-v3.5.\n## Actual owner\n",
	);
	put(root, "docs/MCP_V4_DESIGN.md", "# Future\n\nPROPOSAL — NOT SHIPPED.\n");
	return root;
}

afterEach(() => {
	for (const root of created.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("architecture anti-slop check", () => {
	it("passes the current real source and canonical documentation", () => {
		const arch = run("check-architecture.mjs", repoRoot);
		expect(arch.code, arch.output).toBe(0);
		expect(arch.output).toContain("zero violations");
		const docs = run("check-docs.mjs", repoRoot);
		expect(docs.code, docs.output).toBe(0);
		expect(docs.output).toContain("Documentation guard passed");
	});

	it("allows an explicit domain-to-support import but rejects domain-to-adapter imports", () => {
		const { root } = archFixture();
		put(root, "src/state/store.ts", "export const state = 1;\n");
		put(
			root,
			"src/files/cache.ts",
			'import { state } from "../state/store.js";\nexport const cache = state;\n',
		);
		expect(run("check-architecture.mjs", root).code).toBe(0);
		put(root, "src/cli/router.ts", "export const run = () => undefined;\n");
		put(
			root,
			"src/files/cache.ts",
			'import { run } from "../cli/router.js";\nexport const cache = run;\n',
		);
		const failed = run("check-architecture.mjs", root);
		expect(failed.code).toBe(1);
		expect(failed.output).toMatch(
			/\[FORBIDDEN_IMPORT\] src\/files\/cache\.ts:1/,
		);
		expect(failed.output).toMatch(/Fix: Depend on the owning domain contract/);
	});

	it("enforces real physical line counts and the exact composition function budget", () => {
		const { root, policy } = archFixture();
		put(root, "src/files/cache.ts", Array(401).fill("const a = 1;").join("\n"));
		const oversized = run("check-architecture.mjs", root);
		expect(oversized.code).toBe(1);
		expect(oversized.output).toMatch(/\[FILE_BUDGET\] src\/files\/cache\.ts/);
		expect(oversized.output).toContain("401 lines; reviewed maximum is 400");

		put(root, "src/files/cache.ts", "export const cache = 1;\n");
		put(
			root,
			"src/runtime/bootstrap.ts",
			"export function boot() {\n const one=1;\n const two=2;\n const three=3;\n return one+two+three;\n}\n",
		);
		policy.functionBudgets = [
			{
				path: "src/runtime/bootstrap.ts",
				symbol: "boot",
				maxLines: 4,
				owner: "runtime",
			},
		];
		setPolicy(root, policy);
		const longFunction = run("check-architecture.mjs", root);
		expect(longFunction.code).toBe(1);
		expect(longFunction.output).toMatch(
			/\[FUNCTION_BUDGET\] src\/runtime\/bootstrap\.ts/,
		);
		expect(longFunction.output).toContain("boot has 6 lines; maximum 4");
	});

	it("rejects an exported raw record or unbounded interface at a protected boundary", () => {
		const { root, policy } = archFixture();
		policy.boundaryTypeRules = [
			{ path: "src/files/cache.ts", symbol: "ProcessSnapshot", kind: "type" },
		];
		put(
			root,
			"src/files/cache.ts",
			"export type ProcessSnapshot = Record<string, unknown>;\n",
		);
		setPolicy(root, policy);
		const raw = run("check-architecture.mjs", root);
		expect(raw.code).toBe(1);
		expect(raw.output).toMatch(/\[UNTYPED_BOUNDARY\].*ProcessSnapshot/);

		policy.boundaryTypeRules = [
			{
				path: "src/files/cache.ts",
				symbol: "ProcessSnapshot",
				kind: "interface",
			},
		];
		put(
			root,
			"src/files/cache.ts",
			"export interface ProcessSnapshot { [key: string]: unknown }\n",
		);
		setPolicy(root, policy);
		const unbounded = run("check-architecture.mjs", root);
		expect(unbounded.output).toContain("UNTYPED_BOUNDARY");
		put(
			root,
			"src/files/cache.ts",
			"export interface ProcessSnapshot { state: string; id: number }\n",
		);
		expect(run("check-architecture.mjs", root).code).toBe(0);
	});

	it("rejects unreviewed double casts and stale exception entries", () => {
		const { root, policy } = archFixture();
		put(
			root,
			"src/files/cache.ts",
			"const data = input as unknown as Thing;\n",
		);
		const unreviewed = run("check-architecture.mjs", root);
		expect(unreviewed.code).toBe(1);
		expect(unreviewed.output).toContain("UNREVIEWED_DOUBLE_ASSERTION");

		put(root, "src/files/cache.ts", "export const cache = 1;\n");
		policy.doubleAssertionExceptions = [
			{
				path: "src/files/cache.ts",
				needle: "as unknown as Thing",
				owner: "files",
				reason: "Testing stale waiver",
				reviewTrigger: "Code removal",
			},
		];
		setPolicy(root, policy);
		const stale = run("check-architecture.mjs", root);
		expect(stale.code).toBe(1);
		expect(stale.output).toContain("STALE_DOUBLE_ASSERTION_EXCEPTION");
	});

	it("rejects private product-root evidence and missing required ignore rules without reading contents", () => {
		const { root, policy } = archFixture();
		policy.hygiene.requiredGitignore = ["artifacts/"];
		policy.hygiene.forbiddenProductRootSuffixes = [".db"];
		setPolicy(root, policy);
		put(root, "sensitive.db", "PRIVATE_TEST_SENTINEL_ONLY_NOT_FOR_LOGS");
		const failed = run("check-architecture.mjs", root);
		expect(failed.code).toBe(1);
		expect(failed.output).toContain("[PRODUCT_ROOT_ARTIFACT] sensitive.db");
		expect(failed.output).toContain("[MISSING_IGNORE] .gitignore");
		expect(failed.output).not.toContain("PRIVATE_TEST_SENTINEL");
		put(root, ".gitignore", "artifacts/\n");
		rmSync(join(root, "sensitive.db"));
		expect(run("check-architecture.mjs", root).code).toBe(0);
	});

	it("accepts the exact reviewed cast exception without a wildcard", () => {
		const { root, policy } = archFixture();
		put(
			root,
			"src/files/cache.ts",
			"export const cache = ({}) as unknown as Known;\n",
		);
		policy.doubleAssertionExceptions = [
			{
				path: "src/files/cache.ts",
				needle: "as unknown as Known",
				owner: "files",
				reason: "Narrow external type seam",
				reviewTrigger: "Library upgrade",
			},
		];
		setPolicy(root, policy);
		expect(run("check-architecture.mjs", root).code).toBe(0);
	});
});

describe("guard waiver precision", () => {
	it("ignores as unknown as words in comments or string literals, not actual assertions", () => {
		const { root } = archFixture();
		put(
			root,
			"src/files/cache.ts",
			[
				"// as unknown as NotAnActualCast",
				'export const text = "as unknown as JustDocumentation";',
				"export const number = 1;",
			].join("\n"),
		);
		expect(run("check-architecture.mjs", root).code).toBe(0);
	});

	it("rejects stale and glob-sized exceptions that hide newly moved files", () => {
		const { root, policy } = archFixture();
		policy.fileBudgets["src/files/moved.ts"] = {
			maxLines: 900,
			owner: "files",
			reason: "No longer exists",
			reviewTrigger: "Code move",
		};
		policy.fileBudgets["src/files/*.ts"] = {
			maxLines: 900,
			owner: "files",
			reason: "Glob is not reviewable",
			reviewTrigger: "Every edit",
		};
		setPolicy(root, policy);
		const failure = run("check-architecture.mjs", root);
		expect(failure.code).toBe(1);
		expect(failure.output).toContain("[STALE_FILE_EXCEPTION]");
		expect(failure.output).toContain("[BROAD_FILE_EXCEPTION]");
		expect(failure.output).toContain("Fix:");
	});
});

describe("documentation navigation and contract check", () => {
	it("accepts internal paths and real Markdown heading anchors", () => {
		const root = docFixture();
		put(
			root,
			"README.md",
			"# HostSpan\n\n0.13.2 hostspan-v3.5. See [Owner](docs/ARCHITECTURE.md#actual-owner).\n",
		);
		expect(run("check-docs.mjs", root).code).toBe(0);
	});

	it("catches missing links, missing anchors and stale shipped contract versions", () => {
		const root = docFixture();
		put(
			root,
			"README.md",
			"# HostSpan\n\n0.13.2 hostspan-v3.4 [missing](docs/missing.md) [wrong](docs/ARCHITECTURE.md#old-heading).\n",
		);
		const output = run("check-docs.mjs", root);
		expect(output.code).toBe(1);
		expect(output.output).toContain("[BROKEN_DOC_LINK] README.md");
		expect(output.output).toContain("[BROKEN_DOC_ANCHOR] README.md");
		expect(output.output).toContain("[STALE_CURRENT_CONTRACT] README.md");
		expect(output.output).toContain("Fix:");
	});

	it("fails an unmarked future proposal, and rejects an oversized navigation document", () => {
		const root = docFixture();
		put(root, "docs/MCP_V4_DESIGN.md", "# Unmarked v4\n");
		put(
			root,
			"AGENTS.md",
			`# Agent map\n0.13.2 hostspan-v3.5\n${"Repeat\n".repeat(130)}`,
		);
		const output = run("check-docs.mjs", root);
		expect(output.code).toBe(1);
		expect(output.output).toContain("[FUTURE_CONTRACT_UNMARKED]");
		expect(output.output).toContain("[DOC_SIZE_BUDGET] AGENTS.md");
	});

	it("does not execute or change any fixture while reporting problems", () => {
		const root = docFixture();
		put(
			root,
			"README.md",
			"# HostSpan\n\n0.13.2 hostspan-v3.5 [missing](docs/deleted.md).\n",
		);
		const before = readFileSync(join(root, "README.md"));
		const result = run("check-docs.mjs", root);
		expect(result.code).toBe(1);
		expect(readFileSync(join(root, "README.md"))).toEqual(before);
	});
});
