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

type IdeAction =
    | 'workspace_active' | 'file_open' | 'file_switch' | 'edit' | 'save'
    | 'debug_start' | 'debug_end' | 'task_run' | 'terminal_open'
    | 'file_rename' | 'file_delete';

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

// ── Reconnection state ────────────────────────────────────────────────────────
//
// When a network error (ECONNREFUSED, ECONNRESET, etc.) occurs the extension
// marks itself as disconnected and schedules a reconnect probe.  Probes use
// exponential backoff — 5 s, 10 s, 20 s, 40 s, capped at 60 s — so we never
// spam the log with rapid retries.  Once a probe is accepted (202) or the app
// replies with a recognisable HTTP status (even 401) we cancel the timer and
// return to normal operation.

let isConnected        = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs   = 5_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

function scheduleReconnect(): void {
    if (reconnectTimer) { return; }  // probe already queued
    log(`  Reconnect probe scheduled in ${reconnectDelayMs / 1000}s.`);
    reconnectTimer   = setTimeout(attemptReconnect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}

function cancelReconnect(): void {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }
    reconnectDelayMs = RECONNECT_MIN_MS;
}

function onConnectionRestored(action: string): void {
    if (!isConnected) {
        isConnected = true;
        cancelReconnect();
        log(`✓ Connection to FocusTrack app restored (action=${action}).`);
    }
}

function onConnectionLost(): void {
    if (isConnected) {
        isConnected = false;
        log('Connection to FocusTrack app lost — will probe for reconnect.');
    }
    scheduleReconnect();
}

function attemptReconnect(): void {
    reconnectTimer = undefined;  // clear slot so scheduleReconnect can queue the next one
    const { enabled, port } = getConfig();
    if (!enabled) { return; }
    log(`Reconnect probe → http://127.0.0.1:${port}/ide/events ...`);
    sendProbe();
}

// ── Edit burst tracking ───────────────────────────────────────────────────────
//
// We track three accumulators per burst window:
//   pendingEditCount  — number of discrete contentChange operations (VS Code atoms)
//   pendingLinesAdded — lines inserted: count of '\n' chars in the inserted text
//   pendingLinesDeleted — lines removed: range.end.line - range.start.line per change
// No actual text content is stored or transmitted.

let pendingEditCount    = 0;
let pendingLinesAdded   = 0;
let pendingLinesDeleted = 0;
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

// Returns 'true' / 'false' indicating whether doc lives inside any workspace folder.
function isFileInWorkspace(doc: vscode.TextDocument): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return 'false'; }
    const filePath = doc.uri.fsPath;
    return folders.some(f => filePath.startsWith(f.uri.fsPath)) ? 'true' : 'false';
}

// ── Config helpers ────────────────────────────────────────────────────────────

function getConfig() {
    const cfg     = vscode.workspace.getConfiguration('focustrack');
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
                onConnectionRestored(payload.action);
            } else if (res.statusCode === 401) {
                log(`✗ Token rejected (401) — the token in VS Code settings does not match the FocusTrack app token.`);
                log(`  Tip: open FocusTrack app → Settings → VS Code Integration → copy the token → paste into focustrack.token in VS Code.`);
                updateStatusBar('token_rejected');
                // 401 means the app IS reachable — auth is wrong but connection is fine.
                isConnected = true;
                cancelReconnect();
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
            onConnectionLost();
        } else if (err.code === 'ECONNRESET') {
            log(`✗ Connection reset on port ${port} — the app closed the connection unexpectedly.`);
            updateStatusBar('error', `Connection reset`);
            onConnectionLost();
        } else {
            log(`✗ Network error: ${err.code ?? 'unknown'} — ${err.message}`);
            updateStatusBar('error', err.message);
            onConnectionLost();
        }
    });

    req.write(body);
    req.end();
}

// sendDocEvent enriches the payload with per-file metadata.
function sendDocEvent(
    action: IdeAction,
    doc: vscode.TextDocument,
    extra?: Record<string, string>
): void {
    if (doc.uri.scheme !== 'file') { return; }

    const payload: IdeEventPayload = {
        type:      'ide',
        action,
        timestamp: new Date().toISOString(),
        metadata:  {
            workspaceName:  workspaceName(),
            workspaceId:    workspaceHashedId(),
            languageId:     doc.languageId,
            fileExtension:  path.extname(doc.fileName),
            fileName:       path.basename(doc.fileName),   // name only — no directory path
            isInWorkspace:  isFileInWorkspace(doc),
            source:         'vscode-extension',
            ...extra,
        },
    };

    sendPayload(payload);
}

// sendWorkspaceActive sends a workspace-level heartbeat, enriched with the
// currently active editor context when one is open.
function sendWorkspaceActive(): void {
    const { enabled } = getConfig();
    if (!enabled) { return; }

    const name = workspaceName();
    if (name === 'unknown') { return; }

    // Attach active editor context when available.
    const editor = vscode.window.activeTextEditor;
    const activeFileMeta: Record<string, string> = {};
    if (editor && editor.document.uri.scheme === 'file') {
        activeFileMeta.languageId    = editor.document.languageId;
        activeFileMeta.fileExtension = path.extname(editor.document.fileName);
        activeFileMeta.fileName      = path.basename(editor.document.fileName);
    }

    const payload: IdeEventPayload = {
        type:      'ide',
        action:    'workspace_active',
        timestamp: new Date().toISOString(),
        metadata:  {
            workspaceName:        name,
            workspaceId:          workspaceHashedId(),
            workspaceFolderCount: String(vscode.workspace.workspaceFolders?.length ?? 1),
            source:               'vscode-extension',
            ...activeFileMeta,
        },
    };

    sendPayload(payload);
}

// sendProbe is used exclusively by the reconnection timer.  It sends a minimal
// workspace_active event that is valid even when there is no open workspace,
// so reconnection probes always reach the receiver.
function sendProbe(): void {
    const { enabled } = getConfig();
    if (!enabled) { cancelReconnect(); return; }

    const payload: IdeEventPayload = {
        type:      'ide',
        action:    'workspace_active',
        timestamp: new Date().toISOString(),
        metadata:  {
            workspaceName:        workspaceName() !== 'unknown' ? workspaceName() : '',
            workspaceId:          workspaceHashedId(),
            workspaceFolderCount: String(vscode.workspace.workspaceFolders?.length ?? 0),
            source:               'vscode-extension',
        },
    };

    sendPayload(payload);
}

// ── Edit burst ────────────────────────────────────────────────────────────────

function onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme !== 'file') { return; }
    if (e.contentChanges.length === 0) { return; }

    // If the active document changed mid-burst, flush the previous burst first
    // so edits to different files are reported separately.
    if (pendingEditDoc && pendingEditDoc.uri.toString() !== e.document.uri.toString()) {
        if (editFlushTimer) { clearTimeout(editFlushTimer); editFlushTimer = undefined; }
        flushEditBurst();
    }

    for (const change of e.contentChanges) {
        pendingEditCount    += 1;
        // Lines added = number of newlines in the inserted text (content never stored)
        pendingLinesAdded   += (change.text.match(/\n/g) ?? []).length;
        // Lines deleted = lines spanned by the replaced range
        pendingLinesDeleted += change.range.end.line - change.range.start.line;
    }
    pendingEditDoc = e.document;

    if (editFlushTimer) { clearTimeout(editFlushTimer); }
    editFlushTimer = setTimeout(flushEditBurst, EDIT_DEBOUNCE_MS);
}

function flushEditBurst(): void {
    if (pendingEditCount === 0 || pendingEditDoc === null) { return; }

    sendDocEvent('edit', pendingEditDoc, {
        editCount:    String(pendingEditCount),
        linesAdded:   String(pendingLinesAdded),
        linesDeleted: String(pendingLinesDeleted),
    });

    pendingEditCount    = 0;
    pendingLinesAdded   = 0;
    pendingLinesDeleted = 0;
    pendingEditDoc      = null;
    editFlushTimer      = undefined;
}

// sendWorkspaceEvent sends a workspace-scoped event (no document required).
// Used for debug, task, terminal, file-system operations.
function sendWorkspaceEvent(action: IdeAction, extra?: Record<string, string>): void {
    const { enabled } = getConfig();
    if (!enabled) { return; }

    const payload: IdeEventPayload = {
        type:      'ide',
        action,
        timestamp: new Date().toISOString(),
        metadata:  {
            workspaceName: workspaceName(),
            workspaceId:   workspaceHashedId(),
            source:        'vscode-extension',
            ...extra,
        },
    };

    sendPayload(payload);
}

// ── Test connection command ───────────────────────────────────────────────────

function runTestConnection(): void {
    out.show(true);
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
            workspaceName:        name !== 'unknown' ? name : 'test',
            workspaceId:          workspaceHashedId() || 'test',
            workspaceFolderCount: String(vscode.workspace.workspaceFolders?.length ?? 0),
            source:               'vscode-extension-test',
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

    // Active editor changed — user switched tabs.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                sendDocEvent('file_switch', editor.document);
            }
        })
    );

    // Document opened — only emit for files inside the workspace to avoid
    // noise from language-server background loads and extension internals.
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (isFileInWorkspace(doc) === 'true') {
                sendDocEvent('file_open', doc);
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

    // ── Debug sessions ────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession((session) => {
            sendWorkspaceEvent('debug_start', {
                debugType: session.type,
                debugName: path.basename(session.name),
            });
        })
    );
    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession((session) => {
            sendWorkspaceEvent('debug_end', {
                debugType: session.type,
            });
        })
    );

    // ── Task runs ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.tasks.onDidStartTask((e) => {
            sendWorkspaceEvent('task_run', {
                taskType: e.execution.task.definition.type,
                taskName: e.execution.task.name,
            });
        })
    );

    // ── Integrated terminal opens ─────────────────────────────────────────────
    context.subscriptions.push(
        vscode.window.onDidOpenTerminal((terminal) => {
            sendWorkspaceEvent('terminal_open', {
                terminalName: terminal.name,
            });
        })
    );

    // ── File renames ──────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidRenameFiles((e) => {
            for (const { oldUri, newUri } of e.files) {
                sendWorkspaceEvent('file_rename', {
                    fileName:    path.basename(newUri.fsPath),
                    oldFileName: path.basename(oldUri.fsPath),
                });
            }
        })
    );

    // ── File deletes ──────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidDeleteFiles((e) => {
            for (const uri of e.files) {
                sendWorkspaceEvent('file_delete', {
                    fileName:      path.basename(uri.fsPath),
                    fileExtension: path.extname(uri.fsPath),
                });
            }
        })
    );
}

export function deactivate(): void {
    cancelReconnect();
    if (editFlushTimer) {
        clearTimeout(editFlushTimer);
        flushEditBurst();
    }
}
