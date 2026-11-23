import { describe, expect, it } from "vitest";
import {
	mapDesktopWorkerError,
	parseDesktopWorkerCommand,
	parseDesktopWorkerReply,
} from "../../src/computer/worker-protocol.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const observationId = "00000000-0000-4000-8000-000000000003";

describe("private desktop JSON-lines wire contract", () => {
	it("accepts actual Linux/macOS/Windows event, frame, close, and error families", () => {
		expect(
			parseDesktopWorkerReply(
				'{"event":"permission_required","permission":"screen_recording"}',
			),
		).toEqual({
			kind: "permission_required",
			permission: "screen_recording",
		});
		expect(parseDesktopWorkerReply('{"event":"closed"}')).toEqual({
			kind: "closed",
		});
		expect(
			parseDesktopWorkerReply(
				JSON.stringify({
					id: requestId,
					result: {
						display_id: "main-screen",
						coordinate_width: 1280,
						coordinate_height: 720,
						pipewire_node_id: 14,
					},
				}),
			),
		).toMatchObject({
			kind: "result",
			id: requestId,
			result: { display_id: "main-screen" },
		});
		expect(
			parseDesktopWorkerReply(
				JSON.stringify({
					id: requestId,
					result: {
						image: "cG5n",
						mime_type: "image/png",
						coordinate_width: 800,
						coordinate_height: 600,
						capture_started_at: "2026-11-23T00:00:00Z",
					},
				}),
			),
		).toMatchObject({ kind: "result", result: { mime_type: "image/png" } });
		expect(
			parseDesktopWorkerReply(
				JSON.stringify({ id: requestId, result: { closed: true } }),
			),
		).toMatchObject({ kind: "result", result: { closed: true } });
		expect(
			parseDesktopWorkerReply(
				JSON.stringify({ id: requestId, result: { dispatched: true } }),
			),
		).toMatchObject({ kind: "result", result: { dispatched: true } });
		const workerError = parseDesktopWorkerReply(
			JSON.stringify({
				id: requestId,
				error: "Locked",
				error_details: { reason: "macos_desktop_locked", dispatched: false },
			}),
		);
		expect(workerError).toMatchObject({
			kind: "error",
			error_details: { dispatched: false },
		});
		if (workerError.kind === "error")
			expect(mapDesktopWorkerError(workerError)).toMatchObject({
				code: "TARGET_NOT_READY",
				details: { reason: "macos_desktop_locked", dispatched: false },
			});
	});

	it("rejects malformed, unknown, ambiguous and over-budget replies before session updates", () => {
		for (const raw of [
			"",
			"{bad",
			"null",
			"[]",
			'{"event":"unknown"}',
			'{"event":"permission_required","permission":"root"}',
			JSON.stringify({ id: requestId, result: { image: 1 } }),
			JSON.stringify({ id: requestId, result: { mime_type: "text/plain" } }),
			JSON.stringify({ id: requestId, error: "x", result: { closed: true } }),
			JSON.stringify({ id: "wrong", result: {} }),
			JSON.stringify({ id: requestId, result: null }),
		])
			expect(() => parseDesktopWorkerReply(raw)).toThrow(
				/Invalid desktop worker response/,
			);
		expect(() =>
			parseDesktopWorkerReply(JSON.stringify({ event: "closed" }), 4),
		).toThrow(/budget/);
	});

	it("validates outgoing commands and preserves original computer mutation fields", () => {
		expect(
			parseDesktopWorkerCommand({ id: requestId, action: "open" }),
		).toEqual({ id: requestId, action: "open" });
		expect(
			parseDesktopWorkerCommand({ id: requestId, action: "observe" }),
		).toEqual({ id: requestId, action: "observe" });
		const command = {
			id: requestId,
			action: "text",
			session_id: sessionId,
			observation_id: observationId,
			idempotency_key: "original-delivery",
			text: "hello",
		};
		expect(parseDesktopWorkerCommand(command)).toEqual(command);
		for (const bad of [
			{ id: requestId, action: "unknown" },
			{ id: requestId, action: "open", extra: true },
			{ id: "invalid", action: "close" },
			{
				id: requestId,
				action: "move",
				session_id: sessionId,
				observation_id: observationId,
				idempotency_key: "1",
				x: -4,
				y: 0,
			},
		])
			expect(() => parseDesktopWorkerCommand(bad)).toThrow(
				/Invalid desktop worker command/,
			);
	});
});
