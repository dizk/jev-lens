import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keyFilePath, readStoredKey, resolveApiKey, storeKey } from "../src/config.ts";

describe("TypeSafe API key resolution", () => {
	const saved = { file: process.env.JEV_LENS_KEY_FILE, key: process.env.TYPESAFE_API_KEY };
	afterEach(() => {
		if (saved.file === undefined) delete process.env.JEV_LENS_KEY_FILE; else process.env.JEV_LENS_KEY_FILE = saved.file;
		if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved.key;
	});
	it("stores the key user-only and reads it back; the environment wins when set", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevkey-"));
		process.env.JEV_LENS_KEY_FILE = join(dir, "sub", "jev-lens.json");
		delete process.env.TYPESAFE_API_KEY;
		expect(readStoredKey()).toBeUndefined();
		expect(resolveApiKey()).toBeUndefined();
		const where = storeKey("  ts_abc  ");
		expect(where).toBe(keyFilePath());
		expect(JSON.parse(readFileSync(where, "utf8"))).toEqual({ apiKey: "ts_abc" });
		if (process.platform !== "win32") expect(statSync(where).mode & 0o777).toBe(0o600);
		expect(readStoredKey()).toBe("ts_abc");
		expect(resolveApiKey()).toBe("ts_abc");
		process.env.TYPESAFE_API_KEY = "ts_env";
		expect(resolveApiKey()).toBe("ts_env");
	});
	it("ignores a malformed key file", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevkey-"));
		process.env.JEV_LENS_KEY_FILE = join(dir, "k.json");
		writeFileSync(process.env.JEV_LENS_KEY_FILE, "{not json");
		expect(readStoredKey()).toBeUndefined();
	});
});
