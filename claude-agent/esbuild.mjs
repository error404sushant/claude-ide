// Bundles the extension (and the Claude Agent SDK) into out/extension.js. Usage: node esbuild.mjs [--watch]
import { build, context } from 'esbuild';

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'out/extension.js',
  external: ['vscode'],
  // The SDK is ESM and reads import.meta.url; provide it in the CommonJS bundle.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl=require('url').pathToFileURL(__filename).href;" },
  logLevel: 'info',
};
if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
