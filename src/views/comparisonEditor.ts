import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ComparisonMode, ComparisonSnapshot, loadComparison, loadComparisonFile, splitComparisonLines } from '../services/comparison';
import { GitService } from '../services/gitService';
import { runGit } from '../services/gitRunner';
import { formatGitError, repositoryKey } from '../services/gitUtils';
import { openEditorDiff } from '../commands/helpers';
import { getLocale, t, webviewStrings } from '../i18n';
import { ComparisonEditorMessage, ComparisonEditorResponse } from './messages';

export interface ComparisonEditorTarget {
    /** Fixed repository root; graph navigation must never retarget this tab. */
    repository: string;
    source: string;
    target: string;
    mode: ComparisonMode;
}

/**
 * Independent comparison editor: one tab per repository/ref pair. The graph may
 * keep navigating while this tab owns its snapshot, selection and scroll state.
 * The webview sends only paths and request IDs; Git refs always come from here.
 */
export class ComparisonEditor {
    private static readonly _tabs = new Map<string, ComparisonEditor>();

    static show(git: GitService, extensionUri: vscode.Uri, target: ComparisonEditorTarget): void {
        const key = JSON.stringify([repositoryKey(target.repository), target.source, target.target]);
        const existing = this._tabs.get(key);
        if (existing) {
            // A tab may have swapped direction since it was registered. A new
            // invocation must honor the requested endpoints rather than silently
            // reopening that reversed comparison under the original key.
            if (existing._target.source !== target.source || existing._target.target !== target.target || existing._target.mode !== target.mode) {
                existing._target = target;
                existing._panel.title = existing._title();
                if (existing._ready) {void existing._load();}
            }
            existing._panel.reveal();
            return;
        }
        this._tabs.set(key, new ComparisonEditor(git, extensionUri, target, key));
    }

    private readonly _panel: vscode.WebviewPanel;
    private _snapshot: ComparisonSnapshot | undefined;
    private _generation = 0;
    private _fileRequest = 0;
    private _disposed = false;
    private _ready = false;

    private constructor(
        private readonly _git: GitService,
        extensionUri: vscode.Uri,
        private _target: ComparisonEditorTarget,
        private readonly _key: string
    ) {
        this._panel = vscode.window.createWebviewPanel('idea-git.comparison', this._title(), vscode.ViewColumn.Active, {
            enableScripts: true, retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
        });
        this._panel.webview.html = this._html(extensionUri);
        this._panel.webview.onDidReceiveMessage((message: ComparisonEditorMessage) => void this._onMessage(message));
        this._panel.onDidDispose(() => {
            this._disposed = true;
            this._generation++;
            ComparisonEditor._tabs.delete(this._key);
        });
    }

    private _title(): string {
        const short = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, '');
        return `${short(this._target.source)} → ${short(this._target.target)}`;
    }

    private _post(message: ComparisonEditorResponse): void {
        if (this._ready && !this._disposed) {void this._panel.webview.postMessage(message);}
    }

    private async _onMessage(message: ComparisonEditorMessage): Promise<void> {
        if (this._disposed) {return;}
        switch (message.command) {
            case 'ready':
                this._ready = true;
                await this._load();
                return;
            case 'changeMode':
                if (message.mode !== 'pr' && message.mode !== 'direct') {return;}
                this._target = { ...this._target, mode: message.mode };
                await this._load();
                return;
            case 'swap':
                this._target = { ...this._target, source: this._target.target, target: this._target.source };
                await this._load();
                return;
            case 'refresh':
                await this._load();
                return;
            case 'selectFile':
                await this._file(message.path, message.generation, message.requestId);
                return;
            case 'openNativeDiff': {
                const snapshot = this._snapshot;
                const file = snapshot?.files.find(item => item.path === message.path);
                if (!snapshot || !file || message.generation !== this._generation) {return;}
                try {
                    await openEditorDiff(this._git, snapshot.baseHash, snapshot.sourceHash, file.path,
                        `${file.path} (${snapshot.baseHash.slice(0, 8)} ↔ ${snapshot.sourceHash.slice(0, 8)})`,
                        file.fromPath, this._target.repository);
                } catch (error) {
                    vscode.window.showErrorMessage(t('view.openDiffFailed', { error: formatGitError(error) }));
                }
                return;
            }
        }
    }

    /** Refresh freezes a new pair of tips and invalidates every old file request. */
    private async _load(): Promise<void> {
        const generation = ++this._generation;
        const target = this._target;
        this._snapshot = undefined;
        this._fileRequest++;
        this._panel.title = this._title();
        this._post({ command: 'comparison', generation, source: target.source, target: target.target, mode: target.mode });
        try {
            const snapshot = await loadComparison(args => runGit(args, { cwd: target.repository }), target.source, target.target, target.mode);
            if (this._disposed || generation !== this._generation) {return;}
            this._snapshot = snapshot;
            this._post({ command: 'comparison', generation, source: target.source, target: target.target, mode: target.mode, snapshot });
        } catch (error) {
            if (this._disposed || generation !== this._generation) {return;}
            this._post({ command: 'comparison', generation, source: target.source, target: target.target, mode: target.mode,
                error: formatGitError(error) });
        }
    }

    /** The file must belong to this tab's current snapshot; stale replies are discarded. */
    private async _file(filePath: string, generation: number, requestId: number): Promise<void> {
        const snapshot = this._snapshot;
        if (!snapshot || generation !== this._generation || !snapshot.files.some(file => file.path === filePath)) {return;}
        const ticket = ++this._fileRequest;
        const repository = this._target.repository;
        try {
            const preview = await loadComparisonFile(args => runGit(args, { cwd: repository }), snapshot, filePath);
            if (this._disposed || generation !== this._generation || ticket !== this._fileRequest) {return;}
            this._post({ command: 'file', generation, requestId, path: filePath,
                rows: splitComparisonLines(preview.lines), binary: preview.binary, truncated: preview.truncated });
        } catch (error) {
            if (this._disposed || generation !== this._generation || ticket !== this._fileRequest) {return;}
            this._post({ command: 'file', generation, requestId, path: filePath, error: formatGitError(error) });
        }
    }

    private _html(extensionUri: vscode.Uri): string {
        const webview = this._panel.webview;
        const nonce = crypto.randomBytes(16).toString('hex');
        const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'comparisonEditor.css'));
        const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'comparisonEditor.js'));
        const strings = JSON.stringify(webviewStrings()).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="${getLocale()}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<header><div id="refs"></div><div class="actions">
<button id="pr" type="button">${t('comparison.pr')}</button><button id="direct" type="button">${t('comparison.direct')}</button>
<button id="swap" type="button" data-title="${t('comparison.swap')}" aria-label="${t('comparison.swap')}">⇄</button><button id="refresh" type="button" data-title="${t('comparison.refresh')}" aria-label="${t('comparison.refresh')}">↻</button>
</div></header>
<div id="summary" role="status" aria-live="polite"></div>
<main><aside><input id="filter" type="search" placeholder="${t('comparison.filterFiles')}" aria-label="${t('comparison.filterFiles')}"><div id="files" role="tree"></div></aside>
<div id="divider" role="separator" aria-label="${t('comparison.resizeFiles')}" tabindex="0"></div>
<section id="diff"><div class="file-toolbar"><span id="filename"></span><button id="previous" type="button" data-title="${t('comparison.previousFile')}" aria-label="${t('comparison.previousFile')}">↑</button><button id="next" type="button" data-title="${t('comparison.nextFile')}" aria-label="${t('comparison.nextFile')}">↓</button><button id="native" type="button">${t('comparison.fullDiff')}</button></div>
<div class="sides"><span id="left-title"></span><span id="right-title"></span></div>
<div id="patch" tabindex="0"></div></section></main><div id="tooltip" role="tooltip"></div>
<script nonce="${nonce}">window.I18N_STRINGS=${strings};</script><script nonce="${nonce}" src="${js}"></script>
</body></html>`;
    }
}
