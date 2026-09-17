# ChatGPT Web connection

HostSpan Alpha is designed for ChatGPT Web Developer Mode through OpenAI Secure MCP Tunnel.

It also provides an optional one-command development transport, `hostspan expose`, that creates an outbound Cloudflare Quick Tunnel while keeping HostSpan itself loopback-only.

## 1. Verify HostSpan locally

```bash
hostspan doctor
hostspan smoke --target local-app
hostspan print-toolset
hostspan serve
```

Confirm these loopback endpoints from the same host:

```text
http://127.0.0.1:39393/healthz
http://127.0.0.1:39393/readyz
http://127.0.0.1:39393/mcp
```

`GET /mcp` is intentionally not a tool call; MCP uses `POST /mcp`.

## 2. Start OpenAI Secure MCP Tunnel

Use the current OpenAI Secure MCP Tunnel instructions to create an outbound tunnel whose local upstream is:

```text
http://127.0.0.1:39393/mcp
```

Do not bind HostSpan to a public interface and do not treat the tunnel as file/exec authorization. The HostSpan policy remains the final authority.

OpenAI reference: <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>

## Alternative: one-command Quick Tunnel exposure

Install the official `cloudflared` binary, then run:

```bash
hostspan expose
```

The command prints a value like:

```json
{
  "provider": "cloudflare_quick",
  "public_mcp_url": "https://random.trycloudflare.com/mcp/<random-capability>",
  "authorization": "capability_url",
  "ephemeral": true
}
```

Paste the complete `public_mcp_url` into the MCP client. Do not remove the capability suffix and do not share the URL: possession of the URL grants access to the HostSpan tool surface permitted by local target policy.

This mode intentionally uses a separate ephemeral loopback listener. Plain `/mcp`, `/healthz`, and `/readyz` are not available through that listener. HostSpan keeps the fixed 10-tool contract unchanged and normalizes the secret route to `/mcp` before writing transport traces.

Cloudflare documents Quick Tunnels as development/testing only. They use a random `trycloudflare.com` hostname and do not support SSE. HostSpan's MCP 2026-07-28 stateless request path works without relying on a long-lived SSE connection, but use OpenAI Secure MCP Tunnel when you need the standard supported ChatGPT topology or broader legacy-client compatibility.

Cloudflare reference: <https://developers.cloudflare.com/tunnel/get-started/#quick-tunnels-development>

## 3. Add the app in ChatGPT Developer Mode

In ChatGPT Developer Mode, add the MCP endpoint issued by Secure MCP Tunnel. After the app is visible, invoke `system_status` and verify:

- `toolset_version` is `hostspan-v1`
- the toolset has exactly 10 tools
- `toolset_hash` matches `hostspan print-toolset`
- `policy_epoch` matches the local config

OpenAI Developer Mode reference: <https://developers.openai.com/api/docs/guides/developer-mode>

## Refresh after metadata changes

ChatGPT may cache tool names/descriptions/schemas. Alpha intentionally keeps the 10 tool names and input schemas fixed. If a HostSpan release changes tool metadata, compare `server_version` and `toolset_hash`, then use the ChatGPT app Refresh action before diagnosing a cached schema as a HostSpan runtime failure.

A breaking contract must use a new toolset version rather than silently changing `hostspan-v1`.

## Distinguish client-side blocking from server failures

If ChatGPT says a Developer MCP call was blocked before invocation, first determine whether HostSpan actually received an HTTP/MCP request.

```bash
hostspan logs --follow
hostspan support-export ./hostspan-support.json
```

HostSpan records transport requests and accepted tool calls. If there is no corresponding transport/request event, the failure occurred before HostSpan and is a client/tunnel compatibility incident, not a HostSpan handler failure. Do not fabricate a successful tool result for a request that never arrived.

If a request arrived but failed, use `request_id`, `idempotency_key`, `process_id`, and structured error code to identify the stage.

For `hostspan expose`, if the public URL stops responding, first check whether the `hostspan expose` process is still running. The Quick Tunnel URL is ephemeral and changes on every restart; update/refresh the MCP app with the newly printed URL.

## Inspector validation

Before ChatGPT interoperability testing, MCP Inspector can be used against the local or tunnel endpoint to verify 2026-07-28 `server/discover`, per-request `tools/list`, schemas, annotations, and tool calls independently of ChatGPT UI behavior. The repository contract test performs 100 modern per-request `tools/list` exchanges as an automated registry-stability check; the HTTP entry also retains the SDK's stateless 2025-era fallback for compatible clients.
