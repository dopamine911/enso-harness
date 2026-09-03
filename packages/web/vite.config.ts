import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Dev-only config.
 *
 * ⚠ `/api` is proxied to the zen server rather than the browser calling it directly, so the
 * page and the API share an origin and no CORS surface is opened. The server binds loopback
 * only (see `src/server/index.ts`), and that pairing is deliberate: with no sandbox and
 * `bash` unconfined (#9), the API must not be reachable from another host.
 */
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		// ⚠ The "@" alias MUST match tsconfig's `paths` exactly — they are two resolvers
		// with no shared source of truth. If only tsconfig knows it, typecheck passes and
		// the browser 404s; if only vite knows it, the app runs and `tsc -b` fails.
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	server: {
		port: 5178,
		host: "127.0.0.1",
		proxy: {
			"/api": {
				target: "http://127.0.0.1:5179",
				changeOrigin: false,
			},
		},
	},
});
