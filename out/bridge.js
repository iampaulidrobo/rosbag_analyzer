"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BagBridge = exports.BridgeError = void 0;
exports.expandHome = expandHome;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/**
 * `spawn()` runs the executable directly, not through a shell, so a leading
 * `~` (a very natural thing to type into a path setting) is never expanded
 * the way it would be in a terminal — it's passed through literally and the
 * spawn fails with ENOENT. Expand it ourselves before ever using the path.
 */
function expandHome(p) {
    if (p === '~') {
        return os.homedir();
    }
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}
class BridgeError extends Error {
    constructor(message, hint = '') {
        super(message);
        this.hint = hint;
        this.name = 'BridgeError';
    }
}
exports.BridgeError = BridgeError;
const REQUEST_TIMEOUT_MS = 180000;
/**
 * Owns one long-lived Python process and multiplexes requests onto it.
 *
 * The process is kept alive between requests so the sidecar's parse cache
 * survives tab switches; re-decoding a large topic on every interaction is the
 * main thing that makes bag tooling feel slow.
 */
class BagBridge {
    constructor(scriptPath, log) {
        this.scriptPath = scriptPath;
        this.log = log;
        this.buffer = '';
        this.nextId = 1;
        this.pending = new Map();
        this.disposed = false;
    }
    get probe() {
        return this.probeResult;
    }
    /** Interpreter from settings, then the Python extension's choice, then the path. */
    async resolveInterpreter() {
        const configured = vscode.workspace
            .getConfiguration('rosbagAnalyzer')
            .get('pythonPath', '')
            .trim();
        if (configured) {
            return expandHome(configured);
        }
        try {
            const pythonExt = vscode.extensions.getExtension('ms-python.python');
            if (pythonExt) {
                if (!pythonExt.isActive) {
                    await pythonExt.activate();
                }
                const api = pythonExt.exports;
                const active = api?.environments?.getActiveEnvironmentPath?.();
                const resolved = active ? await api.environments.resolveEnvironment(active) : undefined;
                const execPath = resolved?.executable?.uri?.fsPath ?? active?.path;
                if (execPath) {
                    this.log.info(`Using interpreter from the Python extension: ${execPath}`);
                    return execPath;
                }
            }
        }
        catch (err) {
            this.log.warn(`Could not read the Python extension's interpreter: ${String(err)}`);
        }
        return process.platform === 'win32' ? 'python' : 'python3';
    }
    async start() {
        const interpreter = await this.resolveInterpreter();
        this.log.info(`Starting bag reader: ${interpreter} ${this.scriptPath}`);
        const proc = (0, child_process_1.spawn)(interpreter, ['-u', this.scriptPath], {
            cwd: path.dirname(this.scriptPath),
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        });
        proc.stdout.setEncoding('utf-8');
        proc.stderr.setEncoding('utf-8');
        proc.stdout.on('data', (chunk) => this.onStdout(chunk));
        proc.stderr.on('data', (chunk) => {
            chunk
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .forEach((line) => this.log.debug(line));
        });
        proc.on('error', (err) => {
            const message = err.code === 'ENOENT'
                ? `Could not run "${interpreter}". Set rosbagAnalyzer.pythonPath to a working interpreter.`
                : `Bag reader failed to start: ${err.message}`;
            this.failAll(new BridgeError(message, 'Run "Rosbag: Check Python Environment" for details.'));
            this.proc = undefined;
            this.starting = undefined;
        });
        proc.on('exit', (code, signal) => {
            if (!this.disposed) {
                this.log.warn(`Bag reader exited (code=${code}, signal=${signal})`);
            }
            this.failAll(new BridgeError('The bag reader stopped unexpectedly.', 'Run "Rosbag: Restart Bag Reader", or check the log for the Python traceback.'));
            this.proc = undefined;
            this.starting = undefined;
            this.probeResult = undefined;
        });
        this.proc = proc;
        this.probeResult = await this.send('probe', {});
        if (!this.probeResult.rosbags) {
            this.log.warn(`rosbags is unavailable: ${this.probeResult.rosbagsError}`);
        }
        this.log.info(`Bag reader ready — python ${this.probeResult.versions.python}, ` +
            `rosbags ${this.probeResult.versions.rosbags ?? 'missing'}, ` +
            `pandas ${this.probeResult.versions.pandas ?? 'missing'}`);
    }
    async ensure() {
        if (this.disposed) {
            throw new BridgeError('The analyzer has been closed.');
        }
        if (this.proc) {
            return;
        }
        if (!this.starting) {
            this.starting = this.start().catch((err) => {
                this.starting = undefined;
                throw err;
            });
        }
        return this.starting;
    }
    onStdout(chunk) {
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line) {
                continue;
            }
            try {
                this.dispatch(JSON.parse(line));
            }
            catch (err) {
                this.log.error(`Unparseable line from the bag reader: ${line.slice(0, 400)}`);
            }
        }
    }
    dispatch(message) {
        const entry = this.pending.get(message.id);
        if (!entry) {
            this.log.warn(`Response for an unknown request id: ${message.id}`);
            return;
        }
        this.pending.delete(message.id);
        if (message.ok) {
            entry.resolve(message.result);
        }
        else {
            entry.reject(new BridgeError(message.error ?? 'Unknown error', message.hint ?? ''));
        }
    }
    failAll(err) {
        for (const [, entry] of this.pending) {
            entry.reject(err);
        }
        this.pending.clear();
    }
    send(cmd, args) {
        const proc = this.proc;
        if (!proc) {
            return Promise.reject(new BridgeError('The bag reader is not running.'));
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) {
                    reject(new BridgeError(`"${cmd}" took longer than ${REQUEST_TIMEOUT_MS / 1000}s and was abandoned.`, 'Very large bags can exceed this. Try a single topic, or raise rosbagAnalyzer.maxPlotPoints.'));
                }
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, {
                cmd,
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (reason) => {
                    clearTimeout(timer);
                    reject(reason);
                },
            });
            proc.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`, (err) => {
                if (err) {
                    this.pending.delete(id);
                    clearTimeout(timer);
                    reject(new BridgeError(`Could not reach the bag reader: ${err.message}`));
                }
            });
        });
    }
    /** Public entry point: starts the process on first use. */
    async request(cmd, args = {}) {
        await this.ensure();
        const started = Date.now();
        try {
            const result = await this.send(cmd, args);
            this.log.debug(`${cmd} finished in ${Date.now() - started}ms`);
            return result;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // BridgeError's `hint` usually carries the actually-useful detail (e.g.
            // evo's own stderr) — the UI shows it, but logging only `message` left
            // this channel with a bare "evo_ape failed." and no way to diagnose
            // from the log alone.
            const hint = err instanceof BridgeError && err.hint ? ` | ${err.hint}` : '';
            this.log.error(`${cmd} failed: ${message}${hint}`);
            throw err;
        }
    }
    async restart() {
        this.log.info('Restarting the bag reader');
        this.kill();
        await this.ensure();
    }
    kill() {
        this.failAll(new BridgeError('The bag reader was restarted.'));
        this.proc?.stdin.end();
        this.proc?.kill();
        this.proc = undefined;
        this.starting = undefined;
        this.probeResult = undefined;
    }
    dispose() {
        this.disposed = true;
        this.kill();
    }
}
exports.BagBridge = BagBridge;
//# sourceMappingURL=bridge.js.map