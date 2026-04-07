import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Output channel ────────────────────────────────────────────────────────────

let out: vscode.OutputChannel;

function log(msg: string): void {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
    out.appendLine(`[${ts}] ${msg}`);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type IdeAction = 'workspace_active' | 'file_open' | 'file_switch' | 'edit' | 'save';

interface IdeEventPayload {
    type: 'ide';
    action: IdeAction;
    timestamp: string;
    metadata: Record<string, string>;
}

// ── Status bar ────────────────────────────────────────────────────────────────

let statusBar: vscode.StatusBarItem;

type SendResult = 'ok' | 'token_rejected' | 'error' | 'disabled' | 'no_token';

function updateStatusBar(result: SendResult, detail?: string): void {
    switch (result) {
        case 'ok':
            statusBar.text    = '$(check) FocusTrack';
            statusBar.tooltip = `Connected — last event accepted\n${detail ?? ''}`;
            statusBar.color   = undefined;
            break;
        case 'token_rejected':
            statusBar.text    = '$(warning) FocusTrack: token rejected';
            statusBar.tooltip = 'The app rejected the token.\nCheck focustrack.token in VS Code settings matches the token in the FocusTrack app.';
            statusBar.color   = new vscode.ThemeColor('statusBarItem.warningForeground');
            break;
        case 'error':
            statusBar.text    = '$(error) FocusTrack: not connected';
            statusBar.tooltip = `Could not reach FocusTrack app.\n${detail ?? 'Is the app running with the receiver enabled?'}`;
            statusBar.color   = new vscode.ThemeColor('statusBarItem.errorForeground');
            break;
        case 'disabled':
            statusBar.text    = '$(circle-slash) FocusTrack: disabled';
            statusBar.tooltip = 'Extension is disabled (focustrack.enabled = false).';
            statusBar.color   = undefined;
            break;
        case 'no_token':
            statusBar.text    = '$(warning) FocusTrack: no token';
            statusBar.tooltip = 'focustrack.token is empty. Copy the token from the FocusTrack app.';
            statusBar.color   = new vscode.ThemeColor('statusBarItem.warningForeground');
            break;
    }
}

// ── Edit burst tracking ───────────────────────────────────────────────────────

let pendingEditCount = 0;
let pendingEditDoc: vscode.TextDocument | null = null;
let editFlushTimer: ReturnType<typeof setTimeout> | undefined;
const EDIT_DEBOUNCE_MS = 2000;

// ── Workspace identity ────────────────────────────────────────────────────────

function workspaceId(uri: string): string {
    return crypto.createHash('sha256').update(uri).digest('hex').slice(0, 16);
}

function workspaceName(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? path.basename(folder.uri.fsPath) : 'unknown';
}

function workspaceHashedId(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? workspaceId(folder.uri.toString()) : '';
}

// ── Config helpers ────────────────────────────────────────────────────────────

function getConfig() {
    const cfg   = vscode.workspace.getConfiguration('focustrack');
    const enabled = cfg.get<boolean>('enabled', true);
    const port    = cfg.get<number>('receiverPort', 54321);
    const token   = cfg.get<string>('token', '');
    return { enabled, port, token };
}

function logConfig(): void {
    const { enabled, port, token } = getConfig();
    log(`Config — enabled=${enabled}, port=${port}, token=${token ? `set (${token.length} chars)` : 'NOT SET (empty)'}`);
    if (!token) {
        log('WARNING: focustrack.token is empty. If the FocusTrack app requires a token, all requests will be rejected.');
    }
}

// ── Event sending ─────────────────────────────────────────────────────────────

function sendPayload(payload: IdeEventPayload): void {
    const { enabled, port, token } = getConfig();

    if (!enabled) {
        updateStatusBar('disabled');
        return;
    }

    const url  = `http://127.0.0.1:${port}/ide/events`;
    const body = JSON.stringify(payload);

    const headers: Record<string, string | number> = {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
    };

    if (token) {
        headers['X-FocusTrack-Token'] = token;
    }

    log(`→ POST ${url}  action=${payload.action}  token=${token ? 'present' : 'absent'}`);

    const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port,
        path:     '/ide/events',
        method:   'POST',
        headers,
    };

    const req = http.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
            if (res.statusCode === 202) {
                log(`✓ Accepted (202) — ${payload.action}`);
                updateStatusBar('ok', `action=${payload.action}`);
            } else if (res.statusCode === 401) {
                log(`✗ Token rejected (401) — the token in VS Code settings does not match the FocusTrack app token.`);
                log(`  Tip: open FocusTrack app → Settings → VS Code Integration → copy the token → paste into focustrack.token in VS Code.`);
                updateStatusBar('token_rejected');
            } else if (res.statusCode === 404) {
                log(`✗ 404 Not Found — receiver path wrong or app version mismatch. URL: ${url}`);
                updateStatusBar('error', `404 at ${url}`);
            } else if (res.statusCode === 422) {
                log(`✗ 422 Unprocessable — event was rejected by the app normalizer (type=${payload.type} action=${payload.action})`);
                updateStatusBar('error', `422 Unprocessable`);
            } else {
                log(`✗ Unexpected status ${res.statusCode} — body: ${responseBody.slice(0, 200)}`);
                updateStatusBar('error', `HTTP ${res.statusCode}`);
            }
        });
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED') {
            log(`✗ Connection refused on port ${port} — FocusTrack app is not running, or the receiver is not enabled.`);
            log(`  Check: FocusTrack app → Settings → VS Code Integration → Enable Local Extension Receiver (toggle On).`);
            updateStatusBar('error', `Connection refused — app not running or receiver disabled`);
        } else if (err.code === 'ECONNRESET') {
            log(`✗ Connection reset on port ${port} — the app closed the connection unexpectedly.`);
            updateStatusBar('error', `Connection reset`);
        } else {
            log(`✗ Network error: ${err.code ?? 'unknown'} — ${err.message}`);
            updateStatusBar('error', err.message);
        }
    });

    req.write(body);
    req.end();
}

function sendDocEvent(
    action: IdeAction,
    doc: vscode.TextDocument,
    extra?: Record<string, string>
): void {
    if (doc.uri.scheme !== 'file') return;

    const payload: IdeEventPayload = {
        type:      'ide',
        action,
        timestamp: new Date().toISOString(),
        metadata:  {
            workspaceName:  workspaceName(),
            workspaceId:    workspaceHashedId(),
            languageId:     doc.languageId,
            fileExtension:  path.extname(doc.fileName),
            source:         'vscode-extension',
            ...extra,
        },
    };

    sendPayload(payload);
}

function sendWorkspaceActive(): void {
    const { enabled } = getConfig();
    if (!enabled) return;

    const name = workspaceName();
    if (name === 'unknown') return;

    const payload: IdeEventPayload = {
        type:      'ide',
        action:    'workspace_active',
        timestamp: new Date().toISOString(),
        metadata:  {
            workspaceName: name,
            workspaceId:   workspaceHashedId(),
            source:        'vscode-extension',
        },
    };

    sendPayload(payload);
}

// ── Edit burst ────────────────────────────────────────────────────────────────

function onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme !== 'file') return;
    if (e.contentChanges.length === 0) return;

    pendingEditCount += e.contentChanges.length;
    pendingEditDoc    = e.document;

    if (editFlushTimer) clearTimeout(editFlushTimer);
    editFlushTimer = setTimeout(flushEditBurst, EDIT_DEBOUNCE_MS);
}

function flushEditBurst(): void {
    if (pendingEditCount === 0 || pendingEditDoc === null) return;

    sendDocEvent('edit', pendingEditDoc, {
        editCount: String(pendingEditCount),
    });

    pendingEditCount = 0;
    pendingEditDoc   = null;
    editFlushTimer   = undefined;
}

// ── Test connection command ───────────────────────────────────────────────────

function runTestConnection(): void {
    out.show(true); // bring output panel to front
    log('--- Test Connection ---');
    logConfig();

    const { enabled, port, token } = getConfig();

    if (!enabled) {
        log('Extension is disabled (focustrack.enabled = false). Enable it to send telemetry.');
        updateStatusBar('disabled');
        return;
    }

    if (!token) {
        log('WARNING: No token configured. Sending test request without a token.');
        log('If the app requires a token (Require local extension token = On), this will return 401.');
    }

    log(`Sending test workspace_active event to http://127.0.0.1:${port}/ide/events ...`);

    const name = workspaceName();
    const payload: IdeEventPayload = {
        type:      'ide',
        action:    'workspace_active',
        timestamp: new Date().toISOString(),
        metadata:  {
            workspaceName: name !== 'unknown' ? name : 'test',
            workspaceId:   workspaceHashedId() || 'test',
            source:        'vscode-extension-test',
        },
    };

    sendPayload(payload);
    log('Test request sent — check the lines above for the result.');
}

// ── Activation / deactivation ─────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    out = vscode.window.createOutputChannel('FocusTrack');
    context.subscriptions.push(out);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'focustrack.showOutput';
    statusBar.text    = '$(sync~spin) FocusTrack';
    statusBar.tooltip = 'FocusTrack — click to show log';
    statusBar.show();
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('focustrack.showOutput', () => out.show(true))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('focustrack.testConnection', runTestConnection)
    );

    log('FocusTrack extension activated.');
    logConfig();

    sendWorkspaceActive();

    if (vscode.window.activeTextEditor) {
        sendDocEvent('file_switch', vscode.window.activeTextEditor.document);
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                sendDocEvent('file_switch', editor.document);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            sendDocEvent('save', doc);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(onDocumentChanged)
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            log('Workspace folders changed — sending workspace_active.');
            sendWorkspaceActive();
        })
    );

    // Re-log config when the user changes settings so the output reflects new values.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('focustrack')) {
                log('Settings changed:');
                logConfig();
            }
        })
    );
}

export function deactivate(): void {
    if (editFlushTimer) {
        clearTimeout(editFlushTimer);
        flushEditBurst();
    }
}
