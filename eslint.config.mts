import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json',
						'vitest.config.ts',
						'vitest.integration.config.ts'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The client↔server integration harness runs in Node (vitest), not inside
		// Obsidian, so it legitimately uses `fetch`, Node builtins, and Node globals.
		// The Obsidian-plugin rules that forbid those do not apply to these files.
		files: ["__tests__/integration/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			"no-restricted-globals": "off",
			"import/no-nodejs-modules": "off",
			"no-undef": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
