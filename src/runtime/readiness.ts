import { databaseResponsive } from "../state/database.js";
import { isQualifiedCorePlatform } from "../platform.js";
import { toolsetHash } from "../mcp/registry.js";
import type { HostSpanRuntime } from "./create-runtime.js";

export function runtimeReadiness(runtime: HostSpanRuntime) {
	let databaseReady = false;
	try {
		databaseReady = databaseResponsive(runtime.db);
	} catch {
		databaseReady = false;
	}
	const processReady = isQualifiedCorePlatform();
	const searchReady = runtime.searchBackendReady();
	const terminalReady = runtime.config.terminal
		? runtime.terminalBackendReady()
		: true;
	return {
		ready: databaseReady && processReady,
		degraded: !searchReady || !terminalReady,
		toolset_hash: toolsetHash(runtime.authenticationMode),
		policy_epoch: runtime.config.policy_epoch,
		backends: {
			database: databaseReady,
			process: processReady,
			search: searchReady,
			terminal: terminalReady,
		},
	};
}
