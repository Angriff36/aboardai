#!/usr/bin/env node

/**
 * Electron-builder afterPack hook
 * Rebuilds native modules in the server bundle for the target architecture
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execAsync = promisify(exec);

exports.default = async function (context) {
  const { appOutDir, electronPlatformName, arch, packager } = context;
  // electronVersion MUST be resolvable, otherwise @electron/rebuild targets the wrong
  // (or an "undefined") ABI and the native module silently mismatches at runtime. Prefer
  // the pinned build config value, fall back to the detected Electron version.
  const electronVersion = packager.config.electronVersion || packager.info?.framework?.version;
  if (!electronVersion) {
    throw new Error(
      'rebuild-server-natives: could not determine the Electron version. ' +
        'Set "electronVersion" in the electron-builder "build" config.'
    );
  }

  // Convert arch to string if it's a number (electron-builder sometimes passes indices)
  const archNames = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
  const archStr = typeof arch === 'number' ? archNames[arch] : arch;

  console.log(`\n🔨 Rebuilding server native modules for ${electronPlatformName}-${archStr}...`);

  // Path to server node_modules in the packaged app
  let serverNodeModulesPath;
  if (electronPlatformName === 'darwin') {
    serverNodeModulesPath = path.join(
      appOutDir,
      `${packager.appInfo.productName}.app`,
      'Contents',
      'Resources',
      'server',
      'node_modules'
    );
  } else if (electronPlatformName === 'win32') {
    serverNodeModulesPath = path.join(appOutDir, 'resources', 'server', 'node_modules');
  } else {
    serverNodeModulesPath = path.join(appOutDir, 'resources', 'server', 'node_modules');
  }

  try {
    // Rebuild native modules for the target architecture
    const rebuildCmd = `npx --yes @electron/rebuild --version=${electronVersion} --arch=${archStr} --force --module-dir="${serverNodeModulesPath}/.."`;

    console.log(`   Command: ${rebuildCmd}`);

    // node-pty's vendored winpty.gyp runs `cmd /c "cd shared && GetCommitHash.bat"` without a
    // `.\` prefix. When NoDefaultCurrentDirectoryInExePath is set (a Windows hardening flag,
    // common in CI and locked-down/sandboxed shells), cmd.exe won't resolve a batch file from
    // the current directory, so gyp configure fails. Clear the flag for the child so the
    // native build is reproducible regardless of the host environment.
    const childEnv = { ...process.env };
    delete childEnv.NoDefaultCurrentDirectoryInExePath;

    const { stdout, stderr } = await execAsync(rebuildCmd, { env: childEnv, maxBuffer: 64 * 1024 * 1024 });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    console.log(`✅ Server native modules rebuilt successfully for ${archStr}\n`);
  } catch (error) {
    // Fail the build. A packaged app whose native modules (e.g. node-pty) don't match the
    // Electron ABI looks "built" but crashes the terminal at runtime — worse than no build.
    console.error(`❌ Failed to rebuild server native modules:`, error.message);
    if (error.stdout) console.error(error.stdout);
    if (error.stderr) console.error(error.stderr);

    // node-pty requires Spectre-mitigated MSVC libs (its binding.gyp sets SpectreMitigation).
    // MSB8040 means that VS component is missing — give the exact remedy instead of a raw error.
    const combined = `${error.message}\n${error.stdout || ''}\n${error.stderr || ''}`;
    if (/MSB8040|Spectre-mitigated/i.test(combined)) {
      console.error(
        '\n👉 node-pty needs the MSVC Spectre-mitigated libraries. Install them once:\n' +
          '   Visual Studio Installer → Modify → Individual components →\n' +
          '   "MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs" (match your toolset),\n' +
          '   or via CLI:\n' +
          '     vs_installer.exe modify --passive ^\n' +
          '       --add Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre\n' +
          '   Then re-run the build.\n'
      );
    }
    throw error;
  }
};
