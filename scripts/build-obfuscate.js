const fs = require('fs');
const path = require('path');
const { build } = require('esbuild');
const bytenode = require('bytenode');
const { execSync } = require('child_process');

async function main() {
  const target = process.argv[2] || 'macos';
  console.log(`Building for target: ${target}`);
  
  console.log('1. Preparing dist folder...');
  const distDir = path.join(__dirname, '../dist');
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir);

  console.log('2. Bundling backend with esbuild...');
  await build({
    entryPoints: [path.join(__dirname, '../server.js')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    outfile: path.join(distDir, 'server.bundled.js'),
    external: ['bytenode', '@aws-sdk/client-s3'],
    minify: true,
  });

  console.log('6. Creating entry point for pkg...');
  const entryContent = `
const path = require('path');
require('bytenode');
require(path.join(__dirname, 'server.bundled.jsc'));
  `;
  fs.writeFileSync(path.join(distDir, 'entry.js'), entryContent.trim());
  
  console.log('3. Compiling to V8 Bytecode (.jsc)...');
  
  // To ensure the bytecode matches the exact V8 version of the target platform,
  // we must compile it using the pkg base binary for that platform.
  // First, we fetch the pkg binary if it's not cached.
  const nodeVersion = 'node18';
  const targetPlatform = target === 'linux' ? 'linux' : 'macos';
  const targetArch = target === 'linux' ? 'x64' : 'arm64';
  let compilerPlatform = targetPlatform;
  let compilerArch = targetArch;
  let compilerBinaryName = target === 'linux' ? 'fetched-v18.5.0-linux-x64' : 'fetched-v18.5.0-macos-arm64';

  // If host is macOS and target is Linux x64, we cannot run the linux binary.
  // Instead, we fetch the macOS x64 binary to compile the bytecode (runs via Rosetta).
  if (process.platform === 'darwin' && target === 'linux') {
      console.log('Host is macOS and target is Linux x64. Using macOS x64 pkg binary as compiler (via Rosetta).');
      compilerPlatform = 'macos';
      compilerArch = 'x64';
      compilerBinaryName = 'fetched-v18.5.0-macos-x64';
  }

  console.log(`Ensuring pkg base binary for compiler (${compilerPlatform}-${compilerArch}) is fetched...`);
  try {
    execSync(`PKG_CACHE_PATH=./.pkg-cache npx pkg-fetch -n ${nodeVersion} -p ${compilerPlatform} -a ${compilerArch}`, { stdio: 'inherit' });
  } catch (e) {
    console.error('Failed to fetch pkg base compiler binary. Continuing anyway...');
  }
  
  const cacheDir = path.join(__dirname, '..', '.pkg-cache', 'v3.4');
  const compilerBinaryPath = path.join(cacheDir, compilerBinaryName);
  
  const serverBundledJs = path.join(distDir, 'server.bundled.js');
  const serverBundledJsc = path.join(distDir, 'server.bundled.jsc');

  if (fs.existsSync(compilerBinaryPath)) {
      let compilerBinary = compilerBinaryPath;
      if (compilerPlatform === 'macos') {
          console.log(`Copying and signing the pkg base binary for macOS to prevent SIGKILL...`);
          compilerBinary = path.join(distDir, 'pkg-compiler-temp');
          fs.copyFileSync(compilerBinaryPath, compilerBinary);
          try {
              execSync(`codesign --force --sign - "${compilerBinary}"`, { stdio: 'inherit' });
          } catch(e) {
              console.error('Failed to sign binary, it might get killed if on Apple Silicon.');
          }
      }
      console.log(`Compiling bytecode using pkg binary: ${compilerBinary}`);
      // Create a temporary script to compile via bytenode using the exact node version
      const compilerScript = path.join(distDir, 'compile.js');
      fs.writeFileSync(compilerScript, `
          const bytenode = require('bytenode');
          bytenode.compileFile({
              filename: '${serverBundledJs}',
              output: '${serverBundledJsc}'
          });
      `);
      execSync(`"${compilerBinary}" ${compilerScript}`, { stdio: 'inherit' });
      fs.unlinkSync(compilerScript);
      if (target === 'macos') {
          fs.unlinkSync(compilerBinary);
      }
  } else {
      console.log('Falling back to local node to compile bytecode (Safe for native macOS builds)');
      bytenode.compileFile({
        filename: serverBundledJs,
        output: serverBundledJsc
      });
  }

  console.log('4. Removing intermediate JS to protect source code...');
  fs.unlinkSync(serverBundledJs);

  console.log('5. Copying public folder to dist...');
  fs.cpSync(path.join(__dirname, '../public'), path.join(distDir, 'public'), { recursive: true });

  console.log('Build preparation completed! Ready for pkg packaging.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
