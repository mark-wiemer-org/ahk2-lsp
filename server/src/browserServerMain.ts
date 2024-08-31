/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
	createConnection, BrowserMessageReader, BrowserMessageWriter, DidChangeConfigurationNotification,
	InitializeResult, TextDocuments, TextDocumentSyncKind
} from 'vscode-languageserver/browser';
import {
	chinese_punctuations, colorPresentation, colorProvider, commands, completionProvider,
	defintionProvider, documentFormatting, enumNames, executeCommandProvider, exportSymbols,
	hoverProvider, initahk2cache, Lexer, lexers, loadahk2, loadlocalize, prepareRename, rangeFormatting,
	referenceProvider, renameProvider, SemanticTokenModifiers, semanticTokensOnFull, semanticTokensOnRange,
	SemanticTokenTypes, set_ahk_h, set_Connection, set_dirname, set_locale, set_version, set_WorkspaceFolders,
	signatureProvider, symbolProvider, typeFormatting, updateSettings, workspaceSymbolProvider
} from './common';
import { AhkppConfig } from './config';

const languageServer = 'ahk2-language-server';
const messageReader = new BrowserMessageReader(self);
const messageWriter = new BrowserMessageWriter(self);
const documents = new TextDocuments(TextDocument);
const workspaceFolders = new Set<string>();
const connection = set_Connection(createConnection(messageReader, messageWriter));

let hasConfigurationCapability = false, hasWorkspaceFolderCapability = false;
let uri_switch_to_ahk2 = '';

connection.onInitialize(params => {
	const capabilities = params.capabilities;
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);

	const result: InitializeResult = {
		serverInfo: {
			name: languageServer,
		},
		capabilities: {
			textDocumentSync: {
				change: TextDocumentSyncKind.Incremental,
				openClose: true
			},
			completionProvider: {
				resolveProvider: false,
				triggerCharacters: ['.', '#', '*', '@']
			},
			signatureHelpProvider: {
				triggerCharacters: ['(', ',', ' ']
			},
			documentSymbolProvider: true,
			definitionProvider: true,
			documentFormattingProvider: true,
			documentRangeFormattingProvider: true,
			documentOnTypeFormattingProvider: { firstTriggerCharacter: '}', moreTriggerCharacter: ['\n', ...Object.keys(chinese_punctuations)] },
			executeCommandProvider: { commands: Object.keys(commands) },
			hoverProvider: true,
			foldingRangeProvider: true,
			colorProvider: true,
			renameProvider: { prepareProvider: true },
			referencesProvider: { workDoneProgress: true },
			semanticTokensProvider: {
				legend: {
					tokenTypes: enumNames(SemanticTokenTypes),
					tokenModifiers: enumNames(SemanticTokenModifiers)
				},
				full: true,
				range: true
			},
			workspaceSymbolProvider: true
		}
	};
	if (hasWorkspaceFolderCapability) {
		params.workspaceFolders?.forEach(it => workspaceFolders.add(it.uri.toLowerCase() + '/'));
		result.capabilities.workspace = { workspaceFolders: { supported: true } };
	}

	const configs: AhkppConfig = params.initializationOptions;
	set_ahk_h(true);
	set_locale(params.locale);
	set_dirname(configs.extensionUri!);
	loadlocalize();
	updateSettings(configs);
	set_WorkspaceFolders(workspaceFolders);
	set_version('3.0.0');
	initahk2cache();
	loadahk2();
	loadahk2('ahk2_h');
	loadahk2('winapi', 4);
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(event => {
			event.removed.forEach(it => workspaceFolders.delete(it.uri.toLowerCase() + '/'));
			event.added.forEach(it => workspaceFolders.add(it.uri.toLowerCase() + '/'));
			set_WorkspaceFolders(workspaceFolders);
		});
	}
});

connection.onDidChangeConfiguration(async change => {
	let newset: AhkppConfig | undefined = change?.settings;
	if (hasConfigurationCapability && !newset)
		newset = await connection.workspace.getConfiguration('ahk++');
	if (!newset) {
		connection.window.showWarningMessage('Failed to obtain the configuration');
		return;
	}
	updateSettings(newset);
	set_WorkspaceFolders(workspaceFolders);
});

documents.onDidOpen(e => {
	const to_ahk2 = uri_switch_to_ahk2 === e.document.uri;
	const uri = e.document.uri.toLowerCase();
	let doc = lexers[uri];
	if (doc) doc.document = e.document;
	else lexers[uri] = doc = new Lexer(e.document);
	doc.actived = true;
	if (to_ahk2)
		doc.actionWhenV1Detected = 'Continue';
});

documents.onDidClose(e => lexers[e.document.uri.toLowerCase()]?.close());
documents.onDidChangeContent(e => lexers[e.document.uri.toLowerCase()].update());

connection.onCompletion(completionProvider);
connection.onColorPresentation(colorPresentation);
connection.onDocumentColor(colorProvider);
connection.onDefinition(defintionProvider);
connection.onDocumentFormatting(documentFormatting);
connection.onDocumentRangeFormatting(rangeFormatting);
connection.onDocumentOnTypeFormatting(typeFormatting);
connection.onDocumentSymbol(symbolProvider);
connection.onFoldingRanges(params => lexers[params.textDocument.uri.toLowerCase()].foldingranges);
connection.onHover(hoverProvider);
connection.onPrepareRename(prepareRename);
connection.onReferences(referenceProvider);
connection.onRenameRequest(renameProvider);
connection.onSignatureHelp(signatureProvider);
connection.onExecuteCommand(executeCommandProvider);
connection.onWorkspaceSymbol(workspaceSymbolProvider);
connection.languages.semanticTokens.on(semanticTokensOnFull);
connection.languages.semanticTokens.onRange(semanticTokensOnRange);
connection.onRequest('ahk2.exportSymbols', exportSymbols);
connection.onRequest('ahk2.getContent', (uri: string) => lexers[uri.toLowerCase()]?.document.getText());
connection.onRequest('ahk2.getVersionInfo', (uri: string) => {
	const doc = lexers[uri.toLowerCase()];
	if (doc) {
		const tk = doc.get_token(0);
		if ((tk.type === 'TK_BLOCK_COMMENT' || tk.type === '') && tk.content.match(/^\s*[;*]?\s*@(date|version)\b/im)) {
			return {
				uri: uri,
				content: tk.content,
				range: {
					start: doc.document.positionAt(tk.offset),
					end: doc.document.positionAt(tk.offset + tk.length)
				}
			};
		}
	}
	return null;
});
connection.onNotification('onDidCloseTextDocument',
	(params: { uri: string, id: string }) => {
		if (params.id === 'ahk2')
			lexers[params.uri.toLowerCase()]?.close(true);
		else uri_switch_to_ahk2 = params.uri;
	});
documents.listen(connection);
connection.listen();
