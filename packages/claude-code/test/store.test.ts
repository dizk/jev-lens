import { mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepDays, loadOutput, loadOutputAnywhere, pruneOutputs, saveOutput } from "../src/store.ts";

const DAY = 24 * 60 * 60 * 1000;
const rec = (id: string) => ({ id, toolName: "bash", args: {}, text: "x", view: "focus", kind: "command", sessionId: "s", cwd: "/", at: 0 });

describe("outputs store", () => {
	afterEach(() => { delete process.env.JEV_LENS_KEEP_DAYS; });
	it("keeps outputs for 90 days unless JEV_LENS_KEEP_DAYS says otherwise", () => {
		expect(keepDays()).toBe(90);
		process.env.JEV_LENS_KEEP_DAYS = "7";
		expect(keepDays()).toBe(7);
		process.env.JEV_LENS_KEEP_DAYS = "nope";
		expect(keepDays()).toBe(90);
	});
	it("prunes only outputs older than the retention, at most once an hour", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevstore-"));
		process.env.JEV_LENS_DATA_DIR = dir;
		const old = saveOutput(rec("old")), fresh = saveOutput(rec("fresh"));
		const now = Date.now();
		utimesSync(old, new Date(now - 100 * DAY), new Date(now - 100 * DAY));
		utimesSync(fresh, new Date(now - 30 * DAY), new Date(now - 30 * DAY));
		expect(pruneOutputs(undefined, now)).toBe(1);
		expect(readdirSync(join(dir, "outputs"))).toEqual(["fresh.json"]);
		expect(loadOutput("fresh")?.id).toBe("fresh");
		expect(loadOutputAnywhere("fresh")?.id).toBe("fresh");
		expect(loadOutput("old")).toBeUndefined();
		// the stamp file stops a second sweep within the hour
		utimesSync(fresh, new Date(now - 100 * DAY), new Date(now - 100 * DAY));
		expect(pruneOutputs(undefined, now + 60 * 1000)).toBe(0);
	});
});
