import { z } from "zod";

const session = { session_id: z.string().uuid() };
const mutation = {
	...session,
	observation_id: z.string().uuid(),
	idempotency_key: z.string().min(1).max(128),
};
const pointer = {
	x: z.number().finite().nonnegative(),
	y: z.number().finite().nonnegative(),
};
const keyModifiers =
	process.platform === "win32"
		? z
				.array(z.enum(["Shift", "Alt", "Meta"]))
				.max(3)
				.refine(
					(values) => new Set(values).size === values.length,
					"Duplicate modifiers",
				)
				.describe(
					"Windows modifiers: Meta is the Windows key (KeyE+Meta opens Explorer; Tab+Alt switches apps).",
				)
		: z.array(z.literal("Shift")).max(1);
export const ComputerInputSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("open") }).strict(),
	z.object({ action: z.literal("observe"), ...session }).strict(),
	z.object({ action: z.literal("close"), ...session }).strict(),
	z.object({ action: z.literal("move"), ...mutation, ...pointer }).strict(),
	z
		.object({
			action: z.literal("click"),
			...mutation,
			...pointer,
			button: z.enum(["left", "right", "middle"]).default("left"),
		})
		.strict(),
	z
		.object({
			action: z.literal("text"),
			...mutation,
			text: z
				.string()
				.min(1)
				.max(4096)
				.refine(
					(text) =>
						[...text].every(
							(char) =>
								char === "\n" ||
								char === "\t" ||
								(char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
						),
					"Unsupported control character",
				),
		})
		.strict(),
	z
		.object({
			action: z.literal("key"),
			...mutation,
			key: z.enum([
				"Enter",
				"Tab",
				"Escape",
				"Backspace",
				"Delete",
				"Left",
				"Up",
				"Right",
				"Down",
				"Home",
				"End",
				"KeyA",
				"KeyB",
				"KeyC",
				"KeyD",
				"KeyE",
				"KeyF",
				"KeyG",
				"KeyH",
				"KeyI",
				"KeyJ",
				"KeyK",
				"KeyL",
				"KeyM",
				"KeyN",
				"KeyO",
				"KeyP",
				"KeyQ",
				"KeyR",
				"KeyS",
				"KeyT",
				"KeyU",
				"KeyV",
				"KeyW",
				"KeyX",
				"KeyY",
				"KeyZ",
			]),
			modifiers: keyModifiers.optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("scroll"),
			...mutation,
			dx: z.number().finite().min(-10000).max(10000),
			dy: z.number().finite().min(-10000).max(10000),
		})
		.strict(),
]);
export type ComputerInput = z.infer<typeof ComputerInputSchema>;
