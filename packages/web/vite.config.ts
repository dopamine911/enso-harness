import react from "@vitejs/plugin-react";
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
	plugins: [react()],
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
