import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// Tests run against the core sources; the built dist is what pi and the Claude Code plugin load at runtime.
		alias: { "jev-lens": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) },
	},
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		exclude: ["eval/**", "node_modules/**"],
	},
});
