import { createBaseConfig } from '../../eslint.base.config.js';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'tsup.config.ts'] },
  ...createBaseConfig({ includeTanstackQuery: false }),
];
