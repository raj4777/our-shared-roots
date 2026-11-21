import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

// `vite build --mode test` writes dist-test/ with the window.__TREE / __ADMIN /
// __MIGRATE test hooks compiled in. Every other mode (the normal `npm run build`
// that produces dist/ for deploy) defines __OSR_TEST_HOOKS__ as false, so the
// hooks are removed from the production bundle.
export default defineConfig(({ mode }) => ({
  define: {
    __OSR_TEST_HOOKS__: JSON.stringify(mode === 'test')
  },
  root: 'src',
  publicDir: resolve(rootDir, 'static'),
  build: {
    outDir: resolve(rootDir, mode === 'test' ? 'dist-test' : 'dist'),
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
}));
