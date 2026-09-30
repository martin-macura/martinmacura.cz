// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	vite: {
		build: {
			// three.js is one big chunk on purpose: src/scripts/background.ts imports it lazily, after first paint
			chunkSizeWarningLimit: 600,
		},
	},
});
