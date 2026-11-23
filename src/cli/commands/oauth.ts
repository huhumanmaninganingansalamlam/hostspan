import {
	chmodSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	createOAuthSetup,
	rotateOAuthApprovalSecret,
} from "../../auth/oauth-service.js";
import { loadConfig } from "../../config/loader.js";
import { oauthApprovalSecretPath } from "../../config/paths.js";
import { writeConfigAtomic } from "../../config/writer.js";
import { protectWindowsFile } from "../../security/windows-acl.js";
import { openDatabase } from "../../state/database.js";
import { OAuthRepo } from "../../state/oauth-repo.js";
import { readOption } from "../arguments.js";
import {
	cliValidationError,
	type CliCommandContext,
	writeJsonResult,
} from "../context.js";

function writeOAuthApprovalSecret(configPath: string, secret: string): string {
	const path = oauthApprovalSecretPath(configPath);
	const dir = dirname(path);
	const temp = `${path}.tmp-${process.pid}`;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		writeFileSync(temp, `${secret}\n`, { mode: 0o600 });
		chmodSync(temp, 0o600);
		protectWindowsFile(temp);
		renameSync(temp, path);
		chmodSync(path, 0o600);
		protectWindowsFile(path);
	} finally {
		rmSync(temp, { force: true });
	}
	return path;
}

export async function runOAuthCommand(
	context: CliCommandContext,
): Promise<number> {
	const { argv, configPath } = context;
	const action = argv[1];
	const config = loadConfig(configPath);
	if (action === "init") {
		if (config.oauth) {
			throw cliValidationError(
				"OAuth is already configured. Use hostspan oauth rotate-secret to rotate credentials.",
			);
		}
		if (config.authentication && config.authentication.mode !== "oauth") {
			throw cliValidationError(
				"Change authentication.mode to oauth explicitly before initializing OAuth.",
			);
		}
		const publicUrl = readOption(argv, "--public-url");
		if (!publicUrl)
			throw cliValidationError(
				"oauth init requires --public-url https://host/mcp",
			);
		const setup = createOAuthSetup(publicUrl);
		const hostname = new URL(setup.config.public_mcp_url).hostname;
		const allowedHosts = new Set(config.server.allowed_hosts ?? []);
		allowedHosts.add(hostname);
		config.server.allowed_hosts = [...allowedHosts];
		config.oauth = setup.config;
		config.policy_epoch += 1;
		writeConfigAtomic(configPath, config);
		const approvalSecretFile = writeOAuthApprovalSecret(
			configPath,
			setup.approval_secret,
		);
		writeJsonResult(context.stdout, {
			ok: true,
			public_mcp_url: setup.config.public_mcp_url,
			issuer: new URL(`${new URL(setup.config.public_mcp_url).origin}/`).href,
			approval_secret_file: approvalSecretFile,
			warning:
				"The OAuth approval secret is stored only in the local mode-0600 file. Do not copy it into logs or chat messages.",
		});
		return 0;
	}
	if (action === "status") {
		writeJsonResult(context.stdout, {
			enabled: Boolean(config.oauth),
			...(config.oauth
				? {
						public_mcp_url: config.oauth.public_mcp_url,
						issuer: new URL(`${new URL(config.oauth.public_mcp_url).origin}/`)
							.href,
						approval_secret_file: oauthApprovalSecretPath(configPath),
						access_token_ttl_minutes: config.oauth.access_token_ttl_minutes,
						refresh_token_ttl_days: config.oauth.refresh_token_ttl_days,
					}
				: {}),
		});
		return 0;
	}
	if (action === "rotate-secret") {
		if (!config.oauth)
			throw cliValidationError(
				"OAuth is not configured. Run hostspan oauth init first.",
			);
		const rotated = rotateOAuthApprovalSecret(config.oauth);
		config.oauth = rotated.config;
		config.policy_epoch += 1;
		writeConfigAtomic(configPath, config);
		const approvalSecretFile = writeOAuthApprovalSecret(
			configPath,
			rotated.approval_secret,
		);
		const db = openDatabase(join(config.server.data_dir, "state.db"));
		try {
			new OAuthRepo(db).revokeAll(Math.floor(Date.now() / 1000));
		} finally {
			db.close();
		}
		writeJsonResult(context.stdout, {
			ok: true,
			approval_secret_file: approvalSecretFile,
			tokens_revoked: true,
			warning:
				"The new OAuth approval secret is stored only in the local mode-0600 file. Existing access and refresh tokens were revoked.",
		});
		return 0;
	}
	throw cliValidationError("oauth requires init, status, or rotate-secret");
}
