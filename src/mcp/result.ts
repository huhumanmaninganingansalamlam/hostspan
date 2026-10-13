import { v7 as uuidv7 } from "uuid";
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
  return {
    isError: true,
    content: [{ type: "text" as const, text: humanMessage ? known.message : JSON.stringify(payload) }],
    ...(humanMessage ? { structuredContent: payload } : {}),
  };
}
