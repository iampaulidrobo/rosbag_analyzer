import * as vscode from 'vscode';
import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BagBridge, expandHome } from './bridge';

const REQUIRED_PACKAGES = ['rosbags', 'pandas', 'numpy', 'evo'];

export function managedVenvDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'venv');
}

export function managedVenvPython(context: vscode.ExtensionContext): string {
  const dir = managedVenvDir(context);
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python3');
}

function findSystemPython(): string | null {
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `${cmd} ${args.join(' ')} exited with code ${code}`)),
    );
  });
}

/**
 * The venv's python executable existing is NOT proof the environment works —
 * `python3 -m venv` can succeed in laying out the directory while leaving it
 * with no working pip (e.g. Debian/Ubuntu systems missing the separate
 * `python3-venv`/`python3-pip` OS packages), or a previous provisioning
 * attempt can have died partway through `pip install`. Only trust an
 * environment that can actually import everything we need.
 */
function verifyEnvironment(pythonExe: string): boolean {
  try {
    execFileSync(pythonExe, ['-c', 'import rosbags, pandas, numpy, evo'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasWorkingPip(pythonExe: string): Promise<boolean> {
  return run(pythonExe, ['-m', 'pip', '--version']).then(
    () => true,
    () => false,
  );
}

/**
 * Creates (or repairs) a virtual environment private to this extension and
 * installs everything the bag reader and Accuracy tab need into it, so a
 * user never has to run pip themselves. Lives under the extension's own
 * global storage — never touches the system interpreter or any project.
 * Safe to call repeatedly: it self-heals a partially-built or broken venv
 * (missing pip, incomplete package install) instead of assuming that because
 * the interpreter file exists, everything else worked too.
 */
export async function provisionManagedVenv(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
): Promise<string | null> {
  const venvDir = managedVenvDir(context);
  const venvPython = managedVenvPython(context);

  if (fs.existsSync(venvPython) && verifyEnvironment(venvPython)) {
    return venvPython;
  }

  const base = findSystemPython();
  if (!base) {
    log.warn('No system python3/python found on PATH; cannot set up a managed environment automatically.');
    void vscode.window.showWarningMessage(
      'Rosbag Analyzer could not find a Python interpreter on PATH to set up its own environment. Install Python, or choose an interpreter manually.',
    );
    return null;
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Rosbag Analyzer: setting up a Python environment',
      cancellable: false,
    },
    async (progress) => {
      try {
        if (!fs.existsSync(venvPython)) {
          progress.report({ message: 'Creating a private virtual environment…' });
          try {
            await run(base, ['-m', 'venv', venvDir]);
          } catch (venvErr) {
            // Some systems (notably Debian/Ubuntu without the separate
            // python3-venv package) exit non-zero here because their patched
            // venv module can't bootstrap pip, but still lay down a usable
            // python executable. Don't give up yet — try to repair pip
            // ourselves below; only fail if there's truly no interpreter.
            log.warn(`"python -m venv" reported an error, checking whether a usable interpreter was still created: ${venvErr}`);
          }
        }
        if (!fs.existsSync(venvPython)) {
          throw new Error('The virtual environment could not be created — is the "venv" module available for this Python?');
        }

        if (!(await hasWorkingPip(venvPython))) {
          progress.report({ message: 'Bootstrapping pip…' });
          await run(venvPython, ['-m', 'ensurepip', '--upgrade']);
        }

        progress.report({ message: `Installing ${REQUIRED_PACKAGES.join(', ')}…` });
        await run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
        await run(venvPython, ['-m', 'pip', 'install', ...REQUIRED_PACKAGES]);

        if (!verifyEnvironment(venvPython)) {
          throw new Error('Packages were installed but are still not importable — see the log for pip output.');
        }

        log.info(`Managed Python environment ready at ${venvPython}`);
        return venvPython;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed to set up the managed environment: ${message}`);
        const hint =
          process.platform === 'linux'
            ? ' On Debian/Ubuntu this is usually fixed by: sudo apt install python3-venv python3-pip, then running "Rosbag: Choose Python Interpreter" again.'
            : '';
        void vscode.window
          .showWarningMessage(
            `Rosbag Analyzer couldn't set up its own Python environment automatically (${message}).${hint}`,
            'Show log',
          )
          .then((choice) => choice === 'Show log' && log.show());
        return null;
      }
    },
  );
}

/**
 * Runs on every activation until it succeeds: if the user hasn't picked an
 * interpreter of their own and no working managed environment exists yet, it
 * (re)provisions one and points the extension at it. Never overrides an
 * explicit user choice. A failed attempt is retried on the next activation
 * instead of being permanently given up on — the previous version marked
 * itself "attempted" before knowing whether provisioning had succeeded,
 * which left a user with a half-built (e.g. pip-less) venv stuck forever.
 */
export async function autoSetupIfNeeded(
  context: vscode.ExtensionContext,
  bridge: BagBridge,
  log: vscode.LogOutputChannel,
  onReady: () => void,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('rosbagAnalyzer');
  if (cfg.get<string>('pythonPath', '').trim()) {
    return; // user already has an explicit preference — never override it
  }

  const provisioned = await provisionManagedVenv(context, log);
  if (provisioned) {
    await cfg.update('pythonPath', provisioned, vscode.ConfigurationTarget.Global);
    await bridge.restart();
    onReady();
  }
}

interface InterpreterChoice extends vscode.QuickPickItem {
  path?: string;
  browse?: boolean;
  provision?: boolean;
}

/**
 * Lets the user pick which Python interpreter the bag reader should use,
 * without leaving the panel to hand-edit a settings string.
 */
export async function chooseInterpreter(
  context: vscode.ExtensionContext,
  bridge: BagBridge,
  log: vscode.LogOutputChannel,
  onChanged: () => void,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('rosbagAnalyzer');
  const current = expandHome(cfg.get<string>('pythonPath', '').trim());
  const items: InterpreterChoice[] = [];

  const venvPython = managedVenvPython(context);
  const venvReady = fs.existsSync(venvPython) && verifyEnvironment(venvPython);
  items.push(
    venvReady
      ? {
          label: '$(rocket) Rosbag Analyzer\'s managed environment',
          description: venvPython,
          detail: current === venvPython ? 'Currently selected' : undefined,
          // Always re-verify/repair on selection rather than trusting this
          // snapshot — always route through provisionManagedVenv().
          provision: true,
        }
      : {
          label: '$(rocket) Set up / repair the managed environment (recommended)',
          description: fs.existsSync(venvPython)
            ? 'Exists but is missing packages — will repair it automatically'
            : 'Creates a private venv and installs rosbags, pandas, numpy, evo automatically',
          provision: true,
        },
  );

  try {
    const pythonExt = vscode.extensions.getExtension('ms-python.python');
    if (pythonExt) {
      if (!pythonExt.isActive) {
        await pythonExt.activate();
      }
      const api: any = pythonExt.exports;
      const active = api?.environments?.getActiveEnvironmentPath?.();
      const resolved = active ? await api.environments.resolveEnvironment(active) : undefined;
      const execPath: string | undefined = resolved?.executable?.uri?.fsPath ?? active?.path;
      if (execPath) {
        items.push({
          label: '$(symbol-namespace) Python extension\'s active interpreter',
          description: execPath,
          detail: current === execPath ? 'Currently selected' : undefined,
          path: execPath,
        });
      }
    }
  } catch (err) {
    log.warn(`Could not read the Python extension's interpreter: ${String(err)}`);
  }

  for (const candidate of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      items.push({
        label: `$(terminal) ${candidate} (on PATH)`,
        detail: current === candidate ? 'Currently selected' : undefined,
        path: candidate,
      });
    } catch {
      continue;
    }
  }

  items.push({ label: '$(folder-opened) Browse for a Python executable…', browse: true });

  const chosen = await vscode.window.showQuickPick(items, {
    title: 'Choose the Python interpreter for Rosbag Analyzer',
    placeHolder: current ? `Currently: ${current}` : 'No interpreter configured yet',
  });
  if (!chosen) {
    return;
  }

  let target: string | undefined;
  if (chosen.provision) {
    target = (await provisionManagedVenv(context, log)) ?? undefined;
  } else if (chosen.browse) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: 'Use this interpreter',
      title: 'Choose a Python executable',
    });
    target = picked?.[0]?.fsPath;
  } else {
    target = chosen.path;
  }

  if (!target) {
    return;
  }
  await cfg.update('pythonPath', target, vscode.ConfigurationTarget.Global);
  await bridge.restart();
  onChanged();
  void vscode.window.showInformationMessage(`Rosbag Analyzer will use ${target}.`);
}
