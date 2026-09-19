import { CURSOR_MARKER, decodeKittyPrintable, truncateToWidth, type Component, type Focusable, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { ThemeLike } from "./ui.ts";

const PASTE_START = "\x1b[200~", PASTE_END = "\x1b[201~";
const MAX_LENGTH = 4096;

/** A secret-only editor: no plaintext rendering, history, clipboard, undo, or reveal action. */
export class SecretInput implements Component, Focusable {
	focused = false;
	private value: string[] = [];
	private cursor = 0;
	private paste: string | undefined;
	private pasteTooLong = false;
	private error = "";
	private closed = false;

	constructor(
		private theme: ThemeLike,
		private keys: Pick<KeybindingsManager, "matches" | "getKeys">,
		private done: (value: string | undefined) => void,
		private requestRender: () => void,
	) {}

	private insert(text: string): void {
		const chars = Array.from(text);
		if (/[\x00-\x1f\x7f-\x9f]/.test(text)) {
			this.error = "Paste a single-line API key. Control characters are not allowed.";
		} else if (this.value.length + chars.length > MAX_LENGTH) {
			this.error = `The key is too long. Maximum: ${MAX_LENGTH} characters.`;
		} else {
			this.value.splice(this.cursor, 0, ...chars);
			this.cursor += chars.length;
			this.error = "";
		}
	}

	private finish(value?: string): void {
		this.dispose();
		this.done(value);
	}

	/** Drop references on submit, cancel, or external teardown. JS cannot guarantee memory erasure. */
	dispose(): void {
		this.value.fill("");
		this.value = [];
		this.cursor = 0;
		this.paste = undefined;
		this.error = "";
		this.closed = true;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.paste === undefined && data.startsWith(PASTE_START)) {
			this.paste = "";
			this.pasteTooLong = false;
			data = data.slice(PASTE_START.length);
		}
		if (this.paste !== undefined) {
			this.paste += data;
			const end = this.paste.indexOf(PASTE_END);
			if (end >= 0) {
				const text = this.paste.slice(0, end);
				const remaining = this.paste.slice(end + PASTE_END.length);
				this.paste = undefined;
				if (this.pasteTooLong) this.error = "The pasted key is too long. Paste only the API key.";
				else this.insert(text.trim());
				if (remaining) this.handleInput(remaining);
			} else if (this.paste.length > MAX_LENGTH + PASTE_END.length) {
				this.pasteTooLong = true;
				this.paste = this.paste.slice(-PASTE_END.length); // retain a possible split end marker
			}
		} else if (this.keys.matches(data, "tui.select.cancel")) {
			this.finish();
		} else if (this.keys.matches(data, "tui.input.submit")) {
			if (!this.error) this.finish(this.value.join("").trim() || undefined);
		} else if (this.keys.matches(data, "tui.editor.cursorLeft")) {
			this.cursor = Math.max(0, this.cursor - 1);
		} else if (this.keys.matches(data, "tui.editor.cursorRight")) {
			this.cursor = Math.min(this.value.length, this.cursor + 1);
		} else if (this.keys.matches(data, "tui.editor.cursorLineStart")) {
			this.cursor = 0;
		} else if (this.keys.matches(data, "tui.editor.cursorLineEnd")) {
			this.cursor = this.value.length;
		} else if (this.keys.matches(data, "tui.editor.deleteCharBackward")) {
			if (this.cursor) this.value.splice(--this.cursor, 1);
			this.error = "";
		} else if (this.keys.matches(data, "tui.editor.deleteCharForward")) {
			this.value.splice(this.cursor, 1);
			this.error = "";
		} else if (this.keys.matches(data, "tui.editor.deleteToLineStart")) {
			this.value.splice(0, this.cursor);
			this.cursor = 0;
			this.error = "";
		} else if (this.keys.matches(data, "tui.editor.deleteToLineEnd")) {
			this.value.splice(this.cursor);
			this.error = "";
		} else {
			const text = decodeKittyPrintable(data) ?? data;
			if (!/[\x00-\x1f\x7f-\x9f]/.test(text)) this.insert(text);
		}
		this.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 1) return [""];
		const room = Math.max(1, width - 2);
		const start = Math.max(0, this.cursor - room + 1);
		const before = "*".repeat(this.cursor - start);
		const after = "*".repeat(Math.min(this.value.length - this.cursor, room - before.length - 1));
		const cursor = this.cursor < this.value.length ? "*" : " ";
		const marker = this.focused ? CURSOR_MARKER : "";
		const field = `${width > 2 ? "> " : ""}${before}${marker}${this.focused ? `\x1b[7m${cursor}\x1b[27m` : cursor}${after}`;
		return [
			this.theme.fg("accent", "TypeSafe API key (masked)"),
			this.theme.fg("dim", "Get a key at console.typesafe.ai. Type or paste it below."),
			field,
			this.theme.fg("dim", `${this.keys.getKeys("tui.input.submit").join("/")}: save · ${this.keys.getKeys("tui.select.cancel").join("/")}: cancel`),
			...(this.error ? [this.theme.fg("warning", this.error)] : []),
		].map((line) => truncateToWidth(line, width));
	}
}
