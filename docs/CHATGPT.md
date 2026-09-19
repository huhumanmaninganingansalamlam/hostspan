# ChatGPT Web connection

HostSpan Alpha is designed for ChatGPT Web Developer Mode through OpenAI Secure MCP Tunnel.

As an alternative, you can operate any ordinary HTTPS reverse proxy or tunnel gateway yourself. HostSpan does not create or manage provider-specific public endpoints. Non-loopback HostSpan requires its built-in OAuth layer.

## 1. Verify HostSpan locally

```bash
hostspan doctor
hostspan smoke --target local-app
hostspan print-toolset
hostspan serve
```

With the default config, confirm these loopback endpoints from the same host:

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

Secure MCP Tunnel normally uses the loopback bind. Do not treat the tunnel as file/exec authorization. The HostSpan policy remains the final authority.

OpenAI reference: <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>

## Alternative: user-managed reverse proxy + HostSpan OAuth

Initialize OAuth with the exact public MCP URL first:

```bash
hostspan oauth init --public-url https://mcp.example.com/mcp
```

HostSpan stores only a salted scrypt hash in config and writes the generated approval credential to the local mode-`0600` file reported as `approval_secret_file`. Read that file locally when the authorization page asks for approval. Then run `hostspan serve` and put your HTTPS endpoint in front of it:

```text
https://mcp.example.com/mcp
  -> reverse proxy / ingress / reverse tunnel you operate
  -> http://127.0.0.1:39393/mcp
```

For a proxy on the same host, keep the default `127.0.0.1` bind but preserve the public `Host` value. `hostspan oauth init` adds that public hostname to `allowed_hosts`.

For a proxy in another container, VM, or host, bind HostSpan to a reachable interface instead:

```yaml
server:
  listen_host: 0.0.0.0
  listen_port: 39393
  allowed_hosts:
    - mcp.example.com
    - 192.168.10.20
  data_dir: ~/.local/state/hostspan
```

Wildcard binds (`0.0.0.0` or `::`) fail configuration validation unless `allowed_hosts` is non-empty. A specific bind such as `192.168.10.20` automatically permits that Host value when no explicit allowlist is supplied. `hostspan oauth init` automatically adds the public OAuth hostname to `allowed_hosts`. Non-loopback `serve` fails when OAuth is absent.

Minimal Caddy example:

```caddyfile
mcp.example.com {
    @hostspan path /mcp /.well-known/oauth-* /authorize /token /register /revoke
    reverse_proxy @hostspan 127.0.0.1:39393
}
```

Minimal nginx example:

```nginx
location ~ ^/(mcp|authorize$|token$|register$|revoke$|\.well-known/) {
    proxy_pass http://127.0.0.1:39393;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
    proxy_buffering off;
}
```

The public side of the proxy must provide HTTPS. Add rate limiting/WAF controls as appropriate, especially for the unauthenticated OAuth registration and authorization entrypoints. HostSpan performs the client OAuth authorization itself.

Forward these paths to the same HostSpan upstream:

```text
/mcp
/.well-known/oauth-authorization-server
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
/register
/authorize
/token
/revoke
```

Keep `/healthz` and `/readyz` private unless you have an explicit operational reason to publish them. HostSpan advertises the refresh-capable `hostspan` scope, requires PKCE S256, and issues rotating refresh tokens so ChatGPT can maintain OAuth connectivity. The OAuth metadata and endpoint layout intentionally follow the MCP SDK shape used by known-working ChatGPT integrations.

MCP `2026-07-28` is stateless at the protocol core, so ordinary reverse proxies and load balancers do not need sticky MCP sessions for modern requests. The proxy should preserve the `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, content type, and request body headers/data.

## 3. Add the app in ChatGPT Developer Mode

In ChatGPT Developer Mode, add the MCP endpoint issued by Secure MCP Tunnel or the OAuth-protected HTTPS reverse proxy endpoint you operate. For the latter, choose OAuth. ChatGPT should open the HostSpan authorization page; enter the credential from the local `approval_secret_file` created by `hostspan oauth init`. After authorization/tool scan, invoke `system_status` and verify:

- `toolset_version` is `hostspan-v2`
- the toolset has exactly 11 tools
- `toolset_hash` matches `hostspan print-toolset`
- `policy_epoch` matches the local config

OpenAI Developer Mode reference: <https://developers.openai.com/api/docs/guides/developer-mode>

## Refresh after metadata changes

ChatGPT may cache tool names/descriptions/schemas. `hostspan-v2` intentionally keeps its 11 tool names and input schemas fixed. If a HostSpan release changes tool metadata, compare `server_version` and `toolset_hash`, then use the ChatGPT app Refresh action before diagnosing a cached schema as a HostSpan runtime failure.

A breaking contract must use a new toolset version rather than silently changing `hostspan-v2`.

## Interactive terminal use

Targets with the explicit `terminal` capability may start `process_start` with `tty=true`. ChatGPT then uses the same durable `process_id` with `process_poll`, `process_write`, and `process_cancel`. `process_write` can send text, control keys such as `C-c`, and resize updates, and every write carries its own UUIDv7 idempotency key. The tmux-backed session survives HostSpan daemon restart; an ambiguous write that crosses a crash boundary is reported as unknown rather than replayed automatically.

This is intentionally separate from ordinary bounded exec policy. A writable interactive PTY can host a shell/REPL/TUI and therefore has native user authority beyond an `allowed_programs` list. On an `exec`-only target the program/env allowlists remain enforced. On a target that also grants `terminal`, non-interactive `process_start` accepts the same class of programs and explicit environment that the stronger terminal authority already permits; deadline/output/concurrency/idempotency controls remain enforced. Enable `terminal` only on targets where that authority is acceptable.

## Distinguish client-side blocking from server failures

If ChatGPT says a Developer MCP call was blocked before invocation, first determine whether HostSpan actually received an HTTP/MCP request.

```bash
hostspan logs --follow
hostspan support-export ./hostspan-support.json
```

HostSpan records transport requests and accepted tool calls. If there is no corresponding transport/request event, the failure occurred before HostSpan and is a client/tunnel compatibility incident, not a HostSpan handler failure. Do not fabricate a successful tool result for a request that never arrived.

If the trace shows `GET /authorize` and a successful `POST /authorize`, an authorization code exists, but ChatGPT never sends `POST /token`, compare the public OAuth metadata and redirect response against a known-working MCP SDK server before attributing the failure to the client. HostSpan intentionally uses the SDK-compatible root authorization paths and does not add an RFC 9207 `iss` parameter that the working DevSpace flow does not advertise.

If a request arrived but failed, use `request_id`, `idempotency_key`, `process_id`, and structured error code to identify the stage.

For a user-managed reverse proxy, first verify the configured private HostSpan endpoint, then the proxy's upstream reachability, allowed `Host` value, TLS, OAuth discovery routes, and finally the external URL. If the HostSpan trace has no request, the problem is before HostSpan.

Useful OAuth checks:

```bash
hostspan oauth status
curl https://mcp.example.com/.well-known/oauth-protected-resource/mcp
curl https://mcp.example.com/.well-known/oauth-authorization-server
```

If the approval credential is lost or suspected compromised, run `hostspan oauth rotate-secret`. This revokes all existing access/refresh tokens and replaces the local mode-`0600` approval file.

## Inspector validation

Before ChatGPT interoperability testing, MCP Inspector can be used against the local or tunnel endpoint to verify 2026-07-28 `server/discover`, per-request `tools/list`, schemas, annotations, and tool calls independently of ChatGPT UI behavior. The repository contract test performs 100 modern per-request `tools/list` exchanges as an automated registry-stability check; the HTTP entry also retains the SDK's stateless 2025-era fallback for compatible clients.
