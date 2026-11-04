import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    // The portal only ever ships to evergreen browsers, so skip esbuild's
    // downlevel transforms instead of paying them in bytes.
    target: 'es2022',
    rollupOptions: {
      output: {
        // Two stable vendor chunks plus the app chunk. The first load downloads
        // the same total bytes; the win is that editing Portal.tsx invalidates a
        // few kB of app code instead of the whole vendor graph.
        manualChunks: {
          react: ['react', 'react-dom'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
});
