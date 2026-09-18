import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { SecretInput } from "../src/secret-input.ts";

const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
function setup(bindings = new KeybindingsManager(TUI_KEYBINDINGS)) {
	const done = vi.fn(), render = vi.fn();
	const input = new SecretInput(theme, bindings, done, render);
	input.focused = true;
	return { input, done, render };
}

describe("masked key input", () => {
	it("renders only masks at every width, including after invalidation and focus changes", () => {
		const { input, done } = setup();
		const key = "ts_super_secret_123";
		input.handleInput(key);
		for (const focused of [true, false]) for (const width of [0, 1, 2, 3, 12, 80]) {
			input.focused = focused;
			input.invalidate();
			const lines = input.render(width);
			expect(lines.join("\n")).not.toContain(key);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		input.focused = true;
		expect(input.render(80).join("\n")).toContain("*".repeat(key.length));
		expect(input.render(80).join("\n")).toContain(CURSOR_MARKER);
		input.handleInput("\r");
		expect(done).toHaveBeenCalledWith(key);
		expect(input.render(80).join("\n")).not.toContain("*");
		input.handleInput("ts_other");
		input.handleInput("\r");
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("supports cursor editing, deletion, and Kitty printable keys", () => {
		const { input, done } = setup();
		for (const key of ["ts_ac", "\x1b[D", "b", "\x1b[3~", "\x7f", "\x1b[99u", "\x01", "\x1b[C", "\x1b[C", "\x15", "\x05", "\r"]) input.handleInput(key);
		expect(done).toHaveBeenCalledWith("_ac");
	});

	it("buffers bracketed paste, including split end markers, without submitting pasted newlines", () => {
		const { input, done } = setup();
		for (const part of ["\x1b[200~ts_", "pasted_key\n", "\x1b[20", "1~"]) {
			input.handleInput(part);
			expect(input.render(80).join("\n")).not.toContain("pasted_key");
		}
		expect(done).not.toHaveBeenCalled();
		input.handleInput("\r");
		expect(done).toHaveBeenCalledWith("ts_pasted_key");
	});

	it.each(["\x1b", "\x03"])("cancels without returning or retaining a secret", (cancel) => {
		const { input, done } = setup();
		input.handleInput("ts_cancelled");
		input.handleInput(cancel);
		expect(done).toHaveBeenCalledWith(undefined);
		expect(input.render(80).join("\n")).not.toContain("*");
	});

	it("handles empty submission and external disposal", () => {
		const { input, done } = setup();
		input.handleInput("\r");
		expect(done).toHaveBeenCalledWith(undefined);
		const other = setup();
		other.input.handleInput("ts_secret");
		other.input.dispose();
		other.input.handleInput("\r");
		expect(other.done).not.toHaveBeenCalled();
		expect(other.input.render(80).join("\n")).not.toContain("*");
	});

	it("uses injected submit/cancel bindings and displays their hints", () => {
		const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+s", "tui.select.cancel": "ctrl+q" });
		const { input, done } = setup(keys);
		input.handleInput("ts_key");
		input.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
		expect(input.render(80).join("\n")).toContain("ctrl+s: save");
		input.handleInput("\x13");
		expect(done).toHaveBeenCalledWith("ts_key");
	});

	it("rejects control characters and oversized pastes without echoing or saving them", () => {
		const { input, done } = setup();
		input.handleInput("\x1b[200~ts_secret\x1b[31m\x1b[201~");
		expect(input.render(80).join("\n")).toContain("Control characters");
		expect(input.render(80).join("\n")).not.toContain("ts_secret");
		input.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
		input.handleInput("\x1b[200~" + "x".repeat(5000));
		input.handleInput("\x1b[201~");
		input.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
		expect(input.render(80).join("\n")).toContain("too long");
		input.handleInput("\x1b");
		expect(done).toHaveBeenCalledWith(undefined);
	});
});
