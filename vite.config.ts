import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'production-content-security-policy',
      apply: 'build',
      // Vite's local React refresh preamble is inline. Keep the deployed app
      // strict without breaking the loopback-only development server.
      transformIndexHtml() {
        return [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content:
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'",
            },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  ],
  // Relative assets work at /, /joule-kitchen/, and a different Pages repo name.
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { sourcemap: false, target: 'es2022' },
});
