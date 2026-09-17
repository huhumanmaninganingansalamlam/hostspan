import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { createHostSpanHttpServer, listenHostSpan } from "../mcp/server.js";
import { TOOLSET_HASH } from "../mcp/registry.js";
import type { HostSpanRuntime } from "./index.js";
import { runtimeReadiness } from "./index.js";

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
type TunnelChild = ChildProcessByStdio<null, Readable, Readable>;

export interface ExposureSession {
  provider: "cloudflare_quick";
  public_mcp_url: string;
  local_origin: string;
  capability_path: string;
  ephemeral: true;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  close(): Promise<void>;
}

export interface ExposureOptions {
  cloudflared?: string;
  timeout_ms?: number;
  spawn_process?: typeof spawn;
}

function capabilityPath(): string {
  return `/mcp/${randomBytes(32).toString("base64url")}`;
}

function extractPublicUrl(text: string): string | undefined {
  QUICK_TUNNEL_URL.lastIndex = 0;
  return QUICK_TUNNEL_URL.exec(text)?.[0];
}

async function waitForExit(child: TunnelChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopTunnel(child: TunnelChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 3_000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 1_000);
}

async function startCloudflareQuickTunnel(
  localOrigin: string,
  binary: string,
  timeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<{ child: TunnelChild; base_url: string }> {
  const child = spawnProcess(
    binary,
    ["tunnel", "--url", localOrigin, "--http-host-header", "127.0.0.1"],
    {
      env: { ...process.env, NO_AUTOUPDATE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let diagnostics = "";
    let publicUrl: string | undefined;
    let connected = false;
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else if (url) {
        child.stdout.resume();
        child.stderr.resume();
        resolve({ child, base_url: url });
      }
    };
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      diagnostics = `${diagnostics}${text}`.slice(-16_384);
      publicUrl ??= extractPublicUrl(text) ?? extractPublicUrl(diagnostics);
      if (text.includes("Registered tunnel connection")) connected = true;
      if (publicUrl && connected) finish(undefined, publicUrl);
    };
    const onError = (error: Error) => {
      finish(
        new Error(
          error.message.includes("ENOENT")
            ? `cloudflared was not found (${binary}). Install cloudflared or pass --cloudflared /path/to/cloudflared.`
            : `cloudflared failed to start: ${error.message}`,
        ),
      );
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`cloudflared exited before publishing a URL (code=${code ?? "null"}, signal=${signal ?? "null"}): ${diagnostics.trim()}`));
    };
    const timer = setTimeout(() => {
      finish(new Error(`cloudflared did not publish a Quick Tunnel URL within ${timeoutMs}ms.`));
      void stopTunnel(child);
    }, timeoutMs);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function startExposure(runtime: HostSpanRuntime, options: ExposureOptions = {}): Promise<ExposureSession> {
  const path = capabilityPath();
  let app: FastifyInstance | undefined;
  let tunnel: TunnelChild | undefined;
  try {
    app = createHostSpanHttpServer({
      listen_host: "127.0.0.1",
      listen_port: 0,
      mcp_path: path,
      diagnostic_routes: false,
      handlers: runtime.handlers,
      responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: runtime.config.policy_epoch }),
      status: {
        health: () => ({ server_version: "exposure" }),
        readiness: () => runtimeReadiness(runtime),
      },
      trace: (event, metadata) => runtime.logger.info(event, { ...metadata, exposure: "cloudflare_quick" }),
    });
    const address = await listenHostSpan(app, "127.0.0.1", 0);
    const started = await startCloudflareQuickTunnel(
      address,
      options.cloudflared ?? "cloudflared",
      options.timeout_ms ?? 20_000,
      options.spawn_process ?? spawn,
    );
    tunnel = started.child;
    const publicMcpUrl = `${started.base_url}${path}`;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      if (started.child.exitCode !== null || started.child.signalCode !== null) {
        resolve({ code: started.child.exitCode, signal: started.child.signalCode });
      } else {
        started.child.once("exit", (code, signal) => resolve({ code, signal }));
      }
    });
    return {
      provider: "cloudflare_quick",
      public_mcp_url: publicMcpUrl,
      local_origin: address,
      capability_path: path,
      ephemeral: true,
      closed,
      close: async () => {
        await stopTunnel(started.child);
        await app?.close();
      },
    };
  } catch (error) {
    if (tunnel) await stopTunnel(tunnel);
    if (app) await app.close();
    throw error;
  }
}
