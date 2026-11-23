import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
	parsePrivateTokenScopes,
	PrivateTokenStore,
} from "../../auth/private-token.js";
import { loadConfig } from "../../config/loader.js";
import { protectWindowsFile } from "../../security/windows-acl.js";
import { hasFlag, readOption } from "../arguments.js";
import {
	cliValidationError,
	type CliCommandContext,
	writeJsonResult,
} from "../context.js";

function deliverPrivateToken(
	context: CliCommandContext,
	secret: string,
): { credential_file?: string; shown_once?: boolean } {
	const output = readOption(context.argv, "--output");
	const show = hasFlag(context.argv, "--show");
	if (Boolean(output) === show) {
		throw cliValidationError(
			"Choose exactly one of --output FILE (automated) or --show (local trusted TTY).",
		);
	}
	if (show) {
		if (!process.stdout.isTTY || !process.stdin.isTTY) {
			throw cliValidationError(
				"--show requires an interactive trusted local terminal; use --output for automation.",
			);
		}
		// Deliberate one-time display only at an operator-controlled TTY.
		context.stdout.write(`HostSpan private token (shown once): ${secret}\n`);
		return { shown_once: true };
	}
	if (!output)
		throw cliValidationError("--output requires a credential file path.");
	const path = resolve(output);
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const fd = openSync(
		path,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			(constants.O_NOFOLLOW || 0),
		0o600,
	);
	try {
		try {
			writeFileSync(fd, `${secret}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(path, 0o600);
		protectWindowsFile(path);
	} catch (error) {
		rmSync(path, { force: true });
		throw error;
	}
	return { credential_file: path };
}

export async function runAccessTokenCommand(
	context: CliCommandContext,
): Promise<number> {
	const { argv, configPath } = context;
	if (argv[1] !== "token")
		throw cliValidationError("access requires token create|list|revoke|rotate");
	const action = argv[2];
	const config = loadConfig(configPath);
	const store = new PrivateTokenStore(config.server.data_dir);
	try {
		if (action === "list") {
			writeJsonResult(context.stdout, {
				tokens: store.list(),
				authentication_mode:
					config.authentication?.mode ?? (config.oauth ? "oauth" : "none"),
			});
			return 0;
		}
		if (action === "revoke") {
			const tokenId = argv[3] ?? "";
			if (!/^pt_[0-9a-f]{32}$/.test(tokenId) || !store.revoke(tokenId)) {
				throw cliValidationError(
					"Unknown or already revoked private token ID.",
				);
			}
			writeJsonResult(context.stdout, {
				ok: true,
				token_id: tokenId,
				revoked: true,
			});
			return 0;
		}
		if (action === "create" || action === "rotate") {
			const name = readOption(argv, "--name");
			const scopesFlag = readOption(argv, "--scopes");
			const tokenId = argv[3];
			if (action === "create" && (!name || !scopesFlag)) {
				throw cliValidationError(
					"token create requires --name CLIENT and --scopes comma-separated scopes.",
				);
			}
			if (
				action === "rotate" &&
				(!tokenId || !/^pt_[0-9a-f]{32}$/.test(tokenId))
			) {
				throw cliValidationError("token rotate requires a valid TOKEN_ID.");
			}
			// The output callback runs inside the store transaction: failed file writing preserves old credentials.
			let outputFile: string | undefined;
			let delivery: { credential_file?: string; shown_once?: boolean } = {};
			try {
				const receive = (secret: string) => {
					delivery = deliverPrivateToken(context, secret);
					outputFile = delivery.credential_file;
				};
				const record =
					action === "create"
						? store.issue(
								name ?? "",
								parsePrivateTokenScopes(scopesFlag ?? ""),
								receive,
							)
						: store.rotate(tokenId ?? "", receive);
				if (!record)
					throw cliValidationError("Unknown or revoked private token ID.");
				writeJsonResult(context.stdout, {
					ok: true,
					token: record,
					...delivery,
					warning:
						"Keep the private token outside source, logs, chat, and support exports.",
				});
				return 0;
			} catch (error) {
				// Only a file newly created by this exact CLI invocation is eligible for cleanup.
				if (outputFile) rmSync(outputFile, { force: true });
				throw error;
			}
		}
		throw cliValidationError(
			"access token requires create, list, revoke, or rotate",
		);
	} finally {
		store.close();
	}
}
