import { z } from "zod";
import { HostSpanError } from "../errors.js";
import { ComputerInputSchema, type ComputerInput } from "./input-schema.js";

const RequestId = z.string().uuid();
export const DesktopWorkerResultSchema = z
	.object({
		display_id: z.string().optional(),
		pipewire_node_id: z.number().int().nonnegative().optional(),
		coordinate_width: z.number().int().positive().optional(),
		coordinate_height: z.number().int().positive().optional(),
		image: z.string().optional(),
		mime_type: z.literal("image/png").optional(),
		closed: z.boolean().optional(),
		dispatched: z.boolean().optional(),
	})
	.passthrough();

export type DesktopWorkerResult = z.infer<typeof DesktopWorkerResultSchema>;
export interface PendingDesktopRequest {
	resolve(value: DesktopWorkerResult): void;
	reject(error: Error): void;
}

const PermissionEvent = z
	.object({
		event: z.literal("permission_required"),
		permission: z.enum(["screen_recording", "accessibility"]),
	})
	.strict();
const ClosedEvent = z.object({ event: z.literal("closed") }).strict();
const ResultReply = z
	.object({ id: RequestId, result: DesktopWorkerResultSchema })
	.strict();
const ErrorReply = z
	.object({
		id: RequestId,
		error: z.string().min(1),
		error_details: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

export const DesktopWorkerReplyWireSchema = z.union([
	PermissionEvent,
	ClosedEvent,
	ResultReply,
	ErrorReply,
]);
export type DesktopWorkerReply =
	| {
			kind: "permission_required";
			permission: "screen_recording" | "accessibility";
	  }
	| { kind: "closed" }
	| { kind: "result"; id: string; result: DesktopWorkerResult }
	| {
			kind: "error";
			id: string;
			error: string;
			error_details?: Record<string, unknown>;
	  };

export function parseDesktopWorkerReply(
	line: string,
	maxBytes = 24 * 1024 * 1024,
): DesktopWorkerReply {
	if (Buffer.byteLength(line, "utf8") > maxBytes)
		throw new Error("Desktop worker response exceeds the allowed budget");
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		throw new Error("Invalid desktop worker response");
	}
	const parsed = DesktopWorkerReplyWireSchema.safeParse(raw);
	if (!parsed.success) throw new Error("Invalid desktop worker response");
	const reply = parsed.data;
	if ("event" in reply) {
		return reply.event === "closed"
			? { kind: "closed" }
			: { kind: "permission_required", permission: reply.permission };
	}
	if ("error" in reply)
		return {
			kind: "error",
			id: reply.id,
			error: reply.error,
			...(reply.error_details ? { error_details: reply.error_details } : {}),
		};
	return { kind: "result", id: reply.id, result: reply.result };
}

export type DesktopWorkerCommand = { id: string } & (
	| ComputerInput
	| { action: "open" | "observe" | "close" }
);
const CommandBaseSchema = z
	.object({
		id: RequestId,
		action: z.enum([
			"open",
			"observe",
			"close",
			"move",
			"click",
			"text",
			"key",
			"scroll",
		]),
	})
	.passthrough();

export function parseDesktopWorkerCommand(raw: unknown): DesktopWorkerCommand {
	const parsed = CommandBaseSchema.safeParse(raw);
	if (!parsed.success) throw new Error("Invalid desktop worker command");
	const { id, action, ...fields } = parsed.data;
	if (action === "open" || action === "observe" || action === "close") {
		if (Object.keys(fields).length)
			throw new Error("Invalid desktop worker command");
		return { id, action };
	}
	const validatedInput = ComputerInputSchema.safeParse({ action, ...fields });
	if (!validatedInput.success)
		throw new Error("Invalid desktop worker command");
	return { id, ...validatedInput.data };
}

export function mapDesktopWorkerError(
	reply: Extract<DesktopWorkerReply, { kind: "error" }>,
): HostSpanError {
	const reason = reply.error_details?.reason;
	const code =
		reason === "portal_local_timeout"
			? "DEADLINE_EXCEEDED"
			: ["macos_gui_launch_required", "macos_desktop_locked"].includes(
						String(reason),
					)
				? "TARGET_NOT_READY"
				: "INTERNAL_ERROR";
	return new HostSpanError(code, reply.error, false, reply.error_details);
}
