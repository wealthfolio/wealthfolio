import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'goal-progress': 'src/goal-progress.ts',
    'host-dependencies': 'src/host-dependencies.ts',
    'host-api': 'src/host-api.ts',
    index: 'src/index.ts',
    manifest: 'src/manifest.ts',
    permissions: 'src/permissions.ts',
    'query-keys': 'src/query-keys.ts',
    types: 'src/types.ts',
    utils: 'src/utils.ts',
  },
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  minify: false,
  target: 'es2020',
  external: ['react'],
});
