import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'src',
  publicDir: resolve(rootDir, 'static'),
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        index: resolve(rootDir, 'src/index.html'),
        admin: resolve(rootDir, 'src/admin.html'),
        migrate: resolve(rootDir, 'src/migrate-log.html'),
        offline: resolve(rootDir, 'src/offline.html'),
        notfound: resolve(rootDir, 'src/404.html')
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (info) => {
          const name = info.name || '';
          if (name === 'app.css' || name.endsWith('/app.css')) return 'assets/app.[hash].css';
          if (name.endsWith('.css')) return 'assets/[name].[hash][extname]';
          return 'assets/[name]-[hash][extname]';
        }
      }
    }
  }
});
