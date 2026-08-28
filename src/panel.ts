import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BagBridge, BridgeError } from './bridge';
import { chooseInterpreter } from './interpreter';

export interface OpenRequest {
  primary?: string;
  secondary?: string;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function settings() {
  const cfg = vscode.workspace.getConfiguration('rosbagAnalyzer');
  return {
    maxPlotPoints: cfg.get<number>('maxPlotPoints', 20000),
  };
}

export class AnalyzerPanel {
  private static readonly viewType = 'rosbagAnalyzer.panel';
  private static openPanels = new Set<AnalyzerPanel>();

  private disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly webviewPanel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: BagBridge,
    private readonly log: vscode.LogOutputChannel,
    private readonly request: OpenRequest,
  ) {
    AnalyzerPanel.openPanels.add(this);

    this.webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    this.webviewPanel.webview.html = this.render();

    this.disposables.push(
      this.webviewPanel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('rosbagAnalyzer')) {
          this.post({ type: 'settings', settings: settings() });
        }
      }),
    );

    this.webviewPanel.onDidDispose(() => this.dispose());
  }

  static create(
    context: vscode.ExtensionContext,
    bridge: BagBridge,
    log: vscode.LogOutputChannel,
    request: OpenRequest,
    existing?: vscode.WebviewPanel,
  ): AnalyzerPanel {
    const title = request.primary ? path.basename(request.primary) : 'Rosbag Analyzer';
    const panel =
      existing ??
      vscode.window.createWebviewPanel(
        AnalyzerPanel.viewType,
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-tab.svg');
    return new AnalyzerPanel(panel, context, bridge, log, request);
  }

  static disposeAll(): void {
    for (const panel of [...AnalyzerPanel.openPanels]) {
      panel.webviewPanel.dispose();
    }
  }

  static notifyAll(message: unknown): void {
    for (const panel of AnalyzerPanel.openPanels) {
      panel.post(message);
    }
  }

  private post(message: unknown): void {
    void this.webviewPanel.webview.postMessage(message);
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // this.bridge.probe is only populated once the bag reader process has
        // actually started, which normally doesn't happen until the first
        // real request (e.g. opening a file) triggers it lazily. Reading it
        // here unconditionally raced that startup and showed the interpreter
        // chip as permanently "not detected" even with a working
        // environment, since nothing ever re-sent it once the bridge came up
        // through that lazy path. Force startup now so the first render
        // already reflects reality.
        try {
          await this.bridge.request('probe');
        } catch {
          // A genuinely broken interpreter surfaces here as bridge.probe
          // staying unset — the chip correctly shows "not detected", and the
          // first real request will report the concrete error.
        }
        this.post({
          type: 'init',
          probe: this.bridge.probe ?? null,
          settings: settings(),
          request: this.request,
        });
        return;

      case 'request': {
        try {
          const result = await this.bridge.request(msg.cmd, msg.args ?? {});
          this.post({ type: 'response', id: msg.id, ok: true, result });
        } catch (err) {
          const bridgeErr = err instanceof BridgeError ? err : undefined;
          this.post({
            type: 'response',
            id: msg.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            hint: bridgeErr?.hint ?? '',
          });
        }
        return;
      }

      case 'probe': {
        try {
          const probe = await this.bridge.request('probe');
          this.post({ type: 'init', probe, settings: settings(), request: this.request });
        } catch (err) {
          this.post({
            type: 'fatal',
            error: err instanceof Error ? err.message : String(err),
            hint: err instanceof BridgeError ? err.hint : '',
          });
        }
        return;
      }

      case 'pickFile': {
        try {
          // showOpenDialog with BOTH canSelectFiles and canSelectFolders set
          // is unreliable on Linux: GTK's native chooser can settle into
          // folder-selection mode, leaving every file in the list visible but
          // greyed out and unclickable. Ask which kind first, then open a
          // single-mode dialog — that's the combination every platform
          // actually supports.
          const kind = await vscode.window.showQuickPick(
            [
              { label: '$(file) Bag, CSV, TSV, or TUM file', sourceKind: 'file' as const },
              { label: '$(folder) ROS 2 bag folder (holding metadata.yaml)', sourceKind: 'folder' as const },
            ],
            { title: 'What are you adding?' },
          );
          if (!kind) {
            return;
          }
          const picked = await vscode.window.showOpenDialog(
            kind.sourceKind === 'folder'
              ? {
                  canSelectMany: false,
                  canSelectFolders: true,
                  canSelectFiles: false,
                  openLabel: 'Use this folder',
                  title: 'Choose a ROS 2 bag folder',
                }
              : {
                  canSelectMany: false,
                  canSelectFolders: false,
                  canSelectFiles: true,
                  openLabel: 'Use this source',
                  title: 'Choose a bag, CSV, TSV, or TUM trajectory',
                  filters: { 'Bags and tables': ['bag', 'db3', 'mcap', 'csv', 'tsv', 'tum'] },
                },
          );
          if (picked?.[0]) {
            this.post({ type: 'sourcePicked', role: msg.role, path: picked[0].fsPath });
          }
        } catch (err) {
          this.post({
            type: 'fatal',
            error: `Could not open the file picker: ${err instanceof Error ? err.message : String(err)}`,
            hint: '',
          });
        }
        return;
      }

      case 'chooseInterpreter':
        await chooseInterpreter(this.context, this.bridge, this.log, () =>
          AnalyzerPanel.notifyAll({ type: 'reload', probe: this.bridge.probe ?? null }),
        );
        return;

      case 'saveText': {
        const target = await vscode.window.showSaveDialog({
          saveLabel: 'Save',
          defaultUri: vscode.Uri.file(path.join(this.defaultSaveDir(), msg.filename)),
        });
        if (!target) {
          return;
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(msg.content, 'utf-8'));
        const open = await vscode.window.showInformationMessage(
          `Saved ${path.basename(target.fsPath)}`,
          'Open',
        );
        if (open === 'Open') {
          await vscode.window.showTextDocument(target);
        }
        return;
      }

      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        this.post({ type: 'toast', text: msg.label ?? 'Copied' });
        return;

      case 'exportTopic':
      case 'exportTum': {
        const isTum = msg.type === 'exportTum';
        const target = await vscode.window.showSaveDialog({
          saveLabel: isTum ? 'Export TUM' : 'Export CSV',
          filters: isTum ? { 'TUM trajectory': ['tum'] } : { 'CSV': ['csv'] },
          defaultUri: vscode.Uri.file(path.join(this.defaultSaveDir(), msg.filename)),
        });
        if (!target) {
          return;
        }
        try {
          const result =
            msg.type === 'exportTopic'
              ? await this.bridge.request('export', { source: msg.source, target: target.fsPath })
              : await this.bridge.request('export_tum', { source: msg.source, target: target.fsPath });
          const choice = await vscode.window.showInformationMessage(
            `Exported ${Number(result.rows).toLocaleString()} rows to ${path.basename(target.fsPath)}`,
            'Reveal in Explorer',
          );
          if (choice === 'Reveal in Explorer') {
            await vscode.commands.executeCommand('revealFileInOS', target);
          }
        } catch (err) {
          const bridgeErr = err instanceof BridgeError ? err : undefined;
          void vscode.window.showErrorMessage(
            `Export failed: ${err instanceof Error ? err.message : String(err)}` +
              (bridgeErr?.hint ? ` — ${bridgeErr.hint}` : ''),
          );
        }
        return;
      }

      case 'exportEvaluation': {
        const folder = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Choose a parent folder',
          defaultUri: vscode.Uri.file(this.defaultSaveDir()),
        });
        if (!folder?.[0]) {
          return;
        }
        const target = vscode.Uri.joinPath(folder[0], msg.dirName ?? 'SLAM Evaluation');
        try {
          const result = await this.bridge.request('export_evaluation', { ...msg.args, target: target.fsPath });
          const choice = await vscode.window.showInformationMessage(
            `Evaluation package written to ${path.basename(result.path)} (N=${result.n})`,
            'Reveal in Explorer',
          );
          if (choice === 'Reveal in Explorer') {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.path));
          }
        } catch (err) {
          const bridgeErr = err instanceof BridgeError ? err : undefined;
          void vscode.window.showErrorMessage(
            `Export failed: ${err instanceof Error ? err.message : String(err)}` +
              (bridgeErr?.hint ? ` — ${bridgeErr.hint}` : ''),
          );
        }
        return;
      }

      case 'openLog':
        this.log.show();
        return;

      case 'openSettings':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          msg.key ?? 'rosbagAnalyzer',
        );
        return;

      case 'runInTerminal': {
        const terminal =
          vscode.window.terminals.find((t) => t.name === 'Rosbag Analyzer') ??
          vscode.window.createTerminal('Rosbag Analyzer');
        terminal.show();
        terminal.sendText(msg.command);
        return;
      }

      case 'log':
        this.log.debug(`[webview] ${msg.text}`);
        return;

      default:
        this.log.warn(`Unhandled message from the webview: ${msg.type}`);
    }
  }

  private defaultSaveDir(): string {
    if (this.request.primary) {
      const stat = fs.existsSync(this.request.primary) && fs.statSync(this.request.primary);
      const base = stat && stat.isDirectory() ? this.request.primary : path.dirname(this.request.primary);
      return base;
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private render(): string {
    const webview = this.webviewPanel.webview;
    const media = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...parts));

    const n = nonce();
    const plotlyPath = path.join(this.context.extensionPath, 'media', 'vendor', 'plotly.min.js');
    const plotlyReady = fs.existsSync(plotlyPath);
    if (!plotlyReady) {
      this.log.error(
        'media/vendor/plotly.min.js is missing. Run "npm run vendor" in the extension folder.',
      );
    }

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${n}' ${webview.cspSource} 'unsafe-eval'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('main.css')}">
<title>Rosbag Analyzer</title>
</head>
<body data-plotly="${plotlyReady}">
<div id="app"><div class="boot">Starting the bag reader…</div></div>
${plotlyReady ? `<script nonce="${n}" src="${media('vendor', 'plotly.min.js')}"></script>` : ''}
<script nonce="${n}" src="${media('main.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    AnalyzerPanel.openPanels.delete(this);
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

/**
 * Makes double-clicking a .bag in the explorer open the analyzer rather than
 * the binary editor.
 */
export class AnalyzerEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: BagBridge,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const enabled = vscode.workspace
      .getConfiguration('rosbagAnalyzer')
      .get<boolean>('openBagsInAnalyzer', true);

    if (!enabled) {
      webviewPanel.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:2rem">
        <p>Opening bags in the analyzer is turned off.</p>
        <p>Turn on <code>rosbagAnalyzer.openBagsInAnalyzer</code>, or run <b>Rosbag: Open Analyzer</b>.</p>
      </body></html>`;
      return;
    }

    AnalyzerPanel.create(
      this.context,
      this.bridge,
      this.log,
      { primary: document.uri.fsPath },
      webviewPanel,
    );
  }
}
