import {
    CancellationToken,
    DocumentSymbol,
    Range,
    SemanticTokens,
    SemanticTokensDelta,
    SemanticTokensDeltaParams,
    SemanticTokensParams,
    SemanticTokensRangeParams,
    SymbolKind,
} from 'vscode-languageserver';
import {
    ClassNode,
    FuncNode,
    getClassMembers,
    get_class_member,
    Lexer,
    SemanticToken,
    SemanticTokenModifiers,
    SemanticTokenTypes,
    Token,
} from './Lexer';
import { diagnostic, extsettings, lexers, Variable } from './common';
import {
    checkParams,
    globalsymbolcache,
    symbolProvider,
} from './symbolProvider';

let curclass: ClassNode | undefined;
const memscache = new Map<ClassNode, { [name: string]: DocumentSymbol }>();

function resolve_sem(tk: Token, doc: Lexer) {
    let l: string, sem: SemanticToken | undefined;
    if ((sem = tk.semantic)) {
        const pos = tk.pos ?? (tk.pos = doc.document.positionAt(tk.offset));
        let type = sem.type;
        if (type === SemanticTokenTypes.string) {
            if (tk.ignore) {
                let l = pos.line + 1;
                const data = tk.data as number[];
                for (let i = 0; i < data.length; i++) {
                    doc.STB.push(l++, 0, data[i], type, 0);
                }
            } else {
                doc.STB.push(pos.line, pos.character, tk.length, type, 0);
            }
        } else {
            if (
                (curclass &&
                    (type === SemanticTokenTypes.method ||
                        type === SemanticTokenTypes.property) &&
                    tk.previous_token?.type === 'TK_DOT') ||
                ((curclass = undefined), type === SemanticTokenTypes.class)
            ) {
                type = resolveSemanticType(tk.content.toUpperCase(), tk, doc);
            }
            doc.STB.push(
                pos.line,
                pos.character,
                tk.length,
                type,
                sem.modifier ?? 0,
            );
        }
    } else if (
        curclass &&
        tk.type !== 'TK_DOT' &&
        !tk.type.endsWith('COMMENT')
    ) {
        curclass = undefined;
    } else if (
        tk.type === 'TK_WORD' &&
        ['THIS', 'SUPER'].includes((l = tk.content.toUpperCase())) &&
        tk.previous_token?.type !== 'TK_DOT'
    ) {
        const r = doc.searchNode(
            l,
            doc.document.positionAt(tk.offset),
            SymbolKind.Variable,
        );
        if (r && r.ref === false) {
            curclass = r.node as ClassNode;
        }
    }
}

export async function semanticTokensOnFull(
    params: SemanticTokensParams,
    token: CancellationToken,
): Promise<SemanticTokens> {
    const doc = lexers[params.textDocument.uri.toLowerCase()];
    if (!doc || token.isCancellationRequested) {
        return { data: [] };
    }
    doc.STB.previousResult(''), (curclass = undefined), memscache.clear();
    symbolProvider({ textDocument: params.textDocument });
    Object.values(doc.tokens).forEach((tk) => resolve_sem(tk, doc));
    resolve_class_undefined_member(doc), memscache.clear();
    return doc.STB.build();
}

export async function semanticTokensOnRange(
    params: SemanticTokensRangeParams,
    token: CancellationToken,
): Promise<SemanticTokens> {
    const doc = lexers[params.textDocument.uri.toLowerCase()];
    if (!doc || token.isCancellationRequested) {
        return { data: [] };
    }
    const start = doc.document.offsetAt(params.range.start),
        end = doc.document.offsetAt(params.range.end);
    doc.STB.previousResult(''), (curclass = undefined), memscache.clear();
    symbolProvider({ textDocument: params.textDocument });
    for (const tk of Object.values(doc.tokens)) {
        if (tk.offset < start) {
            continue;
        }
        if (tk.offset > end) {
            break;
        }
        resolve_sem(tk, doc);
    }
    resolve_class_undefined_member(doc), memscache.clear();
    return doc.STB.build();
}

function resolveSemanticType(name: string, tk: Token, doc: Lexer) {
    const sem = tk.semantic as SemanticToken;
    switch (sem.type) {
        case SemanticTokenTypes.class:
            curclass = globalsymbolcache[name] as ClassNode;
            if (curclass?.kind !== SymbolKind.Class) {
                curclass = undefined;
            }
            return SemanticTokenTypes.class;
        case SemanticTokenTypes.method:
        case SemanticTokenTypes.property:
            if (
                curclass &&
                sem.modifier !== 1 << SemanticTokenModifiers.modification
            ) {
                let n = curclass.staticdeclaration[name];
                let kind = n?.kind;
                let temp: { [name: string]: DocumentSymbol };
                if (!n || (n as any).def === false) {
                    const t = (temp =
                        memscache.get(curclass) ??
                        (memscache.set(
                            curclass,
                            (temp = getClassMembers(doc, curclass, true)),
                        ),
                        temp))[name];
                    if (t) {
                        (n = t), (kind = t.kind);
                    } else if (sem.type === SemanticTokenTypes.method) {
                        if (temp['__CALL']) {
                            kind = SymbolKind.Null;
                        }
                    } else if (temp['__GET']) {
                        kind = SymbolKind.Null;
                    }
                }
                switch (kind) {
                    case SymbolKind.Method:
                        sem.modifier =
                            (sem.modifier || 0) |
                            (1 << SemanticTokenModifiers.readonly) |
                            (1 << SemanticTokenModifiers.static);
                        if (tk.callinfo) {
                            if (curclass) {
                                if (
                                    n.full?.startsWith('(Object) static Call(')
                                ) {
                                    n =
                                        get_class_member(
                                            doc,
                                            curclass,
                                            '__new',
                                            false,
                                            true,
                                        ) ?? n;
                                } else if (
                                    n.full?.startsWith('(Object) DefineProp(')
                                ) {
                                    let tt = doc.tokens[tk.next_token_offset];
                                    if (tt?.content === '(') {
                                        tt = doc.tokens[tt.next_token_offset];
                                    }
                                    if (tt) {
                                        if (tt.type === 'TK_STRING') {
                                            cls_add_prop(
                                                curclass,
                                                tt.content.slice(1, -1),
                                                tt.offset + 1,
                                            );
                                        } else {
                                            cls_add_prop(curclass, '');
                                        }
                                    }
                                }
                            }
                            checkParams(doc, n as FuncNode, tk.callinfo);
                        }
                        curclass = undefined;
                        return (sem.type = SemanticTokenTypes.method);
                    case SymbolKind.Class:
                        sem.modifier =
                            (sem.modifier || 0) |
                            (1 << SemanticTokenModifiers.readonly);
                        curclass = curclass.staticdeclaration[
                            name
                        ] as ClassNode;
                        if (tk.callinfo) {
                            checkParams(
                                doc,
                                curclass as unknown as FuncNode,
                                tk.callinfo,
                            );
                        }
                        return (sem.type = SemanticTokenTypes.class);
                    case SymbolKind.Property:
                        const t = n.children;
                        if (
                            t?.length === 1 &&
                            t[0].name.toLowerCase() === 'get'
                        ) {
                            sem.modifier =
                                (sem.modifier || 0) |
                                (1 << SemanticTokenModifiers.readonly) |
                                (1 << SemanticTokenModifiers.static);
                        }
                        curclass = undefined;
                        return (sem.type = SemanticTokenTypes.property);
                    case undefined:
                        if (
                            ((<any>curclass).checkmember ??
                                (<any>doc).checkmember) !== false &&
                            extsettings.Diagnostics.ClassStaticMemberCheck
                        ) {
                            const tt = doc.tokens[tk.next_token_offset];
                            if (tt?.content === ':=') {
                                cls_add_prop(curclass, tk.content, tk.offset);
                            } else if (
                                (memscache.get(curclass) as any)?.[
                                    '#checkmember'
                                ] !== false
                            ) {
                                ((curclass.undefined ??= {})[
                                    tk.content.toUpperCase()
                                ] ??= []).push(tk);
                            }
                            // doc.addDiagnostic(diagnostic.maybehavenotmember(curclass.name, tk.content), tk.offset, tk.length, 2);
                        }
                }
            }
        default:
            curclass = undefined;
            return sem.type;
    }

    function cls_add_prop(cls: ClassNode, name: string, offset?: number) {
        const d = lexers[(<any>cls).uri];
        if (d && offset) {
            const rg = Range.create(
                d.document.positionAt(offset),
                d.document.positionAt(offset + name.length),
            );
            const p = DocumentSymbol.create(
                name,
                undefined,
                SymbolKind.Property,
                rg,
                rg,
            ) as Variable;
            (p.static = p.def = true), (name = name.toUpperCase());
            if (d === doc && d.d < 2) {
                cls.children?.push(p), (cls.staticdeclaration[name] ??= p);
            } else {
                const t = memscache.get(cls);
                if (t) {
                    t[name] ??= p;
                }
            }
            if (cls.undefined) {
                delete cls.undefined[name];
            }
        } else {
            delete cls.undefined;
            if (d && d.d < 2) {
                (<any>cls).checkmember = false;
            } else {
                const t = memscache.get(cls) as any;
                if (t) {
                    t['#checkmember'] = false;
                }
            }
        }
    }
}

function resolve_class_undefined_member(doc: Lexer) {
    for (const cls of memscache.keys()) {
        if (cls.undefined) {
            const name = cls.name;
            for (const tks of Object.values(cls.undefined)) {
                for (const tk of tks) {
                    doc.addDiagnostic(
                        diagnostic.maybehavenotmember(name, tk.content),
                        tk.offset,
                        tk.length,
                        2,
                    );
                }
            }
            delete cls.undefined;
        }
    }
}
