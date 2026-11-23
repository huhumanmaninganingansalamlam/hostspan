import { isIP } from "node:net";
import {
	OAuthError,
	OAuthErrorCode,
	type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { OAuthService } from "../auth/oauth-service.js";
import type { HostSpanAuthMode } from "../config/schema.js";
import type { HostSpanHttpServerOptions } from "./server.js";

export function mcpOAuthTokenVerifier(oauth: OAuthService): OAuthTokenVerifier {
	return {
		async verifyAccessToken(token) {
			const verified = oauth.verifyAccessToken(token);
			if (!verified)
				throw new OAuthError(
					OAuthErrorCode.InvalidToken,
					"Access token is invalid, expired, or revoked.",
				);
			return { ...verified, resource: new URL(verified.resource) };
		},
	};
}

function normalizeAllowedHost(host: string): string {
	const trimmed = host.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]"))
		return trimmed.toLowerCase();
	return isIP(trimmed) === 6
		? `[${trimmed.toLowerCase()}]`
		: trimmed.toLowerCase();
}

export function resolveAllowedHosts(
	listenHost: string,
	configured: string[] = [],
): string[] {
	if (configured.length)
		return [...new Set(configured.map(normalizeAllowedHost))];
	if (["0.0.0.0", "::"].includes(listenHost)) {
		throw new Error("wildcard listen_host requires explicit allowed_hosts");
	}
	if (["127.0.0.1", "localhost", "::1"].includes(listenHost.toLowerCase())) {
		return ["127.0.0.1", "localhost", "[::1]"];
	}
	return [normalizeAllowedHost(listenHost)];
}

export function validateHttpAuthenticationConfiguration(
	options: HostSpanHttpServerOptions,
): {
	mode: HostSpanAuthMode;
	allowedHosts: string[];
} {
	const loopback = ["127.0.0.1", "localhost", "::1"].includes(
		options.listen_host.toLowerCase(),
	);
	const mode = options.authenticationMode ?? (options.oauth ? "oauth" : "none");
	if (mode === "oauth" && (!options.oauth || options.privateTokens)) {
		throw new Error("OAuth mode requires OAuth only.");
	}
	if (mode === "private_token" && (!options.privateTokens || options.oauth)) {
		throw new Error(
			"private_token mode requires a private token store and no OAuth.",
		);
	}
	if (
		mode === "none" &&
		(options.oauth || options.privateTokens || !loopback)
	) {
		throw new Error(
			"Non-loopback HostSpan HTTP serving requires OAuth or private_token; local none must not have authentication services.",
		);
	}
	if (mode === "private_token" && !loopback) {
		if (
			!isIP(options.listen_host) ||
			["0.0.0.0", "::"].includes(options.listen_host) ||
			!options.allowed_hosts?.length ||
			options.protected_transport !== "encrypted_private_network"
		) {
			throw new Error(
				"Remote private_token requires exact IP bind, explicit allowed_hosts, and approved encrypted private transport.",
			);
		}
	}
	const allowedHosts = resolveAllowedHosts(
		options.listen_host,
		options.allowed_hosts,
	);
	return { mode, allowedHosts };
}
