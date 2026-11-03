const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['public/x402-client.js'],
  bundle: true,
  outfile: 'public/x402-bundle.js',
  format: 'iife',
  globalName: 'X402App',
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'window'
  }
}).then(() => {
  console.log("x402-bundle.js built successfully.");
}).catch(() => process.exit(1));
