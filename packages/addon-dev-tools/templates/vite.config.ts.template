import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const hostProvidedDependencies = [
  '@tanstack/react-query',
  '@wealthfolio/addon-sdk',
  '@wealthfolio/addon-sdk/goal-progress',
  '@wealthfolio/addon-sdk/host-api',
  '@wealthfolio/addon-sdk/host-dependencies',
  '@wealthfolio/addon-sdk/manifest',
  '@wealthfolio/addon-sdk/permissions',
  '@wealthfolio/addon-sdk/query-keys',
  '@wealthfolio/addon-sdk/types',
  '@wealthfolio/addon-sdk/utils',
  '@wealthfolio/ui',
  '@wealthfolio/ui/chart',
  'date-fns',
  'lucide-react',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
  'recharts',
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: 'src/addon.tsx',
      fileName: () => 'addon.js',
      formats: ['es'],
    },
    outDir: 'dist',
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: hostProvidedDependencies,
    },
    watch: {
      // Watch mode options for better hot reloading
      include: ['src/**'],
      exclude: ['node_modules/**', 'dist/**']
    }
  },
});
