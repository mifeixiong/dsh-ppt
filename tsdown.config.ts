import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/headless.ts',
    'src/tools.ts',
    'src/runtime.ts',
    'src/schemas.ts',
  ],
  format: ['esm'],
  outDir: 'lib',
  clean: true,
  dts: false,
  sourcemap: true,
})
