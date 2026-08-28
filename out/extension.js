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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const bridge_1 = require("./bridge");
const panel_1 = require("./panel");
const interpreter_1 = require("./interpreter");
const BAG_EXTENSIONS = new Set(['.bag', '.db3', '.mcap']);
const TABLE_EXTENSIONS = new Set(['.csv', '.tsv', '.tum']);
let bridge;
let log;
function activate(context) {
    log = vscode.window.createOutputChannel('Rosbag Analyzer', { log: true });
    const scriptPath = path.join(context.extensionPath, 'python', 'rosbag_bridge.py');
    bridge = new bridge_1.BagBridge(scriptPath, log);
    context.subscriptions.push(log, bridge);
    // First run only, and only when the user hasn't picked an interpreter of
    // their own: quietly set up a private virtual environment with everything
    // the extension needs, so nobody has to run pip themselves.
    void (0, interpreter_1.autoSetupIfNeeded)(context, bridge, log, () => panel_1.AnalyzerPanel.notifyAll({ type: 'reload', probe: bridge.probe ?? null }));
    context.subscriptions.push(vscode.window.registerCustomEditorProvider('rosbagAnalyzer.editor', new panel_1.AnalyzerEditorProvider(context, bridge, log), { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push(vscode.commands.registerCommand('rosbagAnalyzer.open', async () => {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFolders: true,
            canSelectFiles: true,
            openLabel: 'Open in analyzer',
            title: 'Choose a bag, ROS 2 bag folder, or CSV/TUM trajectory',
            filters: { 'Bags and tables': ['bag', 'db3', 'mcap', 'csv', 'tsv', 'tum'] },
        });
        if (picked?.[0]) {
            panel_1.AnalyzerPanel.create(context, bridge, log, { primary: picked[0].fsPath });
        }
    }), vscode.commands.registerCommand('rosbagAnalyzer.openFile', async (uri, selection) => {
        const targets = pickTargets(uri, selection);
        if (!targets.length) {
            void vscode.window.showWarningMessage('Select a bag or CSV file first.');
            return;
        }
        panel_1.AnalyzerPanel.create(context, bridge, log, {
            primary: targets[0].fsPath,
            secondary: targets[1]?.fsPath,
        });
    }), vscode.commands.registerCommand('rosbagAnalyzer.showTopics', async (uri, selection) => {
        const targets = pickTargets(uri, selection);
        const target = targets[0];
        if (!target) {
            void vscode.window.showWarningMessage('Select a bag file first.');
            return;
        }
        await showTopicQuickPick(context, target.fsPath);
    }), vscode.commands.registerCommand('rosbagAnalyzer.checkEnvironment', () => checkEnvironment(context)), vscode.commands.registerCommand('rosbagAnalyzer.chooseInterpreter', () => (0, interpreter_1.chooseInterpreter)(context, bridge, log, () => panel_1.AnalyzerPanel.notifyAll({ type: 'reload', probe: bridge.probe ?? null }))), vscode.commands.registerCommand('rosbagAnalyzer.restartBridge', async () => {
        try {
            await bridge.restart();
            panel_1.AnalyzerPanel.notifyAll({ type: 'reload', probe: bridge.probe ?? null });
            void vscode.window.showInformationMessage('Bag reader restarted.');
        }
        catch (err) {
            showError(err);
        }
    }), vscode.commands.registerCommand('rosbagAnalyzer.showLog', () => log.show()));
    log.info('Rosbag Analyzer activated');
}
function deactivate() {
    panel_1.AnalyzerPanel.disposeAll();
    bridge?.dispose();
}
function pickTargets(uri, selection) {
    const candidates = selection?.length ? selection : uri ? [uri] : [];
    const usable = candidates.filter((candidate) => {
        const ext = path.extname(candidate.fsPath).toLowerCase();
        return BAG_EXTENSIONS.has(ext) || TABLE_EXTENSIONS.has(ext) || ext === '';
    });
    if (usable.length) {
        return usable;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    return active ? [active] : [];
}
/**
 * A quick way to answer "what's in this bag?" without opening a panel — the
 * question people usually run `rosbag info` for.
 */
async function showTopicQuickPick(context, bagPath) {
    const info = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reading ${path.basename(bagPath)}…` }, async () => {
        try {
            return await bridge.request('inspect', { path: bagPath });
        }
        catch (err) {
            showError(err);
            return undefined;
        }
    });
    if (!info) {
        return;
    }
    if (info.kind === 'csv') {
        const numeric = info.columns.filter((c) => c.numeric).length;
        void vscode.window.showInformationMessage(`${info.name}: ${info.rows.toLocaleString()} rows, ${info.columns.length} columns (${numeric} numeric).`);
        return;
    }
    const items = info.topics.map((t) => ({
        label: t.topic,
        description: `${t.messages.toLocaleString()} msgs${t.hz ? ` · ${t.hz} Hz` : ''}`,
        detail: t.type,
        topic: t.topic,
    }));
    items.unshift({
        label: '$(graph) Open in analyzer',
        description: `${info.topics.length} topics · ${info.totalMessages.toLocaleString()} messages · ${info.duration}s`,
        openAnalyzer: true,
    });
    const chosen = await vscode.window.showQuickPick(items, {
        title: `${info.name} — ${formatBytes(info.sizeBytes)}`,
        placeHolder: 'Pick a topic to copy its name, or open the analyzer',
        matchOnDetail: true,
    });
    if (!chosen) {
        return;
    }
    if (chosen.openAnalyzer) {
        panel_1.AnalyzerPanel.create(context, bridge, log, { primary: bagPath });
        return;
    }
    if (chosen.topic) {
        await vscode.env.clipboard.writeText(chosen.topic);
        void vscode.window.showInformationMessage(`Copied ${chosen.topic}`);
    }
}
async function checkEnvironment(context) {
    try {
        const probe = await bridge.request('probe');
        const v = probe.versions;
        const lines = [
            `Interpreter: ${v.executable}`,
            `Python:      ${v.python}`,
            `rosbags:     ${probe.rosbags ? v.rosbags : `missing — ${probe.rosbagsError}`}`,
            `numpy:       ${v.numpy ?? 'missing'}`,
            `pandas:      ${v.pandas ?? 'missing'}`,
        ];
        log.info(lines.join('\n'));
        if (probe.rosbags && probe.pandas) {
            void vscode.window.showInformationMessage(`Ready — Python ${v.python}, rosbags ${v.rosbags}.`, 'Show log').then((choice) => choice === 'Show log' && log.show());
            return;
        }
        const missing = [
            !probe.rosbags && 'rosbags',
            !v.pandas && 'pandas',
            !v.numpy && 'numpy',
        ].filter(Boolean);
        const choice = await vscode.window.showWarningMessage(`Missing in ${v.executable}: ${missing.join(', ')}.`, 'Install now', 'Choose interpreter', 'Show log');
        if (choice === 'Install now') {
            const terminal = vscode.window.createTerminal('Rosbag Analyzer');
            terminal.show();
            terminal.sendText(`"${v.executable}" -m pip install ${missing.join(' ')}`);
        }
        else if (choice === 'Choose interpreter') {
            await (0, interpreter_1.chooseInterpreter)(context, bridge, log, () => panel_1.AnalyzerPanel.notifyAll({ type: 'reload', probe: bridge.probe ?? null }));
        }
        else if (choice === 'Show log') {
            log.show();
        }
    }
    catch (err) {
        showError(err);
    }
}
function showError(err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = err instanceof bridge_1.BridgeError ? err.hint : '';
    void vscode.window
        .showErrorMessage(hint ? `${message} ${hint}` : message, 'Show log')
        .then((choice) => choice === 'Show log' && log.show());
}
function formatBytes(bytes) {
    if (!bytes) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
//# sourceMappingURL=extension.js.map