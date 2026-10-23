import { bearerAuthChallengeResponse, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { v7 as uuidv7 } from "uuid";
import { isSupportedHostSpanOAuthScope } from "../auth/oauth-scopes.js";
import { asHostSpanError } from "../errors.js";

export interface ResponseContext {
  toolset_hash: string;
  policy_epoch: number;
}

export function requestId(): string {
  return `req_${uuidv7().replaceAll("-", "")}`;
}

export function successResult(context: ResponseContext, value: Record<string, unknown>, request_id = requestId(), includeImage = false) {
  const { image, ...metadata } = value;
  const hasImage = includeImage && typeof image === "string" && value.mime_type === "image/png";
  const payload = { request_id, ...context, ...(hasImage ? metadata : value) };
  return {
    content: [
      { type: "text" as const, text: includeImage && typeof value.message === "string" ? value.message : JSON.stringify(payload) },
      ...(hasImage ? [{ type: "image" as const, mimeType: "image/png", data: image }] : []),
    ],
    structuredContent: payload,
  };
}

export function errorResult(context: ResponseContext, error: unknown, request_id = requestId(), humanMessage = false) {
  const known = asHostSpanError(error);
  const payload = {
    request_id,
    ...context,
    error: {
      code: known.code,
      message: known.message,
      retryable: known.retryable,
      details: known.details,
      request_id,
    },
  };
  // Only an OAuth scope denial requests reauthorization. Target/OS denials stay denied.
  const required = typeof known.details.required_scope === "string" ? [known.details.required_scope]
    : Array.isArray(known.details.required_scopes) ? known.details.required_scopes : [];
  const granted = Array.isArray(known.details.granted_scopes) ? known.details.granted_scopes : [];
  const challenges = known.code === "SCOPE_DENIED" && known.details.reason === "oauth_scope"
    ? required.filter((scope): scope is string => typeof scope === "string").map((scope) =>
      bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InsufficientScope, "Additional HostSpan authorization is required."), {
        requiredScopes: [...new Set([...granted.filter((value): value is string => typeof value === "string" && isSupportedHostSpanOAuthScope(value)), scope])],
        ...(typeof known.details.resource_metadata === "string" ? { resourceMetadataUrl: known.details.resource_metadata } : {}),
      }).headers.get("www-authenticate"),
    ).filter((challenge): challenge is string => challenge !== null) : [];
  return {
    ...(challenges.length ? { _meta: { "mcp/www_authenticate": challenges } } : {}),
    isError: true,
    content: [{ type: "text" as const, text: humanMessage ? known.message : JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
