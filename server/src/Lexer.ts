import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { argv0 } from 'process';
import {
    Position,
    Range,
    SymbolKind,
    DocumentSymbol,
    Diagnostic,
    DiagnosticSeverity,
    FoldingRange,
    ColorInformation,
    SemanticTokensBuilder,
} from 'vscode-languageserver';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import {
    builtin_ahkv1_commands,
    builtin_variable,
    builtin_variable_h,
} from './constants';
import { completionitem, diagnostic } from './localize';
import {
    action,
    ActionType,
    ahkuris,
    ahkvars,
    connection,
    extsettings,
    hoverCache,
    inBrowser,
    inWorkspaceFolders,
    isahk2_h,
    lexers,
    libdirs,
    libfuncs,
    openAndParse,
    openFile,
    pathenv,
    restorePath,
    rootdir,
    sendDiagnostics,
    setTextDocumentLanguage,
    symbolProvider,
    utils,
} from './common';

export interface ParamInfo {
    offset: number;
    count: number;
    comma: number[];
    miss: number[];
    unknown: boolean;
    method?: boolean;
    data?: string[];
    name?: string;
}

export interface CallInfo extends DocumentSymbol {
    offset?: number;
    paraminfo?: ParamInfo;
}

export interface AhkDoc {
    include: string[];
    children: DocumentSymbol[];
    funccall: CallInfo[];
}

export enum FuncScope {
    DEFAULT = 0,
    STATIC = 1,
    GLOBAL = 2,
}

export enum SemanticTokenTypes {
    class,
    function,
    method,
    parameter,
    variable,
    property,
    keyword,
    string,
    number,
    operator,
}

export enum SemanticTokenModifiers {
    definition,
    readonly,
    static,
    deprecated,
    modification,
    documentation,
    defaultLibrary,
}

export interface FuncNode extends DocumentSymbol {
    assume: FuncScope;
    closure?: boolean;
    static?: boolean;
    params: Variable[];
    global: { [key: string]: Variable };
    local: { [key: string]: Variable };
    full: string;
    hasref: boolean;
    variadic: boolean;
    parent?: DocumentSymbol;
    funccall?: CallInfo[];
    labels: { [key: string]: DocumentSymbol[] };
    declaration: { [name: string]: FuncNode | ClassNode | Variable };
    returntypes?: { [exp: string]: any };
    overwrite?: number;
    has_this_param?: boolean;
    unresolved_vars?: { [name: string]: Variable };
    resolved?: boolean;
    uri?: string;
}

export interface ClassNode extends DocumentSymbol {
    full: string;
    extends: string;
    extendsuri?: string;
    parent?: DocumentSymbol;
    funccall: CallInfo[];
    declaration: { [name: string]: FuncNode | Variable };
    staticdeclaration: { [name: string]: FuncNode | ClassNode | Variable };
    cache: Variable[];
    returntypes?: { [exp: string]: any };
    overwrite?: number;
    undefined?: { [name: string]: Token[] };
    uri?: string;
    checkmember?: boolean;
    static?: boolean; // not use
}

export interface Variable extends DocumentSymbol {
    ref?: boolean;
    static?: boolean | null;
    def?: boolean;
    arr?: boolean;
    defaultVal?: string | false | null;
    full?: string;
    returntypes?: { [exp: string]: any } | null;
    range_offset?: [number, number];
    uri?: string;
    assigned?: boolean;
}

export interface SemanticToken {
    type: SemanticTokenTypes;
    modifier?: number;
}

export interface Token {
    type: string;
    content: string;
    offset: number;
    length: number;
    topofline: number;
    next_token_offset: number; // Next non-comment token offset
    previous_token?: Token; // Previous non-comment token
    previous_pair_pos?: number;
    next_pair_pos?: number;
    prefix_is_whitespace?: string;
    ignore?: boolean;
    fat_arrow_end?: boolean;
    semantic?: SemanticToken;
    pos?: Position;
    callinfo?: CallInfo;
    paraminfo?: ParamInfo;
    data?: any;
    symbol?: DocumentSymbol;
    definition?: DocumentSymbol;
    skip_pos?: number;
    previous_extra_tokens?: {
        i: number;
        len: number;
        parser_pos: number;
        tokens: Token[];
        suffix_is_whitespace: boolean;
    };
}

export interface FormatOptions {
    brace_style?: number;
    break_chained_methods?: boolean;
    ignore_comment?: boolean;
    indent_string?: string;
    indent_between_hotif_directive?: boolean;
    keep_array_indentation?: boolean;
    keyword_start_with_uppercase?: boolean;
    max_preserve_newlines?: number;
    preserve_newlines?: boolean;
    space_before_conditional?: boolean;
    space_after_double_colon?: boolean;
    space_in_empty_paren?: boolean;
    space_in_other?: boolean;
    space_in_paren?: boolean;
    symbol_with_same_case?: boolean;
    white_space_before_inline_comment?: string;
    wrap_line_length?: number;
}

export namespace SymbolNode {
    export function create(
        name: string,
        kind: SymbolKind,
        range: Range,
        selectionRange: Range,
        children?: DocumentSymbol[],
    ): DocumentSymbol {
        return { name, kind, range, selectionRange, children };
    }
}

export namespace FuncNode {
    export function create(
        name: string,
        kind: SymbolKind,
        range: Range,
        selectionRange: Range,
        params: Variable[],
        children?: DocumentSymbol[],
        isstatic?: boolean,
    ): FuncNode {
        let full = '';
        const hasref = params.some((param) => param.ref);
        const variadic = params.some((param) => param.arr);
        (<any>params).format?.(params);
        for (const param of params) {
            full += ', ';
            full += param.ref ? '&' : '';
            full += param.name;
            full += param.defaultVal ? ' := ' + param.defaultVal : '';
            full += param.defaultVal === null ? '?' : param.arr ? '*' : '';
        }
        full =
            (isstatic ? 'static ' : '') + name + '(' + full.substring(2) + ')';
        return {
            assume: FuncScope.DEFAULT,
            static: isstatic,
            hasref,
            name,
            kind,
            range,
            selectionRange,
            params,
            full,
            variadic,
            children,
            funccall: [],
            declaration: {},
            global: {},
            local: {},
            labels: {},
        };
    }
}

namespace Variable {
    export function create(
        name: string,
        kind: SymbolKind,
        range: Range,
    ): Variable {
        return { name, kind, range, selectionRange: range };
    }
}

export function isIdentifierChar(code: number) {
    if (code < 48) {
        return false;
    }
    if (code < 58) {
        return true;
    }
    if (code < 65) {
        return false;
    }
    if (code < 91) {
        return true;
    }
    if (code < 97) {
        return code === 95;
    }
    if (code < 123) {
        return true;
    }
    return code > 127;
}
export const allIdentifierChar = new RegExp(
    '^[^\x00-\x2f\x3a-\x40\x5b\x5c\x5d\x5e\x60\x7b-\x7f]+$',
);
let commentTags = new RegExp('^;;\\s*(?<tag>.+)');

const colorregexp = new RegExp(
    /['"\s](c|background|#)?((0x)?[\da-f]{6}([\da-f]{2})?|(black|silver|gray|white|maroon|red|purple|fuchsia|green|lime|olive|yellow|navy|blue|teal|aqua))\b/i,
);
const colortable = JSON.parse(
    '{ "black": "000000", "silver": "c0c0c0", "gray": "808080", "white": "ffffff", "maroon": "800000", "red": "ff0000", "purple": "800080", "fuchsia": "ff00ff", "green": "008000", "lime": "00ff00", "olive": "808000", "yellow": "ffff00", "navy": "000080", "blue": "0000ff", "teal": "008080", "aqua": "00ffff" }',
);
const whitespace = ' \t\r\n',
    punct =
        '+ - * / % & ++ -- ** // = += -= *= /= //= .= == := != !== ~= > < >= <= >>> >> << >>>= >>= <<= && &= | || ! ~ , ?? : ? ^ ^= |= =>'.split(
            ' ',
        );
const line_starters =
    'try,throw,return,global,local,static,if,switch,case,for,while,loop,continue,break,goto'.split(
        ',',
    );
const reserved_words = line_starters.concat([
    'class',
    'in',
    'is',
    'isset',
    'contains',
    'else',
    'until',
    'catch',
    'finally',
    'and',
    'or',
    'not',
    'as',
    'super',
]);
const MODE = {
    BlockStatement: 'BlockStatement',
    Statement: 'Statement',
    ObjectLiteral: 'ObjectLiteral',
    ArrayLiteral: 'ArrayLiteral',
    Conditional: 'Conditional',
    Expression: 'Expression',
};
const KEYS_RE =
    /^(alttab|alttabandmenu|alttabmenu|alttabmenudismiss|shiftalttab|shift|lshift|rshift|alt|lalt|ralt|control|lcontrol|rcontrol|ctrl|lctrl|rctrl|lwin|rwin|appskey|lbutton|rbutton|mbutton|wheeldown|wheelup|wheelleft|wheelright|xbutton1|xbutton2|(0*[2-9]|0*1[0-6]?)?joy0*([1-9]|[12]\d|3[12])|space|tab|enter|escape|esc|backspace|bs|delete|del|insert|ins|pgdn|pgup|home|end|up|down|left|right|printscreen|ctrlbreak|pause|scrolllock|capslock|numlock|numpad0|numpad1|numpad2|numpad3|numpad4|numpad5|numpad6|numpad7|numpad8|numpad9|numpadmult|numpadadd|numpadsub|numpaddiv|numpaddot|numpaddel|numpadins|numpadclear|numpadleft|numpadright|numpaddown|numpadup|numpadhome|numpadend|numpadpgdn|numpadpgup|numpadenter|f1|f2|f3|f4|f5|f6|f7|f8|f9|f10|f11|f12|f13|f14|f15|f16|f17|f18|f19|f20|f21|f22|f23|f24|browser_back|browser_forward|browser_refresh|browser_stop|browser_search|browser_favorites|browser_home|volume_mute|volume_down|volume_up|media_next|media_prev|media_stop|media_play_pause|launch_mail|launch_media|launch_app1|launch_app2|vk[a-f\d]{1,2}(sc[a-f\d]+)?|sc[a-f\d]+|`[;{]|[\x21-\x3A\x3C-\x7E])$/i;
const EMPTY_TOKEN: Token = {
    type: '',
    content: '',
    offset: 0,
    length: 0,
    topofline: 0,
    next_token_offset: -1,
};

let searchcache: { [name: string]: any } = {};
let hasdetectcache: { [exp: string]: any } = {};

class ParseStopError {
    public message: string;
    public token: Token;
    constructor(message: string, token: Token) {
        this.message = message;
        this.token = token;
    }
}

export class Lexer {
    public actived = false;
    public beautify: (options?: FormatOptions, range?: Range) => string;
    public children: DocumentSymbol[] = [];
    public d = 0;
    public declaration: { [name: string]: FuncNode | ClassNode | Variable } =
        {};
    public diagnostics: Diagnostic[] = [];
    public diags = 0;
    public document: TextDocument;
    public foldingranges: FoldingRange[] = [];
    public funccall: CallInfo[] = [];
    public get_token: (offset?: number, ignorecomment?: boolean) => Token;
    public find_token: (offset: number, ignore?: boolean) => Token;
    public include: { [uri: string]: string } = {};
    public includedir: Map<number, string> = new Map();
    public dlldir: Map<number, string> = new Map();
    public dllpaths: string[] = [];
    public labels: { [key: string]: DocumentSymbol[] } = {};
    public libdirs: string[] = [];
    public object: {
        method: { [key: string]: FuncNode[] };
        property: { [key: string]: Variable[] };
    } = { method: {}, property: {} };
    public parseScript: () => void;
    public reflat = false;
    public isparsed = false;
    public relevance: { [uri: string]: string } | undefined;
    public scriptdir = '';
    public scriptpath = '';
    public tokens: { [offset: number]: Token } = {};
    public STB: SemanticTokensBuilder = new SemanticTokensBuilder();
    public linepos: { [line: number]: number } = {};
    public tokenranges: {
        start: number;
        end: number;
        type: number;
        previous?: number;
    }[] = [];
    public texts: { [key: string]: string } = {};
    public uri = '';
    public fsPath = '';
    public d_uri = '';
    public maybev1?: number;
    public actionwhenv1?: ActionType;
    private anonymous: DocumentSymbol[] = [];
    constructor(document: TextDocument, scriptdir?: string, d = 0) {
        let input: string;
        let output_lines: { text: string[]; indent: number }[];
        let flags: any;
        let opt: FormatOptions;
        let previous_flags: any;
        let flag_store: any[], includetable: { [uri: string]: string };
        let token_text: string;
        let token_text_low: string;
        let token_type: string;
        let last_type: string;
        let last_text: string;
        let last_last_text: string;
        let indent_string: string, includedir: string, dlldir: string;
        let parser_pos: number;
        let customblocks: { region: number[]; bracket: number[] };
        const _this = this;
        let h = isahk2_h;
        const sharp_offsets: number[] = [];
        let input_wanted_newline: boolean;
        let output_space_before_token: boolean | undefined;
        let is_conditional: boolean;
        let keep_object_line: boolean, begin_line: boolean;
        let continuation_sections_mode: boolean;
        let space_in_other: boolean;
        let requirev2 = false;
        let currsymbol: DocumentSymbol | undefined;
        let input_length: number;
        let n_newlines: number;
        let last_LF: number, preindent_string: string, lst: Token, ck: Token;
        let comments: { [line: number]: Token } = {};
        let block_mode = true;
        let format_mode = false;
        let string_mode = false;
        const uri = URI.parse(document.uri);
        let allow_$ = true;
        let last_comment_fr: FoldingRange | undefined;
        const handlers: { [index: string]: () => void } = {
            TK_START_EXPR: handle_start_expr,
            TK_END_EXPR: handle_end_expr,
            TK_START_BLOCK: handle_start_block,
            TK_END_BLOCK: handle_end_block,
            TK_WORD: handle_word,
            TK_RESERVED: handle_word,
            TK_STRING: handle_string,
            TK_EQUALS: handle_equals,
            TK_OPERATOR: handle_operator,
            TK_COMMA: handle_comma,
            TK_BLOCK_COMMENT: handle_block_comment,
            TK_INLINE_COMMENT: handle_inline_comment,
            TK_COMMENT: handle_comment,
            TK_DOT: handle_dot,
            TK_HOT: handle_sharp,
            TK_SHARP: handle_sharp,
            TK_NUMBER: handle_number,
            TK_LABEL: handle_label,
            TK_HOTLINE: handle_sharp,
            TK_UNKNOWN: handle_unknown,
        };

        this.document = document;
        if (document.uri) {
            allow_$ = false;
            this.uri = document.uri.toLowerCase();
            this.scriptpath = (this.fsPath = uri.fsPath).replace(
                /\\[^\\]+$/,
                '',
            );
            this.initlibdirs(scriptdir);
        }

        this.get_token = function (
            offset?: number,
            ignorecomment = false,
        ): Token {
            const p = parser_pos;
            let t: Token, b: Token;
            if (offset !== undefined) {
                parser_pos = offset;
                b = lst;
                do {
                    t = get_next_token();
                } while (ignorecomment && t.type.endsWith('COMMENT'));
                parser_pos = p;
                lst = b;
            } else {
                do {
                    t = get_next_token();
                } while (ignorecomment && t.type.endsWith('COMMENT'));
            }
            return t;
        };

        this.find_token = function (offset: number, ignore = false): Token {
            let i = offset;
            let c = input.charAt(offset);
            const tks = _this.tokens;
            let tk: Token | undefined;
            const eof = Object.assign({}, tks[-1], { type: '', content: '' });
            if (!c) {
                return eof;
            }
            if (whitespace.includes(c)) {
                while (whitespace.includes((c = input.charAt(++i)) || '\0')) {
                    continue;
                }
                if ((tk = tks[i])) {
                    return tk;
                }
                if (
                    !c &&
                    (tk =
                        tks[
                            _this.tokenranges[_this.tokenranges.length - 1]
                                ?.start
                        ])
                ) {
                    if (tk.offset <= offset && offset < tk.offset + tk.length) {
                        return tk;
                    } else {
                        tk = undefined;
                    }
                }
            } else {
                if (isIdentifierChar(c.charCodeAt(0))) {
                    while (isIdentifierChar(input.charCodeAt(--i))) {
                        continue;
                    }
                } else {
                    while (!whitespace.includes((c = input.charAt(--i)))) {
                        if (isIdentifierChar(c.charCodeAt(0))) {
                            break;
                        }
                    }
                }
                if (!(tk = tks[++i] ?? tks[i - 1]) && input.charAt(i) === '.') {
                    while (isIdentifierChar(input.charCodeAt(--i))) {
                        continue;
                    }
                    tk = tks[i + 1];
                }
            }
            if (
                !tk &&
                input.slice((i = input.lastIndexOf('\n', i) + 1), offset).trim()
            ) {
                tk = _this.find_token(i);
            }
            if (tk) {
                if (tk.offset <= offset && offset < tk.offset + tk.length) {
                    return tk;
                }
                while ((tk = tks[tk.next_token_offset])) {
                    if (tk.offset > offset) {
                        break;
                    }
                    if (offset < tk.offset + tk.length) {
                        return tk;
                    }
                }
            }
            return (!ignore && _this.find_str_cmm(offset)) || eof;
        };

        this.beautify = function (options?: FormatOptions, range?: Range) {
            let end_pos: number;
            if (!_this.isparsed) {
                _this.parseScript();
            }

            opt = Object.assign(
                {
                    break_chained_methods: false,
                    ignore_comment: false,
                    indent_string: '\t',
                    keep_array_indentation: true,
                    max_preserve_newlines: 3,
                    preserve_newlines: true,
                    space_before_conditional: true,
                    space_after_double_colon: true,
                    space_in_empty_paren: false,
                    space_in_other: true,
                    space_in_paren: false,
                    wrap_line_length: 0,
                } as FormatOptions,
                options,
            );

            last_type = last_last_text = last_text = '';
            begin_line = true;
            lst = EMPTY_TOKEN;
            last_LF = -1;
            end_pos = input_length;
            ck = _this.get_token(0);
            preindent_string = input.substring(
                input.lastIndexOf('\n', (parser_pos = ck.offset)) + 1,
                parser_pos,
            );
            is_conditional = output_space_before_token = false;
            format_mode = true;
            indent_string = opt.indent_string ?? '\t';
            space_in_other = opt.space_in_other ?? true;
            output_lines = [create_output_line()];
            flag_store = [];
            flags = null;
            set_mode(MODE.BlockStatement);

            if (opt.symbol_with_same_case) {
                symbolProvider({ textDocument: _this.document });
            }

            if (range) {
                end_pos = _this.document.offsetAt(range.end);
                ck = _this.find_token(_this.document.offsetAt(range.start));
                range.start = _this.document.positionAt(
                    (parser_pos = ck.offset),
                );
                preindent_string = input
                    .substring(
                        input.lastIndexOf('\n', parser_pos) + 1,
                        parser_pos,
                    )
                    .replace(/\S.*$/, '');
            }

            while (true) {
                token_type = (ck = get_next_token()).type;
                token_text_low = (token_text = ck.content).toLowerCase();
                if (ck.fat_arrow_end) {
                    while (!flags.in_fat_arrow) {
                        restore_mode();
                    }
                    deindent();
                }

                if (ck.offset >= end_pos) {
                    if (range) {
                        let pt = ck.previous_token;
                        let end = parser_pos;
                        if (
                            last_type === 'TK_RESERVED' &&
                            ['try', 'else', 'finally'].includes(last_text)
                        ) {
                            indent();
                        }
                        if (
                            !flags.declaration_statement ||
                            !just_added_newline()
                        ) {
                            print_newline();
                        }
                        if (pt) {
                            while (
                                (ck = _this.find_token(
                                    pt.skip_pos ?? pt.offset + pt.length,
                                )).offset < end_pos
                            ) {
                                pt = ck;
                            }
                            for (
                                end = pt.offset + pt.length;
                                ' \t'.includes(input.charAt(end) || '\0');
                                end++
                            ) {}
                            if (!whitespace.includes(input.charAt(end))) {
                                end = pt.offset + pt.length;
                            }
                            while (just_added_newline()) {
                                output_lines.pop();
                            }
                        }
                        range.end = _this.document.positionAt(end);
                        (range as any).indent_string =
                            preindent_string +
                            indent_string.repeat(flags.indentation_level);
                    }
                    while (flags.mode === MODE.Statement) {
                        restore_mode();
                    }
                    break;
                } else if (
                    is_conditional &&
                    !(is_conditional = n_newlines
                        ? !conditional_is_end(ck)
                        : token_type !== 'TK_START_BLOCK' || ck.data)
                ) {
                    restore_mode();
                    last_type = 'TK_END_EXPR';
                    flags.last_text = ')';
                    input_wanted_newline = n_newlines > 0;
                } else if ((input_wanted_newline = n_newlines > 0)) {
                    if (continuation_sections_mode) {
                        print_newline();
                        for (let i = 1; i < n_newlines; i++) {
                            output_lines.push(create_output_line());
                        }
                    } else if (!is_conditional && !flags.in_expression) {
                        if (
                            (ck.type.endsWith('COMMENT') ||
                                !is_line_continue(
                                    flags.mode === MODE.Statement
                                        ? ck.previous_token ?? EMPTY_TOKEN
                                        : ({} as Token),
                                    ck,
                                )) &&
                            !(
                                last_type === 'TK_RESERVED' &&
                                ['catch', 'else', 'finally', 'until'].includes(
                                    last_text,
                                )
                            )
                        ) {
                            if (
                                opt.max_preserve_newlines &&
                                n_newlines > opt.max_preserve_newlines
                            ) {
                                n_newlines = opt.max_preserve_newlines;
                            }

                            if (!just_added_newline()) {
                                output_lines.push(create_output_line());
                            }
                            for (let i = 1; i < n_newlines; i++) {
                                output_lines.push(create_output_line());
                            }
                        }
                    }
                }

                handlers[token_type]();

                if (!token_type.endsWith('COMMENT')) {
                    if (
                        !is_conditional &&
                        token_type === 'TK_RESERVED' &&
                        [
                            'if',
                            'for',
                            'while',
                            'loop',
                            'catch',
                            'switch',
                        ].includes(token_text_low)
                    ) {
                        is_conditional = true;
                        set_mode(MODE.Conditional);
                        if (token_text_low !== 'switch') {
                            indent();
                        }
                    }
                    last_last_text = flags.last_text;
                    flags.last_text = token_text_low;
                    flags.had_comment = 0;
                    last_type = token_type;
                    last_text = token_text_low;
                }
            }

            const sweet_code = output_lines
                .map((line) => line.text.join(''))
                .join('\n');
            output_lines = [];
            format_mode = false;
            return sweet_code;

            function conditional_is_end(tk: Token) {
                if (
                    ![MODE.Conditional, MODE.Statement].includes(flags.mode) ||
                    flags.parent.mode === MODE.ObjectLiteral
                ) {
                    return false;
                }
                switch (tk.type) {
                    case 'TK_DOT':
                    case 'TK_COMMA':
                    case 'TK_EQUALS':
                    case 'TK_COMMENT':
                    case 'TK_INLINE_COMMENT':
                    case 'TK_BLOCK_COMMENT':
                        return false;
                    case 'TK_OPERATOR':
                        return Boolean(
                            tk.content.match(/^(!|~|not|%|\+\+|--)$/i),
                        );
                    case 'TK_STRING':
                        return !tk.ignore;
                    default:
                        const lk = tk.previous_token as Token;
                        switch (lk.type) {
                            case 'TK_COMMA':
                            case 'TK_EQUALS':
                                return false;
                            case 'TK_OPERATOR':
                                return Boolean(
                                    lk.content.match(/^(\+\+|--|%)$/),
                                );
                        }
                }
                return true;
            }
        };

        function format_params_default_val(
            tokens: { [offset: number]: Token },
            params: Variable[],
        ) {
            opt = { keep_array_indentation: true, max_preserve_newlines: 1 };
            space_in_other = true;
            indent_string = '\t';
            delete (<any>params).format;
            format_mode = true;
            preindent_string = '';
            for (const param of params) {
                if (!param.range_offset) {
                    continue;
                }
                const [start, end] = param.range_offset;
                delete param.range_offset;
                last_type = last_last_text = last_text = '';
                output_lines = [create_output_line()];
                output_space_before_token = false;
                flag_store = [];
                flags = null;
                set_mode(MODE.Expression);
                for (
                    ck = tokens[tokens[start].next_token_offset];
                    ck && ck.offset < end;
                    ck = tokens[ck.next_token_offset]
                ) {
                    token_type = ck.type;
                    token_text = ck.content;
                    token_text_low = token_text.toLowerCase();
                    handlers[token_type]();
                    last_last_text = flags.last_text;
                    last_type = token_type;
                    flags.last_text = last_text = token_text_low;
                }
                param.defaultVal = output_lines
                    .map((line) => line.text.join(''))
                    .join('\n')
                    .trim();
            }
            format_mode = false;
            output_lines = [];
        }

        if (d || document.uri.match(/\.d\.(ahk2?|ah2)(?=(\?|$))/i)) {
            this.d = d || 1;
            allow_$ ||= true;
            this.parseScript = function (): void {
                input = this.document.getText();
                input_length = input.length;
                includedir = this.scriptpath;
                lst = EMPTY_TOKEN;
                begin_line = true;
                parser_pos = 0;
                last_LF = -1;
                currsymbol = last_comment_fr = undefined;
                let _low = '';
                let i = 0;
                let j = 0;
                let l = 0;
                let isstatic = false;
                let tk: Token, lk: Token;
                this.clear();
                this.reflat = true;
                customblocks = { region: [], bracket: [] };
                this.maybev1 = undefined;
                let blocks = 0;
                let rg: Range;
                let tokens: Token[] = [];
                const cls: string[] = [];
                let _cm: Token;
                const p = [
                    DocumentSymbol.create(
                        '',
                        undefined,
                        SymbolKind.Namespace,
                        (rg = make_range(0, 0)),
                        rg,
                        this.children,
                    ) as ClassNode,
                ];
                includetable = this.include;
                p[0].declaration = p[0].staticdeclaration = this.declaration;
                comments = {};
                while (get_next_token().length) {
                    continue;
                }
                tokens = Object.values(this.tokens);
                l = tokens.length;
                while (i < l) {
                    switch ((tk = tokens[i]).type) {
                        case 'TK_WORD':
                            j = i + 1;
                            if (j < l) {
                                if (
                                    blocks &&
                                    ((lk = tokens[j]).topofline ||
                                        '=>:['.includes(lk.content))
                                ) {
                                    const tn = Variable.create(
                                        tk.content,
                                        SymbolKind.Property,
                                        (rg = make_range(tk.offset, tk.length)),
                                    );
                                    const fn = tn as FuncNode;
                                    tk.symbol = tk.definition = tn;
                                    tk.semantic = {
                                        type: SemanticTokenTypes.property,
                                        modifier:
                                            (1 <<
                                                SemanticTokenModifiers.definition) |
                                            (isstatic
                                                ? 1 <<
                                                  SemanticTokenModifiers.static
                                                : 0),
                                    };
                                    fn.parent = p[blocks];
                                    p[blocks].children?.push(tn);
                                    tn.static = isstatic;
                                    tn.full =
                                        `(${cls.join('.')}) ${
                                            isstatic ? 'static ' : ''
                                        }` + tn.name;
                                    p[blocks][
                                        isstatic
                                            ? 'staticdeclaration'
                                            : 'declaration'
                                    ][tn.name.toUpperCase()] = tn;
                                    if (
                                        (_cm =
                                            comments[
                                                tn.selectionRange.start.line
                                            ])
                                    ) {
                                        tn.detail = trim_comment(_cm.content);
                                    }
                                    (_this.object.property[
                                        tn.name.toUpperCase()
                                    ] ??= []).push(tn);
                                    const pars: Variable[] = [];
                                    if (lk.content === '[') {
                                        tn.children ??= [];
                                        while (
                                            (lk = tokens[++j]).content !== ']'
                                        ) {
                                            if (lk.type === 'TK_WORD') {
                                                const vr = Variable.create(
                                                    lk.content,
                                                    SymbolKind.Variable,
                                                    (rg = make_range(
                                                        lk.offset,
                                                        lk.length,
                                                    )),
                                                );
                                                pars.push(vr);
                                                lk.semantic = {
                                                    type: SemanticTokenTypes.parameter,
                                                    modifier:
                                                        1 <<
                                                        SemanticTokenModifiers.definition,
                                                };
                                                const t = tokens[j + 1];
                                                if (t.content === '?') {
                                                    vr.defaultVal = null;
                                                    j++;
                                                } else if (t.content === ':=') {
                                                    vr.defaultVal =
                                                        tokens[
                                                            (j += 2)
                                                        ].content;
                                                } else if (t.content === '*') {
                                                    vr.arr = true;
                                                    j++;
                                                }
                                            }
                                        }
                                        lk = tokens[++j];
                                        if (pars.length) {
                                            const p = FuncNode.create(
                                                '',
                                                SymbolKind.Function,
                                                fn.range,
                                                fn.range,
                                                (fn.params = pars),
                                            ).full.slice(1, -1);
                                            fn.full += `[${p}]`;
                                        }
                                    }
                                    if (lk.content === '{') {
                                        tn.children ??= [];
                                        while (
                                            (tk = tokens[++j]).content !== '}'
                                        ) {
                                            if (tk.content === '=>') {
                                                const rets: string[] = [];
                                                const tt = FuncNode.create(
                                                    lk.content,
                                                    SymbolKind.Function,
                                                    (rg = make_range(
                                                        lk.offset,
                                                        lk.length,
                                                    )),
                                                    rg,
                                                    pars,
                                                    undefined,
                                                    isstatic,
                                                );
                                                lk.symbol = lk.definition = tt;
                                                lk = tokens[++j];
                                                if (
                                                    lk.type === 'TK_START_EXPR'
                                                ) {
                                                    lk = tokens[++j];
                                                }
                                                if (lk.type === 'TK_WORD') {
                                                    rets.push(
                                                        '#' +
                                                            lk.content.toLowerCase(),
                                                    );
                                                } else if (
                                                    lk.type === 'TK_NUMBER'
                                                ) {
                                                    rets.push(lk.content);
                                                }
                                                while (
                                                    tokens[j + 1].content ===
                                                    '|'
                                                ) {
                                                    if (
                                                        (lk = tokens[(j += 2)])
                                                            .type === 'TK_WORD'
                                                    ) {
                                                        rets.push(
                                                            '#' +
                                                                lk.content.toLowerCase(),
                                                        );
                                                        lk.semantic = {
                                                            type: SemanticTokenTypes.class,
                                                        };
                                                    } else if (
                                                        lk.type === 'TK_NUMBER'
                                                    ) {
                                                        rets.push(lk.content);
                                                    } else {
                                                        j--;
                                                    }
                                                }
                                                if (
                                                    tokens[j + 1].type ===
                                                    'TK_END_EXPR'
                                                ) {
                                                    lk = tokens[++j];
                                                }
                                                tt.range.end =
                                                    this.document.positionAt(
                                                        lk.offset + lk.length,
                                                    );
                                                if (rets[0] !== '#void') {
                                                    tt.returntypes = {
                                                        [rets.length > 1
                                                            ? `[${rets.join(
                                                                  ',',
                                                              )}]`
                                                            : rets.pop() ??
                                                              '#any']: true,
                                                    };
                                                }
                                                tn.children!.push(tt);
                                            } else {
                                                lk = tk;
                                            }
                                        }
                                    } else {
                                        let rets: string[] = [];
                                        if (lk.content === '=>') {
                                            lk = tokens[++j];
                                            if (lk.type === 'TK_START_EXPR') {
                                                lk = tokens[++j];
                                            }
                                            rets = [];
                                            if (lk.type === 'TK_WORD') {
                                                rets.push(
                                                    '#' +
                                                        lk.content.toLowerCase(),
                                                );
                                            }
                                            while (
                                                tokens[j + 1].content === '|'
                                            ) {
                                                if (
                                                    (lk = tokens[(j += 2)])
                                                        .type === 'TK_WORD'
                                                ) {
                                                    rets.push('#' + lk.content);
                                                    lk.semantic = {
                                                        type: SemanticTokenTypes.class,
                                                    };
                                                } else {
                                                    j--;
                                                }
                                            }
                                            if (
                                                tokens[j + 1].type ===
                                                'TK_END_EXPR'
                                            ) {
                                                lk = tokens[++j];
                                            }
                                        }
                                        if (rets[0] !== '#void') {
                                            tn.returntypes = {
                                                [rets.length > 1
                                                    ? `[${rets.join(',')}]`
                                                    : rets.pop() ?? '#any']:
                                                    true,
                                            };
                                        }
                                    }
                                } else if (tokens[j].content === '(') {
                                    const params: Variable[] = [];
                                    let byref = false;
                                    let defVal = 0;
                                    while ((lk = tokens[++j]).content !== ')') {
                                        let tn: Variable;
                                        switch (lk.type) {
                                            case 'TK_WORD':
                                                tn = Variable.create(
                                                    lk.content,
                                                    SymbolKind.Variable,
                                                    (rg = make_range(
                                                        lk.offset,
                                                        lk.length,
                                                    )),
                                                );
                                                tn.ref = byref;
                                                tn.assigned = true;
                                                byref = false;
                                                params.push(tn);
                                                lk.semantic = {
                                                    type: SemanticTokenTypes.parameter,
                                                    modifier:
                                                        1 <<
                                                        SemanticTokenModifiers.definition,
                                                };
                                                if (
                                                    (lk = tokens[j + 1])
                                                        .content === ':='
                                                ) {
                                                    j = j + 2;
                                                    if (
                                                        (lk = tokens[j])
                                                            .content === '+' ||
                                                        lk.content === '-'
                                                    ) {
                                                        tn.defaultVal =
                                                            lk.content +
                                                            tokens[++j].content;
                                                    } else {
                                                        tn.defaultVal =
                                                            lk.content;
                                                    }
                                                } else if (lk.content === '?') {
                                                    tn.defaultVal = null;
                                                    j++;
                                                } else {
                                                    if (defVal) {
                                                        tn.defaultVal = false;
                                                    }
                                                    if (lk.content === '*') {
                                                        tn.arr = true;
                                                        j++;
                                                    } else if (
                                                        lk.content === '['
                                                    ) {
                                                        defVal++;
                                                        j++;
                                                    } else if (
                                                        lk.content === ']'
                                                    ) {
                                                        defVal--;
                                                        j++;
                                                    }
                                                }
                                                break;
                                            case 'TK_STRING':
                                                params.push(
                                                    (tn = Variable.create(
                                                        lk.content,
                                                        SymbolKind.String,
                                                        (rg = make_range(
                                                            lk.offset,
                                                            lk.length,
                                                        )),
                                                    )),
                                                );
                                                if (defVal) {
                                                    tn.defaultVal = false;
                                                }
                                                break;
                                            default:
                                                byref = false;
                                                if (lk.content === '&') {
                                                    byref = true;
                                                } else if (lk.content === '*') {
                                                    params.push(
                                                        (tn = Variable.create(
                                                            '',
                                                            SymbolKind.Variable,
                                                            make_range(
                                                                lk.offset,
                                                                0,
                                                            ),
                                                        )),
                                                    );
                                                    tn.arr = true;
                                                    if (defVal) {
                                                        tn.defaultVal = false;
                                                    }
                                                } else if (lk.content === '[') {
                                                    defVal++;
                                                } else if (lk.content === ']') {
                                                    defVal--;
                                                }
                                                break;
                                        }
                                    }
                                    let rets: string[] | undefined;
                                    let r = '';
                                    let lt = '';
                                    lk = tokens[j];
                                    if (
                                        j < l - 2 &&
                                        '=>:'.includes(tokens[j + 1].content)
                                    ) {
                                        rets = [];
                                        if (
                                            tokens[j + 2].type ===
                                            'TK_START_EXPR'
                                        ) {
                                            j++;
                                        }
                                        do {
                                            j = j + 1;
                                            r = '';
                                            lt = '';
                                            while (
                                                (lk = tokens[j + 1]) &&
                                                (lk.type === 'TK_WORD' ||
                                                    lk.type === 'TK_DOT') &&
                                                !lk.topofline &&
                                                lt !== lk.type
                                            ) {
                                                r += lk.content;
                                                j++;
                                                lt = lk.type;
                                                lk.semantic = {
                                                    type: SemanticTokenTypes.class,
                                                };
                                            }
                                            if (r) {
                                                rets.push(
                                                    (r = r
                                                        .replace(
                                                            /(^|\.)([^.$@#]+)$/,
                                                            '$1@$2',
                                                        )
                                                        .replace('$', '')
                                                        .toLowerCase()),
                                                );
                                                if (r === '@void') {
                                                    rets.pop();
                                                }
                                            }
                                        } while (
                                            tokens[j + 1]?.content === '|'
                                        );
                                        if (lk?.type !== 'TK_END_EXPR') {
                                            lk = tokens[j];
                                        }
                                    }
                                    const tn = FuncNode.create(
                                        tk.content,
                                        blocks
                                            ? SymbolKind.Method
                                            : SymbolKind.Function,
                                        make_range(
                                            tk.offset,
                                            lk.offset + lk.length - tk.offset,
                                        ),
                                        make_range(tk.offset, tk.length),
                                        params,
                                        [],
                                        isstatic,
                                    );
                                    tk.symbol = tk.definition = tn;
                                    tn.full =
                                        (isstatic ? 'static ' : '') +
                                        _this.document.getText(tn.range);
                                    tn.static = isstatic;
                                    tn.declaration = {};
                                    if (tn.variadic) {
                                        params.push(
                                            ...params.splice(
                                                params.findIndex(
                                                    (it) => it.arr,
                                                ),
                                                1,
                                            ),
                                        );
                                    }
                                    tk.semantic = {
                                        type: blocks
                                            ? SemanticTokenTypes.method
                                            : SemanticTokenTypes.function,
                                        modifier:
                                            (1 <<
                                                SemanticTokenModifiers.definition) |
                                            (1 <<
                                                SemanticTokenModifiers.readonly) |
                                            (isstatic
                                                ? 1 <<
                                                  SemanticTokenModifiers.static
                                                : 0),
                                    };
                                    if (blocks) {
                                        tn.full =
                                            `(${cls.join('.')}) ` + tn.full;
                                        (_this.object.method[
                                            tn.name.toUpperCase()
                                        ] ??= []).push(tn);
                                        tn.parent = p[blocks];
                                    }
                                    if (rets?.length) {
                                        const o: any = {};
                                        rets.forEach(
                                            (tp: string) => (o[tp] = true),
                                        );
                                        tn.returntypes = o;
                                    }
                                    if (
                                        (_cm =
                                            comments[
                                                tn.selectionRange.start.line
                                            ])
                                    ) {
                                        tn.detail = trim_comment(_cm.content);
                                    }
                                    p[blocks].children?.push(tn);
                                    p[blocks][
                                        isstatic
                                            ? 'staticdeclaration'
                                            : 'declaration'
                                    ][tn.name.toUpperCase()] = tn;
                                }
                            }
                            i = j + 1;
                            isstatic = false;
                            break;
                        case 'TK_RESERVED':
                            isstatic = false;
                            if (
                                (_low = tk.content.toLowerCase()) === 'static'
                            ) {
                                isstatic = true;
                                i++;
                            } else if (i < l - 4 && _low === 'class') {
                                let extends_ = '';
                                let m: any;
                                const cl = DocumentSymbol.create(
                                    (tk = tokens[++i]).content,
                                    undefined,
                                    SymbolKind.Class,
                                    make_range(tokens[i - 1].offset, 0),
                                    make_range(tk.offset, tk.length),
                                    [],
                                ) as ClassNode;
                                cl.declaration = {};
                                cl.staticdeclaration = {};
                                j = i + 1;
                                cls.push(cl.name);
                                cl.full = cls.join('.');
                                cl.returntypes = {
                                    [cl.full
                                        .replace(/([^.]+)$/, '@$1')
                                        .toLowerCase()]: true,
                                };
                                tk.semantic = {
                                    type: SemanticTokenTypes.class,
                                    modifier:
                                        (1 <<
                                            SemanticTokenModifiers.definition) |
                                        (1 << SemanticTokenModifiers.readonly),
                                };
                                tk.symbol = tk.definition = cl;
                                cl.funccall = [];
                                cl.extends = '';
                                cl.uri ??= _this.uri;
                                p[blocks].children?.push(cl);
                                p[blocks].staticdeclaration[
                                    cl.name.toUpperCase()
                                ] = cl;
                                if (cl.name.startsWith('_')) {
                                    cl.kind = SymbolKind.Interface;
                                }
                                if (
                                    (_cm =
                                        comments[cl.selectionRange.start.line])
                                ) {
                                    cl.detail = trim_comment(_cm.content);
                                }
                                if (
                                    (lk = tokens[j])?.content.toLowerCase() ===
                                    'extends'
                                ) {
                                    if (
                                        (lk = tokens[j + 1])?.type === 'TK_WORD'
                                    ) {
                                        _this.children.push(
                                            Variable.create(
                                                lk.content,
                                                SymbolKind.Variable,
                                                make_range(
                                                    lk.offset,
                                                    lk.length,
                                                ),
                                            ),
                                        );
                                    }
                                    while (
                                        ++j < l &&
                                        (lk = tokens[j]).content !== '{'
                                    ) {
                                        extends_ += lk.content;
                                    }
                                    cl.extends = extends_.toLowerCase();
                                }
                                if (
                                    (m =
                                        cl.detail?.match(
                                            /^\s*@extends\s+(.+)/m,
                                        ))
                                ) {
                                    set_extends(cl, m[1]);
                                }
                                blocks++;
                                p.push(cl);
                                i = j + 1;
                            } else {
                                tk.type = 'TK_WORD';
                            }
                            break;
                        case 'TK_END_BLOCK':
                            if (blocks) {
                                blocks--;
                                cls.pop();
                                const cl = p.pop() as DocumentSymbol;
                                cl.range.end = this.document.positionAt(
                                    tk.offset + tk.length,
                                );
                                this.addFoldingRangePos(
                                    cl.range.start,
                                    cl.range.end,
                                );
                            }
                        default:
                            i++;
                            isstatic = false;
                            break;
                    }
                }

                if (this.d < 0) {
                    return;
                }
                if (this.d & 2) {
                    const overwrite = this.uri.endsWith('/ahk2_h.d.ahk')
                        ? 1
                        : 0;
                    let t: any;
                    this.children.forEach((it) => {
                        switch (it.kind) {
                            case SymbolKind.Function:
                                (<Variable>it).def = false;
                            case SymbolKind.Class:
                                (<FuncNode>it).overwrite ??= overwrite;
                                (<any>it).uri ??= this.uri;
                                if (
                                    !(t =
                                        ahkvars[
                                            (_low = it.name.toUpperCase())
                                        ]) ||
                                    overwrite >= (t.overwrite ?? 0)
                                ) {
                                    ahkvars[_low] = it;
                                }
                                break;
                        }
                    });
                    let s = this.declaration['STRUCT'] as any;
                    if (s && s.kind === SymbolKind.Class) {
                        s.def = false;
                    }
                    s = (ahkvars['CLASS'] as ClassNode)?.staticdeclaration[
                        'CALL'
                    ];
                    if (s) {
                        s.def = false;
                    }
                }
                checksamenameerr({}, this.children, this.diagnostics);
                this.diags = this.diagnostics.length;
                this.isparsed = true;
                customblocks.region.forEach((o) =>
                    this.addFoldingRange(o, parser_pos - 1, 'region'),
                );
            };
        } else {
            this.fsPath.replace(/^(.*)\.(ahk2?|ah2)$/i, (m, m0) => {
                const path = m0 + '.d.ahk',
                    uri = (this.d_uri = URI.file(path)
                        .toString()
                        .toLowerCase());
                if (!inBrowser && !lexers[this.d_uri]) {
                    const t = openFile(restorePath(path), false);
                    if (t) {
                        (lexers[uri] = new Lexer(
                            t,
                            undefined,
                            1,
                        )).parseScript();
                    }
                }
                return '';
            });
            this.parseScript = function (): void {
                input = this.document.getText();
                input_length = input.length;
                includedir = this.scriptpath;
                dlldir = '';
                begin_line = true;
                requirev2 = false;
                lst = EMPTY_TOKEN;
                currsymbol = last_comment_fr = undefined;
                parser_pos = 0;
                last_LF = -1;
                customblocks = { region: [], bracket: [] };
                continuation_sections_mode = false;
                h = isahk2_h;
                this.clear();
                this.reflat = true;
                includetable = this.include;
                comments = {};
                this.maybev1 = undefined;
                try {
                    const rs = utils.get_RCDATA('#2');
                    if (rs) {
                        includetable[rs.uri] = rs.path;
                    }
                    this.children.push(...parse_block());
                } catch (e: any) {
                    if (e instanceof ParseStopError) {
                        if (e.message) {
                            this.addDiagnostic(
                                e.message,
                                e.token.offset,
                                e.token.length,
                                DiagnosticSeverity.Warning,
                            );
                        }
                    } else {
                        console.error(e);
                    }
                }
                checksamenameerr(
                    this.declaration,
                    this.children,
                    this.diagnostics,
                );
                this.diags = this.diagnostics.length;
                this.isparsed = true;
                customblocks.region.forEach((o) =>
                    this.addFoldingRange(o, parser_pos - 1, 'region'),
                );
                if (this.actived) {
                    this.actionwhenv1 ??= 'Continue';
                }
            };
        }

        function stop_parse(
            tk: Token,
            allow_skip = false,
            message = diagnostic.maybev1(),
        ) {
            if (requirev2) {
                return false;
            }
            _this.maybev1 ??= 1;
            switch (_this.actionwhenv1 ?? extsettings.ActionWhenV1IsDetected) {
                case 'SkipLine':
                    if (!allow_skip) {
                        return false;
                    }
                    _this.addDiagnostic(
                        diagnostic.skipline(),
                        tk.offset,
                        tk.length,
                        DiagnosticSeverity.Warning,
                    );
                    if (tk.type === 'TK_WORD') {
                        do {
                            let next_LF = input.indexOf('\n', parser_pos);
                            if (next_LF < 0) {
                                next_LF = input_length;
                            }
                            const s = input
                                .substring(parser_pos, next_LF)
                                .trimLeft();
                            if (s.length) {
                                createToken(
                                    s,
                                    'TK_STRING',
                                    next_LF - s.length,
                                    s.length,
                                    0,
                                );
                            }
                            parser_pos = next_LF;
                        } while (is_next_char(','));
                    }
                    return true;
                case 'SwitchToV1':
                    if (!_this.actived) {
                        break;
                    }
                    connection.console.info(
                        [
                            _this.document.uri,
                            message,
                            diagnostic.tryswitchtov1(),
                        ].join(' '),
                    );
                    if (
                        ((message = ''),
                        setTextDocumentLanguage(_this.document.uri))
                    ) {
                        _this.actionwhenv1 = 'SwitchToV1';
                    }
                    break;
                case 'Continue':
                    return false;
                case 'Warn': {
                    if (!_this.actived) {
                        break;
                    }
                    connection.window
                        .showWarningMessage(
                            `file: '${_this.fsPath}', ${message}`,
                            {
                                title: action.switchtov1(),
                                action: 'SwitchToV1',
                            },
                            { title: action.skipline(), action: 'SkipLine' },
                            { title: action.stopparsing(), action: 'Stop' },
                        )
                        .then((reason?: { action: any }) => {
                            if (
                                (_this.actionwhenv1 =
                                    reason?.action ?? 'Continue') !== 'Stop'
                            ) {
                                if (_this.actionwhenv1 === 'SwitchToV1') {
                                    setTextDocumentLanguage(_this.document.uri);
                                } else {
                                    _this.update();
                                }
                            }
                        });
                    break;
                }
            }
            _this.clear();
            parser_pos = input_length;
            throw new ParseStopError(message, tk);
        }

        function parse_block(
            mode = 0,
            scopevar = new Map<string, any>(),
            classfullname: string = '',
        ): DocumentSymbol[] {
            const result: DocumentSymbol[] = [],
                document = _this.document,
                tokens = _this.tokens;
            let _parent = scopevar.get('#parent') || _this;
            let tk = _this.tokens[parser_pos - 1] ?? EMPTY_TOKEN;
            let lk = tk.previous_token ?? EMPTY_TOKEN;
            let blocks = 0;
            let next = true;
            let _low = '';
            const case_pos: number[] = [];
            let _cm: Token | undefined, line_begin_pos: number | undefined;
            const blockpos: number[] = [];
            let tn: DocumentSymbol | undefined;
            let m: RegExpMatchArray | string | null;
            let o: any, last_hotif: number | undefined;
            const baksym = currsymbol;
            if (((block_mode = true), mode !== 0)) {
                blockpos.push(parser_pos - 1);
                delete tk.data;
            }
            currsymbol = _parent;
            parse_brace();
            currsymbol = baksym;
            if (tk.type === 'TK_EOF' && blocks > (mode === 0 ? 0 : -1)) {
                _this.addDiagnostic(
                    diagnostic.missing('}'),
                    blockpos[blocks - (mode === 0 ? 1 : 0)],
                    1,
                );
            } else if (last_hotif !== undefined) {
                _this.addFoldingRange(last_hotif, lk.offset, 'region');
            }
            return result;

            function is_func_def(fat = undefined) {
                if (input.charAt(tk.offset + tk.length) !== '(') {
                    return false;
                }
                const _lk = lk;
                const _tk = tk;
                const _lst = lst;
                const _ppos = parser_pos;
                let c = '';
                let n = 0;
                const tp = tk.topofline > 0;
                let e = '';
                block_mode = false;
                while (nexttoken()) {
                    if ((c = tk.content) === '(') {
                        n++;
                    } else if (c === ')' && !--n) {
                        nexttoken();
                        e = tk.content;
                        break;
                    }
                }
                lk = _lk;
                tk = _tk;
                lst = _lst;
                parser_pos = _ppos;
                next = true;
                return e === '=>' || (tp && e === '{');
            }

            function check_concat(tk: Token) {
                const t = tk.previous_token ?? EMPTY_TOKEN;
                if (
                    (!t.paraminfo &&
                        /^(TK_NUMBER|TK_WORD|TK_STRING|TK_END_)/.test(
                            t.type,
                        )) ||
                    ['++', '--'].includes(t.content)
                ) {
                    return ' . ';
                }
                return ' ';
            }

            function parse_brace(level = 0) {
                if (tk.type === 'TK_START_BLOCK') {
                    delete tk.data;
                    nexttoken();
                    next = false;
                    if (!tk.topofline && !lk.topofline) {
                        _this.addDiagnostic(
                            diagnostic.unexpected(tk.content),
                            tk.offset,
                            tk.length,
                        );
                    }
                }
                while (((block_mode = true), nexttoken())) {
                    let _nk: Token | undefined;
                    if (tk.topofline === 1) {
                        let p: number;
                        line_begin_pos = tk.offset;
                        if (mode === 2) {
                            if (
                                tk.type !== 'TK_RESERVED' &&
                                allIdentifierChar.test(tk.content)
                            ) {
                                tk.type = 'TK_WORD';
                                delete tk.semantic;
                            }
                        } else if ((p = is_next_char(':'))) {
                            if (
                                (case_pos.length &&
                                    tk.content.toLowerCase() === 'default') ||
                                (p === parser_pos &&
                                    whitespace.includes(
                                        input.charAt(parser_pos + 1),
                                    ) &&
                                    allIdentifierChar.test(tk.content))
                            ) {
                                if ((_nk = tokens[p])) {
                                    if (
                                        (tk.next_token_offset =
                                            _nk.next_token_offset) > 0
                                    ) {
                                        tokens[
                                            _nk.next_token_offset
                                        ].previous_token = tk;
                                    }
                                    delete tokens[p];
                                }
                                tk.content += ':';
                                tk.length = (parser_pos = p + 1) - tk.offset;
                                tk.type = 'TK_LABEL';
                                line_begin_pos = undefined;
                            }
                        }
                    }

                    switch (tk.type) {
                        case 'TK_EOF':
                            return;

                        case 'TK_WORD':
                            if (tk.topofline > 0 && !tk.ignore) {
                                let isfuncdef = is_func_def();
                                nexttoken();
                                if (
                                    !isfuncdef &&
                                    h &&
                                    mode !== 2 &&
                                    lk.topofline === 1 &&
                                    !tk.topofline &&
                                    tk.type === 'TK_WORD' &&
                                    lk.content.toLowerCase() === 'macro'
                                ) {
                                    tk.topofline = 1;
                                    if ((isfuncdef = is_func_def())) {
                                        nexttoken();
                                    } else {
                                        tk.topofline = 0;
                                    }
                                }

                                if (isfuncdef) {
                                    let tn: FuncNode | undefined;
                                    let cm: Token | undefined;
                                    let name_l: string;
                                    const fc = lk;
                                    const rl = result.length;
                                    const se: SemanticToken = (lk.semantic = {
                                        type:
                                            mode === 2
                                                ? SemanticTokenTypes.method
                                                : SemanticTokenTypes.function,
                                    });
                                    let par = parse_params(undefined, true);
                                    const isstatic = fc.topofline === 2;
                                    const oo = isstatic
                                        ? fc.previous_token?.offset!
                                        : fc.offset;
                                    line_begin_pos = undefined;
                                    if (
                                        (name_l =
                                            fc.content.toUpperCase()).match(
                                            /^\d/,
                                        )
                                    ) {
                                        _this.addDiagnostic(
                                            diagnostic.invalidsymbolname(
                                                fc.content,
                                            ),
                                            fc.offset,
                                            fc.length,
                                        );
                                    }
                                    if (!par) {
                                        par = [];
                                        _this.addDiagnostic(
                                            diagnostic.invalidparam(),
                                            fc.offset,
                                            tk.offset + 1 - fc.offset,
                                        );
                                    }
                                    fc.symbol =
                                        fc.definition =
                                        tn =
                                            FuncNode.create(
                                                fc.content,
                                                mode === 2
                                                    ? SymbolKind.Method
                                                    : SymbolKind.Function,
                                                Range.create(
                                                    (fc.pos =
                                                        document.positionAt(
                                                            fc.offset,
                                                        )),
                                                    { line: 0, character: 0 },
                                                ),
                                                make_range(
                                                    fc.offset,
                                                    fc.length,
                                                ),
                                                par,
                                                undefined,
                                                isstatic,
                                            );
                                    if (mode !== 0) {
                                        tn.parent = _parent;
                                    }
                                    if (nexttoken() && tk.content === '=>') {
                                        const rs = result.splice(rl),
                                            storemode = mode,
                                            pp = _parent;
                                        mode |= 1;
                                        _parent = tn;
                                        const sub = parse_line(
                                            (o = {}),
                                            undefined,
                                            'return',
                                            1,
                                        );
                                        result.push(tn);
                                        _parent = pp;
                                        mode = storemode;
                                        tn.range.end = document.positionAt(
                                            lk.offset + lk.length,
                                        );
                                        _this.addFoldingRangePos(
                                            tn.range.start,
                                            tn.range.end,
                                            'line',
                                        );
                                        tn.returntypes = o;
                                        tn.children = rs.concat(sub);
                                        for (const t in o) {
                                            o[t] = tn.range.end;
                                        }
                                        _this.linepos[tn.range.end.line] = oo;
                                    } else if (tk.content === '{') {
                                        const rs = result.splice(rl),
                                            vars = new Map<string, any>(),
                                            ofs = tk.offset;
                                        tk.previous_pair_pos = oo;
                                        vars.set('#parent', tn);
                                        tn.funccall = [];
                                        result.push(tn);
                                        tn.children = rs;
                                        tn.children.push(
                                            ...parse_block(
                                                mode | 1,
                                                vars,
                                                classfullname,
                                            ),
                                        );
                                        tn.range.end =
                                            document.positionAt(parser_pos);
                                        _this.addSymbolFolding(tn, ofs);
                                    } else {
                                        _this.addDiagnostic(
                                            diagnostic.unexpected(tk.content),
                                            tk.offset,
                                            tk.length,
                                        );
                                        break;
                                    }
                                    se.modifier =
                                        (1 <<
                                            SemanticTokenModifiers.definition) |
                                        (1 << SemanticTokenModifiers.readonly) |
                                        (isstatic
                                            ? 1 << SemanticTokenModifiers.static
                                            : 0);
                                    if (
                                        (cm =
                                            comments[
                                                tn.selectionRange.start.line
                                            ])
                                    ) {
                                        tn.detail = trim_comment(cm.content);
                                    }
                                    adddeclaration(tn);
                                    if (mode === 2) {
                                        tn.full =
                                            `(${classfullname.slice(0, -1)}) ` +
                                            tn.full;
                                        if (!_this.object.method[name_l]) {
                                            _this.object.method[name_l] = [];
                                        }
                                        _this.object.method[name_l].push(tn);
                                    }
                                    break;
                                }

                                if (mode === 2) {
                                    if (
                                        input.charAt(lk.offset + lk.length) ===
                                            '[' ||
                                        tk.content.match(/^(=>|\{)$/)
                                    ) {
                                        const fc = lk;
                                        const rl = result.length;
                                        let par: any = [];
                                        let rg: Range;
                                        line_begin_pos = undefined;
                                        if (tk.content === '[') {
                                            par =
                                                parse_params(
                                                    undefined,
                                                    true,
                                                    ']',
                                                ) ?? [];
                                            nexttoken();
                                            if (par.length === 0) {
                                                _this.addDiagnostic(
                                                    diagnostic.propemptyparams(),
                                                    fc.offset,
                                                    lk.offset - fc.offset + 1,
                                                );
                                            }
                                            if (
                                                !tk.content.match(/^(=>|\{)$/)
                                            ) {
                                                _this.addDiagnostic(
                                                    diagnostic.propdeclaraerr(),
                                                    fc.offset,
                                                    fc.length,
                                                );
                                                next = false;
                                                break;
                                            }
                                        }
                                        const isstatic = fc.topofline === 2;
                                        const oo = isstatic
                                            ? (fc.previous_token
                                                  ?.offset as number)
                                            : fc.offset;
                                        const prop = (fc.symbol =
                                            DocumentSymbol.create(
                                                fc.content,
                                                undefined,
                                                SymbolKind.Property,
                                                (rg = make_range(
                                                    fc.offset,
                                                    fc.length,
                                                )),
                                                Object.assign({}, rg),
                                            ) as FuncNode);
                                        if (
                                            (_cm =
                                                comments[
                                                    prop.selectionRange.start
                                                        .line
                                                ])
                                        ) {
                                            prop.detail = trim_comment(
                                                _cm.content,
                                            );
                                        }
                                        par.format?.(par);
                                        prop.parent = _parent;
                                        prop.params = par;
                                        prop.full =
                                            `(${classfullname.slice(0, -1)}) ${
                                                isstatic ? 'static ' : ''
                                            }${fc.content}` +
                                            (par.length
                                                ? `[${par
                                                      .map((it: Variable) => {
                                                          return (
                                                              (it.ref
                                                                  ? '&'
                                                                  : '') +
                                                              it.name +
                                                              (it.defaultVal
                                                                  ? ' := ' +
                                                                    it.defaultVal
                                                                  : it.arr
                                                                  ? '*'
                                                                  : it.defaultVal ===
                                                                    null
                                                                  ? '?'
                                                                  : '')
                                                          );
                                                      })
                                                      .join(', ')}]`
                                                : '');
                                        prop.static = isstatic;
                                        prop.children = result.splice(rl);
                                        result.push(prop);
                                        addprop(fc, prop);
                                        prop.funccall = [];
                                        if (
                                            fc.content.toLowerCase() !==
                                            '__item'
                                        ) {
                                            fc.semantic = {
                                                type: SemanticTokenTypes.property,
                                                modifier:
                                                    (1 <<
                                                        SemanticTokenModifiers.definition) |
                                                    (isstatic
                                                        ? 1 <<
                                                          SemanticTokenModifiers.static
                                                        : 0),
                                            };
                                        }
                                        if (tk.content === '{') {
                                            let nk: Token;
                                            let sk: Token;
                                            let tn: FuncNode | undefined;
                                            const mmm = mode;
                                            const brace = tk.offset;
                                            tk.previous_pair_pos = oo;
                                            nexttoken();
                                            next = false;
                                            mode = 1;
                                            if (
                                                (tk.type as string) ===
                                                    'TK_END_BLOCK' &&
                                                !lk.topofline &&
                                                !tk.topofline
                                            ) {
                                                _this.addDiagnostic(
                                                    diagnostic.unexpected(
                                                        tk.content,
                                                    ),
                                                    tk.offset,
                                                    tk.length,
                                                );
                                            }
                                            while (
                                                nexttoken() &&
                                                (tk.type as string) !==
                                                    'TK_END_BLOCK'
                                            ) {
                                                if (
                                                    tk.topofline &&
                                                    (tk.content =
                                                        tk.content.toLowerCase()).match(
                                                        /^[gs]et$/,
                                                    )
                                                ) {
                                                    let v: Variable;
                                                    tk.semantic = {
                                                        type: SemanticTokenTypes.function,
                                                        modifier:
                                                            (1 <<
                                                                SemanticTokenModifiers.definition) |
                                                            (1 <<
                                                                SemanticTokenModifiers.readonly),
                                                    };
                                                    // nk = tk, sk = _this.get_token(parser_pos, true), parser_pos = sk.offset + sk.length;
                                                    nexttoken();
                                                    nk = lk;
                                                    if (tk.content === '=>') {
                                                        const o: any = {};
                                                        const fcs =
                                                            _parent.funccall
                                                                .length;
                                                        tn = FuncNode.create(
                                                            lk.content.toLowerCase(),
                                                            SymbolKind.Function,
                                                            make_range(
                                                                lk.offset,
                                                                parser_pos -
                                                                    lk.offset,
                                                            ),
                                                            make_range(
                                                                lk.offset,
                                                                lk.length,
                                                            ),
                                                            [...par],
                                                        );
                                                        lk.symbol =
                                                            lk.definition = tn;
                                                        mode = 3;
                                                        tn.parent = prop;
                                                        const sub = parse_line(
                                                            o,
                                                            undefined,
                                                            'return',
                                                            1,
                                                        );
                                                        mode = 2;
                                                        tn.funccall?.push(
                                                            ..._parent.funccall.splice(
                                                                fcs,
                                                            ),
                                                        );
                                                        tn.range.end =
                                                            document.positionAt(
                                                                lk.offset +
                                                                    lk.length,
                                                            );
                                                        prop.range.end =
                                                            tn.range.end;
                                                        _this.addFoldingRangePos(
                                                            tn.range.start,
                                                            tn.range.end,
                                                            'line',
                                                        );
                                                        tn.returntypes = o;
                                                        tn.children = [];
                                                        if (
                                                            lk.content === '=>'
                                                        ) {
                                                            _this.addDiagnostic(
                                                                diagnostic.invaliddefinition(
                                                                    'function',
                                                                ),
                                                                nk.offset,
                                                                nk.length,
                                                            );
                                                        }
                                                        for (const t in o) {
                                                            o[t] = tn.range.end;
                                                        }
                                                        if (
                                                            nk.content.toLowerCase() ===
                                                            'set'
                                                        ) {
                                                            tn.params.unshift(
                                                                (v =
                                                                    Variable.create(
                                                                        'Value',
                                                                        SymbolKind.Variable,
                                                                        Range.create(
                                                                            0,
                                                                            0,
                                                                            0,
                                                                            0,
                                                                        ),
                                                                    )),
                                                            );
                                                            v.detail =
                                                                completionitem.value();
                                                        }
                                                        tn.children.push(
                                                            ...sub,
                                                        );
                                                        adddeclaration(tn);
                                                        _this.linepos[
                                                            tn.range.end.line
                                                        ] = nk.offset;
                                                    } else if (
                                                        tk.content === '{'
                                                    ) {
                                                        sk = tk;
                                                        nk.symbol =
                                                            nk.definition =
                                                            tn =
                                                                FuncNode.create(
                                                                    nk.content,
                                                                    SymbolKind.Function,
                                                                    make_range(
                                                                        nk.offset,
                                                                        parser_pos -
                                                                            nk.offset,
                                                                    ),
                                                                    make_range(
                                                                        nk.offset,
                                                                        3,
                                                                    ),
                                                                    [...par],
                                                                );
                                                        const vars = new Map<
                                                            string,
                                                            any
                                                        >([['#parent', tn]]);
                                                        tn.parent = prop;
                                                        tn.children =
                                                            parse_block(
                                                                3,
                                                                vars,
                                                                classfullname,
                                                            );
                                                        tn.range.end =
                                                            document.positionAt(
                                                                parser_pos,
                                                            );
                                                        if (
                                                            nk.content.toLowerCase() ===
                                                            'set'
                                                        ) {
                                                            tn.params.unshift(
                                                                (v =
                                                                    Variable.create(
                                                                        'Value',
                                                                        SymbolKind.Variable,
                                                                        Range.create(
                                                                            0,
                                                                            0,
                                                                            0,
                                                                            0,
                                                                        ),
                                                                    )),
                                                            );
                                                            v.detail =
                                                                completionitem.value();
                                                        }
                                                        adddeclaration(tn);
                                                        _this.addSymbolFolding(
                                                            tn,
                                                            sk.offset,
                                                        );
                                                        if (
                                                            nk.content.match(
                                                                /^\d/,
                                                            )
                                                        ) {
                                                            _this.addDiagnostic(
                                                                diagnostic.invalidsymbolname(
                                                                    nk.content,
                                                                ),
                                                                nk.offset,
                                                                nk.length,
                                                            );
                                                        }
                                                    } else {
                                                        _this.addDiagnostic(
                                                            diagnostic.invalidprop(),
                                                            tk.offset,
                                                            tk.length,
                                                        );
                                                        if (
                                                            tk.content === '}'
                                                        ) {
                                                            next = false;
                                                            break;
                                                        } else {
                                                            tn = undefined;
                                                            let b = 0;
                                                            while (
                                                                (tk.type as string) !==
                                                                'TK_EOF'
                                                            ) {
                                                                if (
                                                                    tk.content ===
                                                                    '{'
                                                                ) {
                                                                    b++;
                                                                } else if (
                                                                    tk.content ===
                                                                        '}' &&
                                                                    --b < 0
                                                                ) {
                                                                    break;
                                                                }
                                                                nexttoken();
                                                            }
                                                            next = false;
                                                        }
                                                    }
                                                    if (tn) {
                                                        prop.children.push(tn);
                                                        if (
                                                            tn !==
                                                            ((prop as any)[
                                                                tn.name
                                                            ] ??= tn)
                                                        ) {
                                                            _this.addDiagnostic(
                                                                diagnostic.dupdeclaration(),
                                                                nk.offset,
                                                                nk.length,
                                                            );
                                                        }
                                                    }
                                                } else {
                                                    let b = 0;
                                                    _this.addDiagnostic(
                                                        diagnostic.invalidprop(),
                                                        tk.offset,
                                                        tk.length,
                                                    );
                                                    next = false;
                                                    while (nexttoken()) {
                                                        if (
                                                            tk.content === '{'
                                                        ) {
                                                            b++;
                                                        } else if (
                                                            tk.content === '}'
                                                        ) {
                                                            if (--b < 0) {
                                                                break;
                                                            }
                                                        }
                                                    }
                                                    next = false;
                                                }
                                            }
                                            prop.range.end =
                                                document.positionAt(
                                                    parser_pos - 1,
                                                );
                                            mode = mmm;
                                            _this.addSymbolFolding(prop, brace);
                                        } else if (tk.content === '=>') {
                                            const off = parser_pos;
                                            const o: any = {};
                                            const fcs = _parent.funccall.length;
                                            mode = 3;
                                            const tn = FuncNode.create(
                                                'get',
                                                SymbolKind.Function,
                                                (rg = make_range(
                                                    off,
                                                    parser_pos - off,
                                                )),
                                                make_range(0, 0),
                                                par,
                                            );
                                            tn.parent = prop;
                                            (prop as any).get = tn;
                                            tn.children = parse_line(
                                                o,
                                                undefined,
                                                'return',
                                                1,
                                            );
                                            tn.returntypes = o;
                                            tn.funccall?.push(
                                                ..._parent.funccall.splice(fcs),
                                            );
                                            mode = 2;
                                            tn.range.end = document.positionAt(
                                                lk.offset + lk.length,
                                            );
                                            prop.range.end = tn.range.end;
                                            _this.addFoldingRangePos(
                                                tn.range.start,
                                                tn.range.end,
                                                'line',
                                            );
                                            for (const t in o) {
                                                o[t] = tn.range.end;
                                            }
                                            adddeclaration(tn);
                                            prop.children.push(tn);
                                            _this.linepos[prop.range.end.line] =
                                                oo;
                                        }
                                        if (
                                            prop.children.length === 1 &&
                                            prop.children[0].name === 'get'
                                        ) {
                                            (
                                                fc.semantic as SemanticToken
                                            ).modifier =
                                                ((fc.semantic as SemanticToken)
                                                    .modifier || 0) |
                                                (1 <<
                                                    SemanticTokenModifiers.readonly);
                                        }
                                        break;
                                    }
                                    tk = lk;
                                    lk = EMPTY_TOKEN;
                                    next = false;
                                    parser_pos = tk.offset + tk.length;
                                    const rl = result.length,
                                        _ = _parent;
                                    _parent = _parent.declaration.__INIT;
                                    const sta = parse_statement('');
                                    _parent.children.push(...result.splice(rl));
                                    _parent = _;
                                    result.push(...sta);
                                    sta.forEach(
                                        (it) => ((it as FuncNode).parent = _),
                                    );
                                    if (line_begin_pos !== undefined) {
                                        _this.linepos[
                                            (lk.pos ??= document.positionAt(
                                                lk.offset,
                                            )).line
                                        ] = line_begin_pos;
                                    }
                                } else {
                                    reset_extra_index(tk);
                                    tk = lk;
                                    lk = EMPTY_TOKEN;
                                    parser_pos = tk.offset + tk.length;
                                    parse_top_word();
                                    if (line_begin_pos !== undefined) {
                                        _this.linepos[
                                            (lk.pos ??= document.positionAt(
                                                lk.offset,
                                            )).line
                                        ] = line_begin_pos;
                                    }
                                }
                                break;
                            }

                            if (mode === 2) {
                                const rl = result.length;
                                const _ = _parent;
                                _parent = _parent.declaration.__INIT;
                                const sta = parse_statement('');
                                _parent.children.push(...result.splice(rl));
                                _parent = _;
                                result.push(...sta);
                                sta.forEach(
                                    (it) => ((it as FuncNode).parent = _),
                                );
                            } else {
                                if (tk.topofline) {
                                    parse_top_word();
                                } else {
                                    next = false;
                                    result.push(...parse_line());
                                }
                                if (line_begin_pos !== undefined) {
                                    _this.linepos[
                                        (lk.pos ??= document.positionAt(
                                            lk.offset,
                                        )).line
                                    ] = line_begin_pos;
                                }
                            }
                            break;

                        case 'TK_SHARP':
                            parse_sharp();
                            break;

                        case 'TK_RESERVED':
                            parse_reserved();
                            break;

                        case 'TK_START_BLOCK':
                            if (mode === 2) {
                                _this.addDiagnostic(
                                    diagnostic.unexpected(tk.content),
                                    tk.offset,
                                    tk.length,
                                );
                            } else {
                                blocks++;
                                blockpos.push(parser_pos - 1);
                            }
                            break;

                        case 'TK_END_BLOCK':
                            if (--blocks >= 0 && blockpos.length) {
                                const p = blockpos.pop() as number;
                                _this.addFoldingRange(
                                    (tk.previous_pair_pos = p),
                                    parser_pos - 1,
                                );
                                tokens[p].next_pair_pos = tk.offset;
                                if (tk.topofline === 1) {
                                    last_LF = tk.offset;
                                    begin_line = true;
                                }
                            }
                            if (blocks < level) {
                                if (mode === 0 && level === 0) {
                                    _this.addDiagnostic(
                                        diagnostic.unexpected('}'),
                                        tk.offset,
                                        1,
                                    );
                                    blocks = 0;
                                    blockpos.length = 0;
                                } else {
                                    if (blockpos.length) {
                                        tokens[
                                            (tk.previous_pair_pos =
                                                blockpos[blockpos.length - 1])
                                        ].next_pair_pos = tk.offset;
                                    }
                                    return;
                                }
                            }
                            break;

                        // case 'TK_DOT':
                        case 'TK_END_EXPR':
                            _this.addDiagnostic(
                                diagnostic.unexpected(tk.content),
                                tk.offset,
                                1,
                            );
                            line_begin_pos = undefined;
                            break;

                        case 'TK_LABEL':
                            if (
                                case_pos.length &&
                                tk.content.toLowerCase() === 'default:'
                            ) {
                                const last_case = case_pos.pop();
                                if ((case_pos.push(tk.offset), last_case)) {
                                    _this.addFoldingRange(
                                        last_case,
                                        lk.offset,
                                        'case',
                                    );
                                }
                                nexttoken();
                                next = false;
                                tk.topofline ||= -1;
                                break;
                            }
                            if (mode === 2) {
                                _this.addDiagnostic(
                                    diagnostic.propdeclaraerr(),
                                    tk.offset,
                                    tk.length,
                                );
                                break;
                            }
                            tk.symbol = tn = SymbolNode.create(
                                tk.content,
                                SymbolKind.Field,
                                make_range(tk.offset, tk.length),
                                make_range(tk.offset, tk.length - 1),
                            );
                            result.push(tn);
                            if (_parent.labels) {
                                _low = tk.content.toUpperCase().slice(0, -1);
                                (<any>tn).def = true;
                                if (!_parent.labels[_low]) {
                                    _parent.labels[_low] = [tn];
                                } else if (_parent.labels[_low][0].def) {
                                    _this.addDiagnostic(
                                        diagnostic.duplabel(),
                                        tk.offset,
                                        tk.length - 1,
                                    );
                                    _parent.labels[_low].push(tn);
                                } else {
                                    _parent.labels[_low].unshift(tn);
                                }
                            }
                            if (
                                (_cm = comments[tn.selectionRange.start.line])
                            ) {
                                tn.detail = trim_comment(_cm.content);
                            }
                            if (
                                !(_nk = _this.get_token(parser_pos, true))
                                    .topofline
                            ) {
                                _this.addDiagnostic(
                                    diagnostic.unexpected(_nk.content),
                                    _nk.offset,
                                    _nk.length,
                                );
                            }
                            break;

                        case 'TK_HOTLINE': {
                            tk.symbol = tn = SymbolNode.create(
                                tk.content,
                                SymbolKind.Event,
                                make_range(tk.offset, tk.length),
                                make_range(tk.offset, tk.length - 2),
                            );
                            tn.range.end = document.positionAt(parser_pos - 1);
                            result.push(tn);
                            if (
                                (_cm = comments[tn.selectionRange.start.line])
                            ) {
                                tn.detail = trim_comment(_cm.content);
                            }
                            if (mode !== 0) {
                                _this.addDiagnostic(
                                    diagnostic.hotdeferr(),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                            if (tk.ignore) {
                                while (nexttoken()) {
                                    if (
                                        !tk.ignore ||
                                        (tk.type as string) !== 'TK_STRING'
                                    ) {
                                        break;
                                    }
                                }
                                tn.range.end = document.positionAt(
                                    lk.offset + lk.length,
                                );
                                next = false;
                                break;
                            }
                            if (
                                tk.content.match(/\s::$/) ||
                                ((m = tk.content.match(/\S(\s*)&(\s*)\S+::/)) &&
                                    (m[1] === '' || m[2] === ''))
                            ) {
                                _this.addDiagnostic(
                                    diagnostic.invalidhotdef(),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                            break;
                        }
                        case 'TK_HOT': {
                            if (mode !== 0) {
                                _this.addDiagnostic(
                                    diagnostic.hotdeferr(),
                                    tk.offset,
                                    tk.length,
                                );
                            } else if (
                                !tk.ignore &&
                                (tk.content.match(/\s::$/) ||
                                    ((m =
                                        tk.content.match(
                                            /\S(\s*)&(\s*)\S+::/,
                                        )) &&
                                        (m[1] === '' || m[2] === '')))
                            ) {
                                _this.addDiagnostic(
                                    diagnostic.invalidhotdef(),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                            const tn = SymbolNode.create(
                                tk.content,
                                SymbolKind.Event,
                                make_range(tk.offset, tk.length),
                                make_range(tk.offset, tk.length - 2),
                            ) as FuncNode;
                            if (
                                (_cm = comments[tn.selectionRange.start.line])
                            ) {
                                tn.detail = trim_comment(_cm.content);
                            }
                            tk.symbol = tn;
                            nexttoken();
                            const ht = lk;
                            let v: Variable;
                            const vars = new Map<string, any>([
                                ['#parent', tn],
                            ]);
                            tn.funccall = [];
                            tn.declaration = {};
                            result.push(tn);
                            tn.global = {};
                            tn.local = {};
                            while ((tk.type as string) === 'TK_SHARP') {
                                parse_sharp();
                                nexttoken();
                            }
                            if (tk.content === '{') {
                                tk.previous_pair_pos = ht.offset;
                                tn.params = [
                                    (v = Variable.create(
                                        'ThisHotkey',
                                        SymbolKind.Variable,
                                        make_range(0, 0),
                                    )),
                                ];
                                v.detail = completionitem.thishotkey();
                                tn.children = [];
                                tn.children.push(...parse_block(1, vars));
                                tn.range = make_range(
                                    ht.offset,
                                    parser_pos - ht.offset,
                                );
                                _this.addSymbolFolding(tn, tk.offset);
                                adddeclaration(tn);
                            } else if (tk.topofline) {
                                adddeclaration(tn);
                                next = false;
                                if (tk.type.startsWith('TK_HOT')) {
                                    break;
                                }
                                if (
                                    (tk.type as string) !== 'TK_WORD' ||
                                    !is_func_def()
                                ) {
                                    stop_parse(ht);
                                    _this.addDiagnostic(
                                        diagnostic.hotmissbrace(),
                                        ht.offset,
                                        ht.length,
                                    );
                                }
                                next = false;
                            } else {
                                tn.params = [
                                    (v = Variable.create(
                                        'ThisHotkey',
                                        SymbolKind.Variable,
                                        make_range(0, 0),
                                    )),
                                ];
                                v.detail = completionitem.thishotkey();
                                const tparent = _parent,
                                    tmode = mode,
                                    l = tk.content.toLowerCase();
                                _parent = tn;
                                mode = 1;
                                if (l === 'return') {
                                    tn.children = parse_line(
                                        undefined,
                                        undefined,
                                        'return',
                                    );
                                } else if (
                                    ['global', 'local', 'static'].includes(l)
                                ) {
                                    const _p = _parent,
                                        rl = result.length;
                                    _parent = tn;
                                    parse_reserved();
                                    tn.children = result.splice(rl);
                                    _parent = _p;
                                } else {
                                    const rl = result.length;
                                    next = false;
                                    parse_body(null, ht.offset);
                                    tn.children = result.splice(rl);
                                }
                                _parent = tparent;
                                mode = tmode;
                                adddeclaration(tn as FuncNode);
                                let o = lk.offset + lk.length;
                                while (
                                    ' \t'.includes(input.charAt(o) || '\0')
                                ) {
                                    o++;
                                }
                                tn.range = make_range(ht.offset, o - ht.offset);
                                _this.linepos[tn.range.end.line] = ht.offset;
                            }
                            break;
                        }
                        case 'TK_UNKNOWN':
                            _this.addDiagnostic(
                                diagnostic.unknowntoken(tk.content),
                                tk.offset,
                                tk.length,
                            );
                            break;

                        default:
                            if (tk.topofline) {
                                lk = EMPTY_TOKEN;
                            }
                            if (((next = false), mode === 2)) {
                                _this.addDiagnostic(
                                    diagnostic.propdeclaraerr(),
                                    tk.offset,
                                    tk.length,
                                );
                                parse_line();
                            } else {
                                result.push(...parse_line());
                                if (line_begin_pos !== undefined) {
                                    _this.linepos[
                                        (lk.pos ??= document.positionAt(
                                            lk.offset,
                                        )).line
                                    ] = line_begin_pos;
                                }
                            }
                            break;
                    }
                }
            }

            function parse_reserved() {
                let _low = tk.content.toLowerCase();
                const beginpos = tk.offset;
                const bak = lk;
                const t = parser_pos;
                let nk: Token | undefined;
                if (((block_mode = false), mode === 2)) {
                    nk = get_next_token();
                    next = false;
                    parser_pos = t;
                    tk.type = 'TK_WORD';
                    if (
                        '.[('.includes(input.charAt(tk.offset + tk.length)) ||
                        nk.content.match(/^(:=|=>|\{)$/)
                    ) {
                        return;
                    }
                    if (
                        nk.type !== 'TK_EQUALS' &&
                        (_low === 'class' || _low === 'static')
                    ) {
                        nk = undefined;
                        next = true;
                        tk.type = 'TK_RESERVED';
                    } else {
                        return;
                    }
                } else {
                    if (
                        input.charAt(tk.offset - 1) === '%' ||
                        input.charAt(tk.offset + tk.length) === '%'
                    ) {
                        tk.type = 'TK_WORD';
                        next = false;
                        tk.semantic = {
                            type: SemanticTokenTypes.variable,
                        };
                        return;
                    }
                }
                switch (_low) {
                    case 'class':
                        if (tk.topofline !== 1) {
                            next = false;
                            tk.type = 'TK_WORD';
                            break;
                        }
                        let cl: Token;
                        let ex: string = '';
                        const sv = new Map();
                        let rg: Range;
                        nexttoken();
                        if (!tk.topofline && tk.type === 'TK_RESERVED') {
                            tk.type = 'TK_WORD';
                            if (mode !== 2) {
                                _this.addDiagnostic(
                                    diagnostic.reservedworderr(tk.content),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                        }
                        if (!tk.topofline && tk.type === 'TK_WORD') {
                            if (mode & 1) {
                                _this.addDiagnostic(
                                    diagnostic.classinfuncerr(),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                            cl = tk;
                            nexttoken();
                            if (tk.content.toLowerCase() === 'extends') {
                                tk = get_next_token();
                                if (tk.type === 'TK_WORD') {
                                    ex = tk.content;
                                    addvariable(tk, 0, _this.children);
                                    while (
                                        parser_pos < input_length &&
                                        input.charAt(parser_pos) === '.'
                                    ) {
                                        get_next_token();
                                        tk = get_next_token();
                                        if (tk.type === 'TK_WORD') {
                                            ex += '.' + tk.content;
                                            addprop(tk);
                                        } else {
                                            break;
                                        }
                                    }
                                    if (tk.type === 'TK_WORD') {
                                        nexttoken();
                                    }
                                } else {
                                    _this.addDiagnostic(
                                        diagnostic.unexpected(tk.content),
                                        tk.offset,
                                        tk.length,
                                    );
                                }
                            }
                            if (tk.type !== 'TK_START_BLOCK') {
                                next = false;
                                break;
                            }
                            tk.previous_pair_pos = beginpos;
                            if (cl.content.match(/^\d/)) {
                                _this.addDiagnostic(
                                    diagnostic.invalidsymbolname(cl.content),
                                    cl.offset,
                                    cl.length,
                                );
                            }
                            const tn = DocumentSymbol.create(
                                cl.content,
                                undefined,
                                SymbolKind.Class,
                                make_range(0, 0),
                                make_range(cl.offset, cl.length),
                            ) as ClassNode;
                            cl.symbol = cl.definition = tn;
                            sv.set('#parent', tn);
                            tn.full = classfullname + cl.content;
                            tn.funccall = [];
                            tn.children = [];
                            tn.cache = [];
                            tn.staticdeclaration = {};
                            tn.declaration = {};
                            tn.returntypes = {
                                [(
                                    classfullname +
                                    '@' +
                                    cl.content
                                ).toLowerCase()]: true,
                            };
                            if (
                                (_cm = comments[tn.selectionRange.start.line])
                            ) {
                                if (
                                    (m = (tn.detail = trim_comment(
                                        _cm.content,
                                    )).match(/^\s*@extends\s+(.+)/m))
                                ) {
                                    set_extends(tn, m[1]);
                                }
                            }
                            tn.extends = ex.toLowerCase();
                            tn.uri ??= _this.uri;
                            let t: any = FuncNode.create(
                                '__Init',
                                SymbolKind.Method,
                                make_range(0, 0),
                                make_range(0, 0),
                                [],
                                [],
                            );
                            (tn.declaration.__INIT = t).ranges = [];
                            t.parent = tn;
                            t = FuncNode.create(
                                '__Init',
                                SymbolKind.Method,
                                make_range(0, 0),
                                make_range(0, 0),
                                [],
                                [],
                                true,
                            );
                            (tn.staticdeclaration.__INIT = t).ranges = [];
                            t.parent = tn;
                            tn.children.push(
                                ...parse_block(
                                    2,
                                    sv,
                                    classfullname + cl.content + '.',
                                ),
                            );
                            tn.range = make_range(
                                beginpos,
                                parser_pos - beginpos,
                            );
                            adddeclaration(tn as ClassNode);
                            cl.semantic = {
                                type: SemanticTokenTypes.class,
                                modifier:
                                    (1 << SemanticTokenModifiers.definition) |
                                    (1 << SemanticTokenModifiers.readonly),
                            };
                            _this.addSymbolFolding(tn, tk.offset);
                            result.push(tn);
                            return true;
                        } else {
                            next = false;
                            lk.type = 'TK_WORD';
                            parser_pos = lk.offset + lk.length;
                            tk = lk;
                            lk = bak;
                        }
                        break;
                    case 'global':
                    case 'static':
                    case 'local':
                        nexttoken();
                        if (
                            mode === 2 &&
                            !tk.topofline &&
                            allIdentifierChar.test(tk.content)
                        ) {
                            tk.type = 'TK_WORD';
                        }
                        if (tk.topofline) {
                            if (mode === 2) {
                                _this.addDiagnostic(
                                    diagnostic.propdeclaraerr(),
                                    lk.offset,
                                    lk.length,
                                );
                            } else if (
                                _low === 'local' ||
                                _parent.children?.length
                            ) {
                                _this.addDiagnostic(
                                    diagnostic.declarationerr(),
                                    lk.offset,
                                    lk.length,
                                );
                            } else {
                                _parent.assume =
                                    _low === 'static'
                                        ? FuncScope.STATIC
                                        : FuncScope.GLOBAL;
                            }
                        } else if (
                            tk.type === 'TK_WORD' ||
                            tk.type === 'TK_RESERVED'
                        ) {
                            if (mode === 0) {
                                next = false;
                                if (_low !== 'global') {
                                    _this.addDiagnostic(
                                        diagnostic.declarationerr(),
                                        lk.offset,
                                        lk.length,
                                    );
                                }
                                break;
                            } else if (mode === 2 && _low !== 'static') {
                                _this.addDiagnostic(
                                    diagnostic.propdeclaraerr(),
                                    lk.offset,
                                    lk.length,
                                );
                                next = false;
                                break;
                            }
                            if (
                                '(['.includes(input.charAt(parser_pos)) ||
                                _this
                                    .get_token(parser_pos, true)
                                    .content.match(/^(\{|=>)$/)
                            ) {
                                tk.topofline = 2;
                            } else {
                                const rl = result.length,
                                    _ = _parent;
                                if (mode === 2) {
                                    tk.topofline = 2;
                                    _parent = _parent.staticdeclaration.__INIT;
                                }
                                next = false;
                                const sta = parse_statement(
                                    _low === 'global' ? '' : _low,
                                );
                                if (_low === 'global') {
                                    sta.forEach(
                                        (it) =>
                                            (_parent.global[
                                                it.name.toUpperCase()
                                            ] ??= it),
                                    );
                                } else {
                                    if (mode === 2) {
                                        _parent.children.push(
                                            ...result.splice(rl),
                                        );
                                        _parent = _;
                                        for (const it of sta) {
                                            it.static = true;
                                            it.full = it.full?.replace(
                                                ') ',
                                                ') static ',
                                            );
                                            (it as FuncNode).parent = _;
                                        }
                                    } else {
                                        const isstatic = _low === 'static';
                                        sta.forEach((it) => {
                                            _parent.local[
                                                it.name.toUpperCase()
                                            ] ??= it;
                                            it.static = isstatic;
                                        });
                                    }
                                }
                                result.push(...sta);
                            }
                        } else if (tk.type === 'TK_EQUALS') {
                            parser_pos = lk.offset + lk.length;
                            lk.type = 'TK_WORD';
                            tk = lk;
                            lk = bak;
                            if (mode !== 2) {
                                _this.addDiagnostic(
                                    diagnostic.reservedworderr(tk.content),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                        }
                        next = false;
                        break;
                    case 'loop':
                        if (mode === 2) {
                            nk = _this.get_token(parser_pos);
                            next = false;
                            tk.type = 'TK_WORD';
                            if (nk.content !== ':=') {
                                _this.addDiagnostic(
                                    diagnostic.propdeclaraerr(),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                            break;
                        }
                        nexttoken();
                        if (tk.type === 'TK_COMMA') {
                            stop_parse(lk);
                        }
                        let min = 0;
                        let max = 1;
                        let act = 'loop';
                        let sub;
                        if (tk.type === 'TK_EQUALS') {
                            parser_pos = lk.offset + lk.length;
                            lk.type = 'TK_WORD';
                            tk = lk;
                            lk = bak;
                            next = false;
                            if (mode !== 2) {
                                _this.addDiagnostic(
                                    diagnostic.reservedworderr(tk.content),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                            break;
                        } else if (mode === 2) {
                            _this.addDiagnostic(
                                diagnostic.propdeclaraerr(),
                                lk.offset,
                                lk.length,
                            );
                            break;
                        } else if (
                            (next =
                                tk.type === 'TK_WORD' &&
                                ['parse', 'files', 'read', 'reg'].includes(
                                    (sub = tk.content.toLowerCase()),
                                ))
                        ) {
                            min = 1;
                            max = sub === 'parse' ? 3 : 2;
                            tk.type = 'TK_RESERVED';
                            act += ' ' + sub;
                            nexttoken();
                            if (tk.type === 'TK_COMMA' && nexttoken()) {
                                tk.topofline = 0;
                            }
                            next = false;
                        }
                        if (
                            (!tk.topofline || tk.type === 'TK_COMMA') &&
                            tk.type !== 'TK_START_BLOCK'
                        ) {
                            result.push(
                                ...parse_line(undefined, '{', act, min, max),
                            );
                        } else if (min) {
                            _this.addDiagnostic(
                                diagnostic.acceptparams(act, `${min}~${max}`),
                                bak.offset,
                                bak.length,
                            );
                        }
                        if (parse_body(undefined, beginpos)) {
                            return;
                        }
                        if (
                            tk.type === 'TK_RESERVED' &&
                            tk.content.toLowerCase() === 'until'
                        ) {
                            next = true;
                            line_begin_pos = tk.offset;
                            result.push(
                                ...parse_line(undefined, undefined, 'until', 1),
                            );
                        }
                        break;
                    case 'for':
                        const nq = is_next_char('(');
                        if (nq) {
                            nk = get_next_token();
                        }
                        while (nexttoken()) {
                            switch (tk.type) {
                                case 'TK_COMMA':
                                    break;
                                case 'TK_RESERVED':
                                    if (
                                        tk.content.toLowerCase() !== 'class' ||
                                        !(mode & 1)
                                    ) {
                                        _this.addDiagnostic(
                                            diagnostic.reservedworderr(
                                                tk.content,
                                            ),
                                            tk.offset,
                                            tk.length,
                                        );
                                        break;
                                    } else {
                                        tk.type = 'TK_WORD';
                                    }
                                case 'TK_WORD':
                                    const vr = addvariable(tk, 0);
                                    if (vr) {
                                        vr.def = vr.assigned = true;
                                    }
                                    break;
                                case 'TK_OPERATOR':
                                    if (tk.content.toLowerCase() === 'in') {
                                        result.push(...parse_expression());
                                        if (nk) {
                                            if (tk.content !== ')') {
                                                _this.addDiagnostic(
                                                    diagnostic.missing(')'),
                                                    nk.offset,
                                                    nk.length,
                                                );
                                            } else {
                                                next = true;
                                                nexttoken();
                                            }
                                        }
                                        if (
                                            !parse_body(undefined, beginpos) &&
                                            (tk as Token).type ===
                                                'TK_RESERVED' &&
                                            tk.content.toLowerCase() === 'until'
                                        ) {
                                            next = true;
                                            line_begin_pos = tk.offset;
                                            result.push(
                                                ...parse_line(
                                                    undefined,
                                                    undefined,
                                                    'until',
                                                    1,
                                                ),
                                            );
                                        }
                                        return;
                                    }
                                    _this.addDiagnostic(
                                        diagnostic.unknownoperatoruse(),
                                        tk.offset,
                                        tk.length,
                                    );
                                    next = false;
                                    return;
                                default:
                                    next = false;
                                case 'TK_END_EXPR':
                                    _this.addDiagnostic(
                                        diagnostic.unexpected(tk.content),
                                        tk.offset,
                                        tk.length,
                                    );
                                    return;
                                case 'TK_EQUALS':
                                    _this.addDiagnostic(
                                        diagnostic.reservedworderr(lk.content),
                                        lk.offset,
                                        lk.length,
                                    );
                                    return;
                            }
                        }
                        break;
                    case 'continue':
                    case 'break':
                    case 'goto':
                        if (mode === 2) {
                            next = false;
                            tk.type = 'TK_WORD';
                            if (
                                _this.get_token(parser_pos, true).content !==
                                ':='
                            ) {
                                _this.addDiagnostic(
                                    diagnostic.propdeclaraerr(),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                            break;
                        }
                        nexttoken();
                        if (tk.type === 'TK_COMMA') {
                            stop_parse(lk);
                            _this.addDiagnostic(
                                diagnostic.unexpected(','),
                                tk.offset,
                                1,
                            );
                        }
                        if (!tk.topofline) {
                            if (allIdentifierChar.test(tk.content)) {
                                if (
                                    tk.type === 'TK_NUMBER' &&
                                    _low !== 'goto'
                                ) {
                                    if (tk.content.match(/[^\d]/)) {
                                        _this.addDiagnostic(
                                            diagnostic.unexpected(tk.content),
                                            tk.offset,
                                            tk.length,
                                        );
                                    }
                                } else {
                                    tk.ignore = true;
                                    tk.type = 'TK_WORD';
                                    addlabel(tk);
                                    delete tk.semantic;
                                }
                                nexttoken();
                                next = false;
                            } else if (
                                input.charAt(lk.offset + lk.length) === '('
                            ) {
                                const s: Token[] = [];
                                parse_pair('(', ')', undefined, {}, s);
                                s.forEach((i) => {
                                    if (i.content.indexOf('\n') < 0) {
                                        addlabel({
                                            content: i.content.slice(1, -1),
                                            offset: i.offset + 1,
                                            length: i.length - 2,
                                            type: '',
                                            topofline: 0,
                                            next_token_offset: -1,
                                        });
                                    }
                                });
                                nexttoken();
                                next = false;
                            } else if (tk.type === 'TK_STRING') {
                                _this.addDiagnostic(
                                    diagnostic.unexpected(tk.content),
                                    tk.offset,
                                    tk.length,
                                );
                                nexttoken();
                                next = false;
                            } else {
                                parser_pos = lk.offset + lk.length;
                                lk.type = 'TK_WORD';
                                tk = lk;
                                lk = bak;
                                next = false;
                                _this.addDiagnostic(
                                    diagnostic.reservedworderr(tk.content),
                                    tk.offset,
                                    tk.length,
                                );
                                break;
                            }
                            if (!tk.topofline) {
                                _this.addDiagnostic(
                                    diagnostic.unexpected(tk.content),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                        } else if (((next = false), _low === 'goto')) {
                            _this.addDiagnostic(
                                diagnostic.acceptparams(_low, 1),
                                lk.offset,
                                lk.length,
                            );
                        }
                        break;
                    case 'as':
                    case 'catch':
                    case 'else':
                    case 'finally':
                    case 'until':
                        _this.addDiagnostic(
                            diagnostic.unexpected(tk.content),
                            tk.offset,
                            tk.length,
                        );
                        break;
                    case 'super':
                        if (!(mode & 3)) {
                            _this.addDiagnostic(
                                diagnostic.reservedworderr(tk.content),
                                tk.offset,
                                tk.length,
                            );
                        } else {
                            tk.ignore = true;
                        }
                        tk.type = 'TK_WORD';
                        next = false;
                        break;
                    case 'case':
                        if (case_pos.length && tk.topofline) {
                            const last_case = case_pos.pop();
                            if ((case_pos.push(tk.offset), last_case)) {
                                _this.addFoldingRange(
                                    last_case,
                                    lk.offset,
                                    'case',
                                );
                            }
                            nexttoken();
                            next = false;
                            if (tk.content !== ':' && !tk.topofline) {
                                result.push(
                                    ...parse_line(
                                        undefined,
                                        ':',
                                        'case',
                                        1,
                                        20,
                                    ),
                                );
                                if (tk.content !== ':') {
                                    _this.addDiagnostic(
                                        diagnostic.unexpected(tk.content),
                                        tk.offset,
                                        tk.length,
                                    );
                                    next = false;
                                } else {
                                    next = true;
                                    nexttoken();
                                    next = false;
                                    if (tk.type === 'TK_START_BLOCK') {
                                        tk.previous_pair_pos = beginpos;
                                    } else {
                                        tk.topofline ||= -1;
                                    }
                                }
                            } else {
                                next = tk.content === ':';
                                _this.addDiagnostic(
                                    diagnostic.unexpected(tk.content),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                        } else {
                            tk.type = 'TK_WORD';
                            _this.addDiagnostic(
                                diagnostic.reservedworderr(tk.content),
                                tk.offset,
                                tk.length,
                            );
                        }
                        break;
                    case 'try':
                        nexttoken();
                        next = false;
                        if (tk.type === 'TK_COMMA') {
                            stop_parse(lk);
                        }
                        parse_body(true, beginpos);
                        if (
                            tk.type === 'TK_RESERVED' &&
                            tk.content.toLowerCase() !== 'else'
                        ) {
                            while (tk.content.toLowerCase() === 'catch') {
                                next = true;
                                line_begin_pos = tk.offset;
                                parse_catch();
                            }
                            for (const l of ['else', 'finally']) {
                                if (tk.content.toLowerCase() === l) {
                                    next = true;
                                    line_begin_pos = tk.offset;
                                    nexttoken();
                                    next = false;
                                    parse_body(true, lk.offset);
                                }
                            }
                        }
                        break;
                    case 'isset':
                        parse_isset(input.charAt(tk.offset + 5));
                        break;
                    default:
                        nk = get_token_ignore_comment();
                        if (
                            nk.type === 'TK_EQUALS' ||
                            nk.content.match(
                                /^([<>]=?|~=|&&|\|\||[.|?:^]|\*\*?|\/\/?|<<|>>|!?==?)$/,
                            )
                        ) {
                            tk.type = 'TK_WORD';
                            parser_pos = t;
                            _this.addDiagnostic(
                                diagnostic.reservedworderr(tk.content),
                                tk.offset,
                                tk.length,
                            );
                        } else {
                            const tps: any = {};
                            lk = tk;
                            tk = nk;
                            next = false;
                            if (_low === 'return' || _low === 'throw') {
                                if (tk.type === 'TK_COMMA') {
                                    stop_parse(lk);
                                }
                                result.push(
                                    ...parse_line(tps, undefined, _low),
                                );
                                if (mode & 1 && _low === 'return') {
                                    const rg = document.positionAt(
                                        lk.offset + lk.length,
                                    );
                                    if (!_parent.returntypes) {
                                        _parent.returntypes = {};
                                    }
                                    for (const tp in tps) {
                                        _parent.returntypes[tp] = rg;
                                    }
                                }
                            } else if (_low === 'switch') {
                                result.push(
                                    ...parse_line(undefined, '{', _low, 0, 2),
                                );
                                if (tk.content === '{') {
                                    tk.previous_pair_pos = beginpos;
                                    next = true;
                                    blockpos.push(parser_pos - 1);
                                    case_pos.push(0);
                                    parse_brace(++blocks);
                                    const last_case = case_pos.pop();
                                    if (last_case) {
                                        _this.addFoldingRange(
                                            last_case,
                                            lk.offset,
                                            'case',
                                        );
                                    }
                                    nexttoken();
                                    next = false;
                                } else {
                                    _this.addDiagnostic(
                                        diagnostic.unexpected(tk.content),
                                        tk.offset,
                                        tk.length,
                                    );
                                }
                            } else if (_low === 'if' || _low === 'while') {
                                if (tk.type === 'TK_COMMA') {
                                    stop_parse(lk);
                                }
                                result.push(
                                    ...parse_line(undefined, '{', _low, 1),
                                );
                                parse_body(undefined, beginpos);
                            }
                        }
                        break;
                }

                function addlabel(tk: Token) {
                    if (_parent.labels) {
                        _low = tk.content.toUpperCase();
                        if (!_parent.labels[_low]) {
                            _parent.labels[_low] = [];
                        }
                        const rg = make_range(tk.offset, tk.length);
                        _parent.labels[_low].push(
                            (tk.symbol = tn =
                                DocumentSymbol.create(
                                    tk.content,
                                    undefined,
                                    SymbolKind.Field,
                                    rg,
                                    rg,
                                )),
                        );
                    }
                }
            }

            function parse_catch() {
                let p: Token | undefined;
                let nk: Token;
                const bp = tk.offset;
                line_begin_pos = bp;
                lk = nk = tk;
                p = get_token_ignore_comment();
                if (p.topofline || p.content !== '(') {
                    tk = p;
                    p = undefined;
                } else {
                    tk = get_token_ignore_comment();
                }
                if (
                    tk.topofline ||
                    (tk.type !== 'TK_WORD' &&
                        !allIdentifierChar.test(tk.content))
                ) {
                    if (p) {
                        parser_pos = p.offset - 1;
                        _this.addDiagnostic(
                            diagnostic.unexpected(tk.content),
                            tk.offset,
                            tk.length,
                        );
                    } else {
                        next = false;
                        if (tk.topofline || tk.content === '{') {
                            parse_body(null, bp);
                        } else {
                            _this.addDiagnostic(
                                diagnostic.unexpected(tk.content),
                                tk.offset,
                                tk.length,
                            );
                        }
                    }
                } else {
                    const tps: any = {};
                    next = true;
                    if (tk.content.toLowerCase() !== 'as') {
                        while (true) {
                            let tp = '';
                            if (tk.type !== 'TK_WORD') {
                                _this.addDiagnostic(
                                    diagnostic.unexpected(tk.content),
                                    tk.offset,
                                    tk.length,
                                );
                            } else {
                                addvariable(tk);
                                tp += tk.content;
                            }
                            lk = tk;
                            tk = get_token_ignore_comment();
                            if (tk.type === 'TK_DOT') {
                                nexttoken();
                                while (true) {
                                    if ((tk.type as string) === 'TK_WORD') {
                                        addprop(tk);
                                        tp += '.' + tk.content;
                                        nexttoken();
                                    } else if (tk.content === '%') {
                                        _this.addDiagnostic(
                                            diagnostic.unexpected(tk.content),
                                            tk.offset,
                                            tk.length,
                                        );
                                        parse_pair('%', '%');
                                        nexttoken();
                                        tp = '#any';
                                    } else {
                                        break;
                                    }
                                    if (tk.type !== 'TK_DOT') {
                                        break;
                                    } else {
                                        nexttoken();
                                    }
                                }
                            }
                            if (tp) {
                                tps[tp.toUpperCase()] ??= tp;
                            }
                            if (tk.content === ',') {
                                lk = tk;
                                tk = get_token_ignore_comment();
                                if (!allIdentifierChar.test(tk.content)) {
                                    break;
                                }
                            } else {
                                break;
                            }
                        }
                        if (p) {
                            if (tk.content === '{') {
                                _this.addDiagnostic(
                                    diagnostic.missing(')'),
                                    p.offset,
                                    1,
                                );
                                return parse_body(null, bp);
                            } else if (tk.content === ')') {
                                nexttoken();
                                next = false;
                                return parse_body(null, bp);
                            }
                        } else if (tk.content === '{' || tk.topofline) {
                            next = false;
                            return parse_body(null, bp);
                        }
                    }
                    if (tk.content.toLowerCase() === 'as') {
                        lk = tk;
                        tk = get_token_ignore_comment();
                        next = false;
                        if (
                            tk.type !== 'TK_WORD' &&
                            !allIdentifierChar.test(tk.content)
                        ) {
                            _this.addDiagnostic(
                                diagnostic.unexpected(nk.content),
                                nk.offset,
                                nk.length,
                            );
                        } else if (tk.type !== 'TK_WORD') {
                            _this.addDiagnostic(
                                diagnostic.reservedworderr(tk.content),
                                tk.offset,
                                tk.length,
                            );
                            tk.type = 'TK_WORD';
                        } else {
                            const t = get_token_ignore_comment();
                            parser_pos = tk.offset + tk.length;
                            if (
                                !t.topofline &&
                                t.content !== '{' &&
                                !(p && t.content === ')')
                            ) {
                                _this.addDiagnostic(
                                    diagnostic.unexpected(nk.content),
                                    nk.offset,
                                    nk.length,
                                );
                                next = false;
                            } else {
                                const vr = addvariable(tk);
                                if (vr) {
                                    const arr: string[] = Object.values(tps),
                                        o: any = (vr.returntypes = {});
                                    next = true;
                                    vr.def = true;
                                    if (!arr.length) {
                                        arr.push('@error');
                                    }
                                    for (const s of arr) {
                                        o[s.replace(/([^.]+)$/, '@$1')] = 0;
                                    }
                                }
                                if (p) {
                                    if (t.content === ')') {
                                        parser_pos = t.offset + 1;
                                        next = true;
                                    } else {
                                        _this.addDiagnostic(
                                            diagnostic.missing(')'),
                                            p.offset,
                                            1,
                                        );
                                    }
                                }
                                if (next) {
                                    nexttoken();
                                    next = false;
                                    parse_body(null, bp);
                                }
                            }
                        }
                    } else {
                        if (p) {
                            if (tk.content === ')') {
                                lk = tk;
                                tk = get_token_ignore_comment();
                            } else {
                                _this.addDiagnostic(
                                    diagnostic.missing(')'),
                                    p.offset,
                                    1,
                                );
                            }
                        }
                        if (!tk.topofline) {
                            _this.addDiagnostic(
                                diagnostic.unexpected(tk.content),
                                tk.offset,
                                tk.length,
                            );
                        } else {
                            next = false;
                            parse_body(null, bp);
                        }
                    }
                }
            }

            function reset_extra_index(tk: Token) {
                const t = tk.previous_extra_tokens;
                if (t) {
                    t.i = 0;
                }
            }

            function parse_top_word() {
                let c = '';
                next = true;
                nexttoken();
                next = false;
                if (
                    tk.type !== 'TK_EQUALS' &&
                    !/^(=[=>]?|\?\??|:)$/.test(tk.content) &&
                    (tk.type === 'TK_DOT' ||
                        ', \t\r\n'.includes(
                            (c = input.charAt(lk.offset + lk.length)),
                        ))
                ) {
                    if (tk.type === 'TK_DOT') {
                        next = true;
                        addvariable(lk);
                        while (nexttoken()) {
                            if ((tk.type as string) === 'TK_WORD') {
                                if (input.charAt(parser_pos) === '%') {
                                } else if (
                                    (addprop(tk),
                                    nexttoken(),
                                    tk.content === ':=')
                                ) {
                                    maybeclassprop(lk);
                                } else if (tk.type === 'TK_DOT') {
                                    continue;
                                }
                                next = false;
                                if (
                                    (tk.type as string) !== 'TK_EQUALS' &&
                                    !'=??'.includes(tk.content || ' ') &&
                                    ', \t\r\n'.includes(
                                        (c = input.charAt(
                                            lk.offset + lk.length,
                                        )),
                                    )
                                ) {
                                    parse_funccall(SymbolKind.Method, c);
                                } else {
                                    result.push(...parse_line());
                                }
                            } else {
                                next = false;
                                result.push(...parse_line());
                            }
                            break;
                        }
                    } else {
                        addvariable(lk);
                        parse_funccall(SymbolKind.Function, c);
                    }
                } else {
                    let act, offset;
                    if (/^=>?$/.test(tk.content)) {
                        act = tk.content;
                        offset = tk.offset;
                    }
                    reset_extra_index(tk);
                    tk = lk;
                    lk = EMPTY_TOKEN;
                    next = false;
                    parser_pos = tk.skip_pos ?? tk.offset + tk.length;
                    result.push(
                        ...parse_line(undefined, undefined, act, offset),
                    );
                }
            }

            function parse_funccall(type: SymbolKind, nextc: string) {
                let tn: CallInfo;
                const fc = lk;
                const pi: ParamInfo = {
                    offset: fc.offset,
                    miss: [],
                    comma: [],
                    count: 0,
                    unknown: false,
                    name: fc.content,
                };
                if (nextc === ',') {
                    if (
                        type === SymbolKind.Function &&
                        builtin_ahkv1_commands.includes(
                            fc.content.toLowerCase(),
                        ) &&
                        stop_parse(fc, true)
                    ) {
                        return;
                    }
                    _this.addDiagnostic(diagnostic.funccallerr(), tk.offset, 1);
                }
                if (
                    tk.type === 'TK_OPERATOR' &&
                    !tk.content.match(/^(not|\+\+?|--?|!|~|%|&)$/i)
                ) {
                    _this.addDiagnostic(
                        diagnostic.unexpected(tk.content),
                        tk.offset,
                        tk.length,
                    );
                }
                fc.paraminfo = pi;
                const sub = parse_line(
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    pi,
                );
                result.push(...sub);
                fc.semantic = {
                    type:
                        type === SymbolKind.Function
                            ? SemanticTokenTypes.function
                            : ((pi.method = true), SemanticTokenTypes.method),
                };
                _parent.funccall.push(
                    (tn = DocumentSymbol.create(
                        fc.content,
                        undefined,
                        type,
                        make_range(
                            fc.offset,
                            lk.offset + lk.length - fc.offset,
                        ),
                        make_range(fc.offset, fc.length),
                    )),
                );
                tn.paraminfo = pi;
                tn.offset = fc.offset;
                fc.callinfo = tn;
                if (lk === fc) {
                    const lf = input.indexOf('\n', fc.offset);
                    tn.range.end = document.positionAt(
                        lf < 0 ? input_length : lf,
                    );
                }
                if (type === SymbolKind.Method) {
                    maybeclassprop(fc, true);
                }
            }

            function parse_body(
                else_body: boolean | null = false,
                previous_pos?: number,
            ) {
                if (((block_mode = false), tk.type === 'TK_START_BLOCK')) {
                    if (previous_pos !== undefined) {
                        tk.previous_pair_pos = previous_pos;
                    }
                    next = true;
                    blockpos.push(parser_pos - 1);
                    parse_brace(++blocks);
                    nexttoken();
                    next =
                        (tk.type as string) === 'TK_RESERVED' &&
                        tk.content.toLowerCase() === 'else';
                } else {
                    if (
                        tk.type === 'TK_RESERVED' &&
                        line_starters.includes(tk.content.toLowerCase())
                    ) {
                        const t = tk;
                        next = true;
                        if (parse_reserved()) {
                            return else_body;
                        }
                        if (t === tk || (t === lk && !next && !tk.topofline)) {
                            result.push(...parse_line());
                        }
                    } else {
                        if (tk.type === 'TK_WORD') {
                            parse_top_word();
                        } else if (tk.type !== 'TK_EOF') {
                            lk = EMPTY_TOKEN;
                            next = false;
                            result.push(...parse_line());
                        }
                    }
                    if (line_begin_pos !== undefined) {
                        _this.linepos[
                            (lk.pos ??= document.positionAt(lk.offset)).line
                        ] = line_begin_pos;
                    }
                    next =
                        tk.type === 'TK_RESERVED' &&
                        tk.content.toLowerCase() === 'else';
                }
                if (typeof else_body === 'boolean') {
                    if (else_body) {
                        next = false;
                    } else if (next) {
                        line_begin_pos = tk.offset;
                        nexttoken();
                        next = false;
                        parse_body(true, lk.offset);
                        return true;
                    }
                } else {
                    next = false;
                }
                return false;
            }

            function parse_line(
                types?: any,
                end?: string,
                act?: string,
                min = 0,
                max = 1,
                pi?: ParamInfo,
            ): DocumentSymbol[] {
                let b: number;
                const res: DocumentSymbol[] = [];
                let hascomma = 0;
                let t = 0;
                let nk: Token | undefined;
                const tps: string[] = [];
                const info = pi ?? {
                    offset: 0,
                    count: 0,
                    comma: [],
                    miss: [],
                    unknown: false,
                };
                if (((block_mode = false), next)) {
                    const t = _this.get_token(parser_pos, true);
                    b = t.content ? t.offset : parser_pos + 1;
                    if (t.type === 'TK_COMMA') {
                        info.miss.push(info.count++);
                    } else if (!t.topofline || is_line_continue(tk, t)) {
                        ++info.count;
                        nk = t;
                    }
                } else {
                    b = tk.content ? tk.offset : lk.offset + lk.length + 1;
                    if (tk.type === 'TK_COMMA') {
                        info.miss.push(info.count++);
                    } else if (!tk.topofline || is_line_continue(lk, tk)) {
                        ++info.count;
                        nk = tk;
                    }
                }
                while (true) {
                    let o: any = {};
                    res.push(...parse_expression(undefined, o, 0, end));
                    if ((o = Object.keys(o).pop())) {
                        tps.push(o);
                    }
                    if (tk.type === 'TK_COMMA') {
                        next = true;
                        ++hascomma;
                        ++info.count;
                        if (
                            lk.type === 'TK_COMMA' ||
                            lk.type === 'TK_START_EXPR'
                        ) {
                            info.miss.push(info.comma.length);
                        } else if (
                            lk.type === 'TK_OPERATOR' &&
                            !lk.ignore &&
                            !lk.content.match(/(--|\+\+|%)/)
                        ) {
                            _this.addDiagnostic(
                                diagnostic.unexpected(','),
                                tk.offset,
                                1,
                            );
                        }
                        info.comma.push(tk.offset);
                        if (pi) {
                            tk.paraminfo = pi;
                        }
                    } else if (tk.topofline) {
                        next = false;
                        break;
                    } else if (end === tk.content) {
                        break;
                    } else if (t !== parser_pos) {
                        _this.addDiagnostic(
                            diagnostic.unexpected(tk.content),
                            tk.offset,
                            tk.length,
                        );
                        next = false;
                    }
                    if (
                        t === parser_pos &&
                        (!continuation_sections_mode || tk.length)
                    ) {
                        break;
                    }
                    t = parser_pos;
                }
                if (types) {
                    types[tps.pop() ?? '#void'] = 0;
                }
                if (act === '=' || act === '=>') {
                    let expr = tps[0];
                    let q: number, m;
                    if (act === '=>' && (m = expr.match(/^\s\$(\d+)$/))) {
                        expr =
                            Object.keys(
                                (_this.anonymous[m[1] as any] as FuncNode)
                                    ?.returntypes ?? {},
                            ).pop() ?? ' ';
                    }
                    if (
                        expr &&
                        ((q = expr.indexOf('?')) === -1 ||
                            expr.indexOf(':', q) === -1)
                    ) {
                        if (act === '=') {
                            stop_parse(
                                _this.tokens[(nk as Token).next_token_offset],
                            );
                        }
                        _this.addDiagnostic(
                            `${diagnostic.unexpected(act)}, ${diagnostic
                                .didyoumean(':=')
                                .toLowerCase()}`,
                            min,
                            act.length,
                        );
                    }
                } else if (
                    act &&
                    (hascomma >= max || info.count - (tk === nk ? 1 : 0) < min)
                ) {
                    _this.addDiagnostic(
                        diagnostic.acceptparams(
                            act,
                            max === min ? min : `${min}~${max}`,
                        ),
                        b,
                        lk.offset + lk.length - b,
                    );
                }
                if (lk.content === '*') {
                    info.unknown = true;
                    info.count--;
                }
                return res;
            }

            function parse_sharp() {
                let isdll = false;
                const data = tk.data ?? {
                    content: '',
                    offset: tk.offset + tk.length,
                    length: 0,
                };
                let l: string;
                switch ((l = tk.content.toLowerCase())) {
                    case '#dllload':
                        isdll = true;
                    case '#include':
                    case '#includeagain':
                        add_include_dllload(
                            data.content.replace(/`;/g, ';'),
                            data,
                            mode,
                            isdll,
                        );
                        break;
                    case '#dllimport':
                        if (
                            (m = data.content.match(/^((\w|[^\x00-\x7f])+)/i))
                        ) {
                            const rg = make_range(data.offset, m[0].length),
                                rg2 = Range.create(0, 0, 0, 0);
                            const tps: { [t: string]: string } = {
                                t: 'ptr',
                                i: 'int',
                                s: 'str',
                                a: 'astr',
                                w: 'wstr',
                                h: 'short',
                                c: 'char',
                                f: 'float',
                                d: 'double',
                                I: 'int64',
                            };
                            const n = m[0];
                            const args: Variable[] = [];
                            let arg: Variable | undefined;
                            let u = '';
                            let i = 0;
                            h = true;
                            m = data.content
                                .substring(m[0].length)
                                .match(/^\s*,[^,]+,([^,]*)/);
                            if (m) {
                                for (const c of m[1]
                                    .replace(/\s/g, '')
                                    .replace(/^\w*[=@]?=/, '')
                                    .toLowerCase()
                                    .replace(/i6/g, 'I')) {
                                    if (c === 'u') {
                                        u = 'u';
                                    } else {
                                        if (tps[c]) {
                                            args.push(
                                                (arg = Variable.create(
                                                    `p${++i}_${u + tps[c]}`,
                                                    SymbolKind.Variable,
                                                    rg2,
                                                )),
                                            );
                                            arg.defaultVal = null;
                                            u = '';
                                        } else if (
                                            arg &&
                                            (c === '*' || c === 'p')
                                        ) {
                                            arg.name += 'p';
                                            arg = undefined;
                                        } else {
                                            _this.addDiagnostic(
                                                diagnostic.invalidparam(),
                                                data.offset,
                                                data.length,
                                            );
                                            return;
                                        }
                                    }
                                }
                            }
                            const fn = FuncNode.create(
                                n,
                                SymbolKind.Function,
                                rg,
                                rg,
                                args,
                            );
                            fn.returntypes = { '#number': 0 };
                            result.push(fn);
                        }
                        break;
                    case '#requires':
                        h ||= (l = data.content.toLowerCase()).startsWith(
                            'autohotkey_h',
                        );
                        if ((m = l.match(/^\w+\s+v(1|2)/))) {
                            if (m[1] === '2') {
                                requirev2 = true;
                            } else if (
                                ((_this.maybev1 = 3),
                                !stop_parse(data, true, diagnostic.requirev1()))
                            ) {
                                _this.addDiagnostic(
                                    diagnostic.unexpected(data.content),
                                    data.offset,
                                    data.length,
                                );
                            }
                        }
                        break;
                    case '#hotif':
                        if (mode !== 0) {
                            _this.addDiagnostic(
                                diagnostic.invalidusage(tk.content),
                                tk.offset,
                                tk.length,
                            );
                        } else {
                            if (last_hotif !== undefined) {
                                _this.addFoldingRange(last_hotif, tk.offset);
                            }
                            nexttoken();
                            next = false;
                            last_hotif = tk.topofline ? undefined : lk.offset;
                        }
                        break;
                    default:
                        if (
                            l.match(
                                /^#(if|hotkey|(noenv|persistent|commentflag|escapechar|menumaskkey|maxmem|maxhotkeysperinterval|keyhistory)\b)/i,
                            ) &&
                            !stop_parse(tk, true)
                        ) {
                            _this.addDiagnostic(
                                diagnostic.unexpected(tk.content),
                                tk.offset,
                                tk.length,
                            );
                        }
                        break;
                }
            }

            function parse_statement(local: string) {
                const sta: Variable[] = [];
                let bak: Token, pc: Token | undefined;
                block_mode = false;
                loop: while (nexttoken()) {
                    if (
                        tk.topofline === 1 &&
                        !is_line_continue(lk, tk, _parent)
                    ) {
                        next = false;
                        break;
                    }
                    switch (tk.type) {
                        case 'TK_WORD':
                            bak = lk;
                            nexttoken();
                            if ((tk.type as string) === 'TK_EQUALS') {
                                let vr: Variable | undefined;
                                const o: any = {},
                                    equ = tk.content,
                                    pp = parser_pos;
                                if (bak.type === 'TK_DOT') {
                                    addprop(lk);
                                } else if ((vr = addvariable(lk, mode, sta))) {
                                    if (
                                        (pc =
                                            comments[
                                                vr.selectionRange.start.line
                                            ])
                                    ) {
                                        vr.detail = trim_comment(pc.content);
                                    }
                                } else if (local) {
                                    _this.addDiagnostic(
                                        diagnostic.conflictserr(
                                            local,
                                            'built-in variable',
                                            lk.content,
                                        ),
                                        lk.offset,
                                        lk.length,
                                    );
                                }
                                result.push(...parse_expression(undefined, o));
                                _parent.ranges?.push([
                                    pp,
                                    lk.offset + lk.length,
                                ]);
                                if (vr) {
                                    vr.returntypes = {
                                        [equ === ':='
                                            ? Object.keys(o)
                                                  .pop()
                                                  ?.toUpperCase() || '#any'
                                            : equ === '.='
                                            ? '#string'
                                            : '#number']: true,
                                    };
                                    vr.range = {
                                        start: vr.range.start,
                                        end: document.positionAt(
                                            lk.offset + lk.length,
                                        ),
                                    };
                                    vr.def = true;
                                    const tt = vr.returntypes;
                                    for (const t in tt) {
                                        tt[t] = vr.range.end;
                                    }
                                }
                            } else {
                                if (mode === 2) {
                                    const llk = lk;
                                    const ttk = tk;
                                    let err = diagnostic.propnotinit();
                                    (
                                        addvariable(lk, 2, sta) ??
                                        ({} as Variable)
                                    ).def = false;
                                    if ((tk.type as string) === 'TK_DOT') {
                                        while (
                                            nexttoken() &&
                                            tk.type === 'TK_WORD'
                                        ) {
                                            if (!nexttoken()) {
                                                break;
                                            }
                                            if (
                                                (tk.type as string) ===
                                                'TK_EQUALS'
                                            ) {
                                                const pp = parser_pos;
                                                addprop(lk);
                                                result.push(
                                                    ...parse_expression(),
                                                );
                                                _parent.ranges?.push([
                                                    pp,
                                                    lk.offset + lk.length,
                                                ]);
                                                continue loop;
                                            }
                                            if (
                                                (tk.type as string) === 'TK_DOT'
                                            ) {
                                                addprop(lk);
                                            } else if (
                                                tk.topofline &&
                                                (allIdentifierChar.test(
                                                    tk.content,
                                                ) ||
                                                    tk.content === '}')
                                            ) {
                                                lk = EMPTY_TOKEN;
                                                next = false;
                                                break loop;
                                            } else {
                                                if (tk.content !== ',') {
                                                    err =
                                                        diagnostic.propdeclaraerr();
                                                } else {
                                                    err = '';
                                                }
                                                break;
                                            }
                                        }
                                    }
                                    if (err) {
                                        _this.addDiagnostic(
                                            err,
                                            lk.offset,
                                            lk.length,
                                        );
                                    }
                                    if (
                                        tk.topofline &&
                                        allIdentifierChar.test(tk.content)
                                    ) {
                                        lk = EMPTY_TOKEN;
                                        next = false;
                                        break loop;
                                    }
                                    if (
                                        !tk.topofline &&
                                        (tk.type as string) !== 'TK_COMMA'
                                    ) {
                                        next = false;
                                        lk = llk;
                                        tk = ttk;
                                        parser_pos = tk.offset + tk.length;
                                        parse_expression(',');
                                    }
                                    next = false;
                                    break;
                                }
                                if (
                                    (tk.type as string) === 'TK_COMMA' ||
                                    (tk.topofline &&
                                        !(
                                            [
                                                'TK_COMMA',
                                                'TK_OPERATOR',
                                                'TK_EQUALS',
                                            ].includes(tk.type) &&
                                            !tk.content.match(/^(!|~|not)$/i)
                                        ))
                                ) {
                                    const vr = addvariable(lk, mode, sta);
                                    if (vr) {
                                        if (
                                            (pc =
                                                comments[
                                                    vr.selectionRange.start.line
                                                ])
                                        ) {
                                            vr.detail = trim_comment(
                                                pc.content,
                                            );
                                        }
                                    } else if (local) {
                                        _this.addDiagnostic(
                                            diagnostic.conflictserr(
                                                local,
                                                'built-in variable',
                                                lk.content,
                                            ),
                                            lk.offset,
                                            lk.length,
                                        );
                                    }
                                    if ((tk.type as string) !== 'TK_COMMA') {
                                        break loop;
                                    }
                                }
                            }
                            break;
                        case 'TK_COMMA':
                            continue;
                        case 'TK_UNKNOWN':
                            _this.addDiagnostic(
                                diagnostic.unknowntoken(tk.content),
                                tk.offset,
                                tk.length,
                            );
                            break;
                        case 'TK_RESERVED':
                            if (mode !== 2) {
                                _this.addDiagnostic(
                                    diagnostic.reservedworderr(tk.content),
                                    tk.offset,
                                    tk.length,
                                );
                            }
                            next = false;
                            tk.type = 'TK_WORD';
                            break;
                        case 'TK_END_BLOCK':
                            next = false;
                        case 'TK_END_EXPR':
                            _this.addDiagnostic(
                                diagnostic.unexpected(tk.content),
                                tk.offset,
                                1,
                            );
                        default:
                            break loop;
                    }
                }
                return sta;
            }

            function parse_expression(
                inpair?: string,
                types: any = {},
                mustexp = 1,
                end?: string,
            ): DocumentSymbol[] {
                const pres = result.length;
                let tpexp = '';
                let byref = undefined;
                const ternarys: number[] = [];
                let t: any;
                block_mode = false;
                while (nexttoken()) {
                    if (tk.topofline === 1) {
                        if (
                            (!inpair || inpair === ',') &&
                            !is_line_continue(lk, tk, _parent)
                        ) {
                            if (
                                lk.type === 'TK_WORD' &&
                                input.charAt(lk.offset - 1) === '.'
                            ) {
                                addprop(lk);
                            }
                            next = false;
                            break;
                        } else if (lk !== EMPTY_TOKEN) {
                            tk.topofline = -1;
                        }
                    }
                    switch (tk.type) {
                        case 'TK_WORD':
                            const predot = input.charAt(tk.offset - 1) === '.';
                            if (input.charAt(parser_pos) === '(') {
                                break;
                            }
                            nexttoken();
                            if ((tk.type as string) === 'TK_COMMA') {
                                if (predot) {
                                    addprop(lk);
                                    tpexp += '.' + lk.content;
                                } else if (
                                    input.charAt(lk.offset - 1) !== '%'
                                ) {
                                    const vr = addvariable(lk);
                                    if (vr && byref !== undefined) {
                                        vr.def = true;
                                        if (byref) {
                                            vr.ref = vr.assigned = true;
                                            tpexp =
                                                tpexp.slice(0, -1) + ' #varref';
                                        } else {
                                            tpexp +=
                                                check_concat(lk) + lk.content;
                                            vr.returntypes = {
                                                '#number': 0,
                                            };
                                        }
                                    } else {
                                        tpexp += check_concat(lk) + lk.content;
                                    }
                                } else {
                                    lk.ignore = true;
                                }
                                types[tpexp] = 0;
                                next = false;
                                return result.splice(pres);
                            } else if (tk.content === '=>') {
                                const o: any = {},
                                    rl = result.length,
                                    fl = _parent.funccall.length,
                                    p = lk,
                                    _mode = mode;
                                mode = 1;
                                const rg = make_range(p.offset, p.length);
                                const sub = parse_expression(
                                    inpair,
                                    o,
                                    mustexp || 1,
                                    end ?? (ternarys.length ? ':' : undefined),
                                );
                                mode = _mode;
                                const tn = FuncNode.create(
                                    '',
                                    SymbolKind.Function,
                                    make_range(
                                        p.offset,
                                        lk.offset + lk.length - p.offset,
                                    ),
                                    make_range(p.offset, 0),
                                    [
                                        Variable.create(
                                            p.content,
                                            SymbolKind.Variable,
                                            rg,
                                        ),
                                    ],
                                    result.splice(rl).concat(sub),
                                );
                                tn.funccall = _parent.funccall.splice(fl);
                                tn.returntypes = o;
                                for (const t in o) {
                                    o[t] = tn.range.end;
                                }
                                if (mode !== 0) {
                                    tn.parent = _parent;
                                }
                                adddeclaration(tn);
                                result.push(tn);
                                tpexp += ` $${_this.anonymous.push(tn) - 1}`;
                                break;
                            } else if (
                                (tk.type as string) === 'TK_OPERATOR' &&
                                (!tk.topofline ||
                                    !tk.content.match(/^(!|~|not|\+\+|--)$/i))
                            ) {
                                let suf = ['++', '--'].includes(tk.content);
                                if (
                                    input.charAt(lk.offset - 1) !== '%' &&
                                    input.charAt(lk.offset + lk.length) !== '%'
                                ) {
                                    if (predot) {
                                        tpexp += '.' + lk.content;
                                        addprop(lk);
                                    } else {
                                        tpexp += check_concat(lk) + lk.content;
                                        const vr = addvariable(lk);
                                        if (vr) {
                                            if (suf) {
                                                vr.def = true;
                                                vr.returntypes = {
                                                    '#number': 0,
                                                };
                                            } else if (
                                                tk.content === '??' ||
                                                tk.ignore
                                            ) {
                                                vr.returntypes = null;
                                            }
                                        }
                                    }
                                } else if (predot) {
                                    tpexp += '.#any';
                                    maybeclassprop(lk, null);
                                    tk = lk;
                                    lk = tk.previous_token ?? EMPTY_TOKEN;
                                    parse_prop();
                                    nexttoken();
                                    suf ||= ['++', '--'].includes(tk.content);
                                } else {
                                    tpexp += check_concat(lk) + '#any';
                                    lk.ignore = true;
                                }
                                if (!suf) {
                                    next = false;
                                }
                                continue;
                            } else if (
                                tk.topofline &&
                                (tk.type as string) !== 'TK_EQUALS' &&
                                (tk.type as string) !== 'TK_DOT'
                            ) {
                                next = false;
                                if (!predot) {
                                    if (input.charAt(lk.offset - 1) !== '%') {
                                        const vr = addvariable(lk);
                                        if (vr && byref !== undefined) {
                                            vr.def = true;
                                            if (byref) {
                                                vr.ref = vr.assigned = true;
                                                tpexp =
                                                    tpexp.slice(0, -1) +
                                                    ' #varref';
                                            } else {
                                                tpexp +=
                                                    check_concat(lk) +
                                                    lk.content;
                                                vr.returntypes = {
                                                    '#number': 0,
                                                };
                                            }
                                        } else {
                                            tpexp +=
                                                check_concat(lk) + lk.content;
                                        }
                                    } else {
                                        lk.ignore = true;
                                    }
                                    types[tpexp] = 0;
                                } else if (
                                    input.charAt(lk.offset - 1) !== '%'
                                ) {
                                    addprop(lk);
                                    types[tpexp + '.' + lk.content] = 0;
                                } else {
                                    types['#any'] = 0;
                                    lk.ignore = true;
                                }
                                ternaryMiss();
                                return result.splice(pres);
                            }
                            if (!predot) {
                                let vr: Variable | undefined;
                                if (
                                    input.charAt(lk.offset - 1) !== '%' &&
                                    (vr = addvariable(lk))
                                ) {
                                    if (byref !== undefined) {
                                        vr.def = true;
                                        if (byref) {
                                            vr.ref = vr.assigned = true;
                                        } else {
                                            vr.returntypes = {
                                                '#number': 0,
                                            };
                                        }
                                    }
                                    if ((tk.type as string) === 'TK_EQUALS') {
                                        if (
                                            (_cm =
                                                comments[
                                                    vr.selectionRange.start.line
                                                ])
                                        ) {
                                            vr.detail = trim_comment(
                                                _cm.content,
                                            );
                                        }
                                        const o: any = {},
                                            equ = tk.content;
                                        next = true;
                                        result.push(
                                            ...parse_expression(
                                                inpair,
                                                o,
                                                mustexp || 1,
                                                end ??
                                                    (ternarys.length
                                                        ? ':'
                                                        : undefined),
                                            ),
                                        );
                                        vr.range = {
                                            start: vr.range.start,
                                            end: document.positionAt(
                                                lk.offset + lk.length,
                                            ),
                                        };
                                        const tp =
                                            equ === ':='
                                                ? Object.keys(o)
                                                      .pop()
                                                      ?.toUpperCase() || '#any'
                                                : equ === '.='
                                                ? '#string'
                                                : '#number';
                                        vr.returntypes ??= {
                                            [tp]: vr.range.end,
                                        };
                                        if (vr.ref) {
                                            tpexp =
                                                tpexp.slice(0, -1) + '#varref';
                                        } else {
                                            tpexp += tp;
                                            vr.def = true;
                                        }
                                    } else {
                                        next = false;
                                        if (vr.ref) {
                                            if (
                                                (tk.type as string) === 'TK_DOT'
                                            ) {
                                                _this.addDiagnostic(
                                                    diagnostic.requirevariable(),
                                                    lk.previous_token!.offset,
                                                    1,
                                                );
                                            }
                                            tpexp =
                                                tpexp.slice(0, -1) + '#varref';
                                        } else {
                                            tpexp +=
                                                check_concat(lk) + lk.content;
                                        }
                                    }
                                } else {
                                    tpexp += check_concat(lk) + lk.content;
                                    next = false;
                                    lk.ignore = true;
                                }
                            } else {
                                if ((tk.type as string) === 'TK_EQUALS') {
                                    tpexp = tpexp.replace(/\s*\S+$/, '');
                                    next = true;
                                    if (tk.content === ':=') {
                                        maybeclassprop(lk);
                                    }
                                } else {
                                    tpexp += '.' + lk.content;
                                    next = false;
                                }
                                addprop(lk);
                            }
                            break;
                        case 'TK_START_EXPR':
                            if (tk.content === '[') {
                                const pre =
                                    !tk.topofline &&
                                    ((lk.previous_pair_pos !== undefined &&
                                        lk.content === '%') ||
                                        [
                                            'TK_WORD',
                                            'TK_STRING',
                                            'WK_NUMBER',
                                            'TK_END_EXPR',
                                            'TK_END_BLOCK',
                                        ].includes(lk.type));
                                parse_pair('[', ']');
                                if (pre) {
                                    tpexp = tpexp.replace(/\S+$/, '') + '#any';
                                } else {
                                    tpexp += ' #array';
                                }
                            } else {
                                let fc: Token | undefined;
                                let quoteend: number;
                                const tpe: any = {};
                                const b = tk.offset;
                                const nospace =
                                    !lk.type ||
                                    input.charAt(lk.offset + lk.length) === '(';
                                const rl = result.length,
                                    ttk = tk;
                                if (lk.type === 'TK_WORD' && nospace) {
                                    if (input.charAt(lk.offset - 1) === '.') {
                                        const ptk = lk,
                                            o: any = {};
                                        parse_pair('(', ')', undefined, o);
                                        let tn: CallInfo;
                                        const pp = ttk.paraminfo?.count
                                            ? `(${ttk.offset})`
                                            : '()';
                                        ptk.semantic = {
                                            type: SemanticTokenTypes.method,
                                        };
                                        _parent.funccall.push(
                                            (tn = DocumentSymbol.create(
                                                ptk.content,
                                                undefined,
                                                SymbolKind.Method,
                                                make_range(
                                                    ptk.offset,
                                                    parser_pos - ptk.offset,
                                                ),
                                                make_range(
                                                    ptk.offset,
                                                    ptk.length,
                                                ),
                                            )),
                                        );
                                        Object.assign(ttk.paraminfo ?? {}, {
                                            name: ptk.content,
                                            method: true,
                                        });
                                        tn.paraminfo = o.paraminfo;
                                        tn.offset = ptk.offset;
                                        ptk.callinfo = tn;
                                        tpexp += '.' + ptk.content + pp;
                                        maybeclassprop(ptk, true);
                                        continue;
                                    } else {
                                        fc = lk;
                                    }
                                }
                                parse_pair('(', ')', undefined, tpe);
                                quoteend = parser_pos;
                                if (
                                    _this.get_token(parser_pos).content === '=>'
                                ) {
                                    result.splice(rl);
                                    lk =
                                        (tk = ttk).previous_token ??
                                        EMPTY_TOKEN;
                                    parser_pos = tk.offset + 1;
                                    let par = parse_params();
                                    const rs = result.splice(rl);
                                    const pfl = _parent.funccall.length,
                                        bbb = fc ? fc.offset : b;
                                    quoteend = parser_pos;
                                    nexttoken();
                                    if (fc) {
                                        if (fc.content.match(/^\d/)) {
                                            _this.addDiagnostic(
                                                diagnostic.invalidsymbolname(
                                                    fc.content,
                                                ),
                                                fc.offset,
                                                fc.length,
                                            );
                                        }
                                        fc.semantic = {
                                            type: SemanticTokenTypes.function,
                                            modifier:
                                                (1 <<
                                                    SemanticTokenModifiers.definition) |
                                                (1 <<
                                                    SemanticTokenModifiers.readonly),
                                        };
                                    } else {
                                        fc = Object.assign({}, EMPTY_TOKEN, {
                                            offset: ttk.offset,
                                        });
                                    }
                                    if (!par) {
                                        par = [];
                                        _this.addDiagnostic(
                                            diagnostic.invalidparam(),
                                            bbb,
                                            quoteend - bbb,
                                        );
                                    }
                                    const tn = FuncNode.create(
                                        fc.content,
                                        SymbolKind.Function,
                                        make_range(fc.offset, 0),
                                        make_range(fc.offset, fc.length),
                                        par,
                                    );
                                    const _p = _parent,
                                        _m = mode;
                                    _parent = tn;
                                    mode = 1;
                                    result.push(
                                        (fc.symbol = fc.definition = tn),
                                    );
                                    tn.children = rs.concat(
                                        parse_expression(
                                            inpair,
                                            (o = {}),
                                            fc?.topofline ? 2 : mustexp || 1,
                                            end ??
                                                (ternarys.length
                                                    ? ':'
                                                    : undefined),
                                        ),
                                    );
                                    _parent = _p;
                                    mode = _m;
                                    tn.range.end = _this.document.positionAt(
                                        lk.offset + lk.length,
                                    );
                                    tn.returntypes = o;
                                    _this.addFoldingRangePos(
                                        tn.range.start,
                                        tn.range.end,
                                        'line',
                                    );
                                    tn.funccall?.push(
                                        ..._parent.funccall.splice(pfl),
                                    );
                                    for (const t in o) {
                                        o[t] = tn.range.end;
                                    }
                                    if (mode !== 0) {
                                        tn.parent = _parent;
                                    }
                                    adddeclaration(tn);
                                    if (fc.content) {
                                        tpexp += ' ' + fc.content.toLowerCase();
                                    } else {
                                        tpexp += ` $${
                                            _this.anonymous.push(tn) - 1
                                        }`;
                                    }
                                    types[tpexp] = 0;
                                } else {
                                    if (fc) {
                                        if (
                                            input.charAt(fc.offset - 1) !==
                                                '%' ||
                                            fc.previous_token
                                                ?.previous_pair_pos ===
                                                undefined
                                        ) {
                                            let tn: CallInfo;
                                            const pp = ttk.paraminfo?.count
                                                ? `(${ttk.offset})`
                                                : '()';
                                            tpexp +=
                                                check_concat(fc) +
                                                fc.content +
                                                pp;
                                            addvariable(fc);
                                            fc.semantic ??= {
                                                type: SemanticTokenTypes.function,
                                            };
                                            _parent.funccall.push(
                                                (tn = DocumentSymbol.create(
                                                    fc.content,
                                                    undefined,
                                                    SymbolKind.Function,
                                                    make_range(
                                                        fc.offset,
                                                        quoteend - fc.offset,
                                                    ),
                                                    make_range(
                                                        fc.offset,
                                                        fc.length,
                                                    ),
                                                )),
                                            );
                                            Object.assign(ttk.paraminfo ?? {}, {
                                                name: fc.content,
                                            });
                                            tn.paraminfo = tpe.paraminfo;
                                            tn.offset = fc.offset;
                                            fc.callinfo = tn;
                                        } else {
                                            fc.ignore = true;
                                        }
                                    } else {
                                        let s = Object.keys(tpe).pop() || '';
                                        if (input.charAt(quoteend) === '(') {
                                            const t = s
                                                .trim()
                                                .match(
                                                    /^\(\s*(([\w.]|[^\x00-\x7f])+)\s*\)$/,
                                                );
                                            if (t) {
                                                s = t[1];
                                            }
                                        }
                                        if (nospace) {
                                            tpexp +=
                                                tpexp === '' ||
                                                tpexp.slice(-1).match(/\s/)
                                                    ? s
                                                    : '()';
                                        } else {
                                            tpexp += ' ' + s;
                                        }
                                    }
                                }
                            }
                            break;
                        case 'TK_START_BLOCK':
                            if (
                                tpexp &&
                                !(
                                    lk.type === 'TK_OPERATOR' &&
                                    !lk.content.match(/^(\+\+|--)$/)
                                ) &&
                                lk.type !== 'TK_EQUALS'
                            ) {
                                types[tpexp] = 0;
                                next = false;
                                ternaryMiss();
                                return result.splice(pres);
                            } else {
                                const l = _this.diagnostics.length;
                                let isobj = false;
                                if (
                                    lk.type === 'TK_RESERVED' &&
                                    lk.content.toLowerCase() === 'switch'
                                ) {
                                    let t: Token;
                                    next = false;
                                    if (
                                        tk.topofline ||
                                        (t = _this.get_token(parser_pos))
                                            .topofline ||
                                        t.type.endsWith('COMMENT')
                                    ) {
                                        ternaryMiss();
                                        return result.splice(pres);
                                    }
                                    next = isobj = true;
                                } else if (lk.type === 'TK_EQUALS') {
                                    if (lk.content !== ':=') {
                                        _this.addDiagnostic(
                                            diagnostic.unknownoperatoruse(
                                                lk.content,
                                            ),
                                            lk.offset,
                                            lk.length,
                                        );
                                    }
                                } else if (mustexp === 1) {
                                    if (
                                        lk.type === 'TK_WORD' ||
                                        lk.type === 'TK_OPERATOR' ||
                                        lk.type.startsWith('TK_END')
                                    ) {
                                        mustexp = 0;
                                    }
                                }
                                if (parse_obj(mustexp > 0 || isobj, (t = {}))) {
                                    tpexp +=
                                        ' ' +
                                        (Object.keys(t).pop() || '#object');
                                    break;
                                } else {
                                    types[tpexp] = 0;
                                    _this.diagnostics.splice(l);
                                    ternaryMiss();
                                    next = false;
                                    return result.splice(pres);
                                }
                            }
                        case 'TK_NUMBER':
                            tpexp += check_concat(tk) + '#number';
                            break;
                        case 'TK_STRING':
                            tpexp += check_concat(tk) + '#string';
                            break;
                        case 'TK_END_BLOCK':
                        case 'TK_END_EXPR':
                        case 'TK_COMMA':
                            next = false;
                            types[tpexp] = 0;
                            ternaryMiss();
                            return result.splice(pres);
                        case 'TK_LABEL':
                            _this.addDiagnostic(
                                diagnostic.unexpected(tk.content),
                                tk.offset,
                                tk.length,
                            );
                            break;
                        case 'TK_UNKNOWN':
                            _this.addDiagnostic(
                                diagnostic.unknowntoken(tk.content),
                                tk.offset,
                                tk.length,
                            );
                            break;
                        case 'TK_RESERVED': {
                            const c = input.charAt(tk.offset + tk.length);
                            if (
                                c === '%' ||
                                input.charAt(tk.offset - 1) === '%'
                            ) {
                                next = false;
                                tk.type = 'TK_WORD';
                                tk.semantic = {
                                    type: SemanticTokenTypes.variable,
                                };
                                break;
                            }
                            if (/^(class|super|isset)$/i.test(tk.content)) {
                                if (
                                    tk.content.toLowerCase() === 'isset' &&
                                    parse_isset(c)
                                ) {
                                    break;
                                }
                                next = false;
                                tk.type = 'TK_WORD';
                                break;
                            }
                            _this.addDiagnostic(
                                diagnostic.reservedworderr(tk.content),
                                tk.offset,
                                tk.length,
                            );
                            break;
                        }
                        case 'TK_OPERATOR':
                            if (tk.content === '%') {
                                const prec = input.charAt(tk.offset - 1);
                                if (inpair === '%') {
                                    next = false;
                                    types[tpexp] = 0;
                                    ternaryMiss();
                                    return result.splice(pres);
                                } else if (prec.match(/\w|\.|[^\x00-\x7f]/)) {
                                    tpexp = tpexp.replace(/\S+$/, '#any');
                                } else {
                                    tpexp += check_concat(tk) + '#any';
                                }
                                if (prec === '.') {
                                    maybeclassprop(tk, null);
                                    parse_prop();
                                } else {
                                    parse_pair('%', '%');
                                }
                            } else if (
                                tk.content === '=>' &&
                                lk.type === 'TK_WORD'
                            ) {
                                if (
                                    result.length &&
                                    result[result.length - 1].name ===
                                        lk.content
                                ) {
                                    result.pop();
                                }
                                const tn = FuncNode.create(
                                    '',
                                    SymbolKind.Function,
                                    make_range(lk.offset, lk.length),
                                    make_range(lk.offset, 0),
                                    [
                                        Variable.create(
                                            lk.content,
                                            SymbolKind.Variable,
                                            make_range(lk.offset, lk.length),
                                        ),
                                    ],
                                );
                                const prec = _parent.funccall.length,
                                    o: any = {};
                                tn.children = parse_expression(
                                    inpair,
                                    o,
                                    1,
                                    end ?? (ternarys.length ? ':' : undefined),
                                );
                                tn.range.end = document.positionAt(
                                    lk.offset + lk.length,
                                );
                                tn.funccall = _parent.funccall.splice(prec);
                                tn.returntypes = o;
                                for (const t in o) {
                                    o[t] = tn.range.end;
                                }
                                if (mode !== 0) {
                                    tn.parent = _parent;
                                }
                                result.push(tn);
                                adddeclaration(tn);
                                tpexp = tpexp.replace(
                                    /\S+$/,
                                    `$${_this.anonymous.push(tn) - 1}`,
                                );
                            } else {
                                if (
                                    allIdentifierChar.test(tk.content) &&
                                    (input[tk.offset - 1] === '%' ||
                                        input[tk.offset + tk.length] === '%')
                                ) {
                                    next = false;
                                    tk.type = 'TK_WORD';
                                    tk.semantic = {
                                        type: SemanticTokenTypes.variable,
                                    };
                                    break;
                                }
                                tpexp += ' ' + tk.content;
                                if (
                                    lk.type === 'TK_OPERATOR' &&
                                    !lk.content.match(/^([:?%]|\+\+|--|=>)$/) &&
                                    !tk.content.match(/[+\-%!~]|^not$/i)
                                ) {
                                    _this.addDiagnostic(
                                        diagnostic.unknownoperatoruse(),
                                        tk.offset,
                                        tk.length,
                                    );
                                }
                                if (tk.content === '&') {
                                    if (
                                        lk.paraminfo ||
                                        [
                                            'TK_EQUALS',
                                            'TK_COMMA',
                                            'TK_START_EXPR',
                                            'TK_OPERATOR',
                                            '',
                                        ].includes(lk.type)
                                    ) {
                                        byref = true;
                                        continue;
                                    }
                                } else if (tk.content === '?') {
                                    if (tk.ignore) {
                                        tpexp = tpexp.slice(0, -2);
                                    } else {
                                        ternarys.push(tk.offset);
                                    }
                                } else if (['++', '--'].includes(tk.content)) {
                                    byref = false;
                                    tpexp = tpexp.slice(0, -3);
                                    continue;
                                } else if (
                                    tk.content === ':' &&
                                    ternarys.pop() === undefined
                                ) {
                                    if (end === ':') {
                                        next = false;
                                        tpexp = tpexp.slice(0, -2);
                                        types[tpexp] = 0;
                                        return result.splice(pres);
                                    }
                                    _this.addDiagnostic(
                                        diagnostic.unexpected(':'),
                                        tk.offset,
                                        1,
                                    );
                                }
                            }
                            break;
                        case 'TK_EQUALS':
                            tpexp += ' ' + tk.content;
                            break;
                    }
                    byref = undefined;
                }
                types[tpexp] = 0;
                ternaryMiss();
                return result.splice(pres);

                function ternaryMiss() {
                    let o: number | undefined;
                    while ((o = ternarys.pop()) !== undefined) {
                        _this.addDiagnostic(diagnostic.missing(':'), o, 1);
                    }
                }
            }

            function parse_params(types: any = {}, must = false, endc = ')') {
                let paramsdef = true;
                const beg = parser_pos - 1;
                const cache: Variable[] = [];
                let rg;
                const la = [',', endc === ')' ? '(' : '['];
                let byref = false;
                let tpexp = '';
                let bb = parser_pos;
                let bak = tk;
                let hasexpr = false;
                const info: ParamInfo = {
                    offset: beg,
                    count: 0,
                    comma: [],
                    miss: [],
                    unknown: false,
                };
                block_mode = false;
                bak.paraminfo = info;
                if (
                    lk.type === 'TK_WORD' &&
                    bak.prefix_is_whitespace === undefined
                ) {
                    info.name = lk.content;
                }
                while (nexttoken()) {
                    if (tk.topofline === 1) {
                        tk.topofline = -1;
                    }
                    if (tk.content === endc) {
                        if (lk.type === 'TK_COMMA') {
                            if (must) {
                                _this.addDiagnostic(
                                    diagnostic.unexpected(endc),
                                    tk.offset,
                                    tk.length,
                                );
                                break;
                            }
                            types['#void'] = 0;
                            tk.previous_pair_pos = beg;
                            info.miss.push(info.count++);
                            Object.defineProperty(types, 'paraminfo', {
                                value: info,
                                configurable: true,
                            });
                            result.push(...cache);
                            return;
                        }
                        break;
                    } else if (tk.type === 'TK_WORD') {
                        if (is_builtinvar(tk.content.toLowerCase())) {
                            paramsdef = false;
                            break;
                        }
                        info.count++;
                        if (la.includes(lk.content) || lk === EMPTY_TOKEN) {
                            nexttoken();
                            if (tk.content === ',' || tk.content === endc) {
                                if (lk.content.match(/^\d/)) {
                                    _this.addDiagnostic(
                                        diagnostic.invalidsymbolname(
                                            lk.content,
                                        ),
                                        lk.offset,
                                        lk.length,
                                    );
                                }
                                const tn = Variable.create(
                                    lk.content,
                                    SymbolKind.Variable,
                                    (rg = make_range(lk.offset, lk.length)),
                                );
                                if (
                                    (_cm =
                                        comments[tn.selectionRange.start.line])
                                ) {
                                    tn.detail = trim_comment(_cm?.content);
                                }
                                if (byref) {
                                    byref = false;
                                    tn.ref = tn.def = tn.assigned = true;
                                    tpexp = '#varref';
                                } else {
                                    tpexp = ' ' + tn.name;
                                }
                                cache.push(tn);
                                bb = parser_pos;
                                bak = tk;
                                if (tk.content === ',') {
                                    info.comma.push(tk.offset);
                                } else {
                                    break;
                                }
                            } else if (
                                tk.content === ':=' ||
                                (must && tk.content === '=')
                            ) {
                                if (tk.content === '=') {
                                    stop_parse(lk);
                                    _this.addDiagnostic(
                                        `${diagnostic.unexpected(
                                            '=',
                                        )}, ${diagnostic
                                            .didyoumean(':=')
                                            .toLowerCase()}`,
                                        tk.offset,
                                        tk.length,
                                    );
                                }
                                const ek = tk;
                                let o: any;
                                if (lk.content.match(/^\d/)) {
                                    _this.addDiagnostic(
                                        diagnostic.invalidsymbolname(
                                            lk.content,
                                        ),
                                        lk.offset,
                                        lk.length,
                                    );
                                }
                                const tn = Variable.create(
                                    lk.content,
                                    SymbolKind.Variable,
                                    (rg = make_range(lk.offset, lk.length)),
                                );
                                if (
                                    (_cm =
                                        comments[tn.selectionRange.start.line])
                                ) {
                                    tn.detail = trim_comment(_cm.content);
                                }
                                tn.def = true;
                                tn.defaultVal = null;
                                cache.push(tn);
                                result.push(
                                    ...parse_expression(',', (o = {}), 2),
                                );
                                next = true;
                                bb = parser_pos;
                                bak = tk;
                                let t = Object.keys(o).pop();
                                if (t) {
                                    t = t.trim().toLowerCase();
                                    if (t === '#string') {
                                        tn.defaultVal =
                                            tokens[
                                                ek.next_token_offset
                                            ].content;
                                    } else if (t === 'true' || t === 'false') {
                                        tn.defaultVal = t;
                                    } else if (t.match(/^([-+]\s)?#number$/)) {
                                        if (t.charAt(0) === '#') {
                                            tn.defaultVal =
                                                tokens[
                                                    ek.next_token_offset
                                                ].content;
                                        } else {
                                            const t =
                                                tokens[ek.next_token_offset];
                                            tn.defaultVal =
                                                t.content +
                                                tokens[t.next_token_offset]
                                                    .content;
                                        }
                                    } else if (t !== 'unset') {
                                        tn.range_offset = [
                                            ek.offset,
                                            tk.offset,
                                        ];
                                        hasexpr = true;
                                    }
                                }
                                if (byref) {
                                    byref = false;
                                    tn.ref = tn.assigned = true;
                                    tpexp = '#varref';
                                } else {
                                    tpexp = Object.keys(o).pop() ?? '#void';
                                    tn.returntypes = o;
                                }
                                if ((tk.type as string) === 'TK_COMMA') {
                                    info.comma.push(tk.offset);
                                    continue;
                                } else {
                                    paramsdef = (tk as Token).content === endc;
                                    break;
                                }
                            } else if ((tk.type as string) === 'TK_OPERATOR') {
                                if (tk.content === '*') {
                                    const t = lk;
                                    nexttoken();
                                    if (tk.content === endc) {
                                        tn = Variable.create(
                                            t.content,
                                            SymbolKind.Variable,
                                            (rg = make_range(
                                                t.offset,
                                                t.length,
                                            )),
                                        );
                                        cache.push(tn);
                                        (<any>tn).arr = true;
                                        info.unknown = true;
                                        bb = parser_pos;
                                        bak = tk;
                                        break;
                                    } else {
                                        paramsdef = false;
                                        info.count--;
                                        break;
                                    }
                                } else if (tk.content === '?' && tk.ignore) {
                                    const t = lk;
                                    const tn = Variable.create(
                                        lk.content,
                                        SymbolKind.Variable,
                                        (rg = make_range(lk.offset, lk.length)),
                                    );
                                    tn.def = true;
                                    tn.defaultVal = null;
                                    cache.push(tn);
                                    if (byref) {
                                        byref = false;
                                        tn.ref = tn.assigned = true;
                                        tpexp = '#varref';
                                    } else {
                                        tpexp = ' ' + lk.content;
                                    }
                                    nexttoken();
                                    if ((tk.type as string) === 'TK_COMMA') {
                                        if (t.content.match(/^\d/)) {
                                            _this.addDiagnostic(
                                                diagnostic.invalidsymbolname(
                                                    t.content,
                                                ),
                                                t.offset,
                                                t.length,
                                            );
                                        }
                                        info.comma.push(tk.offset);
                                        bb = parser_pos;
                                        bak = tk;
                                        continue;
                                    } else {
                                        if (
                                            !(paramsdef = tk.content === endc)
                                        ) {
                                            cache.pop();
                                            info.count--;
                                        }
                                        break;
                                    }
                                } else {
                                    paramsdef = false;
                                    info.count--;
                                    break;
                                }
                            } else {
                                if (
                                    must &&
                                    lk.type === 'TK_WORD' &&
                                    lk.content.toLowerCase() === 'byref' &&
                                    tk.type === 'TK_WORD'
                                ) {
                                    stop_parse(lk);
                                    _this.addDiagnostic(
                                        diagnostic.deprecated('&', 'ByRef'),
                                        lk.offset,
                                        tk.topofline
                                            ? lk.length
                                            : tk.offset - lk.offset,
                                    );
                                    next = false;
                                    lk = EMPTY_TOKEN;
                                    continue;
                                }
                                paramsdef = false;
                                info.count--;
                                break;
                            }
                        } else {
                            paramsdef = false;
                            info.count--;
                            break;
                        }
                    } else if (la.includes(lk.content)) {
                        if (tk.content === '*') {
                            const t = tk;
                            let tn: Variable;
                            nexttoken();
                            if (tk.content === endc) {
                                cache.push(
                                    (tn = Variable.create(
                                        '',
                                        SymbolKind.Variable,
                                        (rg = make_range(t.offset, 0)),
                                    )),
                                );
                                tn.arr = true;
                                break;
                            } else {
                                _this.addDiagnostic(
                                    diagnostic.unexpected('*'),
                                    t.offset,
                                    1,
                                );
                            }
                        } else if (tk.content === '&') {
                            const t = tk;
                            tk = get_token_ignore_comment();
                            if (tk.type === 'TK_WORD') {
                                byref = true;
                                next = false;
                                continue;
                            } else {
                                _this.addDiagnostic(
                                    diagnostic.unexpected('&'),
                                    t.offset,
                                    1,
                                );
                            }
                        }
                        paramsdef = false;
                        break;
                    } else {
                        paramsdef = false;
                        break;
                    }
                }
                Object.defineProperty(types, 'paraminfo', {
                    value: info,
                    configurable: true,
                });
                info.comma.forEach((o) => (_this.tokens[o].paraminfo = info));
                if (paramsdef) {
                    if (hasexpr) {
                        Object.defineProperty(cache, 'format', {
                            value: format_params_default_val.bind(
                                undefined,
                                _this.tokens,
                            ),
                            configurable: true,
                        });
                    }
                    types[tpexp] = 0;
                    tk.previous_pair_pos = beg;
                    _this.addFoldingRange(beg, parser_pos, 'block');
                    return cache;
                } else {
                    result.push(...cache);
                    parser_pos = bb;
                    tk = bak;
                    parse_pair(endc === ')' ? '(' : '[', endc, beg, types);
                    return;
                }
            }

            function parse_prop() {
                next = false;
                parser_pos = tk.offset + tk.length;
                while (nexttoken()) {
                    switch (tk.type) {
                        case 'TK_OPERATOR':
                            if (tk.content === '%') {
                                parse_pair('%', '%');
                                if (
                                    isIdentifierChar(
                                        input.charCodeAt(parser_pos),
                                    )
                                ) {
                                    continue;
                                }
                                break;
                            }
                        case 'TK_NUMBER':
                            if (!allIdentifierChar.test(tk.content)) {
                                next = false;
                                break;
                            }
                        case 'TK_RESERVED':
                        case 'TK_WORD':
                            tk.type = 'TK_WORD';
                            tk.semantic = {
                                type: SemanticTokenTypes.property,
                                modifier:
                                    1 << SemanticTokenModifiers.modification,
                            };
                            if (input.charAt(parser_pos) === '%') {
                                continue;
                            }
                            break;
                        default:
                            next = false;
                            break;
                    }
                    break;
                }
            }

            function parse_obj(must: boolean = false, tp: any = {}): boolean {
                const l = lk;
                const b = tk;
                const rl = result.length;
                let isobj = true;
                const props: any = {};
                let ts: any = {};
                let k: Token | undefined;
                const mark: number[] = [];
                const cls = DocumentSymbol.create(
                    '',
                    undefined,
                    SymbolKind.Class,
                    make_range(0, 0),
                    make_range(0, 0),
                ) as ClassNode;
                cls.extends = '';
                block_mode = false;
                next = true;
                tk.data = cls;
                while (objkey()) {
                    if (objval()) {
                        break;
                    }
                }
                if (isobj || must) {
                    mark.forEach((o) => {
                        if ((k = tokens[o])) {
                            k.type = 'TK_WORD';
                            k.semantic = {
                                type: SemanticTokenTypes.property,
                                modifier:
                                    1 << SemanticTokenModifiers.modification,
                            };
                        }
                    });
                }
                if (!isobj) {
                    const e = tk;
                    lk = l;
                    tk = b;
                    result.splice(rl);
                    parser_pos = tk.skip_pos ?? tk.offset + tk.length;
                    if (must) {
                        parse_errobj();
                        tk.previous_pair_pos = b.offset;
                        _this.addDiagnostic(
                            diagnostic.objectliteralerr(),
                            e.offset,
                            parser_pos - e.offset,
                        );
                        return true;
                    }
                    return (next = false);
                } else if (lk.content === ':' || lk.type === 'TK_LABEL') {
                    _this.addDiagnostic(
                        diagnostic.unexpected(tk.content),
                        tk.offset,
                        tk.length,
                    );
                }
                if (tk.type === 'TK_END_BLOCK') {
                    _this.addFoldingRange(
                        (tk.previous_pair_pos = b.offset),
                        tk.offset,
                    );
                    b.next_pair_pos = tk.offset;
                } else {
                    _this.addDiagnostic(diagnostic.missing('}'), b.offset, 1);
                }
                if (Object.keys(props).length) {
                    cls.name = cls.full = `$${_this.anonymous.push(cls) - 1}`;
                    cls.staticdeclaration = props;
                    cls.declaration = {};
                    tp[cls.name] = true;
                    cls.uri = _this.uri;
                }
                return true;

                function objkey(): boolean {
                    while (nexttoken()) {
                        k = undefined;
                        if (tk.topofline === 1) {
                            tk.topofline = -1;
                        }
                        switch (tk.type) {
                            case 'TK_OPERATOR':
                                if (tk.content === '%') {
                                    parse_pair('%', '%');
                                    if (
                                        isIdentifierChar(
                                            input.charCodeAt(parser_pos),
                                        )
                                    ) {
                                        break;
                                    } else {
                                        nexttoken();
                                        if ((tk.content as string) === ':') {
                                            return true;
                                        }
                                        return (isobj = false);
                                    }
                                }
                            case 'TK_NUMBER':
                                if (!allIdentifierChar.test(tk.content)) {
                                    return (isobj = false);
                                }
                            case 'TK_RESERVED':
                            case 'TK_WORD':
                                if (
                                    input.charAt(parser_pos) === '%' &&
                                    mark.push(tk.offset)
                                ) {
                                    break;
                                }
                                const t = lk;
                                nexttoken();
                                if (tk.content === ':') {
                                    mark.push(lk.offset);
                                    if (t.content !== '%') {
                                        k = lk;
                                    }
                                    return true;
                                }
                                return (isobj = false);
                            case 'TK_STRING':
                                nexttoken();
                                if (tk.content === ':') {
                                    k = Object.assign({}, lk);
                                    k.content = k.content.slice(1, -1);
                                    k.offset++;
                                    k.length -= 2;
                                    if (!h) {
                                        _this.addDiagnostic(
                                            diagnostic.invalidpropname(),
                                            lk.offset,
                                            lk.length,
                                        );
                                    }
                                    return true;
                                }
                                return (isobj = false);
                            case 'TK_LABEL':
                                if (tk.content.match(/^(\w|[^\x00-\x7f])+:$/)) {
                                    k = Object.assign({}, tk);
                                    k.content = k.content.slice(0, -1);
                                    k.length--;
                                    return true;
                                }
                                return (isobj = false);
                            case 'TK_END_BLOCK':
                                if (
                                    lk.type === 'TK_START_BLOCK' ||
                                    lk.type === 'TK_COMMA'
                                ) {
                                    return false;
                                }
                            case 'TK_START_EXPR':
                                return (isobj = false);
                            case 'TK_COMMA':
                                if (
                                    lk.type === 'TK_COMMA' ||
                                    lk.type === 'TK_START_BLOCK'
                                ) {
                                    return true;
                                }
                            default:
                                return (isobj = false);
                        }
                    }
                    return false;
                }

                function objval(): boolean {
                    const exp = parse_expression(',', (ts = {}));
                    result.push(...exp);
                    if (k) {
                        const _ = k.content.toUpperCase();
                        if (_ === 'BASE') {
                            let t = Object.keys(ts).pop();
                            if (t && t.match(/\.prototype$/i)) {
                                t = t.slice(0, -10).trim().toLowerCase();
                                if (
                                    classfullname &&
                                    t === 'this' &&
                                    _parent.static &&
                                    _parent.kind === SymbolKind.Method
                                ) {
                                    t = classfullname
                                        .slice(0, -1)
                                        .toLowerCase();
                                }
                                cls.extends = t.replace(/([^.]+)$/, '@$1');
                            }
                        } else {
                            (props[_] = Variable.create(
                                k.content,
                                SymbolKind.Property,
                                make_range(k.offset, k.length),
                            )).returntypes = ts;
                            addprop(k);
                        }
                    }
                    if (tk.type === 'TK_COMMA') {
                        return !(next = true);
                    } else if (tk.type === 'TK_END_BLOCK') {
                        return (next = true);
                    } else if (tk.type === 'TK_EOF') {
                        return true;
                    } else {
                        return !(isobj = false);
                    }
                }
            }

            function parse_errobj() {
                let num = 0;
                if (!next && tk.type === 'TK_START_BLOCK') {
                    next = true;
                }
                while (nexttoken()) {
                    switch (tk.type) {
                        case 'TK_START_BLOCK':
                            num++;
                            break;
                        case 'TK_END_BLOCK':
                            if (--num < 0) {
                                return;
                            }
                            break;
                    }
                }
            }

            function parse_pair(
                b: string,
                e: string,
                pairbeg?: number,
                types: any = {},
                strs?: Token[],
            ) {
                let pairnum = 0;
                let apos = result.length;
                let tp = parser_pos;
                let llk = lk;
                const pairpos = [(pairbeg ??= tk.offset)];
                let rpair = 0;
                let tpexp = '';
                let byref;
                const _pk = _this.tokens[pairbeg];
                const ternarys: number[] = [];
                let info: ParamInfo = {
                    offset: pairbeg,
                    count: 0,
                    comma: [],
                    miss: [],
                    unknown: false,
                };
                const exps: string[] = [];
                let iscall = false;
                if (((block_mode = false), types.paraminfo)) {
                    info = types.paraminfo;
                    delete types.paraminfo;
                }
                if (b !== '%') {
                    const t = _pk.previous_token;
                    _pk.data = info.data = exps;
                    if (
                        info.name ||
                        (!_pk.topofline &&
                            t &&
                            _pk.prefix_is_whitespace === undefined &&
                            (t.previous_pair_pos !== undefined ||
                                t.type === 'TK_WORD'))
                    ) {
                        _pk.paraminfo = info;
                        iscall = true;
                    }
                }
                while (nexttoken()) {
                    if (tk.topofline) {
                        if (
                            b === '%' &&
                            !(
                                [
                                    'TK_COMMA',
                                    'TK_OPERATOR',
                                    'TK_EQUALS',
                                ].includes(tk.type) &&
                                !tk.content.match(/^(!|~|not)$/i)
                            )
                        ) {
                            stop_parse(_pk);
                            _pk.next_pair_pos = -1;
                            _this.addDiagnostic(
                                diagnostic.missing('%'),
                                pairbeg,
                                1,
                            );
                            next = false;
                            tpexp = '#any';
                            ternaryMiss();
                            return;
                        }
                        if (tk.topofline === 1) {
                            tk.topofline = -1;
                        }
                    }
                    if (b !== '(' && tk.content === '(') {
                        apos = result.length;
                        tp = parser_pos;
                        rpair = 1;
                        llk = lk;
                        parse_pair('(', ')');
                    } else if (tk.content === e) {
                        tokens[
                            (tk.previous_pair_pos = pairpos.pop() as number)
                        ].next_pair_pos = tk.offset;
                        if (e !== '%') {
                            _this.addFoldingRange(
                                tk.previous_pair_pos as number,
                                tk.offset + 1,
                                'block',
                            );
                        }
                        if (--pairnum < 0) {
                            break;
                        }
                        if (e === ')') {
                            tpexp += ')';
                            rpair++;
                        }
                    } else if (tk.content === b) {
                        if (b === '(') {
                            if (input.charAt(tk.offset - 1) === ')') {
                                parse_pair('(', ')', undefined, (o = {}));
                                tpexp += '()';
                                continue;
                            }
                            apos = result.length;
                            tp = parser_pos;
                            rpair = 0;
                            tpexp += '(';
                        }
                        pairnum++;
                        pairpos.push(parser_pos - 1);
                        llk = lk;
                    } else if (tk.content === '=>') {
                        let rs = result.splice(apos);
                        const bb = tk;
                        let par: DocumentSymbol[] | undefined;
                        let nk: Token;
                        let b = -1;
                        if (lk.content === ')') {
                            if (rpair !== 1) {
                                _this.addDiagnostic(
                                    diagnostic.unknownoperatoruse(),
                                    tk.offset,
                                    2,
                                );
                                next = true;
                                continue;
                            }
                            lk = llk;
                            parser_pos = tp - 1;
                            tk = get_next_token();
                            b = tk.offset;
                            rs = [];
                            par = parse_params();
                            if (!par) {
                                par = [];
                                _this.addDiagnostic(
                                    diagnostic.invalidparam(),
                                    b,
                                    tk.offset - b + 1,
                                );
                            }
                            nk = get_token_ignore_comment();
                        } else if (
                            lk.type === 'TK_WORD' &&
                            input.charAt(lk.offset - 1) !== '.'
                        ) {
                            let rg: Range;
                            nk = tk;
                            b = lk.offset;
                            par = [
                                Variable.create(
                                    lk.content,
                                    SymbolKind.Variable,
                                    (rg = make_range(lk.offset, lk.length)),
                                ),
                            ];
                        } else {
                            _this.addDiagnostic(
                                diagnostic.unknownoperatoruse(),
                                tk.offset,
                                2,
                            );
                            next = true;
                            continue;
                        }
                        if (nk.content !== '=>') {
                            tk = bb;
                            parser_pos = bb.offset + bb.length;
                            next = true;
                            tpexp = '';
                            result.push(...rs);
                            _this.addDiagnostic(
                                diagnostic.unknownoperatoruse(),
                                tk.offset,
                                2,
                            );
                            continue;
                        }
                        rs.push(...result.splice(apos));
                        const prec = _parent.funccall.length,
                            sub = parse_expression(
                                e,
                                undefined,
                                1,
                                ternarys.length ? ':' : undefined,
                            );
                        const tn = FuncNode.create(
                            '',
                            SymbolKind.Function,
                            make_range(b, lk.offset + lk.length - b),
                            make_range(b, 0),
                            par,
                            rs.concat(sub),
                        );
                        for (const t in o) {
                            o[t] = tn.range.end;
                        }
                        if (mode !== 0) {
                            tn.parent = _parent;
                        }
                        apos = result.length;
                        result.push(tn);
                        adddeclaration(tn);
                        tn.funccall = _parent.funccall.splice(prec);
                        tpexp =
                            tpexp.replace(/(\([^()]*\)|\S*)$/, '') +
                            ` $${_this.anonymous.push(tn as FuncNode) - 1}`;
                        if (tk.length === 1 && ',:)]}'.includes(tk.content)) {
                            tk.fat_arrow_end = true;
                        }
                    } else if (tk.type === 'TK_WORD') {
                        if (input.charAt(tk.offset - 1) !== '.') {
                            if (input.charAt(parser_pos) !== '(') {
                                if (
                                    b === '%' ||
                                    (input.charAt(tk.offset - 1) !== '%' &&
                                        input.charAt(tk.offset + tk.length) !==
                                            '%')
                                ) {
                                    const vr = addvariable(tk);
                                    if (vr) {
                                        nexttoken();
                                        next = false;
                                        if (
                                            (tk.type as string) === 'TK_EQUALS'
                                        ) {
                                            if (
                                                (_cm =
                                                    comments[
                                                        vr.selectionRange.start
                                                            .line
                                                    ])
                                            ) {
                                                vr.detail = trim_comment(
                                                    _cm.content,
                                                );
                                            }
                                            const o: any = {},
                                                equ = tk.content;
                                            next = true;
                                            result.push(
                                                ...parse_expression(
                                                    e,
                                                    o,
                                                    2,
                                                    ternarys.length
                                                        ? ':'
                                                        : undefined,
                                                ),
                                            );
                                            vr.range = {
                                                start: vr.range.start,
                                                end: document.positionAt(
                                                    lk.offset + lk.length,
                                                ),
                                            };
                                            const tp =
                                                equ === ':='
                                                    ? Object.keys(o)
                                                          .pop()
                                                          ?.toUpperCase() ||
                                                      '#any'
                                                    : equ === '.='
                                                    ? '#string'
                                                    : '#number';
                                            vr.returntypes ??= {
                                                [tp]: vr.range.end,
                                            };
                                            if (byref) {
                                                tpexp =
                                                    tpexp.slice(0, -1) +
                                                    '#varref';
                                            } else {
                                                tpexp += tp;
                                                vr.def = true;
                                            }
                                        } else if (byref) {
                                            tpexp =
                                                tpexp.slice(0, -1) + '#varref';
                                        } else {
                                            tpexp +=
                                                check_concat(lk) + lk.content;
                                            if (
                                                ['++', '--'].includes(
                                                    tk.content,
                                                )
                                            ) {
                                                byref = false;
                                            }
                                        }
                                        if (byref !== undefined) {
                                            vr.def = true;
                                            if (byref) {
                                                vr.ref = vr.assigned = true;
                                            } else {
                                                vr.returntypes = {
                                                    '#number': 0,
                                                };
                                            }
                                        } else if (
                                            tk.content === '??' ||
                                            (tk.ignore && tk.content === '?')
                                        ) {
                                            vr.returntypes = null;
                                        }
                                    } else {
                                        tpexp += check_concat(tk) + tk.content;
                                    }
                                } else {
                                    tk.ignore = true;
                                }
                            } else {
                                lk = tk;
                                tk = get_next_token();
                                const fc = lk,
                                    ttk = tk,
                                    rl = result.length,
                                    o: any = {},
                                    par = parse_params(o),
                                    quoteend = parser_pos;
                                nexttoken();
                                if (tk.content === '=>') {
                                    const o: any = {},
                                        pp = _parent;
                                    if (!par) {
                                        _this.addDiagnostic(
                                            diagnostic.invalidparam(),
                                            fc.offset,
                                            tk.offset - fc.offset + 1,
                                        );
                                    }
                                    const tn = FuncNode.create(
                                        fc.content,
                                        SymbolKind.Function,
                                        make_range(
                                            fc.offset,
                                            parser_pos - fc.offset,
                                        ),
                                        make_range(fc.offset, fc.length),
                                        <Variable[]>par || [],
                                    );
                                    if (fc.content.match(/^\d/)) {
                                        _this.addDiagnostic(
                                            diagnostic.invalidsymbolname(
                                                fc.content,
                                            ),
                                            fc.offset,
                                            fc.length,
                                        );
                                    }
                                    fc.symbol = fc.definition = _parent = tn;
                                    tn.children = result
                                        .splice(rl)
                                        .concat(
                                            parse_expression(
                                                e,
                                                o,
                                                2,
                                                ternarys.length
                                                    ? ':'
                                                    : undefined,
                                            ),
                                        );
                                    fc.semantic = {
                                        type: SemanticTokenTypes.function,
                                        modifier:
                                            (1 <<
                                                SemanticTokenModifiers.definition) |
                                            (1 <<
                                                SemanticTokenModifiers.readonly),
                                    };
                                    _parent = pp;
                                    tn.range.end = document.positionAt(
                                        lk.offset + lk.length,
                                    );
                                    for (const t in o) {
                                        o[t] = tn.range.end;
                                    }
                                    if (mode !== 0) {
                                        tn.parent = _parent;
                                    }
                                    tn.returntypes = o;
                                    adddeclaration(tn);
                                    result.push(tn);
                                    _this.addFoldingRangePos(
                                        tn.range.start,
                                        tn.range.end,
                                        'line',
                                    );
                                    if (fc.content) {
                                        tpexp += ' ' + fc.content.toLowerCase();
                                    } else {
                                        tpexp += ` $${
                                            _this.anonymous.push(tn) - 1
                                        }`;
                                    }
                                } else {
                                    if (
                                        input.charAt(fc.offset - 1) !== '%' ||
                                        fc.previous_token?.previous_pair_pos ===
                                            undefined
                                    ) {
                                        let tn: CallInfo;
                                        const pp = ttk.paraminfo?.count
                                            ? `(${ttk.offset})`
                                            : '()';
                                        addvariable(fc);
                                        _parent.funccall.push(
                                            (tn = DocumentSymbol.create(
                                                fc.content,
                                                undefined,
                                                SymbolKind.Function,
                                                make_range(
                                                    fc.offset,
                                                    quoteend - fc.offset,
                                                ),
                                                make_range(
                                                    fc.offset,
                                                    fc.length,
                                                ),
                                            )),
                                        );
                                        Object.assign(ttk.paraminfo ?? {}, {
                                            name: fc.content,
                                        });
                                        tn.paraminfo = o.paraminfo;
                                        tn.offset = fc.offset;
                                        fc.callinfo = tn;
                                        tpexp +=
                                            check_concat(fc) + fc.content + pp;
                                        fc.semantic ??= {
                                            type: SemanticTokenTypes.function,
                                        };
                                    } else {
                                        fc.ignore = true;
                                    }
                                    next = false;
                                    if (par) {
                                        for (const it of par) {
                                            if (
                                                !is_builtinvar(
                                                    it.name.toLowerCase(),
                                                )
                                            ) {
                                                result.push(it);
                                                if (it.ref || it.returntypes) {
                                                    it.def = true;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else if (input.charAt(parser_pos) === '(') {
                            const ptk = tk;
                            const o: any = {};
                            const ttk = (tk = get_next_token());
                            ptk.semantic = {
                                type: SemanticTokenTypes.method,
                            };
                            parse_pair('(', ')', undefined, o);
                            let tn: CallInfo;
                            const pp = ttk.paraminfo?.count
                                ? `(${ttk.offset})`
                                : '()';
                            tpexp += '.' + ptk.content + pp;
                            ptk.semantic = {
                                type: SemanticTokenTypes.method,
                            };
                            _parent.funccall.push(
                                (tn = DocumentSymbol.create(
                                    ptk.content,
                                    undefined,
                                    SymbolKind.Method,
                                    make_range(
                                        ptk.offset,
                                        parser_pos - ptk.offset,
                                    ),
                                    make_range(ptk.offset, ptk.length),
                                )),
                            );
                            Object.assign(ttk.paraminfo ?? {}, {
                                name: ptk.content,
                                method: true,
                            });
                            tn.paraminfo = o.paraminfo;
                            tn.offset = ptk.offset;
                            ptk.callinfo = tn;
                            maybeclassprop(ptk, true);
                        } else if (
                            b !== '%' &&
                            input.charAt(parser_pos) === '%'
                        ) {
                            maybeclassprop(tk, null);
                            parse_prop();
                            nexttoken();
                            next = false;
                        } else {
                            addprop(tk);
                            tpexp += '.' + tk.content;
                            nexttoken();
                            next = false;
                            if ((tk.type as string) === 'TK_EQUALS') {
                                maybeclassprop(lk);
                            }
                        }
                    } else if (tk.type === 'TK_START_BLOCK') {
                        const t: any = {};
                        if (
                            ['TK_WORD', 'TK_STRING', 'TK_NUMBER'].includes(
                                lk.type,
                            )
                        ) {
                            _this.addDiagnostic(
                                diagnostic.unexpected('{'),
                                tk.offset,
                                tk.length,
                            );
                        }
                        parse_obj(true, t);
                        tpexp += ' ' + (Object.keys(t).pop() || '#object');
                    } else if (tk.type === 'TK_STRING') {
                        tpexp += check_concat(tk) + '#string';
                        strs?.push(tk);
                        if (
                            b === '[' &&
                            is_next_char(']') &&
                            !tk.content.match(/\n|`n/)
                        ) {
                            addtext(
                                tk.content.substring(1, tk.content.length - 1),
                            );
                        }
                    } else if (tk.content === '[') {
                        const pre =
                            !tk.topofline &&
                            ((lk.previous_pair_pos !== undefined &&
                                lk.content === '%') ||
                                [
                                    'TK_WORD',
                                    'TK_STRING',
                                    'WK_NUMBER',
                                    'TK_END_EXPR',
                                    'TK_END_BLOCK',
                                ].includes(lk.type));
                        parse_pair('[', ']');
                        if (pre) {
                            tpexp = tpexp.replace(/\S+$/, '') + '#any';
                        } else {
                            tpexp += ' #array';
                        }
                    } else if (tk.content === '%') {
                        const prec = input.charAt(tk.offset - 1);
                        if (prec.match(/\w|\.|[^\x00-\x7f]/)) {
                            tpexp = tpexp.replace(/\S+$/, '#any');
                        } else {
                            tpexp += check_concat(tk) + '#any';
                        }
                        if (prec === '.') {
                            maybeclassprop(tk, null);
                            parse_prop();
                        } else {
                            parse_pair('%', '%');
                        }
                    } else if (tk.type.startsWith('TK_END_')) {
                        _this.addDiagnostic(
                            diagnostic.unexpected(tk.content),
                            tk.offset,
                            1,
                        );
                        pairMiss();
                        next = false;
                        exps.push(tpexp);
                        types[
                            tpexp.indexOf('#any') < 0
                                ? '(' + tpexp + ')'
                                : '#any'
                        ] = 0;
                        ternaryMiss();
                        return;
                    } else if (tk.type === 'TK_RESERVED') {
                        const c = input.charAt(tk.offset + tk.length);
                        if (
                            b !== '%' &&
                            (c === '%' || input.charAt(tk.offset - 1) === '%')
                        ) {
                            next = false;
                            tk.type = 'TK_WORD';
                            tk.semantic = {
                                type: SemanticTokenTypes.variable,
                            };
                            continue;
                        }
                        if (tk.content.match(/^(class|super|isset)$/i)) {
                            if (
                                tk.content.toLowerCase() === 'isset' &&
                                parse_isset(c)
                            ) {
                                continue;
                            }
                            next = false;
                            tk.type = 'TK_WORD';
                            continue;
                        }
                        _this.addDiagnostic(
                            diagnostic.reservedworderr(tk.content),
                            tk.offset,
                            tk.length,
                        );
                    } else if (tk.type === 'TK_COMMA') {
                        if (iscall) {
                            tk.paraminfo = info;
                        }
                        if (pairnum === 0 && b !== '%') {
                            exps.push(tpexp);
                            tpexp = '';
                            ++info.count;
                            if (
                                lk.type === 'TK_COMMA' ||
                                lk.type === 'TK_START_EXPR'
                            ) {
                                info.miss.push(info.comma.length);
                            } else if (
                                !lk.ignore &&
                                lk.type === 'TK_OPERATOR' &&
                                !lk.content.match(/(--|\+\+|%)/)
                            ) {
                                _this.addDiagnostic(
                                    diagnostic.unexpected(','),
                                    tk.offset,
                                    1,
                                );
                            }
                            // else if (lk.ignore && lk.content.toLowerCase() === 'unset') {
                            // 	let t = lk.previous_token;
                            // 	if (t?.length === 1 && ',('.includes(t.content))
                            // 		info.miss.push(info.count - 1);
                            // }
                            info.comma.push(tk.offset);
                        } else if (b === '(') {
                            tpexp = tpexp.substring(
                                0,
                                tpexp.lastIndexOf('(') + 1,
                            );
                        } else {
                            tpexp += ' ,';
                        }
                    } else if (tk.type === 'TK_NUMBER') {
                        tpexp += check_concat(tk) + '#number';
                    } else if (tk.type === 'TK_OPERATOR') {
                        tpexp += ' ' + tk.content;
                        if (
                            tk.content === '&' &&
                            (lk.content === '=>' ||
                                [
                                    'TK_EQUALS',
                                    'TK_COMMA',
                                    'TK_START_EXPR',
                                ].includes(lk.type))
                        ) {
                            byref = true;
                            continue;
                        } else if (tk.content === '?') {
                            if (tk.ignore) {
                                tpexp = tpexp.slice(0, -2);
                            } else {
                                ternarys.push(tk.offset);
                            }
                        } else if (
                            tk.content === ':' &&
                            ternarys.pop() === undefined
                        ) {
                            _this.addDiagnostic(
                                diagnostic.unexpected(':'),
                                tk.offset,
                                1,
                            );
                        } else if (['++', '--'].includes(tk.content)) {
                            byref = false;
                            tpexp = tpexp.slice(0, -3);
                            continue;
                        } else if (
                            b !== '%' &&
                            allIdentifierChar.test(tk.content) &&
                            (input[tk.offset - 1] === '%' ||
                                input[tk.offset + tk.length] === '%')
                        ) {
                            next = false;
                            tk.type = 'TK_WORD';
                            tk.semantic = {
                                type: SemanticTokenTypes.variable,
                            };
                            tpexp = tpexp.slice(0, -1 - tk.length);
                        }
                    }
                    byref = undefined;
                }
                exps.push(tpexp);
                types[b + tpexp + e] = 0;
                if (tk.type === 'TK_EOF' && pairnum > -1) {
                    if (e === '%') {
                        stop_parse(_pk);
                    }
                    pairMiss();
                } else {
                    tokens[tk.previous_pair_pos!].next_pair_pos = tk.offset;
                }
                if (b !== '%') {
                    if (lk.content === ',') {
                        info.miss.push(info.count++);
                    } else if (lk.type !== 'TK_START_EXPR') {
                        info.count++;
                        if (lk.content === '*') {
                            info.unknown = true;
                            info.count--;
                        }
                        // else if (lk.ignore && lk.content.toLowerCase() === 'unset') {
                        // 	let t = lk.previous_token;
                        // 	if (t?.length === 1 && ',('.includes(t.content))
                        // 		info.miss.push(info.count - 1);
                        // }
                    }
                    Object.defineProperty(types, 'paraminfo', {
                        value: info,
                        configurable: true,
                    });
                }
                ternaryMiss();

                function ternaryMiss() {
                    let o: number | undefined;
                    while ((o = ternarys.pop()) !== undefined) {
                        _this.addDiagnostic(diagnostic.missing(':'), o, 1);
                    }
                }
                function pairMiss() {
                    let o: number | undefined;
                    while ((o = pairpos.pop()) !== undefined) {
                        _this.addDiagnostic(diagnostic.missing(e), o, 1);
                    }
                }
            }

            function parse_isset(c: string) {
                const l = result.length;
                tk.definition = ahkvars['ISSET'];
                tk.ignore = true;
                tk.type = 'TK_WORD';
                tk.semantic = { type: SemanticTokenTypes.operator };
                if (c === '(') {
                    const fc = tk;
                    nexttoken();
                    parse_pair('(', ')');
                    const pc =
                        tokens[tk.previous_pair_pos!]?.paraminfo?.count ?? 0;
                    if (pc !== 1) {
                        if (extsettings.Diagnostics.ParamsCheck) {
                            _this.addDiagnostic(
                                diagnostic.paramcounterr(1, pc),
                                fc.offset,
                                parser_pos - fc.offset,
                            );
                        }
                    } else if (result.length > l && lk.type === 'TK_WORD') {
                        const vr = result[result.length - 1] as Variable;
                        if (
                            lk.content === vr.name &&
                            lk.offset ===
                                _this.document.offsetAt(vr.range.start)
                        ) {
                            vr.assigned = true;
                            vr.returntypes ??= null;
                        }
                    }
                    return true;
                }
                _this.addDiagnostic(diagnostic.missing('('), tk.offset, 5);
            }

            function maybeclassprop(tk: Token, flag: boolean | null = false) {
                if (classfullname === '') {
                    return;
                }
                let rg: Range;
                const ts = tk.previous_token?.previous_token;
                if (!ts || input.charAt(ts.offset - 1) === '.') {
                    return;
                }
                _low = ts.content.toLowerCase();
                if (_low !== 'this' && _low !== 'super') {
                    return;
                }
                let p = _parent as ClassNode;
                let s = false;
                if (flag) {
                    const pi = tk.callinfo?.paraminfo;
                    if (
                        pi &&
                        tk.content.toLowerCase() === 'defineprop' &&
                        pi.count > 1 &&
                        pi.miss[0] !== 0
                    ) {
                        get_class();
                        if (p && p.kind === SymbolKind.Class) {
                            const end = pi.comma[0];
                            let nk = tokens[tk.next_token_offset];
                            if (input.charAt(tk.offset + tk.length) === '(') {
                                nk = tokens[nk.next_token_offset];
                            }
                            if (
                                nk.type !== 'TK_STRING' ||
                                nk.next_token_offset !== end
                            ) {
                                (<any>p).checkmember = false;
                            } else {
                                const o = tokens[tokens[end].next_token_offset],
                                    prop = nk.content.slice(1, -1);
                                let t: Variable | FuncNode;
                                rg = make_range(nk.offset + 1, prop.length);
                                if (
                                    o.type === 'TK_START_BLOCK' &&
                                    (t = o.data?.staticdeclaration?.CALL)
                                ) {
                                    const r =
                                        Object.keys(t.returntypes ?? {})
                                            .pop()
                                            ?.trim() ?? '';
                                    if (
                                        /^\$\d+$/.test(r) &&
                                        (t =
                                            _this.anonymous[
                                                parseInt(r.substring(1))
                                            ]) &&
                                        (t as FuncNode).params
                                    ) {
                                        let p = (t as FuncNode).params;
                                        if (
                                            t.kind === SymbolKind.Function &&
                                            p.length &&
                                            !p[0].arr
                                        ) {
                                            p = p.slice(1);
                                        }
                                        t = FuncNode.create(
                                            prop,
                                            SymbolKind.Method,
                                            t.range,
                                            t.selectionRange,
                                            p,
                                            undefined,
                                            s,
                                        );
                                    } else {
                                        t = Variable.create(
                                            '',
                                            SymbolKind.Variable,
                                            make_range(0, 0),
                                        );
                                        t.arr = true;
                                        t = FuncNode.create(
                                            prop,
                                            SymbolKind.Method,
                                            rg,
                                            rg,
                                            [t],
                                            undefined,
                                            s,
                                        );
                                    }
                                    t.full =
                                        `(${classfullname.slice(0, -1)}) ` +
                                        t.full;
                                } else {
                                    t = Variable.create(
                                        prop,
                                        SymbolKind.Property,
                                        rg,
                                    );
                                    t.static = s;
                                }
                                p.cache.push(t);
                                (t as FuncNode).parent = p;
                                return t;
                            }
                        }
                    }
                } else {
                    get_class();
                    if (p && p.kind === SymbolKind.Class) {
                        if (flag === null) {
                            return ((p as any).checkmember = false), undefined;
                        }
                        const t = Variable.create(
                            tk.content,
                            SymbolKind.Property,
                            (rg = make_range(tk.offset, tk.length)),
                        );
                        t.static = s;
                        p.cache.push(t);
                        t.def = false;
                        (t as FuncNode).parent = p;
                        return t;
                    }
                }
                return undefined;

                function get_class() {
                    if (
                        p.kind === SymbolKind.Method ||
                        p.kind === SymbolKind.Function
                    ) {
                        while (p && p.kind !== SymbolKind.Class) {
                            if (p.kind === SymbolKind.Method && p.static) {
                                s = true;
                            }
                            p = p.parent as ClassNode;
                        }
                    }
                }
            }

            function is_builtinvar(name: string, mode = 0): boolean {
                if (mode === 2) {
                    return false;
                }
                if (
                    builtin_variable.includes(name) ||
                    (h && builtin_variable_h.includes(name))
                ) {
                    return true;
                }
                return false;
            }

            function addvariable(
                token: Token,
                md: number = 0,
                p?: DocumentSymbol[],
            ) {
                const _low = token.content.toLowerCase();
                if (token.ignore || is_builtinvar(_low, md)) {
                    if (
                        token.semantic &&
                        token.semantic.type !== SemanticTokenTypes.operator
                    ) {
                        delete token.semantic;
                    }
                    token.definition = ahkvars[_low.toUpperCase()];
                    token.ignore = true;
                    return;
                }
                const rg = make_range(token.offset, token.length),
                    tn = Variable.create(
                        token.content,
                        SymbolKind.Variable,
                        rg,
                    );
                if (md === 2) {
                    tn.kind = SymbolKind.Property;
                    addprop(token, tn);
                    if (classfullname) {
                        tn.full = `(${classfullname.slice(0, -1)}) ${tn.name}`;
                        token.symbol = tn;
                    }
                } else if (_low.match(/^\d/)) {
                    _this.addDiagnostic(
                        diagnostic.invalidsymbolname(token.content),
                        token.offset,
                        token.length,
                    );
                }
                (p ?? result).push(tn);
                return tn;
            }

            function addprop(tk: Token, v?: Variable) {
                const t = (_this.object.property[tk.content.toUpperCase()] ??=
                    []);
                tk.semantic ??= { type: SemanticTokenTypes.property };
                if (v) {
                    t.unshift(v);
                } else {
                    t[0] ??= Variable.create(
                        tk.content,
                        SymbolKind.Property,
                        make_range(tk.offset, tk.length),
                    );
                }
            }

            function addtext(text: string) {
                _this.texts[text.toUpperCase()] = text;
            }

            function adddeclaration(node: FuncNode | ClassNode) {
                let t: Variable;
                const severity = DiagnosticSeverity.Error;
                const dec = (node.declaration ??= {});
                const _diags = _this.diagnostics;
                let lpv = false;
                const pars: { [name: string]: Variable } = {};
                if (!dec) {
                    return;
                }
                if (node.kind === SymbolKind.Class) {
                    const cls = node as ClassNode,
                        sdec = (cls.staticdeclaration ??= {}),
                        children = (cls.children ??= []);
                    adddeclaration(sdec.__INIT as FuncNode);
                    if ((dec.__INIT as any)?.ranges?.length) {
                        adddeclaration(dec.__INIT as FuncNode);
                    } else {
                        delete dec.__INIT;
                    }
                    children.forEach((it: Variable) => {
                        _low = it.name.toUpperCase();
                        if (
                            /^__(NEW|INIT|ITEM|ENUM|GET|CALL|SET|DELETE)$/.test(
                                _low,
                            )
                        ) {
                            delete (
                                tokens[
                                    document.offsetAt(it.selectionRange.start)
                                ] ?? {}
                            ).semantic;
                        }
                        if (it.children) {
                            const tc =
                                it.static || it.kind === SymbolKind.Class
                                    ? sdec
                                    : dec;
                            if (!(t = tc[_low])) {
                                tc[_low] = it;
                            } else if (
                                t.kind === SymbolKind.Property &&
                                !t.children?.length
                            ) {
                                if (
                                    it.children.length ||
                                    it.kind !== SymbolKind.Property
                                ) {
                                    tc[_low] = it;
                                }
                            } else {
                                if (
                                    t.kind !== it.kind &&
                                    ![it.kind, t.kind].includes(
                                        SymbolKind.Class,
                                    )
                                ) {
                                    let method;
                                    const prop: any =
                                        t.kind === SymbolKind.Property
                                            ? ((method = it), t)
                                            : ((method = t), it);
                                    if (!prop.call) {
                                        return (
                                            (prop.call = method),
                                            (tc[_low] = prop)
                                        );
                                    }
                                }
                                _diags.push({
                                    message: diagnostic.dupdeclaration(),
                                    range: it.selectionRange,
                                    severity,
                                });
                            }
                        }
                    });
                    children.forEach((it: Variable) => {
                        if (it.children) {
                            return;
                        }
                        const tc =
                            it.static || it.kind === SymbolKind.Class
                                ? sdec
                                : dec;
                        if (!(t = tc[(_low = it.name.toUpperCase())])) {
                            return it.def === false || (tc[_low] = it);
                        }
                        if (t.children) {
                            const _ = t as any;
                            if (!_.val) {
                                return (_.val = it);
                            }
                        }
                        if (it.def !== false) {
                            _diags.push({
                                message: diagnostic.dupdeclaration(),
                                range: it.selectionRange,
                                severity,
                            });
                        }
                    });
                    if (dec.__INIT) {
                        children.unshift(dec.__INIT);
                    }
                    children.unshift(sdec.__INIT);
                    cls.cache
                        ?.splice(0)
                        .forEach(
                            (it) =>
                                ((it.static ? sdec : dec)[
                                    (_low = it.name.toUpperCase())
                                ] ??= it),
                        );
                } else {
                    const fn = node as FuncNode;
                    let vars: { [k: string]: any } = {};
                    let unresolved_vars: { [k: string]: any } = {};
                    let vr: Variable;
                    const has_this_param =
                        node.kind === SymbolKind.Method ||
                        (node.parent?.kind === SymbolKind.Property &&
                            node.kind === SymbolKind.Function);
                    if (has_this_param) {
                        const rg = make_range(0, 0);
                        fn.has_this_param = true;
                        pars.THIS = dec.THIS = Variable.create(
                            'this',
                            SymbolKind.TypeParameter,
                            rg,
                        );
                        pars.SUPER = dec.SUPER = Variable.create(
                            'super',
                            SymbolKind.TypeParameter,
                            rg,
                        );
                        pars.THIS.def = pars.SUPER.def = true;
                    }
                    if (
                        node.kind === SymbolKind.Function &&
                        node.name.toLowerCase() === 'isset'
                    ) {
                        const offset = _this.document.offsetAt(
                            node.selectionRange.start,
                        );
                        _this.addDiagnostic(
                            diagnostic.reservedworderr('IsSet'),
                            offset,
                            5,
                        );
                        _this.tokens[offset].semantic = {
                            type: SemanticTokenTypes.operator,
                        };
                    }
                    fn.children ??= [];
                    for (const it of (fn.params ??= [])) {
                        if (!it.name) {
                            continue;
                        }
                        node.children?.unshift(it);
                        it.def = it.assigned = true;
                        it.kind = SymbolKind.TypeParameter;
                        if (it.defaultVal !== undefined || it.arr) {
                            lpv = true;
                        } else if (lpv) {
                            _diags.push({
                                message: diagnostic.defaultvalmissing(it.name),
                                range: it.selectionRange,
                                severity,
                            });
                        }
                        if ((t = pars[(_low = it.name.toUpperCase())])) {
                            _diags.push({
                                message: diagnostic.conflictserr(
                                    'parameter',
                                    'parameter',
                                    t.name,
                                ),
                                range: it.selectionRange,
                                severity,
                            });
                        } else {
                            pars[_low] = dec[_low] = it;
                        }
                    }
                    for (const [k, v] of Object.entries((fn.local ??= {}))) {
                        if ((t = pars[k])) {
                            _diags.push({
                                message: diagnostic.conflictserr(
                                    v.static ? 'static' : 'local',
                                    'parameter',
                                    t.name,
                                ),
                                range: v.selectionRange,
                                severity,
                            });
                        } else {
                            dec[k] = v;
                            v.assigned ||= Boolean(v.returntypes);
                        }
                    }
                    Object.entries((fn.global ??= {})).forEach(([k, v]) => {
                        if ((t = dec[k])) {
                            if (pars[k]) {
                                return _diags.push({
                                    message: diagnostic.conflictserr(
                                        'global',
                                        'parameter',
                                        t.name,
                                    ),
                                    range: v.selectionRange,
                                    severity,
                                });
                            } else {
                                const varsp = v.static ? 'static' : 'local';
                                _diags.push({
                                    message: diagnostic.conflictserr(
                                        ...(t.selectionRange.start.line <
                                        v.selectionRange.start.line
                                            ? ((t = v), ['global', varsp])
                                            : [varsp, 'global']),
                                        t.name,
                                    ),
                                    range: t.selectionRange,
                                    severity,
                                });
                                if (v !== t) {
                                    return;
                                }
                                delete fn.local[k];
                            }
                        }
                        _this.declaration[k] ??= dec[k] = v;
                        v.assigned ||= Boolean(v.returntypes);
                        (v as any).infunc = true;
                    });
                    fn.children.forEach((it) => {
                        _low = it.name.toUpperCase();
                        if (it.kind === SymbolKind.Function) {
                            const _f = it as FuncNode;
                            if (!_f.static) {
                                _f.closure = true;
                            }
                            if (!_low) {
                                return;
                            }
                            if (dec[_low]) {
                                if ((t = pars[_low])) {
                                    return _diags.push({
                                        message: diagnostic.conflictserr(
                                            'function',
                                            'parameter',
                                            t.name,
                                        ),
                                        range: it.selectionRange,
                                        severity,
                                    });
                                }
                                if ((t = fn.global[_low])) {
                                    _diags.push({
                                        message: diagnostic.conflictserr(
                                            ...(t.selectionRange.start.line <
                                                it.selectionRange.start.line ||
                                            (t.selectionRange.start.line ===
                                                it.selectionRange.start.line &&
                                                t.selectionRange.start
                                                    .character <
                                                    it.selectionRange.start
                                                        .character)
                                                ? ((t = it),
                                                  ['function', 'global'])
                                                : ['global', 'function']),
                                            t.name,
                                        ),
                                        range: t.selectionRange,
                                        severity,
                                    });
                                    if (it === t) {
                                        return;
                                    }
                                    delete fn.global[_low];
                                    delete (t as any).infunc;
                                    if (_this.declaration[_low] === t) {
                                        delete _this.declaration[_low];
                                    }
                                } else if ((t = fn.local[_low])) {
                                    if (
                                        t.selectionRange.start.line <
                                            it.selectionRange.start.line ||
                                        (t.selectionRange.start.line ===
                                            it.selectionRange.start.line &&
                                            t.selectionRange.start.character <
                                                it.selectionRange.start
                                                    .character)
                                    ) {
                                        return _diags.push({
                                            message: diagnostic.conflictserr(
                                                'function',
                                                t.kind === SymbolKind.Function
                                                    ? 'Func'
                                                    : t.static
                                                    ? 'static'
                                                    : 'local',
                                                it.name,
                                            ),
                                            range: it.selectionRange,
                                            severity,
                                        });
                                    } else if (t.static) {
                                        _diags.push({
                                            message: diagnostic.conflictserr(
                                                t.kind === SymbolKind.Function
                                                    ? 'function'
                                                    : 'static',
                                                it.kind === SymbolKind.Function
                                                    ? 'Func'
                                                    : 'static',
                                                t.name,
                                            ),
                                            range: t.selectionRange,
                                            severity,
                                        });
                                    }
                                }
                            }
                            dec[_low] = fn.local[_low] = it;
                        } else if (it.kind === SymbolKind.Variable) {
                            ((vr = it as Variable).def
                                ? vars
                                : unresolved_vars)[_low] ??=
                                ((vr.assigned ||= Boolean(vr.returntypes)), it);
                        }
                    });
                    if (fn.assume === FuncScope.GLOBAL) {
                        Object.entries(
                            (vars = Object.assign({}, unresolved_vars, vars)),
                        ).forEach(([k, v]) => {
                            if (!(t = dec[k])) {
                                _this.declaration[k] ??= fn.global[k] = v;
                                v.infunc = true;
                            } else if (
                                t.kind === SymbolKind.Function &&
                                v.def
                            ) {
                                _diags.push({
                                    message: diagnostic.assignerr(
                                        'Func',
                                        t.name,
                                    ),
                                    range: v.selectionRange,
                                    severity,
                                });
                            } else if (
                                t.kind === SymbolKind.Variable &&
                                v.def &&
                                v.kind === t.kind
                            ) {
                                t.def = true;
                                t.assigned ||= Boolean(v.returntypes);
                            }
                        });
                        unresolved_vars = {};
                    } else {
                        const assme_static = fn.assume === FuncScope.STATIC;
                        const is_outer =
                            fn.kind === SymbolKind.Method || !fn.parent;
                        Object.entries(vars).forEach(([k, v]) => {
                            delete unresolved_vars[k];
                            if (!(t = dec[k])) {
                                if (((dec[k] = v), is_outer)) {
                                    fn.local[k] = v;
                                    v.static = assme_static;
                                } else if (assme_static) {
                                    v.static = null;
                                }
                            } else if (t.kind === SymbolKind.Function) {
                                _diags.push({
                                    message: diagnostic.assignerr(
                                        'Func',
                                        t.name,
                                    ),
                                    range: v.selectionRange,
                                    severity,
                                });
                            } else if (
                                t.kind === SymbolKind.Variable &&
                                v.def &&
                                v.kind === t.kind
                            ) {
                                t.def = true;
                                t.assigned ||= Boolean(v.returntypes);
                            }
                        });
                    }
                    vars = unresolved_vars;
                    unresolved_vars = {};
                    for (const k in vars) {
                        if (!dec[k]) {
                            (unresolved_vars[k] = vars[k]).def = false;
                        }
                    }
                    fn.unresolved_vars = unresolved_vars;
                    if (has_this_param) {
                        delete pars.THIS;
                        delete pars.SUPER;
                        delete dec.THIS;
                        delete dec.SUPER;
                    }
                    for (const k in (vars = fn.local)) {
                        vars[k].def = true;
                    }
                    Object.assign(fn.local, pars);
                }
            }

            function nexttoken() {
                if (next) {
                    return (
                        (lk = tk),
                        (next =
                            (tk = get_token_ignore_comment()).type !== 'TK_EOF')
                    );
                } else {
                    return (next = tk.type !== 'TK_EOF');
                }
            }
        }

        function set_extends(tn: ClassNode, str: string) {
            tn.extendsuri = '';
            tn.extends = str
                .replace(/^{(.*)}$/, '$1')
                .trim()
                .replace(/^(.+[\\/])?/, (m) => {
                    if ((m = m.slice(0, -1))) {
                        let u: URI;
                        m = m.replace(/\\/g, '/').toLowerCase();
                        if (!m.endsWith('.ahk')) {
                            m += '.d.ahk';
                        }
                        if (m.startsWith('~/')) {
                            u = inBrowser
                                ? URI.parse(rootdir + m.slice(1))
                                : URI.file(rootdir + m.slice(1));
                        } else if (/^([a-z]:)?\//.test(m)) {
                            u = URI.file(m);
                        } else if (!m.includes(':')) {
                            const t = (uri.path + '/../' + m).split('/'),
                                arr: string[] = [];
                            t.shift();
                            for (const s of t) {
                                if (s !== '..') {
                                    arr.push(s);
                                } else if (!arr.pop()) {
                                    return '';
                                }
                            }
                            u = uri.with({ path: arr.join('/') });
                        } else {
                            u = URI.parse(m);
                        }
                        tn.extendsuri = u.toString().toLowerCase();
                    }
                    return '';
                })
                .toLowerCase();
        }

        function add_include_dllload(
            text: string,
            tk?: Token,
            mode = 0,
            isdll = false,
        ) {
            let m: any;
            let raw: string;
            let ignore = false;
            const q = text[0];
            if (`'"`.includes(q) && text.endsWith(q)) {
                text = text.slice(1, -1);
            }
            if ((m = text.match(/^(\*[iI]\s)?(.*)$/))) {
                raw = m[2];
                ignore = Boolean(m[1]);
                m = raw
                    .replace(/%(a_scriptdir|a_workingdir)%/i, _this.scriptdir)
                    .replace(/%a_linefile%/i, _this.fsPath);
                if (tk) {
                    _this[isdll ? 'dlldir' : 'includedir'].set(
                        (tk.pos ??= _this.document.positionAt(tk.offset)).line,
                        isdll ? dlldir : includedir,
                    );
                }
                if (!m.trim()) {
                    if (isdll) {
                        dlldir = '';
                    } else if (tk) {
                        _this.addDiagnostic(
                            diagnostic.pathinvalid(),
                            tk.offset,
                            tk.length,
                        );
                    }
                } else if (!inBrowser) {
                    if (isdll) {
                        if (existsSync(m) && statSync(m).isDirectory()) {
                            dlldir =
                                m.endsWith('/') || m.endsWith('\\')
                                    ? m
                                    : m + '\\';
                        } else {
                            if (!m.match(/\.\w+$/)) {
                                m = m + '.dll';
                            }
                            if (m.includes(':')) {
                                _this.dllpaths.push(
                                    m.replace(/\\/g, '/').toLowerCase(),
                                );
                            } else {
                                _this.dllpaths.push(
                                    (dlldir && existsSync(dlldir + m)
                                        ? dlldir + m
                                        : m
                                    )
                                        .replace(/\\/g, '/')
                                        .toLowerCase(),
                                );
                            }
                        }
                    } else {
                        if (tk) {
                            if (m.startsWith('*')) {
                                const rs = utils.get_RCDATA(
                                    tk.content.substring(1),
                                );
                                if (rs) {
                                    includetable[rs.uri] = rs.path;
                                    tk.data = [undefined, rs.uri];
                                    return;
                                }
                                _this.addDiagnostic(
                                    diagnostic.resourcenotfound(),
                                    tk.offset,
                                    tk.length,
                                    DiagnosticSeverity.Warning,
                                );
                            } else if (
                                !(m = pathanalyze(
                                    m,
                                    _this.libdirs,
                                    includedir,
                                )) ||
                                !existsSync(m.path)
                            ) {
                                if (!ignore) {
                                    _this.addDiagnostic(
                                        m
                                            ? diagnostic.filenotexist(m.path)
                                            : diagnostic.pathinvalid(),
                                        tk.offset,
                                        tk.length,
                                    );
                                }
                            } else if (statSync(m.path).isDirectory()) {
                                _this.includedir.set(
                                    tk.pos!.line,
                                    (includedir = m.path),
                                );
                            } else {
                                includetable[m.uri] = m.path;
                                tk.data = [m.path, m.uri];
                            }
                            if (mode !== 0) {
                                _this.addDiagnostic(
                                    diagnostic.unsupportinclude(),
                                    tk.offset,
                                    tk.length,
                                    DiagnosticSeverity.Warning,
                                );
                            }
                        } else if (
                            (m = pathanalyze(
                                m.replace(/(\.d)?>$/i, '.d>'),
                                _this.libdirs,
                                _this.scriptpath,
                            )) &&
                            existsSync(m.path) &&
                            !statSync(m.path).isDirectory()
                        ) {
                            includetable[m.uri] = m.path;
                        }
                    }
                }
            } else if (text && tk) {
                _this.addDiagnostic(
                    diagnostic.pathinvalid(),
                    tk.offset,
                    tk.length,
                );
            }
        }

        function trim_comment(comment: string): string {
            if (comment.startsWith(';')) {
                return comment.replace(/^[ \t]*; ?/gm, '');
            }
            const c = comment.split(/\r?\n/),
                jsdoc = comment.startsWith('/**');
            if (!(c[0] = c[0].replace(/^\/\*+\s*/, ''))) {
                c.splice(0, 1);
            }
            if (
                !(c[c.length - 1] = c[c.length - 1].replace(/\s*\*+\/\s*$/, ''))
            ) {
                c.pop();
            }
            if (!jsdoc) {
                return c.join('\n');
            }
            return c
                .map((l) => l.replace(/^\s*\*(\s*(?=@)| ?)/, ''))
                .join('\n');
        }

        function make_range(offset: number, length: number): Range {
            return Range.create(
                _this.document.positionAt(offset),
                _this.document.positionAt(offset + length),
            );
        }

        function createToken(
            content: string,
            type: string,
            offset: number,
            length: number,
            topofline: number,
        ): Token {
            const c = input.charAt(offset - 1);
            const tk: Token = {
                content,
                type,
                offset,
                length,
                topofline,
                previous_token: lst,
                next_token_offset: -1,
                prefix_is_whitespace: whitespace.includes(c) ? c : undefined,
            };
            _this.tokens[offset] = tk;
            lst.next_token_offset = offset;
            return tk;
        }

        function create_flags(flags_base: any, mode: any) {
            let indentation_level = 0;
            let had_comment = 0;
            let ternary_depth;
            let last_text = '';
            let last_word = '';
            let in_expression = [
                MODE.ArrayLiteral,
                MODE.Expression,
                MODE.ObjectLiteral,
            ].includes(mode);
            if (flags_base) {
                indentation_level = flags_base.indentation_level;
                had_comment = flags_base.had_comment;
                last_text = flags_base.last_text;
                last_word = flags_base.last_word;
                in_expression ||= flags_base.in_expression;
                ternary_depth = flags_base.ternary_depth;
            }

            const next_flags = {
                case_body: false,
                catch_block: false,
                declaration_statement: false,
                else_block: false,
                finally_block: false,
                had_comment,
                if_block: false,
                in_case_statement: false,
                in_case: false,
                in_expression,
                indentation_level,
                last_text,
                last_word,
                loop_block: 0,
                mode,
                parent: flags_base,
                start_line_index: output_lines.length,
                ternary_depth,
                try_block: false,
            };
            return next_flags;
        }

        // Using object instead of string to allow for later expansion of info about each line
        function create_output_line() {
            return { text: [], indent: 0 };
        }

        function trim_newlines() {
            if (continuation_sections_mode) {
                return;
            }
            let line = output_lines.pop();
            while (line?.text.length === 0) {
                line = output_lines.pop();
            }
            if (line) {
                output_lines.push(line);
            }
            if (flags.had_comment) {
                output_lines.push(create_output_line());
            }
        }

        function just_added_newline(): boolean {
            const line = output_lines[output_lines.length - 1];
            return line.text.length === 0;
        }

        function allow_wrap_or_preserved_newline(force_linewrap = false): void {
            if (opt.wrap_line_length && !force_linewrap) {
                const line = output_lines[output_lines.length - 1];
                let proposed_line_length = 0;
                // never wrap the first token of a line.
                if (line.text.length > 0) {
                    proposed_line_length =
                        line.text.join('').length +
                        token_text.length +
                        (output_space_before_token ? 1 : 0);
                    if (proposed_line_length >= opt.wrap_line_length) {
                        force_linewrap = true;
                    }
                }
            }
            if (
                ((opt.preserve_newlines && input_wanted_newline) ||
                    force_linewrap) &&
                !just_added_newline()
            ) {
                print_newline(true);
            }
        }

        function print_newline(preserve_statement_flags = false): void {
            if (!preserve_statement_flags) {
                if (
                    last_type !== 'TK_COMMA' &&
                    last_type !== 'TK_EQUALS' &&
                    (last_type !== 'TK_OPERATOR' ||
                        ['++', '--', '%'].includes(flags.last_text))
                ) {
                    // while (flags.mode === MODE.Statement && (flags.declaration_statement || !flags.if_block && !flags.loop_block && !flags.try_block))
                    // 	restore_mode();
                    while (flags.mode === MODE.Statement) {
                        restore_mode();
                    }
                    flags.if_block =
                        flags.loop_block =
                        flags.try_block =
                        flags.catch_block =
                            0;
                }
            }

            if (!just_added_newline()) {
                output_lines.push(create_output_line());
            }
        }

        function print_token(printable_token?: string): void {
            const line = output_lines[output_lines.length - 1];
            if (!line.text.length) {
                if (
                    opt.keep_array_indentation &&
                    is_array(flags.mode) &&
                    input_wanted_newline
                ) {
                    if (preindent_string) {
                        line.text.push(preindent_string);
                    }
                    if (is_expression(flags.parent.mode)) {
                        print_indent_string(flags.parent.indentation_level);
                    } else {
                        print_indent_string(flags.indentation_level);
                    }
                } else {
                    if (preindent_string) {
                        line.text.push(preindent_string);
                    }
                    print_indent_string(flags.indentation_level);
                }
            } else if (output_space_before_token) {
                line.text.push(' ');
            }
            output_space_before_token = undefined;
            line.text.push(printable_token ?? token_text);

            function print_indent_string(level: number) {
                if (level) {
                    for (let i = output_lines.length - 2; i >= 0; i--) {
                        if (output_lines[i].text.length) {
                            level = Math.min(output_lines[i].indent + 1, level);
                            break;
                        }
                    }
                    line.text.push(indent_string.repeat((line.indent = level)));
                }
            }
        }

        function indent(): void {
            flags.indentation_level += 1;
        }

        function deindent(): void {
            if (
                flags.indentation_level > 0 &&
                (!flags.parent ||
                    flags.indentation_level > flags.parent.indentation_level)
            ) {
                flags.indentation_level -= 1;
            }
        }

        function set_mode(mode: any): void {
            if (flags) {
                flag_store.push(flags);
                previous_flags = flags;
            } else {
                previous_flags = create_flags(null, mode);
            }

            flags = create_flags(previous_flags, mode);
        }

        function is_array(mode: string): boolean {
            return mode === MODE.ArrayLiteral;
        }

        function is_expression(mode: string): boolean {
            return [MODE.Expression, MODE.Conditional].includes(mode);
        }

        function restore_mode(): void {
            if (flag_store.length > 0) {
                previous_flags = flags;
                flags = flag_store.pop();
            }
        }

        function start_of_object_property(): boolean {
            return (
                flags.parent.mode === MODE.ObjectLiteral &&
                flags.mode === MODE.Statement &&
                flags.last_text === ':' &&
                !flags.ternary_depth
            );
        }

        function start_of_statement(): boolean {
            if (
                (last_type === 'TK_RESERVED' &&
                    ['try', 'else', 'finally'].includes(flags.last_text)) ||
                (last_type === 'TK_END_EXPR' &&
                    previous_flags.mode === MODE.Conditional) ||
                (last_type === 'TK_WORD' &&
                    flags.mode === MODE.BlockStatement &&
                    ((!input_wanted_newline && ck.previous_token?.callinfo) ||
                        (!flags.in_case &&
                            ![
                                'TK_WORD',
                                'TK_RESERVED',
                                'TK_START_EXPR',
                            ].includes(token_type) &&
                            !['--', '++', '%'].includes(token_text)))) ||
                flags.declaration_statement ||
                (flags.mode === MODE.ObjectLiteral &&
                    flags.last_text === ':' &&
                    !flags.ternary_depth)
            ) {
                set_mode(MODE.Statement);
                indent();

                switch (flags.last_word) {
                    case 'if':
                    case 'for':
                    case 'loop':
                    case 'while':
                    case 'catch':
                        print_newline(true);
                    case 'try':
                    case 'finally':
                    case 'else':
                        flags.declaration_statement = true;
                        break;
                }
                return true;
            }
            return false;
        }

        function all_lines_start_with(lines: string[], c: string): boolean {
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.charAt(0) !== c) {
                    return false;
                }
            }
            return true;
        }

        function is_special_word(word: string): boolean {
            return [
                'break',
                'continue',
                'global',
                'goto',
                'local',
                'return',
                'static',
                'throw',
            ].includes(word);
        }

        function is_next_char(find_char: string) {
            let local_pos = parser_pos;
            let c = input.charAt(local_pos);
            while (
                c !== find_char &&
                whitespace.includes(c) &&
                ++local_pos < input_length
            ) {
                c = input.charAt(local_pos);
            }
            return c === find_char ? local_pos : 0;
        }

        function get_token_ignore_comment(depth = 0): Token {
            let tk: Token;
            do {
                tk = get_next_token(depth);
            } while (tk.type.endsWith('COMMENT'));
            return tk;
        }

        function get_next_token(depth = 0): Token {
            let resulting_string: string, c: string, m: RegExpMatchArray | null;
            let bg = 0;
            const _ppos = parser_pos;
            n_newlines = 0;

            while (whitespace.includes((c = input.charAt(parser_pos++)))) {
                if (c === '\n') {
                    last_LF = parser_pos - 1;
                    n_newlines += 1;
                    begin_line = true;
                } else if (parser_pos >= input_length) {
                    add_comment_foldingrange();
                    add_sharp_foldingrange();
                    return (_this.tokens[-1] ??= {
                        content: '',
                        type: 'TK_EOF',
                        offset: input_length,
                        length: 0,
                        topofline: is_line_continue(lst, EMPTY_TOKEN) ? -1 : 1,
                        next_token_offset: -1,
                        previous_token: lst,
                    });
                }
            }

            let offset = parser_pos - 1;
            let _tk = _this.tokens[offset];
            if (_tk && _tk.length) {
                if (
                    (begin_line = Boolean(
                        _tk.topofline && _tk.type.endsWith('_BLOCK'),
                    ))
                ) {
                    last_LF = offset;
                }
                parser_pos = _tk.skip_pos ?? offset + _tk.length;
                if (((lst = _tk), _tk.ignore)) {
                    if (_tk.type === 'TK_START_EXPR') {
                        continuation_sections_mode = true;
                        if (!format_mode) {
                            return get_next_token();
                        }
                    } else if (_tk.type === 'TK_END_EXPR') {
                        continuation_sections_mode = false;
                        if (!format_mode) {
                            return get_next_token();
                        }
                    }
                } else if (_tk.type.endsWith('COMMENT')) {
                    lst = _tk.previous_token ?? EMPTY_TOKEN;
                }
                if (!format_mode) {
                    const extra = _tk.previous_extra_tokens;
                    if (extra) {
                        if (_ppos < offset) {
                            extra.i = 0;
                        }
                        if (extra.i < extra.len) {
                            _tk = extra.tokens[extra.i++];
                            parser_pos = offset;
                        } else {
                            extra.i = 0;
                        }
                    }
                }
                return _tk;
            }
            if (begin_line) {
                begin_line = false;
                bg = 1;
                let next_LF = input.indexOf('\n', parser_pos);
                if (next_LF < 0) {
                    next_LF = input_length;
                }
                const line = input
                    .substring(last_LF + 1, next_LF)
                    .trim()
                    .replace(/(^|\s+);.*$/, '');
                if (
                    line.includes('::') &&
                    (block_mode ||
                        !'"\''.includes(line[0]) ||
                        !['TK_EQUALS', 'TK_COMMA', 'TK_START_EXPR'].includes(
                            lst.type,
                        ))
                ) {
                    if ((m = line.match(/^(:([^:]*):(`.|[^`])*?::)(.*)$/i))) {
                        let execute: any;
                        if (
                            (execute = m[2].match(/[xX]/)) ||
                            m[4].match(/^\s*\{?$/)
                        ) {
                            parser_pos += m[1].length - 1;
                            lst = createToken(
                                m[1],
                                'TK_HOT',
                                offset,
                                m[1].length,
                                1,
                            );
                        } else {
                            last_LF = next_LF;
                            parser_pos = offset + m[0].length;
                            lst = createToken(
                                m[1],
                                'TK_HOTLINE',
                                offset,
                                m[1].length,
                                1,
                            );
                            offset += m[1].length;
                            lst.skip_pos = parser_pos;
                            lst.data = {
                                content: input.substring(offset, parser_pos),
                                offset,
                                length: parser_pos - offset,
                            };
                            _this.tokenranges.push({
                                start: offset,
                                end: parser_pos,
                                type: 3,
                                previous: lst.offset,
                            });
                        }
                        lst.ignore = true;
                        add_sharp_foldingrange();
                        if (!m[3]) {
                            _this.addDiagnostic(
                                diagnostic.invalidhotdef(),
                                lst.offset,
                                lst.length,
                            );
                        }
                        if (
                            lst.type === 'TK_HOTLINE' ||
                            (!execute && !m[4].match(/^\s*\{/))
                        ) {
                            if (depth > 5) {
                                delete _this.tokens[lst.offset];
                                return lst;
                            }
                            string_mode = execute = true;
                            const _lst = lst;
                            let tk = get_token_ignore_comment(depth + 1);
                            let t: number;
                            while (tk.ignore && tk.type === 'TK_STRING') {
                                if (
                                    (parser_pos = input.indexOf(
                                        '\n',
                                        (t = parser_pos),
                                    )) < 0
                                ) {
                                    parser_pos = input_length;
                                }
                                if (t < parser_pos) {
                                    const s = input
                                        .substring(t, parser_pos)
                                        .trimRight();
                                    tk.content += s;
                                    tk.length += s.length;
                                }
                                _this.tokenranges.push({
                                    start: tk.offset,
                                    end: tk.offset + tk.length,
                                    type: 3,
                                });
                                execute = false;
                                tk = get_token_ignore_comment(depth + 1);
                            }
                            string_mode = false;
                            lst = _lst;
                            if (!execute && lst.type === 'TK_HOT') {
                                lst.type = 'TK_HOTLINE';
                                lst.skip_pos = parser_pos =
                                    offset + m[0].length;
                                offset += m[1].length;
                                lst.data = {
                                    content: input.substring(
                                        offset,
                                        parser_pos,
                                    ),
                                    offset,
                                    length: parser_pos - offset,
                                };
                                _this.tokenranges.push({
                                    start: offset,
                                    end: parser_pos,
                                    type: 3,
                                    previous: lst.offset,
                                });
                            } else {
                                parser_pos =
                                    _lst.skip_pos ?? _lst.offset + _lst.length;
                            }
                        }
                        return lst;
                    } else if (
                        (m = line.match(
                            /^(((([<>$~*!+#^]*?)(`?;|\w+|[\x21-\x3A\x3C-\x7E]|[^\x00-\x7f]))|~?(`?;|[\x21-\x3A\x3C-\x7E]|\w+|[^\x00-\x7f])\s*&\s*~?(`?;|[\x21-\x3A\x3C-\x7E]|\w+|[^\x00-\x7f]))(\s+up)?\s*::)(.*)$/i,
                        ))
                    ) {
                        const mm = m[9].match(
                            /^(\s*)(([<>~*!+#^]*?)(`[{;]|[a-z]\w+|[\x21-\x7A\x7C-\x7E]|[^\x00-\x7f]))$/i,
                        );
                        add_sharp_foldingrange();
                        if (mm) {
                            const t = mm[4].toLowerCase();
                            if (
                                !allIdentifierChar.test(t) ||
                                (KEYS_RE.test(t) && !t.startsWith('joy'))
                            ) {
                                last_LF = next_LF;
                                parser_pos = offset + m[0].length;
                                lst = createToken(
                                    m[1].replace(/\s+/g, ' '),
                                    'TK_HOTLINE',
                                    offset,
                                    m[1].length,
                                    1,
                                );
                                offset += lst.length + mm[1].length;
                                lst.skip_pos = parser_pos;
                                lst.data = {
                                    content: m[9].trim(),
                                    offset,
                                    length: parser_pos - offset,
                                    data: mm[2],
                                };
                                _this.tokenranges.push({
                                    start: offset,
                                    end: parser_pos,
                                    type: 4,
                                    previous: lst.offset,
                                });
                                return lst;
                            }
                        }
                        parser_pos = input.indexOf('::', parser_pos) + 2;
                        return (lst = createToken(
                            m[1].replace(/\s+/g, ' '),
                            'TK_HOT',
                            offset,
                            m[1].length,
                            1,
                        ));
                    }
                }
                if (c !== '#') {
                    add_sharp_foldingrange();
                }
            }

            if (isIdentifierChar(c.charCodeAt(0)) || (c === '$' && allow_$)) {
                while (
                    parser_pos < input_length &&
                    isIdentifierChar(input.charCodeAt(parser_pos))
                ) {
                    c += input.charAt(parser_pos);
                    parser_pos += 1;
                }

                // small and surprisingly unugly hack for 1E-10 representation
                if (input.charAt(offset - 1) !== '.') {
                    if (
                        (m = c.match(
                            /^(\d+[Ee](\d+)?|(0[Xx][\da-fA-F]+)|(\d+))$/,
                        ))
                    ) {
                        if (m[2] || m[3]) {
                            return (
                                (lst = createToken(
                                    c,
                                    'TK_NUMBER',
                                    offset,
                                    c.length,
                                    bg,
                                )),
                                (lst.semantic = {
                                    type: SemanticTokenTypes.number,
                                }),
                                lst
                            );
                        }
                        if (m[4]) {
                            if (
                                parser_pos < input_length &&
                                input.charAt(parser_pos) === '.'
                            ) {
                                let cc = '';
                                let t = '';
                                let p = parser_pos + 1;
                                while (
                                    p < input_length &&
                                    isIdentifierChar(input.charCodeAt(p))
                                ) {
                                    cc += input.charAt(p);
                                    p += 1;
                                }
                                if (cc.match(/^\d*([Ee]\d+)?$/)) {
                                    c += '.' + cc;
                                    parser_pos = p;
                                    lst = createToken(
                                        c,
                                        'TK_NUMBER',
                                        offset,
                                        c.length,
                                        bg,
                                    );
                                    return (
                                        (lst.semantic = {
                                            type: SemanticTokenTypes.number,
                                        }),
                                        lst
                                    );
                                } else if (
                                    cc.match(/^\d*[Ee]$/) &&
                                    p < input_length &&
                                    '-+'.includes(input.charAt(p))
                                ) {
                                    cc += input.charAt(p);
                                    p += 1;
                                    while (
                                        p < input_length &&
                                        isIdentifierChar(input.charCodeAt(p))
                                    ) {
                                        t += input.charAt(p);
                                        p += 1;
                                    }
                                    if (t.match(/^\d+$/)) {
                                        c += '.' + cc + t;
                                        parser_pos = p;
                                    }
                                }
                            }
                            lst = createToken(
                                c,
                                'TK_NUMBER',
                                offset,
                                c.length,
                                bg,
                            );
                            return (
                                (lst.semantic = {
                                    type: SemanticTokenTypes.number,
                                }),
                                lst
                            );
                        } else if (
                            parser_pos < input_length &&
                            '-+'.includes(input.charAt(parser_pos))
                        ) {
                            const sign = input.charAt(parser_pos);
                            const p = parser_pos;
                            parser_pos += 1;
                            const t = get_next_token(depth + 1);
                            delete _this.tokens[t.offset];
                            if (
                                t.type === 'TK_NUMBER' &&
                                t.content.match(/^\d+$/)
                            ) {
                                c += sign + t.content;
                                lst = createToken(
                                    c,
                                    'TK_NUMBER',
                                    offset,
                                    c.length,
                                    bg,
                                );
                                return (
                                    (lst.semantic = {
                                        type: SemanticTokenTypes.number,
                                    }),
                                    lst
                                );
                            } else {
                                parser_pos = p;
                            }
                        }
                    }
                    if (reserved_words.includes(c.toLowerCase())) {
                        if (c.match(/^(and|or|not|in|is|contains)$/i)) {
                            // hack for 'in' operator
                            return (lst = createToken(
                                c,
                                'TK_OPERATOR',
                                offset,
                                c.length,
                                bg,
                            ));
                        }
                        if (bg || c.toLowerCase() !== 'class') {
                            return (lst = createToken(
                                c,
                                'TK_RESERVED',
                                offset,
                                c.length,
                                bg,
                            ));
                        }
                    }
                }
                return (lst = createToken(c, 'TK_WORD', offset, c.length, bg));
            }

            if (c === '(' || c === '[') {
                if (c === '(') {
                    if (bg && !continuation_sections_mode) {
                        let i = parser_pos;
                        let t: string;
                        while (i < input_length) {
                            if ((t = input.charAt(i++)) === '\n') {
                                if (string_mode) {
                                    // raw string
                                    // ::hotstring::string
                                    // (Join`s
                                    //   continuation
                                    //   string
                                    // )
                                    const o = last_LF + 1;
                                    let next_LF = input.indexOf('\n', i);
                                    let m: RegExpMatchArray | null = null;
                                    const data: number[] = [];
                                    while (
                                        next_LF > 0 &&
                                        !(m = input
                                            .substring(i, next_LF)
                                            .match(/^\s*\)/))
                                    ) {
                                        data.push(next_LF - i);
                                        next_LF = input.indexOf(
                                            '\n',
                                            (i = next_LF + 1),
                                        );
                                    }
                                    if (next_LF < 0) {
                                        data.push(input_length - i);
                                        m = input
                                            .substring(i, input_length)
                                            .match(/^\s*\)/);
                                    }
                                    parser_pos = m
                                        ? i + m[0].length
                                        : input_length;
                                    data.push(parser_pos - i);
                                    resulting_string = input
                                        .substring(offset, parser_pos)
                                        .trimRight();
                                    lst = createToken(
                                        input.substring(o, offset) +
                                            resulting_string,
                                        'TK_STRING',
                                        offset,
                                        resulting_string.length,
                                        1,
                                    );
                                    _this.addFoldingRange(
                                        o,
                                        parser_pos,
                                        'block',
                                    );
                                    lst.data = data;
                                    return (lst.ignore = true), lst;
                                } else {
                                    // continuation sections
                                    // obj := {
                                    //   (Join,
                                    //     key1: val1
                                    //     key2: val2
                                    //   )
                                    // }
                                    const top =
                                        !lst.type ||
                                        (lst.type === 'TK_START_BLOCK' &&
                                            lst.topofline > 0);
                                    lst = createToken(
                                        c,
                                        'TK_START_EXPR',
                                        offset,
                                        1,
                                        1,
                                    );
                                    lst.ignore = true;
                                    parser_pos = i - 1;
                                    continuation_sections_mode = true;
                                    while (
                                        ' \t'.includes(
                                            input.charAt(++offset) || '\0',
                                        )
                                    ) {
                                        continue;
                                    }
                                    const content = input
                                        .substring(offset, parser_pos)
                                        .trimRight();
                                    lst.data = {
                                        content,
                                        offset,
                                        length: parser_pos - offset,
                                    };
                                    lst.skip_pos = parser_pos;
                                    _this.tokenranges.push({
                                        start: offset,
                                        end: parser_pos,
                                        type: 4,
                                        previous: lst.offset,
                                    });
                                    const js =
                                        content.match(/(^|\s)join(\S*)/i);
                                    const ignore_comment = /(^|\s)[Cc]/.test(
                                        content,
                                    );
                                    let tk: Token;
                                    const _lst = lst;
                                    let lk = lst;
                                    let optionend = false;
                                    const _mode = format_mode;
                                    let llf = parser_pos;
                                    let sum = 0;
                                    let create_tokens: (
                                        n: number,
                                        LF: number,
                                    ) => any = (n, pos) => undefined;
                                    if (js) {
                                        const s = js[2].replace(
                                            /`[srn]/g,
                                            '  ',
                                        );
                                        let suffix_is_whitespace = false;
                                        const tl = new Lexer(
                                            TextDocument.create(
                                                '',
                                                'ahk2',
                                                -10,
                                                s,
                                            ),
                                        );
                                        tl.parseScript();
                                        delete tl.tokens[-1];
                                        const tks = Object.values(tl.tokens);
                                        offset += 4 + js[1].length + js.index!;
                                        if (tks.length) {
                                            suffix_is_whitespace =
                                                whitespace.includes(
                                                    s.charAt(s.length - 1),
                                                );
                                            tks.forEach((tk) => {
                                                tk.offset += offset;
                                                tk.length = 0;
                                                tk.next_token_offset = -1;
                                            });
                                            create_tokens = (n, last_LF) => {
                                                const tokens: Token[] = [];
                                                for (let i = 0; i < n; i++) {
                                                    last_LF = input.indexOf(
                                                        '\n',
                                                        last_LF + 1,
                                                    );
                                                    for (let tk of tks) {
                                                        tk = Object.assign(
                                                            {},
                                                            tk,
                                                        );
                                                        tk.offset = last_LF;
                                                        tokens.push(tk);
                                                    }
                                                }
                                                return {
                                                    i: 0,
                                                    len: tokens.length,
                                                    tokens,
                                                    suffix_is_whitespace,
                                                };
                                            };
                                            if (
                                                ',)]}'.includes(tks[0].content)
                                            ) {
                                                optionend = true;
                                            }
                                        }
                                    }
                                    format_mode = true;
                                    tk = get_next_token();
                                    if (
                                        continuation_sections_mode &&
                                        tk.type !== 'TK_EOF'
                                    ) {
                                        if (
                                            ignore_comment &&
                                            tk.topofline &&
                                            tk.type.endsWith('COMMENT')
                                        ) {
                                            sum = n_newlines - 2;
                                        } else {
                                            if (n_newlines > 1) {
                                                tk.previous_extra_tokens =
                                                    create_tokens(
                                                        n_newlines - 1,
                                                        llf,
                                                    );
                                            }
                                            tk.topofline = top ? 1 : 0;
                                        }
                                        llf = last_LF;
                                        lk = tk;
                                        tk = get_next_token();
                                    }
                                    while (
                                        continuation_sections_mode &&
                                        tk.type !== 'TK_EOF'
                                    ) {
                                        if (tk.topofline) {
                                            if (
                                                ignore_comment &&
                                                tk.type.endsWith('COMMENT')
                                            ) {
                                                sum += n_newlines - 1;
                                            } else {
                                                if ((sum += n_newlines)) {
                                                    tk.previous_extra_tokens =
                                                        create_tokens(sum, llf);
                                                }
                                                tk.topofline = sum = 0;
                                                if (
                                                    optionend &&
                                                    lk.content === '?'
                                                ) {
                                                    lk.ignore = true;
                                                }
                                            }
                                            llf = last_LF;
                                        }
                                        lk = tk;
                                        tk = get_next_token();
                                    }
                                    if (
                                        tk.ignore &&
                                        tk.type === 'TK_END_EXPR'
                                    ) {
                                        if (n_newlines > 1) {
                                            tk.previous_extra_tokens =
                                                create_tokens(
                                                    n_newlines - 1,
                                                    llf,
                                                );
                                        }
                                        _lst.next_pair_pos = tk.offset;
                                        tk.previous_pair_pos = _lst.offset;
                                        _this.addFoldingRange(
                                            _lst.offset,
                                            tk.offset,
                                            'block',
                                        );
                                    }
                                    parser_pos = _lst.skip_pos as number;
                                    return (lst = (format_mode = _mode)
                                        ? _lst
                                        : get_next_token());
                                }
                            } else if (t === ')' || t === '(') {
                                if (
                                    !input
                                        .substring(i - 6, i - 1)
                                        .match(/[(\s]join\S*$/i)
                                ) {
                                    break;
                                }
                            }
                        }
                    }
                }
                return (lst = createToken(c, 'TK_START_EXPR', offset, 1, bg));
            }

            if (c === ')' || c === ']') {
                lst = createToken(c, 'TK_END_EXPR', offset, 1, bg);
                if (c === ')') {
                    if (bg && continuation_sections_mode) {
                        continuation_sections_mode = false;
                        lst.ignore = true;
                        return format_mode ? lst : get_next_token();
                    }
                }
                return lst;
            }

            if (
                (c === '{' && (resulting_string = 'TK_START_BLOCK')) ||
                (c === '}' && (resulting_string = 'TK_END_BLOCK'))
            ) {
                if (bg) {
                    last_LF = offset;
                    begin_line = true;
                }
                return (lst = createToken(c, resulting_string, offset, 1, bg));
            }

            if (c === '"' || c === "'") {
                const sep = c;
                const o = offset;
                let nosep = false;
                const se = { type: SemanticTokenTypes.string };
                let _lst: Token | undefined, pt: Token | undefined;
                resulting_string = '';
                if (
                    !/^[\s+\-*/%:?~!&|^=<>[({,.]$/.test(
                        (c = input.charAt(offset - 1)),
                    )
                ) {
                    if (sep === c && c === '"') {
                        stop_parse(lst);
                    }
                    _this.addDiagnostic(diagnostic.missingspace(), offset, 1);
                }
                while ((c = input.charAt(parser_pos++))) {
                    if (c === '`') {
                        parser_pos++;
                    } else if (c === sep) {
                        resulting_string += input.substring(offset, parser_pos);
                        lst = createToken(
                            resulting_string,
                            'TK_STRING',
                            offset,
                            parser_pos - offset,
                            bg,
                        );
                        _this.tokenranges.push({
                            start: offset,
                            end: parser_pos,
                            type: 2,
                        });
                        if (nosep) {
                            lst.data = null;
                            lst.semantic = se;
                        }
                        if (_lst) {
                            lst = _lst;
                            parser_pos = lst.offset + lst.length;
                        }
                        if (isIdentifierChar(input.charCodeAt(parser_pos))) {
                            _this.addDiagnostic(
                                diagnostic.missingspace(),
                                parser_pos,
                            );
                        }
                        return lst;
                    } else if (continuation_sections_mode) {
                        if (c === '\n') {
                            const p = parser_pos - 1;
                            while (
                                ' \t'.includes(
                                    (c = input.charAt(parser_pos) || '\0'),
                                )
                            ) {
                                parser_pos++;
                            }
                            if (c === ')') {
                                resulting_string = input
                                    .substring(offset, p)
                                    .trimRight();
                                lst = createToken(
                                    resulting_string,
                                    'TK_STRING',
                                    offset,
                                    resulting_string.length,
                                    (bg = 0),
                                );
                                _lst ??= lst;
                                resulting_string = '';
                                _this.tokenranges.push({
                                    start: offset,
                                    end: offset + lst.length,
                                    type: 2,
                                });
                                let pt = lst.previous_token;
                                while (
                                    pt &&
                                    (!pt.ignore || pt.content !== '(')
                                ) {
                                    pt = pt.previous_token;
                                }
                                // lst.semantic = se;
                                _this.addFoldingRange(offset, p, 'string');
                                lst = createToken(
                                    ')',
                                    'TK_END_EXPR',
                                    parser_pos,
                                    1,
                                    1,
                                );
                                lst.ignore = true;
                                if (pt) {
                                    pt.next_pair_pos = parser_pos;
                                    lst.previous_pair_pos = pt.offset;
                                }
                                continuation_sections_mode = false;
                                nosep = true;
                                offset = ++parser_pos;
                                while (
                                    ' \t'.includes(
                                        (c = input.charAt(parser_pos) || '\0'),
                                    )
                                ) {
                                    parser_pos++;
                                }
                                resulting_string = input.substring(
                                    offset,
                                    parser_pos,
                                );
                                offset = parser_pos;
                            }
                        }
                    } else if (
                        c === '\n' ||
                        (c === ';' &&
                            ' \t'.includes(input.charAt(parser_pos - 2)))
                    ) {
                        resulting_string = (
                            resulting_string +
                            input.substring(
                                offset,
                                parser_pos - (c === ';' ? 2 : 1),
                            )
                        ).trimRight();
                        if ((--parser_pos, resulting_string)) {
                            lst = createToken(
                                resulting_string,
                                'TK_STRING',
                                offset,
                                resulting_string.trimLeft().length,
                                bg,
                            );
                            _this.tokenranges.push({
                                start: offset,
                                end: offset + lst.length,
                                type: 2,
                            });
                            if (nosep) {
                                lst.data = null;
                                lst.semantic = se;
                            }
                            _lst ??= lst;
                            resulting_string = '';
                        }
                        break;
                    }
                }
                if (c) {
                    if (depth > 5) {
                        lst = _lst as Token;
                        parser_pos = lst.offset + lst.length;
                        delete _this.tokens[lst.offset];
                        return lst;
                    }
                    string_mode = block_mode = true;
                    let tk = get_token_ignore_comment(depth + 1);
                    stringend: while (tk.ignore && tk.type === 'TK_STRING') {
                        const p = parser_pos,
                            data = tk.data as number[];
                        if (nosep) {
                            tk.semantic = se;
                        }
                        while ((c = input.charAt(parser_pos++))) {
                            if (c === '`') {
                                parser_pos++;
                            } else if (c === sep) {
                                const s = input.substring(p, parser_pos);
                                tk.content += s;
                                tk.length += s.length;
                                data[data.length - 1] += s.length;
                                _this.tokenranges.push({
                                    start: tk.offset,
                                    end: tk.offset + tk.length,
                                    type: 2,
                                });
                                if (
                                    isIdentifierChar(
                                        input.charCodeAt(parser_pos),
                                    )
                                ) {
                                    _this.addDiagnostic(
                                        diagnostic.missingspace(),
                                        parser_pos,
                                    );
                                }
                                break stringend;
                            } else if (
                                c === '\n' ||
                                (c === ';' &&
                                    ' \t'.includes(
                                        input.charAt(parser_pos - 2),
                                    ))
                            ) {
                                const s = input
                                    .substring(
                                        p,
                                        parser_pos - (c === ';' ? 2 : 1),
                                    )
                                    .trimRight();
                                if (s) {
                                    tk.content += s;
                                    tk.length += s.length;
                                    data[data.length - 1] += s.length;
                                }
                                _this.tokenranges.push({
                                    start: tk.offset,
                                    end: tk.offset + tk.length,
                                    type: 2,
                                });
                                parser_pos--;
                                break;
                            }
                        }
                        if (!c) {
                            const s = input.substring(p, --parser_pos);
                            if (s) {
                                tk.content += s;
                                tk.length += s.length;
                            }
                            _this.tokenranges.push({
                                start: tk.offset,
                                end: tk.offset + tk.length,
                                type: 2,
                            });
                        }
                        tk = get_token_ignore_comment(depth + 1);
                    }
                    if (!tk.ignore || tk.type !== 'TK_STRING') {
                        if ((pt = tk.previous_token)) {
                            _this.addDiagnostic(
                                diagnostic.unterminated(),
                                pt.offset + pt.length,
                                1,
                            );
                        } else {
                            _this.addDiagnostic(diagnostic.missing(sep), o, 1);
                        }
                    }
                    string_mode = false;
                    lst = _lst as Token;
                    parser_pos = lst.offset + lst.length;
                    return lst;
                } else {
                    _this.addDiagnostic(
                        diagnostic.unterminated(),
                        input_length,
                        1,
                    );
                    resulting_string += input.substring(offset, input_length);
                    lst = createToken(
                        resulting_string,
                        'TK_STRING',
                        offset,
                        input_length - offset,
                        bg,
                    );
                    _this.tokenranges.push({
                        start: offset,
                        end: input_length,
                        type: 2,
                    });
                    if (nosep) {
                        lst.data = null;
                        lst.semantic = se;
                    }
                    if (continuation_sections_mode) {
                        _this.addFoldingRange(offset, input_length, 'string');
                        continuation_sections_mode = false;
                    }
                    return lst;
                }
            }

            if (c === '.') {
                let nextc = input.charAt(parser_pos);
                if (nextc === '=') {
                    parser_pos++;
                    return (lst = createToken(
                        '.=',
                        'TK_EQUALS',
                        offset,
                        2,
                        bg,
                    ));
                } else if (
                    whitespace.includes(input.charAt(parser_pos - 2)) &&
                    whitespace.includes(nextc)
                ) {
                    return (lst = createToken(c, 'TK_OPERATOR', offset, 1, bg));
                } else if (
                    nextc.match(/\d/) &&
                    (lst.type === 'TK_EQUALS' || lst.type === 'TK_OPERATOR')
                ) {
                    let p = parser_pos + 1;
                    let t = '';
                    while (
                        p < input_length &&
                        isIdentifierChar(input.charCodeAt(p))
                    ) {
                        nextc += input.charAt(p);
                        p += 1;
                    }
                    if (nextc.match(/^\d+([Ee]\d+)?$/)) {
                        parser_pos = p;
                        c += nextc;
                        lst = createToken(
                            '0' + c,
                            'TK_NUMBER',
                            offset,
                            c.length,
                            bg,
                        );
                        return (
                            (lst.semantic = {
                                type: SemanticTokenTypes.number,
                            }),
                            lst
                        );
                    } else if (
                        p < input_length &&
                        nextc.match(/^\d+[Ee]$/) &&
                        '-+'.includes(input.charAt(p))
                    ) {
                        nextc += input.charAt(p);
                        p += 1;
                        while (
                            p < input_length &&
                            isIdentifierChar(input.charCodeAt(p))
                        ) {
                            t += input.charAt(p);
                            p += 1;
                        }
                        if (t.match(/^\d+$/)) {
                            parser_pos = p;
                            c += nextc + t;
                            lst = createToken(
                                '0' + c,
                                'TK_NUMBER',
                                offset,
                                c.length,
                                bg,
                            );
                            return (
                                (lst.semantic = {
                                    type: SemanticTokenTypes.number,
                                }),
                                lst
                            );
                        }
                    }
                }
                return (lst = createToken(
                    c,
                    !whitespace.includes(nextc) ? 'TK_DOT' : 'TK_UNKNOWN',
                    offset,
                    1,
                    bg,
                ));
            }

            if (c === ';') {
                let comment = '';
                const comment_type =
                    bg && '\n'.includes(input.charAt(last_LF))
                        ? 'TK_COMMENT'
                        : ((bg = 0), 'TK_INLINE_COMMENT');
                let t: any;
                let rg: Range;
                let ignore = undefined;
                let next_LF = offset - 1;
                let line: string;
                let ln = 0;
                while (true) {
                    parser_pos = next_LF;
                    next_LF = input.indexOf('\n', parser_pos + 1);
                    line = input
                        .substring(
                            parser_pos + 1,
                            (next_LF = next_LF < 0 ? input_length : next_LF),
                        )
                        .trim();
                    if (line.startsWith(';')) {
                        ln++;
                        if ((t = line.match(/^;\s*@/))) {
                            let s = line.substring(t[0].length);
                            if ((s = s.toLowerCase()) === 'include-winapi') {
                                if (h && (t = lexers[ahkuris.winapi])) {
                                    Object.defineProperty(
                                        includetable,
                                        ahkuris.winapi,
                                        { value: t.fsPath, enumerable: false },
                                    );
                                }
                            } else if ((t = s.match(/^include\s+(.*)/i))) {
                                add_include_dllload(
                                    t[1].replace(/\s+;.*$/, '').trim(),
                                );
                            } else if (s.startsWith('lint-disable')) {
                                if (
                                    currsymbol &&
                                    s.includes('class-static-member-check')
                                ) {
                                    (currsymbol as ClassNode).checkmember =
                                        false;
                                }
                            } else if (s.startsWith('lint-enable')) {
                                if (
                                    currsymbol &&
                                    s.includes('class-static-member-check')
                                ) {
                                    delete (currsymbol as ClassNode)
                                        .checkmember;
                                }
                            }
                            ignore = true;
                        } else if ((t = line.match(/^;+\s*([{}])/))) {
                            if (t[1] === '{') {
                                customblocks.bracket.push(parser_pos + 1);
                            } else if (
                                (t = customblocks.bracket.pop()) !== undefined
                            ) {
                                _this.addFoldingRange(
                                    t,
                                    parser_pos + 1,
                                    'block',
                                );
                            }
                            if (ln === 1) {
                                ignore = true;
                            }
                            if (bg) {
                                continue;
                            }
                        } else if (
                            (t = line.match(
                                /^;(\s*~?\s*)(todo|fixme)(:?\s*)(.*)/i,
                            ))
                        ) {
                            _this.children.push(
                                DocumentSymbol.create(
                                    `${t[2].toUpperCase()}: ${t[4].trim()}`,
                                    undefined,
                                    SymbolKind.Module,
                                    (rg = make_range(
                                        parser_pos + 1,
                                        next_LF - parser_pos - 1,
                                    )),
                                    rg,
                                ),
                            );
                            if (bg) {
                                continue;
                            }
                        } else if (bg) {
                            if ((t = line.match(/^;\s*#(end)?region\b/i))) {
                                ignore = true;
                                if (!t[1]) {
                                    customblocks.region.push(parser_pos + 1);
                                    if (
                                        (line = line
                                            .substring(t[0].length)
                                            .trim())
                                    ) {
                                        _this.children.push(
                                            DocumentSymbol.create(
                                                line,
                                                undefined,
                                                SymbolKind.Module,
                                                (rg = make_range(
                                                    parser_pos + 1,
                                                    next_LF - parser_pos - 1,
                                                )),
                                                rg,
                                            ),
                                        );
                                    }
                                } else if (
                                    (t = customblocks.region.pop()) !==
                                    undefined
                                ) {
                                    _this.addFoldingRange(
                                        t,
                                        parser_pos + 1,
                                        'region',
                                    );
                                }
                            } else if ((t = line.match(commentTags))) {
                                const g = (t as RegExpMatchArray).groups;
                                if (!g) {
                                    t = t[1]?.trim();
                                } else {
                                    for (const tag in g) {
                                        if (
                                            tag.startsWith('tag') &&
                                            (t = g[tag]?.trim())
                                        ) {
                                            break;
                                        }
                                    }
                                }
                                if (t) {
                                    _this.children.push(
                                        DocumentSymbol.create(
                                            t,
                                            undefined,
                                            SymbolKind.Module,
                                            (rg = make_range(
                                                parser_pos + 1,
                                                next_LF - parser_pos - 1,
                                            )),
                                            rg,
                                        ),
                                    );
                                    ignore = true;
                                }
                            }
                            continue;
                        }
                        parser_pos = next_LF;
                    }
                    break;
                }
                comment = input.substring(offset, parser_pos).trimRight();
                _this.tokenranges.push({
                    start: offset,
                    end: parser_pos,
                    type: 1,
                });
                const cmm: Token = (_this.tokens[offset] = {
                    type: comment_type,
                    content: comment,
                    offset,
                    length: comment.length,
                    next_token_offset: -1,
                    topofline: bg,
                    ignore,
                    skip_pos: parser_pos,
                    previous_token: lst,
                });
                if (!bg) {
                    if (!whitespace.includes(input.charAt(offset - 1))) {
                        _this.addDiagnostic(
                            diagnostic.unexpected(cmm.content),
                            offset,
                            cmm.length,
                        );
                    }
                } else {
                    const l = _this.document.positionAt(parser_pos).line;
                    if (
                        !string_mode &&
                        !ignore &&
                        line[0] &&
                        !line.startsWith('/*')
                    ) {
                        comments[l + 1] = cmm;
                    }
                    if (
                        last_comment_fr &&
                        (lst.pos ??= _this.document.positionAt(lst.offset))
                            .line > last_comment_fr.endLine
                    ) {
                        add_comment_foldingrange();
                    }
                    if (last_comment_fr) {
                        last_comment_fr.endLine = l;
                    } else {
                        last_comment_fr = FoldingRange.create(
                            _this.document.positionAt(offset).line,
                            l,
                            undefined,
                            undefined,
                            'commnet',
                        );
                    }
                }
                return cmm;
            }

            if (c === '/' && bg && input.charAt(parser_pos) === '*') {
                let LF = input.indexOf('\n', --parser_pos);
                let ln = 0;
                let tk: Token;
                while (
                    !(m = input
                        .substring(parser_pos, LF > 0 ? LF : input_length)
                        .match(/(^\s*\*\/)|(\*\/\s*$)/)) &&
                    LF > 0
                ) {
                    last_LF = LF;
                    LF = input.indexOf('\n', (parser_pos = LF + 1));
                    ln++;
                }
                if (m && m[1]) {
                    parser_pos = input.indexOf('*/', last_LF) + 2;
                    begin_line = true;
                    last_LF = parser_pos - 1;
                } else {
                    parser_pos = LF < 0 ? input_length : LF;
                }
                _this.tokenranges.push({
                    start: offset,
                    end: parser_pos,
                    type: 1,
                });
                const cmm: Token = {
                    type: 'TK_BLOCK_COMMENT',
                    content: input.substring(offset, parser_pos),
                    offset,
                    length: parser_pos - offset,
                    next_token_offset: -1,
                    previous_token: lst,
                    topofline: bg,
                    skip_pos: parser_pos,
                };
                if (!string_mode) {
                    if (depth > 5) {
                        return cmm;
                    }
                    const _lst = lst,
                        _pp = parser_pos;
                    if ((tk = get_next_token(depth + 1)).length) {
                        if (n_newlines < 2) {
                            tk.prefix_is_whitespace ??= ' ';
                            comments[
                                _this.document.positionAt(tk.offset).line
                            ] = cmm;
                        }
                        cmm.next_token_offset = tk.offset;
                    }
                    lst = _lst;
                    parser_pos = _pp;
                }
                add_comment_foldingrange();
                _this.tokens[offset] = cmm;
                if (ln) {
                    _this.addFoldingRange(offset, parser_pos, 'comment');
                }
                return cmm;
            }

            if (punct.includes(c)) {
                while (
                    parser_pos < input_length &&
                    punct.includes(c + input.charAt(parser_pos))
                ) {
                    c += input.charAt(parser_pos);
                    parser_pos += 1;
                    if (parser_pos >= input_length) {
                        break;
                    }
                }

                if (c === ',') {
                    return (lst = createToken(c, 'TK_COMMA', offset, 1, bg));
                } else if (c === '?') {
                    lst = createToken(c, 'TK_OPERATOR', offset, 1, bg);
                    const bak = parser_pos,
                        tk = lst,
                        t = get_token_ignore_comment(depth + 1);
                    parser_pos = bak;
                    if (
                        t.type === 'TK_COMMA' ||
                        t.type === 'TK_END_EXPR' ||
                        t.content === '}' ||
                        t.type === 'TK_EOF'
                    ) {
                        tk.ignore = true;
                    }
                    return (lst = tk);
                }
                return (lst = createToken(
                    c,
                    c.match(/([:.+\-*/|&^]|\/\/|>>|<<)=/)
                        ? 'TK_EQUALS'
                        : 'TK_OPERATOR',
                    offset,
                    c.length,
                    bg,
                ));
            }

            if (c === '#') {
                let sharp = '#';
                while (
                    isIdentifierChar(
                        (c = input.charAt(parser_pos)).charCodeAt(0),
                    )
                ) {
                    sharp += c;
                    parser_pos++;
                }
                sharp_offsets.push(offset);
                lst = createToken(sharp, 'TK_SHARP', offset, sharp.length, bg);
                token_text_low = sharp.toLowerCase();
                if (
                    bg &&
                    whitespace.includes(c) &&
                    (token_text_low === '#hotif' ||
                        (h && token_text_low === '#initexec'))
                ) {
                    return lst;
                }
                last_LF = input.indexOf('\n', (offset = parser_pos));
                parser_pos = last_LF < 0 ? input_length : last_LF;
                if (bg && whitespace.includes(c)) {
                    if (c === ' ' || c === '\t') {
                        while (' \t'.includes(input.charAt(offset) || '\0')) {
                            offset++;
                        }
                        const content = input
                            .substring(offset, parser_pos)
                            .trimRight()
                            .replace(/(^|\s+);.*$/, '');
                        lst.skip_pos = parser_pos = offset + content.length;
                        lst.data = { content, offset, length: content.length };
                        _this.tokenranges.push({
                            start: offset,
                            end: offset + content.length,
                            type: 3,
                            previous: lst.offset,
                        });
                    }
                } else {
                    lst.type = 'TK_UNKNOWN';
                    lst.content += input
                        .substring(offset, parser_pos)
                        .trimRight();
                    lst.length += parser_pos - offset;
                }
                return lst;
            }

            return (lst = createToken(c, 'TK_UNKNOWN', offset, c.length, bg));

            function add_sharp_foldingrange() {
                if (sharp_offsets.length > 1) {
                    _this.addFoldingRange(
                        sharp_offsets[0],
                        sharp_offsets.pop() as number,
                        'imports',
                    );
                }
                sharp_offsets.length = 0;
            }
            function add_comment_foldingrange() {
                if (!last_comment_fr) {
                    return;
                }
                if (last_comment_fr.endLine > last_comment_fr.startLine) {
                    _this.foldingranges.push(last_comment_fr);
                }
                last_comment_fr = undefined;
            }
        }

        function real_indentation_level() {
            const line = output_lines[flags.start_line_index - 1];
            if (line?.text.length) {
                return line.indent;
            }
            return flags.indentation_level;
        }

        function handle_start_expr(): void {
            if (start_of_statement()) {
                flags.last_word = '_';
            } else if (
                need_newline() ||
                (input_wanted_newline &&
                    !is_line_continue(ck.previous_token ?? EMPTY_TOKEN, ck))
            ) {
                print_newline();
            }

            let next_mode = MODE.Expression;
            if (token_text === '[') {
                if (!input_wanted_newline) {
                    if (ck.previous_token?.callinfo) {
                        output_space_before_token = true;
                    } else if (
                        ['TK_WORD', 'TK_STRING', 'TK_END_EXPR'].includes(
                            last_type,
                        )
                    ) {
                        set_mode(next_mode);
                        previous_flags.indentation_level =
                            real_indentation_level();
                        print_token();
                        // indent();
                        flags.indentation_level =
                            previous_flags.indentation_level + 1;
                        if (opt.space_in_paren) {
                            output_space_before_token = true;
                        }
                        return;
                    }
                }

                if (last_type === 'TK_RESERVED') {
                    output_space_before_token = true;
                }

                next_mode = MODE.ArrayLiteral;
                if (is_array(flags.mode)) {
                    if (
                        flags.last_text === '[' ||
                        (flags.last_text === ',' &&
                            (last_last_text === ']' || last_last_text === '}'))
                    ) {
                        // ], [ goes to new line
                        // }, [ goes to new line
                        if (!opt.keep_array_indentation) {
                            print_newline();
                        }
                    }
                }
            } else {
                if (ck.ignore) {
                    print_newline(true);
                } else if (
                    last_type === 'TK_END_EXPR' ||
                    last_type === 'TK_WORD'
                ) {
                    output_space_before_token = whitespace.includes(
                        ck.prefix_is_whitespace || '\0',
                    );
                } else if (last_type === 'TK_STRING') {
                    output_space_before_token = true;
                } else if (last_type === 'TK_RESERVED') {
                    if (last_text.match(/^(break|continue|goto)$/i)) {
                        output_space_before_token = false;
                    } else if (
                        [
                            'if',
                            'for',
                            'while',
                            'loop',
                            'case',
                            'catch',
                            'switch',
                        ].includes(last_text)
                    ) {
                        output_space_before_token = Boolean(
                            opt.space_before_conditional,
                        );
                    } else {
                        output_space_before_token = space_in_other;
                    }
                }
            }

            if (input_wanted_newline && opt.preserve_newlines) {
                print_newline(true);
            } else if (
                last_type === 'TK_EQUALS' ||
                last_type === 'TK_COMMA' ||
                last_type === 'TK_OPERATOR'
            ) {
                if (!start_of_object_property()) {
                    allow_wrap_or_preserved_newline();
                }
            }

            set_mode(next_mode);
            flags.indentation_level = real_indentation_level();
            print_token();

            // (options\n...\n)
            if (ck.ignore) {
                const c = ck.data.content;
                if (c) {
                    print_token(c);
                }
            } else if (opt.space_in_paren) {
                output_space_before_token = true;
            }

            // In all cases, if we newline while inside an expression it should be indented.
            indent();

            if (
                token_text === '[' &&
                !opt.keep_array_indentation &&
                opt.preserve_newlines
            ) {
                print_newline(true);
            }
        }

        function handle_end_expr() {
            // statements inside expressions are not valid syntax, but...
            // statements must all be closed when their container closes
            while (flags.mode === MODE.Statement) {
                restore_mode();
            }

            if (
                (last_type === 'TK_END_EXPR' || last_type === 'TK_END_BLOCK') &&
                flags.indentation_level < flags.parent.indentation_level
            ) {
                trim_newlines();
            } else if (last_type !== 'TK_START_EXPR') {
                allow_wrap_or_preserved_newline(
                    token_text === ']' &&
                        is_array(flags.mode) &&
                        !opt.keep_array_indentation &&
                        opt.preserve_newlines,
                );
            }

            output_space_before_token = Boolean(
                opt.space_in_paren &&
                    !(
                        last_type === 'TK_START_EXPR' &&
                        !opt.space_in_empty_paren
                    ),
            );
            restore_mode();
            if (just_added_newline()) {
                if (
                    previous_flags.indentation_level === flags.indentation_level
                ) {
                    deindent();
                    if (
                        previous_flags.indentation_level ===
                        flags.indentation_level
                    ) {
                        trim_newlines();
                    }
                }
            }
            print_token();
        }

        function handle_start_block() {
            if (ck.data) {
                set_mode(MODE.ObjectLiteral);
                keep_object_line =
                    !_this.tokens[ck.next_token_offset]?.topofline;
                flags.indentation_level = real_indentation_level();
                if (previous_flags.mode !== MODE.Conditional) {
                    previous_flags.indentation_level = flags.indentation_level;
                }

                output_space_before_token ||=
                    last_type !== 'TK_START_EXPR' && space_in_other;
                print_token();
                indent();
                if (!keep_object_line) {
                    print_newline(true);
                } else {
                    output_space_before_token = space_in_other;
                }
            } else {
                const had_comment = flags.had_comment;
                if (
                    ![
                        'try',
                        'if',
                        'for',
                        'while',
                        'loop',
                        'catch',
                        'else',
                        'finally',
                        'switch',
                    ].includes(flags.last_word)
                ) {
                    while (flags.mode === MODE.Statement) {
                        restore_mode();
                    }
                }
                flags.declaration_statement = false;
                set_mode(MODE.BlockStatement);
                output_space_before_token ??= space_in_other;

                if (
                    previous_flags.in_case_statement &&
                    !had_comment &&
                    last_type === 'TK_LABEL' &&
                    /^(default)?:$/.test(last_text)
                ) {
                    flags.indentation_level--;
                    flags.case_body = null;
                    trim_newlines();
                }
                if (
                    opt.brace_style === 0 ||
                    (input_wanted_newline &&
                        opt.preserve_newlines &&
                        !opt.brace_style)
                ) {
                    print_newline(true);
                }

                const need_newline = !just_added_newline();
                print_token();
                indent();
                if (need_newline || opt.brace_style !== undefined) {
                    print_newline();
                } else {
                    output_space_before_token = space_in_other;
                }
            }
        }

        function handle_end_block() {
            // statements must all be closed when their container closes
            while (flags.mode === MODE.Statement) {
                restore_mode();
            }

            const is_obj = flags.mode === MODE.ObjectLiteral,
                need_newline = false;
            if (is_obj) {
                if (last_type === 'TK_START_BLOCK') {
                    output_space_before_token = false;
                } else if (is_array(flags.mode) && opt.keep_array_indentation) {
                    // we REALLY need a newline here, but newliner would skip that
                    opt.keep_array_indentation = false;
                    print_newline();
                    opt.keep_array_indentation = true;
                } else {
                    output_space_before_token = space_in_other;
                    if (
                        (last_type === 'TK_END_EXPR' ||
                            last_type === 'TK_END_BLOCK') &&
                        flags.indentation_level < flags.parent.indentation_level
                    ) {
                        trim_newlines();
                    } else if (
                        (input_wanted_newline && opt.preserve_newlines) ||
                        !(flags.mode === MODE.ObjectLiteral && keep_object_line)
                    ) {
                        print_newline();
                    }
                }
            } else if (opt.brace_style !== undefined || input_wanted_newline) {
                print_newline();
            }

            restore_mode();
            if (
                previous_flags.indentation_level === flags.indentation_level &&
                just_added_newline()
            ) {
                deindent();
            }
            print_token();
            if (!is_obj) {
                if (previous_flags.case_body === null) {
                    indent();
                }
                if (opt.brace_style !== undefined) {
                    print_newline(true);
                }
                output_space_before_token = space_in_other;
            }
        }

        function handle_word() {
            let preserve_statement_flags = false;
            if (
                last_text.match(/[^\W]$/) ||
                ['TK_END_EXPR', 'TK_STRING'].includes(last_type)
            ) {
                output_space_before_token = true;
            }

            if (start_of_statement()) {
                // The conditional starts the statement if appropriate.
                preserve_statement_flags = flags.declaration_statement;
                if (
                    !input_wanted_newline &&
                    ['try', 'else', 'finally'].includes(flags.last_word) &&
                    ['if', 'while', 'loop', 'for', 'try', 'switch'].includes(
                        token_text_low,
                    )
                ) {
                    deindent();
                }
            }

            if (token_type === 'TK_RESERVED') {
                if (opt.keyword_start_with_uppercase !== undefined) {
                    token_text = opt.keyword_start_with_uppercase
                        ? token_text_low.replace(/^./, (s) => s.toUpperCase())
                        : token_text_low;
                }
                if (is_special_word(token_text_low)) {
                    if (input_wanted_newline) {
                        print_newline(preserve_statement_flags);
                    }
                } else {
                    let maybe_need_newline = false;

                    switch (token_text_low) {
                        case 'else':
                            while (
                                flags.mode === MODE.Statement &&
                                !flags.if_block &&
                                !flags.loop_block &&
                                !(flags.catch_block && !flags.else_block)
                            ) {
                                restore_mode();
                            }
                            break;
                        case 'finally':
                            while (
                                flags.mode === MODE.Statement &&
                                !flags.catch_block &&
                                !flags.try_block &&
                                !(flags.else_block && flags.catch_block)
                            ) {
                                restore_mode();
                            }
                            break;
                        case 'catch':
                            while (
                                flags.mode === MODE.Statement &&
                                !flags.try_block &&
                                !(flags.catch_block && !flags.else_block)
                            ) {
                                restore_mode();
                            }
                            break;
                        case 'until':
                            while (
                                flags.mode === MODE.Statement &&
                                flags.loop_block !== 1
                            ) {
                                restore_mode();
                            }
                            break;
                        case 'case':
                        case 'class':
                            while (flags.mode === MODE.Statement) {
                                restore_mode();
                            }
                            break;
                        case 'if':
                        case 'for':
                        case 'loop':
                        case 'while':
                        case 'try':
                        case 'switch':
                            if (!preserve_statement_flags) {
                                if (
                                    input_wanted_newline &&
                                    flags.mode === MODE.Statement &&
                                    !flags.declaration_statement &&
                                    !flags.is_expression
                                ) {
                                    print_newline(false);
                                } else {
                                    while (
                                        flags.mode === MODE.Statement &&
                                        flags.declaration_statement
                                    ) {
                                        restore_mode();
                                    }
                                }
                            }
                            break;
                    }

                    if (flags.if_block) {
                        if (token_text_low === 'else') {
                            flags.if_block = false;
                            flags.else_block = true;
                            maybe_need_newline = true;
                        } else {
                            flags.if_block = false;
                        }
                    } else if (flags.loop_block) {
                        if (
                            flags.loop_block === 1 &&
                            token_text_low === 'until'
                        ) {
                            flags.loop_block = 0;
                            maybe_need_newline = true;
                        } else if (token_text_low === 'else') {
                            flags.else_block = true;
                            flags.loop_block = 0;
                            maybe_need_newline = true;
                        } else {
                            flags.loop_block = 0;
                        }
                    } else if (flags.try_block) {
                        if (token_text_low === 'catch') {
                            flags.try_block = false;
                            flags.catch_block = true;
                            maybe_need_newline = true;
                        } else if (token_text_low === 'finally') {
                            flags.try_block = false;
                            flags.finally_block = true;
                            maybe_need_newline = true;
                        } else {
                            flags.try_block = false;
                        }
                    } else if (flags.catch_block) {
                        if (token_text_low === 'finally') {
                            flags.catch_block = flags.else_block = false;
                            flags.finally_block = true;
                            maybe_need_newline = true;
                        } else if (token_text_low === 'else') {
                            flags.else_block = true;
                            maybe_need_newline = true;
                        } else if (token_text_low === 'catch') {
                            maybe_need_newline = true;
                        } else {
                            flags.catch_block = flags.else_block = false;
                        }
                    } else {
                        flags.else_block = flags.finally_block = false;
                    }

                    if (token_text_low === 'class') {
                        print_newline();
                        print_token();
                        flags.last_word = token_text_low;
                        set_mode(MODE.Statement);
                        is_conditional = true;
                        return;
                    } else if (
                        token_text_low === 'case' &&
                        (flags.in_case_statement ||
                            (flags.mode === 'BlockStatement' &&
                                flags.last_word === 'switch'))
                    ) {
                        print_newline();
                        if (flags.case_body) {
                            deindent();
                            flags.case_body = false;
                        }
                        print_token();
                        flags.in_case = true;
                        flags.in_case_statement = true;
                        return;
                    }
                    if (maybe_need_newline) {
                        trim_newlines();
                        if (
                            flags.last_text !== '}' ||
                            opt.brace_style! < 1 ||
                            (input_wanted_newline &&
                                opt.preserve_newlines &&
                                !opt.brace_style)
                        ) {
                            print_newline(true);
                        } else {
                            output_space_before_token = space_in_other;
                        }
                    } else if (input_wanted_newline) {
                        if (
                            last_text === 'else' &&
                            !opt.preserve_newlines &&
                            [
                                'if',
                                'for',
                                'loop',
                                'while',
                                'try',
                                'switch',
                            ].includes(token_text_low)
                        ) {
                            deindent();
                        } else {
                            print_newline(preserve_statement_flags);
                        }
                    }

                    switch (token_text_low) {
                        case 'loop':
                            flags.loop_block = 1;
                            break;
                        case 'while':
                        case 'for':
                            flags.loop_block = 2;
                            break;
                        case 'if':
                            flags.if_block = true;
                            break;
                        case 'try':
                            flags.try_block = true;
                            break;
                    }
                }
                flags.last_word = token_text_low;
            } else {
                if (
                    input_wanted_newline &&
                    flags.mode === MODE.Statement &&
                    !flags.is_expression &&
                    !is_line_continue(ck.previous_token ?? EMPTY_TOKEN, ck)
                ) {
                    print_newline(preserve_statement_flags);
                } else if (
                    input_wanted_newline &&
                    (opt.preserve_newlines || ck.symbol)
                ) {
                    print_newline(!ck.symbol);
                } else if (
                    [
                        'TK_COMMA',
                        'TK_START_EXPR',
                        'TK_EQUALS',
                        'TK_OPERATOR',
                    ].includes(last_type)
                ) {
                    if (!start_of_object_property()) {
                        allow_wrap_or_preserved_newline();
                    }
                }
                if (
                    !is_conditional &&
                    flags.mode === MODE.BlockStatement &&
                    ck.symbol?.children
                ) {
                    set_mode(MODE.Statement);
                    is_conditional = true;
                }
                flags.last_word = '_';
                if (opt.symbol_with_same_case) {
                    token_text = ck.definition?.name || token_text;
                }
            }

            print_token();
        }

        function handle_string() {
            if (start_of_statement()) {
                if (input_wanted_newline && opt.preserve_newlines) {
                    print_newline(true);
                } else {
                    output_space_before_token = flags.declaration_statement
                        ? last_type !== 'TK_OPERATOR'
                        : space_in_other;
                }
            } else if (last_type === 'TK_RESERVED' || last_type === 'TK_WORD') {
                if (input_wanted_newline) {
                    print_newline();
                } else {
                    output_space_before_token = true;
                }
            } else if (
                last_type === 'TK_COMMA' ||
                last_type === 'TK_START_EXPR' ||
                last_type === 'TK_EQUALS' ||
                last_type === 'TK_OPERATOR'
            ) {
                if (!start_of_object_property()) {
                    allow_wrap_or_preserved_newline();
                }
            } else {
                // print_newline();
                if (input_wanted_newline) {
                    print_newline();
                }
                if (ck.ignore || ck.data !== undefined) {
                    output_space_before_token = false;
                } else {
                    output_space_before_token = true;
                }
            }
            if (ck.ignore) {
                print_newline(true);
                output_lines[output_lines.length - 1].text = [token_text];
                return;
            }
            print_token();
        }

        function handle_equals() {
            if (start_of_statement()) {
                // The conditional starts the statement if appropriate.
            }

            output_space_before_token = space_in_other;
            print_token();
            output_space_before_token = space_in_other;
        }

        function handle_comma() {
            if (
                flags.mode === MODE.BlockStatement ||
                flags.declaration_statement
            ) {
                set_mode(MODE.Statement);
                indent();
            }
            if (
                last_type === 'TK_WORD' &&
                whitespace.includes(ck.prefix_is_whitespace || '\0') &&
                ck.previous_token?.callinfo
            ) {
                if (input_wanted_newline && opt.preserve_newlines) {
                    print_newline(true);
                } else {
                    output_space_before_token = true;
                }
            } else {
                output_space_before_token =
                    (space_in_other && last_type === 'TK_COMMA') ||
                    (last_text === 'for' && last_type === 'TK_RESERVED');
                if (
                    flags.mode === MODE.Statement &&
                    flags.parent.mode === MODE.ObjectLiteral
                ) {
                    restore_mode();
                }
                if (input_wanted_newline && opt.preserve_newlines) {
                    print_newline(true);
                } else if (!just_added_newline()) {
                    input_wanted_newline = false;
                }
            }
            print_token();
            if (
                !input_wanted_newline &&
                !keep_object_line &&
                flags.mode === MODE.ObjectLiteral
            ) {
                print_newline();
            } else {
                output_space_before_token = space_in_other;
            }
        }

        function handle_operator() {
            let space_before = Boolean(
                space_in_other || token_text.match(/^\w/),
            );
            let space_after = space_before;
            if (ck.previous_token?.callinfo) {
                output_space_before_token = true;
            }
            if (start_of_statement()) {
                // The conditional starts the statement if appropriate.
                if (
                    flags.declaration_statement &&
                    token_text_low.match(/^(\+\+|--|%|!|~|not)$/)
                ) {
                    output_space_before_token = true;
                    flags.last_word = '_';
                    print_token();
                    if (token_text_low === 'not') {
                        output_space_before_token = true;
                    }
                    return;
                }
            } else if (token_text === '=>') {
                if (flags.mode === MODE.BlockStatement) {
                    set_mode(MODE.Statement);
                } else if (
                    is_conditional &&
                    flags.parent.mode === MODE.BlockStatement
                ) {
                    is_conditional = false;
                }
                indent();
                flags.in_fat_arrow = true;
            } else if (
                token_text_low.match(/^(\+\+|--|%|!|~|not)$/) &&
                need_newline()
            ) {
                print_newline();
                print_token();
                if (token_text_low === 'not') {
                    output_space_before_token = true;
                }
                return;
            }

            if (last_type === 'TK_RESERVED') {
                output_space_before_token = true;
            }

            // %...%
            if (token_text === '%') {
                space_after = Boolean(
                    ck.previous_pair_pos !== undefined &&
                        ' \t'.includes(input.charAt(ck.offset + 1) || '\0'),
                );
                output_space_before_token ||= Boolean(
                    ck.next_pair_pos &&
                        ' \t'.includes(ck.prefix_is_whitespace || '\0'),
                );
                if (input_wanted_newline && opt.preserve_newlines) {
                    if (
                        flags.mode === MODE.Statement &&
                        is_line_continue(ck.previous_token ?? EMPTY_TOKEN, ck)
                    ) {
                        print_newline(true);
                    }
                }
                print_token();
                output_space_before_token = space_after;
                return;
            }

            // case ...:
            if (
                token_text === ':' &&
                (flags.in_case ||
                    (flags.mode === MODE.Statement && flags.parent.in_case))
            ) {
                if (!flags.in_case) {
                    restore_mode();
                }
                indent();
                print_token();
                if (is_next_char('\n')) {
                    print_newline();
                } else {
                    output_space_before_token = space_in_other;
                }
                flags.in_case = false;
                flags.case_body = true;
                set_mode(MODE.Statement);
                flags.case_body = true;
                token_type = 'TK_LABEL';
                return;
            }

            if (input_wanted_newline && opt.preserve_newlines) {
                print_newline(true);
            } else if (
                last_type === 'TK_OPERATOR' &&
                !last_text.match(/^(--|\+\+|%|!|~|not)$/)
            ) {
                allow_wrap_or_preserved_newline();
            }

            if (
                ['--', '++', '!', '~'].includes(token_text) ||
                ('-+'.includes(token_text) &&
                    ([
                        'TK_START_BLOCK',
                        'TK_START_EXPR',
                        'TK_EQUALS',
                        'TK_OPERATOR',
                        'TK_COMMA',
                        'TK_RESERVED',
                    ].includes(last_type) ||
                        ck.previous_token?.callinfo))
            ) {
                space_after = false;
                space_before = token_text === '!' && last_type === 'TK_WORD';

                if (
                    !output_space_before_token &&
                    (token_text === '++' || token_text === '--') &&
                    ['TK_END_EXPR', 'TK_WORD'].includes(last_type)
                ) {
                    space_after = true;
                }
            } else if (token_text === ':') {
                if (flags.ternary_depth) {
                    restore_mode();
                    flags.ternary_depth--;
                } else {
                    space_before = false;
                }
            } else if (token_text === '?') {
                if (!ck.ignore) {
                    if (flags.ternary_depth === undefined) {
                        flags.ternary_depth = 1;
                    } else {
                        flags.ternary_depth++;
                        indent();
                    }
                    set_mode(MODE.Expression);
                } else {
                    space_before = space_after = false;
                }
            } else if (token_text === '.') {
                space_after = space_before = true;
            } else if (token_text === '&') {
                if (
                    (last_type !== 'TK_WORD' && last_type !== 'TK_END_EXPR') ||
                    ck.previous_token?.callinfo
                ) {
                    space_after = false;
                }
                if (last_type === 'TK_COMMA' || last_type === 'TK_START_EXPR') {
                    space_before = false;
                }
            } else if (token_text === '*') {
                if (last_text === ',') {
                    space_after = false;
                } else if (
                    _this.tokens[ck.next_token_offset]?.type === 'TK_END_EXPR'
                ) {
                    space_before = space_after = false;
                }
            }

            output_space_before_token ||= space_before;
            print_token();
            output_space_before_token = space_after;
        }

        function handle_block_comment() {
            const lines = token_text.split('\n');
            const javadoc = lines[0].match(/^\/\*(@ahk2exe-keep|[^*]|$)/i)
                ? false
                : true;
            let remove: RegExp | string = '';
            let t: RegExpMatchArray | null, j: number;
            if (
                !javadoc &&
                (t = lines[lines.length - 1].match(/^(\s)\1*/)) &&
                t[0] !== ' '
            ) {
                remove = new RegExp(`^${t[1]}{1,${t[0].length}}`);
            }

            // block comment starts with a new line
            print_newline(true);
            if (flags.mode === MODE.Statement) {
                const nk = _this.tokens[ck.previous_token?.next_token_offset!];
                if (
                    !nk ||
                    (!flags.in_expression &&
                        !is_line_continue(nk.previous_token ?? EMPTY_TOKEN, nk))
                ) {
                    print_newline();
                } else if (flags.had_comment < 2) {
                    trim_newlines();
                }
            }

            // first line always indented
            print_token(lines[0].trimRight());
            for (j = 1; j < lines.length - 1; j++) {
                print_newline(true);
                if (javadoc) {
                    print_token(' * ' + lines[j].replace(/^\s*\* ?/g, ''));
                } else {
                    print_token(lines[j].trimRight().replace(remove, ''));
                }
            }
            if (lines.length > 1) {
                print_newline(true);
                print_token(
                    (javadoc ? ' ' : '') + lines[lines.length - 1].trim(),
                );
            }
            print_newline(true);
            flags.had_comment = 3;
        }

        function handle_inline_comment() {
            if (opt.ignore_comment) {
                return (token_text = '');
            }
            if (just_added_newline()) {
                output_lines.pop();
            }
            let t;
            output_lines[output_lines.length - 1].text.push(
                opt.white_space_before_inline_comment ||
                    ((t = ck.previous_token)
                        ? input.substring(
                              t.skip_pos ?? t.offset + t.length,
                              ck.offset,
                          )
                        : '\t'),
                token_text,
            );
            print_newline(true);
            flags.had_comment = 1;
        }

        function handle_comment() {
            if (opt.ignore_comment) {
                return;
            }
            print_newline(true);
            if (flags.mode === MODE.Statement) {
                const nk = _this.tokens[ck.previous_token?.next_token_offset!];
                if (
                    !nk ||
                    (!flags.in_expression &&
                        !is_line_continue(nk.previous_token ?? EMPTY_TOKEN, nk))
                ) {
                    print_newline();
                } else if (flags.had_comment < 2) {
                    trim_newlines();
                }
            }
            token_text.split('\n').forEach((s) => {
                print_newline(true);
                print_token(s.trim());
            });
            print_newline(true);
            flags.had_comment = 2;
        }

        function handle_dot() {
            if (start_of_statement()) {
                // The conditional starts the statement if appropriate.
            }

            // allow preserved newlines before dots in general
            // force newlines on dots after close paren when break_chained - for bar().baz()
            allow_wrap_or_preserved_newline(
                flags.last_text === ')' && opt.break_chained_methods,
            );
            print_token();
        }

        function handle_number() {
            token_type = 'TK_WORD';
            handle_word();
        }

        function handle_sharp() {
            print_newline();
            if (opt.symbol_with_same_case && token_type === 'TK_SHARP') {
                token_text = hoverCache[token_text_low]?.[0] || token_text;
            }
            if (
                token_text_low === '#hotif' &&
                opt.indent_between_hotif_directive
            ) {
                if (flags.hotif_block) {
                    deindent();
                    flags.hotif_block = false;
                }
                print_token();
                if (_this.tokens[ck.next_token_offset]?.topofline === 0) {
                    indent();
                    flags.hotif_block = true;
                }
                output_space_before_token = true;
                return;
            }
            print_token();
            const t = ck.data?.content;
            if (t) {
                print_token(token_type === 'TK_HOTLINE' ? t : ' ' + t);
            } else if (token_type === 'TK_HOT') {
                output_space_before_token = !!opt.space_after_double_colon;
            } else {
                output_space_before_token =
                    space_in_other || token_type === 'TK_SHARP';
            }
        }

        function handle_label() {
            print_newline();
            if (
                token_text_low === 'default:' &&
                (flags.in_case_statement ||
                    (flags.mode === MODE.BlockStatement &&
                        flags.last_word === 'switch'))
            ) {
                if (flags.case_body) {
                    deindent();
                } else {
                    flags.case_body = true;
                }
                print_token();
                indent();
                flags.in_case = false;
                flags.in_case_statement = true;
                output_space_before_token = space_in_other;
                set_mode(MODE.Statement);
                flags.case_body = true;
                return;
            }
            print_token();
            const t = output_lines[output_lines.length - 1].text;
            if (t[0].trim() === '') {
                output_lines[output_lines.length - 1].text = t.slice(1);
            } else {
                indent();
            }
        }

        function handle_unknown() {
            print_token();
            print_newline();
        }

        function need_newline() {
            return (
                input_wanted_newline &&
                ((flags.parent.mode === MODE.BlockStatement &&
                    [
                        'TK_END_EXPR',
                        'TK_START_BLOCK',
                        'TK_END_BLOCK',
                        'TK_WORD',
                        'TK_STRING',
                    ].includes(last_type)) ||
                    (last_type === 'TK_OPERATOR' &&
                        last_text.match(/^(\+\+|--|%)$/)) ||
                    (last_type === 'TK_RESERVED' &&
                        last_text.match(
                            /^(break|continue|goto|global|local|loop|return|static|throw)$/,
                        )))
            );
        }
    }

    private clear() {
        this.texts = {};
        this.declaration = {};
        this.include = {};
        this.tokens = {};
        this.linepos = {};
        this.labels = {};
        this.object = { method: {}, property: {} };
        this.funccall.length =
            this.diagnostics.length =
            this.foldingranges.length =
                0;
        this.children.length =
            this.dllpaths.length =
            this.tokenranges.length =
            this.anonymous.length =
                0;
        this.includedir = new Map();
        this.dlldir = new Map();
        delete (<any>this).checkmember;
    }

    public searchNode(
        name: string,
        position?: Position,
        kind?: SymbolKind,
    ):
        | {
              node: DocumentSymbol;
              uri: string;
              ref?: boolean;
              scope?: DocumentSymbol;
              fn_is_static?: boolean;
          }
        | undefined
        | false
        | null {
        let node: DocumentSymbol | undefined;
        let t: DocumentSymbol | undefined;
        let uri = this.uri;
        name = name.toUpperCase();
        if (
            kind === SymbolKind.Variable ||
            kind === SymbolKind.Class ||
            kind === SymbolKind.Function
        ) {
            let scope: DocumentSymbol | undefined;
            let bak: DocumentSymbol | undefined;
            let ref = true;
            let fn_is_static = false;
            if (name.startsWith('$')) {
                const index = parseInt((name = name.substring(1)));
                if ((node = this.anonymous[index])) {
                    return { node, uri };
                }
                if (!isNaN(index)) {
                    return null;
                }
            } else if (name.startsWith('#')) {
                name = name.substring(1);
                if ((node = from_d(this.d_uri))) {
                    return { node, uri };
                }
                return undefined;
            }
            if (position) {
                scope = this.searchScopedNode(position);
                if (scope) {
                    if (scope.kind === SymbolKind.Class) {
                        scope = undefined;
                        // if (scope.selectionRange.start.line === position.line)
                        // 	scope = undefined;
                        // else {
                        // 	let cls = scope as ClassNode, line = this.buildContext(position, true).range.start.line;
                        // 	node = cls.children?.find(it => it.selectionRange.start.line === line && it.name.toUpperCase() === name);
                        // 	if (node?.kind === SymbolKind.Property)
                        // 		node = ((node as Variable).static ? cls.staticdeclaration[name] : cls.declaration[name]) ?? node;
                        // 	if (node)
                        // 		return { node, uri, scope };
                        // 	return null;
                        // }
                    } else if (
                        scope.kind === SymbolKind.Function &&
                        (<FuncNode>scope).static
                    ) {
                        fn_is_static = true;
                    }
                    bak = scope;
                }
            }
            if (scope) {
                while (scope) {
                    const dec = (<FuncNode>scope).declaration,
                        loc = (<FuncNode>scope).local,
                        glo = (<FuncNode>scope).global;
                    if (
                        (t = loc?.[name]) &&
                        (!fn_is_static || (<Variable>t).static)
                    ) {
                        return { node: t, uri, scope };
                    } else if ((t = glo?.[name])) {
                        return {
                            node:
                                from_d(this.d_uri) ??
                                this.declaration[name] ??
                                t,
                            uri,
                        };
                    } else if ((<FuncNode>scope).assume === FuncScope.GLOBAL) {
                        if (
                            (scope as FuncNode).has_this_param &&
                            ['THIS', 'SUPER'].includes(name)
                        ) {
                            node = undefined;
                            break;
                        }
                        if (
                            (node =
                                from_d(this.d_uri) ??
                                this.declaration[name] ??
                                node)
                        ) {
                            return { node, uri };
                        }
                        return undefined;
                    } else if (
                        dec &&
                        scope.kind !== SymbolKind.Class &&
                        (t = dec[name])
                    ) {
                        if (fn_is_static) {
                            if ((<Variable>t).static) {
                                return { node: t, uri, scope };
                            }
                            if (
                                bak === scope ||
                                (<Variable>t).static === null
                            ) {
                                node = t;
                                bak = scope;
                            }
                        } else {
                            if (
                                scope.kind === SymbolKind.Method ||
                                !(<FuncNode>scope).parent
                            ) {
                                return { node: t, uri, scope };
                            }
                            node = t;
                            bak = scope;
                        }
                    } else if (fn_is_static && bak === scope) {
                        node = scope.children?.find(
                            (it) => it.name.toUpperCase() === name,
                        );
                        if (node && (<Variable>node).static) {
                            return { node, uri, scope };
                        }
                    } else if (
                        (scope as FuncNode).has_this_param &&
                        ['THIS', 'SUPER'].includes(name)
                    ) {
                        node = undefined;
                        break;
                    }
                    scope = (<any>scope).parent;
                }
                if (node) {
                    if (
                        fn_is_static &&
                        (t = (<Variable>node).def
                            ? ((scope ??= bak), node)
                            : ((scope = undefined),
                              from_d(this.d_uri) ?? this.declaration[name]))
                    ) {
                        return { node: t, uri, scope };
                    } else {
                        return { node, uri, fn_is_static, scope: bak };
                    }
                } else if (['THIS', 'SUPER'].includes(name)) {
                    scope = bak;
                    if (scope?.kind === SymbolKind.Class && position) {
                        const off = this.document.offsetAt(position);
                        for (const it of scope.children ?? []) {
                            if (
                                it.kind === SymbolKind.Property &&
                                (it as any).static &&
                                this.document.offsetAt(it.range.start) <= off &&
                                off < this.document.offsetAt(it.range.end)
                            ) {
                                ref = false;
                                break;
                            }
                        }
                    }
                    while (scope && scope.kind !== SymbolKind.Class) {
                        if (
                            (<FuncNode>scope).static &&
                            (scope.kind === SymbolKind.Method ||
                                scope.kind === SymbolKind.Property)
                        ) {
                            ref = false;
                        }
                        scope = (<FuncNode>scope).parent;
                    }
                    if (scope) {
                        if (name === 'THIS') {
                            return { node: scope, uri, ref, scope };
                        } else if ((<ClassNode>scope).extends) {
                            let cls = scope as ClassNode;
                            if (
                                (cls = find_class(
                                    this,
                                    cls.extends,
                                    cls.extendsuri,
                                )!)
                            ) {
                                return { node: cls, uri: cls.uri!, ref, scope };
                            }
                        }
                        return undefined;
                    }
                }
                if (
                    !scope &&
                    (node = from_d(this.d_uri) ?? this.declaration[name])
                ) {
                    return { node, uri };
                }
                if (!scope && (scope = bak)) {
                    if (
                        (node = scope.children?.find(
                            (it) => it.name.toUpperCase() === name,
                        ))
                    ) {
                        return { node, uri, scope };
                    }
                }
            } else if ((node = from_d(this.d_uri) ?? this.declaration[name])) {
                return { node, uri };
            }
        } else if (kind === SymbolKind.Field) {
            const scope = position
                    ? this.searchScopedNode(position)
                    : undefined,
                lbs = (<any>(scope || this)).labels;
            if (lbs) {
                if (name.slice(-1) === ':') {
                    name = name.slice(0, -1);
                }
                const a = lbs[name];
                if (a && a[0].def) {
                    return { node: a[0], uri, scope };
                }
            }
            if (scope) {
                return null;
            }
        }
        return undefined;
        function from_d(d_uri: string) {
            const n = lexers[d_uri]?.declaration[name];
            if (n) {
                return (uri = d_uri), n;
            }
        }
    }

    public buildContext(position: Position, ignoreright = false) {
        let kind: SymbolKind;
        let symbol: DocumentSymbol | undefined;
        let token: Token | undefined;
        let start: number;
        let is_end_expr = false;
        const document = this.document;
        const tokens = this.tokens;
        const line = position.line;
        let character = position.character;
        const linetext = document
            .getText(Range.create(line, 0, line + 1, 0))
            .trimRight();
        for (
            start = character;
            --start >= 0 && isIdentifierChar(linetext.charCodeAt(start));

        ) {}
        if (!ignoreright) {
            for (
                ;
                isIdentifierChar(linetext.charCodeAt(character));
                character++
            ) {}
        }
        const range = Range.create(line, ++start, line, character);
        const word = linetext.slice(start, character);
        let text = word;
        const off = document.offsetAt(range.start);
        const pt = (token = tokens[off])
            ? token.previous_token
            : tokens[off - 1];
        if (
            (pt?.content === '.' && pt.type !== 'TK_OPERATOR') ||
            (is_end_expr =
                pt?.type === 'TK_END_EXPR' &&
                token?.type === 'TK_START_EXPR' &&
                token.prefix_is_whitespace === undefined)
        ) {
            let s = '';
            let pre = '';
            const end = pt.offset;
            let tk = pt;
            let lk = pt.previous_token;
            const ps: any = { ')': 0, ']': 0, '}': 0 };
            let psn = 0;
            if (is_end_expr) {
                lk = tokens[pt.previous_pair_pos!];
                ++ps[pt.content];
                ++psn;
                kind = SymbolKind.Null;
            }
            while (lk) {
                switch (lk.type) {
                    case 'TK_DOT':
                        tk = lk;
                        lk = lk.previous_token;
                        break;
                    case 'TK_WORD':
                    case 'TK_NUMBER':
                        if (((tk = lk), (lk = lk.previous_token))) {
                            if (
                                lk.type !== 'TK_DOT' &&
                                !(
                                    lk.previous_pair_pos !== undefined &&
                                    lk.content === '%'
                                )
                            ) {
                                lk = undefined;
                            }
                        }
                        break;
                    case 'TK_START_BLOCK':
                        tk = lk;
                        lk =
                            --ps['}'] < 0 || !--psn
                                ? undefined
                                : lk.previous_token;
                        break;
                    case 'TK_START_EXPR':
                        if (
                            ((tk = lk),
                            --ps[lk.content === '[' ? ']' : ')'] < 0 ||
                                (!--psn && tk.type === 'TK_START_BLOCK'))
                        ) {
                            lk = undefined;
                        } else if ((lk = lk.previous_token)) {
                            if (
                                lk.type !== 'TK_WORD' ||
                                lk.offset + lk.length !== tk.offset
                            ) {
                                lk = undefined;
                            }
                        }
                        break;
                    case 'TK_END_EXPR':
                    case 'TK_END_BLOCK':
                        tk = lk;
                        ps[lk.content]++;
                        psn++;
                        if (
                            (lk = tokens[lk.previous_pair_pos!]) &&
                            (lk.content !== '}' || lk.data)
                        ) {
                            lk.next_pair_pos = tk.offset;
                        } else {
                            tk = EMPTY_TOKEN;
                            lk = undefined;
                        }
                        break;
                    case 'TK_OPERATOR':
                        if (((tk = lk), lk.content === '%')) {
                            if ((lk = tokens[lk.previous_pair_pos!])) {
                                tk = lk;
                                lk = lk.previous_token;
                                if (
                                    !(
                                        lk &&
                                        lk.offset + lk.length === tk.offset &&
                                        (lk.type === 'TK_WORD' ||
                                            lk.type === 'TK_DOT' ||
                                            lk.content === '%')
                                    )
                                ) {
                                    tk = EMPTY_TOKEN;
                                }
                            } else {
                                tk = EMPTY_TOKEN;
                            }
                            break;
                        }
                    default:
                        lk = undefined;
                        break;
                }
            }
            token = tk;
            if (ps[')'] > 0 || ps[']'] > 0 || ps['}'] > 0) {
                tk = EMPTY_TOKEN;
            } else if (tk.symbol?.kind === SymbolKind.Property) {
                const fc = tk.symbol as FuncNode;
                pre = fc.full.replace(
                    /^\((\S+)\).*$/i,
                    (...m) =>
                        `${
                            fc.static ? m[1] : m[1].replace(/([^.]+)$/, '@$1')
                        }.`,
                );
            }
            if (
                /TK_WORD|TK_NUMBER|TK_START_/.test(tk.type) ||
                (tk.content === '%' && tk.next_pair_pos)
            ) {
                const ttk = (token = tk);
                let t;
                loop: while (tk.offset < end) {
                    switch (tk.type) {
                        case 'TK_DOT':
                            s += '.';
                            tk = tokens[tk.next_token_offset];
                            break;
                        case 'TK_STRING':
                            s += '#string';
                            tk = tokens[tk.next_token_offset];
                            break;
                        case 'TK_NUMBER':
                            s += '#number';
                            tk = tokens[tk.next_token_offset];
                            break;
                        case 'TK_START_BLOCK':
                            t = (tk.data as ClassNode)?.name ?? '#object';
                            s += ' ' + t;
                            tk = tokens[tk.next_pair_pos!];
                            tk = tokens[tk.next_token_offset];
                            break;
                        case 'TK_START_EXPR':
                            if (tk.prefix_is_whitespace !== undefined) {
                                let t: string[] | undefined;
                                s +=
                                    tk.content === '['
                                        ? ' #array'
                                        : ` (${
                                              (t =
                                                  tk.paraminfo?.data ?? tk.data)
                                                  ?.length
                                                  ? t[t.length - 1]
                                                  : ''
                                          })`;
                            } else {
                                s +=
                                    tk.content === '['
                                        ? '.__Item'
                                        : tk.paraminfo?.count
                                        ? `(${tk.offset})`
                                        : '()';
                            }
                            tk = tokens[tk.next_pair_pos!];
                            tk = tokens[tk.next_token_offset!];
                            break;
                        default:
                            if (tk.content === '%') {
                                s = s.replace(
                                    /(\w|[^\x00-\x7f]|[@#$])*$/,
                                    '#any',
                                );
                                if (
                                    !(tk = tokens[tk.next_pair_pos!]) ||
                                    !(tk = tokens[tk.next_token_offset])
                                ) {
                                    break loop;
                                }
                                break;
                            } else if (
                                tk.previous_token?.content === '%' &&
                                tk.prefix_is_whitespace === undefined &&
                                tk.type === 'TK_WORD'
                            ) {
                                tk = tokens[tk.next_token_offset!];
                                break;
                            }
                            s +=
                                (tk.prefix_is_whitespace !== undefined
                                    ? ' '
                                    : '') + tk.content;
                            tk = tokens[tk.next_token_offset];
                            break;
                    }
                }
                range.start = document.positionAt(ttk.offset);
                if (is_end_expr) {
                    text = s.trim();
                } else {
                    text = pre + s.trim() + '.' + text;
                }
            } else {
                text = '#any';
            }
            kind ??=
                linetext[character] === '('
                    ? SymbolKind.Method
                    : SymbolKind.Property;
        } else if (token) {
            if (token.type === 'TK_WORD') {
                const sk = token.semantic;
                let fc: FuncNode;
                if ((symbol = token.symbol)) {
                    kind = symbol.kind;
                    if (kind === SymbolKind.Class) {
                        text = (symbol as ClassNode).full;
                    } else if (
                        kind === SymbolKind.Property ||
                        kind === SymbolKind.Method
                    ) {
                        text = (fc = symbol as FuncNode).full.replace(
                            /^\((\S+)\).*$/i,
                            (...m) =>
                                `${
                                    fc.static
                                        ? m[1]
                                        : m[1].replace(/([^.]+)$/, '@$1')
                                }.${fc.name}`,
                        );
                    }
                } else if (sk) {
                    switch (sk.type) {
                        case SemanticTokenTypes.function:
                            kind = SymbolKind.Function;
                            break;
                        case SemanticTokenTypes.method:
                            kind = SymbolKind.Method;
                            break;
                        case SemanticTokenTypes.class:
                            kind = SymbolKind.Class;
                            break;
                        case SemanticTokenTypes.property:
                            kind = SymbolKind.Property;
                            break;
                        case SemanticTokenTypes.parameter:
                        case SemanticTokenTypes.variable:
                            kind = SymbolKind.Variable;
                            break;
                    }
                } else {
                    kind =
                        token.previous_token?.type === 'TK_DOT'
                            ? SymbolKind.Property
                            : SymbolKind.Variable;
                }
            } else if (token.type === 'TK_LABEL') {
                kind = SymbolKind.Field;
            }
        } else if (pt?.content.startsWith('#')) {
            token = pt;
            text = pt.content;
        } else {
            text = (token = this.find_token(
                range.start.character === linetext.length ? off - 1 : off,
            )).content;
        }
        kind ??= SymbolKind.Null;
        return { text, word, range, kind, linetext, token, symbol };
    }

    public searchScopedNode(
        position: Position,
        root?: DocumentSymbol[],
    ): DocumentSymbol | undefined {
        const { line, character } = position;
        let its: DocumentSymbol[] | undefined;
        for (let item of root ?? this.children) {
            if (
                !(its = item.children) ||
                line > item.range.end.line ||
                line < item.selectionRange.start.line ||
                (line === item.selectionRange.start.line &&
                    character < item.selectionRange.start.character) ||
                (line === item.range.end.line &&
                    character > item.range.end.character)
            ) {
                continue;
            }
            if (
                position.line > item.selectionRange.start.line ||
                position.character > item.selectionRange.end.character
            ) {
                item = this.searchScopedNode(position, its) ?? item;
                if (item.kind === SymbolKind.Class) {
                    const offset = this.document.offsetAt(position);
                    for (const dec of [
                        (item as any).staticdeclaration,
                        (item as any).declaration,
                    ]) {
                        for (const rg of dec.__INIT?.ranges ?? []) {
                            if (offset <= rg[0]) {
                                break;
                            } else if (offset <= rg[1]) {
                                return dec.__INIT;
                            }
                        }
                    }
                }
                return item;
            }
            return undefined;
        }
        return undefined;
    }

    public getScopeChildren(scopenode?: DocumentSymbol): {
        [name: string]: Variable;
    } {
        if (
            !scopenode ||
            scopenode.kind === SymbolKind.Class ||
            scopenode.kind === SymbolKind.Property
        ) {
            return {};
        }
        let fn = scopenode as FuncNode;
        const roots: FuncNode[] = [fn],
            rg = Range.create(0, 0, 0, 0);
        let vars: { [name: string]: Variable } = {};
        while ((fn = fn.parent as FuncNode)) {
            if (fn.kind === SymbolKind.Class) {
                break;
            } else {
                roots.push(fn);
            }
        }
        if (fn?.kind === SymbolKind.Class) {
            vars.THIS = DocumentSymbol.create(
                'this',
                completionitem._this(),
                SymbolKind.TypeParameter,
                rg,
                rg,
            );
            if ((fn as any).extends) {
                vars.SUPER = DocumentSymbol.create(
                    'super',
                    completionitem._super(),
                    SymbolKind.TypeParameter,
                    rg,
                    rg,
                );
            }
        }
        while ((fn = roots.pop() as FuncNode)) {
            if (fn.kind === SymbolKind.Property) {
                continue;
            }
            if (fn.assume === FuncScope.GLOBAL) {
                vars = {};
            } else if (fn.assume === FuncScope.STATIC) {
                Object.entries(vars).forEach(
                    ([k, v]) =>
                        !v.static && v.static !== null && delete vars[k],
                );
            }
            Object.assign(vars, fn.local ?? {});
            Object.entries(fn.declaration ?? {}).forEach(
                ([k, v]) => (vars[k] ??= v),
            );
            Object.entries(fn.unresolved_vars ?? {}).forEach(
                ([k, v]) => (vars[k] ??= v),
            );
            Object.keys(fn.global ?? {}).forEach((k) => delete vars[k]);
        }
        return vars;
    }

    public update_relevance() {
        const uri = this.uri,
            { list, main } = getincludetable(uri),
            dir = (lexers[main.toLowerCase()] ?? this).scriptdir;
        this.relevance = list;
        if (dir !== this.scriptdir) {
            this.initlibdirs(dir);
            this.parseScript();
        }
        for (const u in { ...this.relevance, ...this.include }) {
            const d = lexers[u];
            if (d && !d.relevance?.[uri]) {
                d.relevance = getincludetable(u).list;
                if (d.scriptdir !== dir) {
                    d.initlibdirs(dir);
                    d.parseScript();
                }
            }
        }
    }

    public initlibdirs(dir?: string) {
        if (inBrowser) {
            return;
        }
        let workfolder: string;
        for (workfolder of extsettings.WorkingDirs) {
            if (this.uri.startsWith(workfolder)) {
                dir = URI.parse(workfolder).fsPath.replace(/\\$/, '');
                break;
            }
        }
        if (dir) {
            this.scriptdir = restorePath(dir);
        } else if (
            (workfolder = resolve()).toLowerCase() !==
                this.scriptpath.toLowerCase() &&
            workfolder.toLowerCase() !== argv0.toLowerCase() &&
            this.scriptpath.toLowerCase().startsWith(workfolder) &&
            !/\\lib(\\.+)?$/i.test(this.scriptpath)
        ) {
            if (
                existsSync(this.scriptpath + '\\Lib') &&
                statSync(this.scriptpath + '\\Lib').isDirectory()
            ) {
                this.scriptdir = this.scriptpath;
            } else {
                this.scriptdir = workfolder;
            }
        } else {
            this.scriptdir = this.scriptpath.replace(/\\Lib(\\.+)?$/i, '');
        }
        this.libdirs = [(dir = this.scriptdir + '\\Lib\\')];
        dir = dir.toLowerCase();
        for (const t of libdirs) {
            if (this.libdirs[0] !== t.toLowerCase()) {
                this.libdirs.push(t);
            }
        }
    }

    public colors() {
        const t = this.tokenranges,
            document = this.document,
            text = document.getText(),
            colors: ColorInformation[] = [];
        for (const a of t) {
            if (a.type === 2) {
                let s = a.start;
                const e = a.end;
                const m = colorregexp.exec(text.substring(s, e));
                let v = '';
                if (!m || (!m[1] && e - s + 1 !== m[2].length + 2)) {
                    continue;
                }
                const range = Range.create(
                    document.positionAt(
                        (s += m.index + 1 + (m[1]?.length ?? 0)),
                    ),
                    document.positionAt(s + m[2].length),
                );
                v = m[5]
                    ? colortable[m[5].toLowerCase()]
                    : m[3] === undefined
                    ? m[2]
                    : m[2].substring(2);
                const color: any = { red: 0, green: 0, blue: 0, alpha: 1 },
                    cls: string[] = ['red', 'green', 'blue'];
                if (m[4] !== undefined) {
                    cls.unshift('alpha');
                }
                for (const i of cls) {
                    color[i] = parseInt('0x' + v.substring(0, 2)) / 255;
                    v = v.slice(2);
                }
                colors.push({ range, color });
            }
        }
        return colors;
    }

    public addDiagnostic(
        message: string,
        offset: number,
        length?: number,
        severity: DiagnosticSeverity = DiagnosticSeverity.Error,
        arr?: Diagnostic[],
    ) {
        const beg = this.document.positionAt(offset);
        let end = beg;
        if (length !== undefined) {
            end = this.document.positionAt(offset + length);
        }
        (arr || this.diagnostics).push({
            range: Range.create(beg, end),
            message,
            severity,
        });
    }

    private addFoldingRange(
        start: number,
        end: number,
        kind: string = 'block',
    ) {
        const l1 = this.document.positionAt(start).line,
            l2 =
                this.document.positionAt(end).line - (kind === 'block' ? 1 : 0);
        if (l1 < l2) {
            this.foldingranges.push(
                FoldingRange.create(l1, l2, undefined, undefined, kind),
            );
        }
    }

    private addFoldingRangePos(
        start: Position,
        end: Position,
        kind: string = 'block',
    ) {
        const l1 = start.line,
            l2 = end.line - (kind === 'block' ? 1 : 0);
        if (l1 < l2) {
            this.foldingranges.push(
                FoldingRange.create(l1, l2, undefined, undefined, kind),
            );
        }
    }

    private addSymbolFolding(symbol: DocumentSymbol, first_brace: number) {
        const l1 = extsettings.SymbolFoldingFromOpenBrace
            ? this.document.positionAt(first_brace).line
            : symbol.range.start.line;
        const l2 = symbol.range.end.line - 1;
        const ranges = this.foldingranges;
        if (l1 < l2) {
            if (ranges[ranges.length - 1]?.startLine === l1) {
                ranges.pop();
            }
            ranges.push(
                FoldingRange.create(l1, l2, undefined, undefined, 'block'),
            );
        }
    }

    public update() {
        const uri = this.uri;
        const initial = this.include,
            il = Object.keys(initial).length;
        this.isparsed = false;
        this.parseScript();
        if (libfuncs[uri]) {
            libfuncs[uri].length = 0;
            libfuncs[uri].push(
                ...Object.values(this.declaration).filter(
                    (it) =>
                        it.kind === SymbolKind.Class ||
                        it.kind === SymbolKind.Function,
                ),
            );
        }
        if (
            Object.keys(this.include).length === il &&
            Object.keys(Object.assign(initial, this.include)).length === il
        ) {
            if (!this.relevance) {
                this.update_relevance();
            }
            sendDiagnostics();
            return;
        }
        parseinclude(this, this.scriptdir);
        for (const t in initial) {
            if (!this.include[t] && lexers[t]?.diagnostics.length) {
                lexers[t].parseScript();
            }
        }
        resetrelevance();
        this.update_relevance();
        sendDiagnostics();

        function resetrelevance() {
            for (const u in initial) {
                if (lexers[u]) {
                    lexers[u].relevance = getincludetable(u).list;
                }
            }
        }
    }

    public close(force = false) {
        const uri = this.uri;
        this.actived = false;
        if (!lexers[uri]) {
            connection.sendDiagnostics({
                uri: this.document.uri,
                diagnostics: [],
            });
            return;
        }
        const lexs = Object.values(lexers);
        if (!force) {
            if (this.d > 2 && !uri.includes('?')) {
                return;
            }
            if (this.d && lexers[uri.slice(0, -5) + 'ahk']) {
                return;
            }
            if (!inWorkspaceFolders(uri)) {
                return;
            }
            for (const lex of lexs) {
                if (lex.actived && lex.relevance?.[uri]) {
                    return;
                }
            }
        }
        connection.sendDiagnostics({ uri: this.document.uri, diagnostics: [] });
        delete lexers[uri];
        const dels: string[] = [];
        lexs.forEach((lex) => {
            if (
                !lex.actived &&
                !(lex.d > 2 && !lex.uri.includes('?')) &&
                !inWorkspaceFolders(lex.uri)
            ) {
                let del = true;
                for (const u in lex.relevance) {
                    if (lexers[u]?.actived) {
                        del = false;
                        break;
                    }
                }
                if (del) {
                    dels.push(lex.uri);
                }
            }
        });
        dels.forEach((u) => lexers[u]?.close(force));
    }

    public find_str_cmm(offset: number): Token | undefined {
        const sc = this.tokenranges;
        let l = 0;
        let r = sc.length - 1;
        let i = 0;
        let it;
        while (l <= r) {
            it = sc[(i = (l + r) >> 1)];
            if (offset < it.start) {
                r = i - 1;
            } else if (offset >= it.end) {
                l = i + 1;
            } else {
                break;
            }
        }
        if (l <= r && it) {
            return (
                this.tokens[it.start] ??
                ((it = this.tokens[it.previous!])?.data && {
                    ...it.data,
                    previous_token: it,
                    type: '',
                })
            );
        }
    }
}

export function pathanalyze(
    path: string,
    libdirs: string[],
    workdir: string = '',
) {
    let m: RegExpMatchArray | null;
    let uri = '';
    const raw = path;

    if (path.startsWith('<') && path.endsWith('>')) {
        if (!(path = path.slice(1, -1))) {
            return;
        }
        const search: string[] = [path + '.ahk'];
        if ((m = path.match(/^((\w|[^\x00-\x7f])+)_.*/))) {
            search.push(m[1] + '.ahk');
        }
        for (const dir of libdirs) {
            for (const file of search) {
                if (existsSync((path = dir + file))) {
                    uri = URI.file(path).toString().toLowerCase();
                    return { uri, path, raw };
                }
            }
        }
    } else {
        while ((m = path.match(/%a_(\w+)%/i))) {
            const a_ = m[1].toLowerCase();
            if (pathenv[a_]) {
                path = path.replace(m[0], <string>pathenv[a_]);
            } else {
                return;
            }
        }
        if (path.indexOf(':') < 0) {
            path = resolve(workdir, path);
        } else if (path.includes('..')) {
            path = resolve(path);
        }
        uri = URI.file(path).toString().toLowerCase();
        return { uri, path, raw };
    }
}

export function parseinclude(lex: Lexer, dir: string) {
    const include = lex.include,
        u = lex.uri;
    const need_update: Lexer[] = [];
    for (const uri in include) {
        const path = include[uri],
            ll = lexers[uri];
        if (ll) {
            if (!ll.relevance?.[u]) {
                need_update.push(ll);
            }
        } else if (existsSync(path)) {
            const t = openFile(restorePath(path));
            if (!t) {
                continue;
            }
            const doc = new Lexer(t, dir);
            lexers[uri] = doc;
            doc.parseScript();
            parseinclude(doc, dir);
            doc.relevance = getincludetable(uri).list;
        }
    }
    for (const t of need_update) {
        t.update_relevance();
        if (t.diagnostics.length) {
            t.update();
        }
    }
}

export function getClassMembers(
    doc: Lexer,
    node: DocumentSymbol,
    staticmem: boolean = true,
): { [name: string]: DocumentSymbol } {
    const cls = node as ClassNode;
    let bases: any[] = [];
    const v: { [name: string]: DocumentSymbol } = {};
    let l: string;
    if (cls.staticdeclaration) {
        getmems(doc, cls, staticmem);
    }
    return v;

    function getmems(doc: Lexer, cls: ClassNode, isstatic: boolean) {
        const _cls = cls,
            u = cls.uri!;
        if (bases.includes(cls)) {
            return;
        }
        bases.push(cls);
        const dec = isstatic ? cls.staticdeclaration : cls.declaration;
        for (const it of Object.values(dec)) {
            if (
                !v[(l = it.name.toUpperCase())] ||
                (it.children && !v[l].children)
            ) {
                v[l] = it;
                (<any>it).uri ??= u;
            }
        }
        if (!cls.extends) {
            if (cls === ahkvars['ANY']) {
                if (!isstatic) {
                    return;
                } else if (
                    ((isstatic = false),
                    (bases = []),
                    !(cls = ahkvars['CLASS'] as any))
                ) {
                    return;
                }
            } else if (!(cls = ahkvars['OBJECT'] as any)) {
                return;
            }
        } else if (!isstatic && cls === ahkvars['COMOBJECT']) {
            return;
        } else if (
            !(cls = find_class(
                doc,
                cls.extends.replace(
                    /(^|\.)[@#](?=[^.]+$)/,
                    (_, m1) => ((isstatic = false), m1),
                ),
                cls.extendsuri,
            ) as ClassNode)
        ) {
            return;
        }
        getmems(doc, cls, isstatic);
        _cls.checkmember ??= cls.checkmember;
    }
}

export function get_class_member(
    doc: Lexer,
    cls: ClassNode,
    name: string,
    isstatic: boolean,
    ismethod: boolean,
    bases?: any[],
): DocumentSymbol | undefined {
    let prop: DocumentSymbol | undefined;
    let method = prop;
    let sym = prop;
    let val = prop;
    let t: any;
    let i = 0;
    let key: 'staticdeclaration' | 'declaration' = isstatic
        ? 'staticdeclaration'
        : 'declaration';
    let _bases = (bases ??= []);
    name = name.toUpperCase();
    while (true) {
        if (i === _bases.length) {
            if (_bases.includes(cls)) {
                break;
            }
            _bases.push(cls);
        }
        if ((sym = cls[key][name])?.children) {
            (sym as ClassNode).uri ??= cls.uri;
            if ((sym.kind === SymbolKind.Method) === ismethod) {
                return sym;
            }
            if (
                ismethod &&
                ((t = sym).kind === SymbolKind.Class || (t = (sym as any).call))
            ) {
                return t;
            }
            if (ismethod) {
                prop ??= sym;
            } else {
                method ??= sym;
            }
        } else if (sym) {
            val ??= sym;
            (sym as ClassNode).uri ??= cls.uri;
        }

        if (!cls.extends) {
            if (cls === ahkvars['ANY']) {
                if (!isstatic) {
                    break;
                } else if (
                    ((isstatic = false),
                    (key = 'declaration'),
                    (i = 0),
                    (_bases = []),
                    !(t = ahkvars['CLASS']))
                ) {
                    break;
                }
            } else if (!(++i, (t = ahkvars['OBJECT']))) {
                break;
            }
        } else if (
            (!isstatic && cls === ahkvars['COMOBJECT']) ||
            (t = _bases[++i]) === null
        ) {
            break;
        } else if (
            !(t ??= find_class(
                doc,
                cls.extends.replace(
                    /(^|\.)[@#](?=[^.]+$)/,
                    (_, m1) => ((isstatic = false), (key = 'declaration'), m1),
                ),
                cls.extendsuri,
            ))
        ) {
            _bases.push(null);
            break;
        }
        cls = t;
    }
    if (!ismethod) {
        return prop ?? method ?? val;
    }
    if (!(sym = prop ?? val)) {
        return;
    }
    // let ts: any = {};
    // if (t = get_comment_types(sym, true)) {
    // 	(t as string[]).forEach(tp => (tp.includes('=>') && (searchcache[tp] ??= gen_fat_fn(tp, doc.uri, sym!, (sym as any).parent)), ts[tp] = true));
    // } else if (t = ((sym as any).get ?? sym).returntypes) {
    // 	doc = lexers[(sym as ClassNode).uri!] ?? doc;
    // 	for (let [exp, p] of Object.entries(t)) {
    // 		detectExp(doc, exp.toLowerCase(), Position.is(p) ? p : sym.range.end)
    // 			.forEach(tp => (tp.includes('=>') && (searchcache[tp] ??= gen_fat_fn(tp, doc.uri, sym!, (sym as any).parent)), ts[tp] = true));
    // 	}
    // }
    return;
}

export function get_class_call(cls: ClassNode) {
    const bases: any[] = [],
        doc = lexers[cls.uri!];
    const fn = get_class_member(doc, cls, 'call', true, true, bases);
    if ((fn as FuncNode)?.full?.startsWith('(Object) static Call(')) {
        const t = get_class_member(doc, cls, '__new', false, true, bases);
        if (t) {
            return t;
        }
    }
    return fn;
}

export function find_class(doc: Lexer, name: string, uri?: string) {
    const arr = name.toUpperCase().split('.');
    let n = arr.shift()!;
    let c = (
        uri
            ? lexers[uri]?.declaration[n]
            : searchNode(doc, n, undefined, SymbolKind.Class)?.[0].node
    ) as ClassNode;
    for (n of arr) {
        c = get_ownprop(c, n) as any;
        if (!c?.staticdeclaration || (c as any).def === false) {
            return undefined;
        }
    }
    if (c?.kind === SymbolKind.Class) {
        return c;
    }
    function get_ownprop(
        cls: ClassNode | undefined,
        name: string,
    ): DocumentSymbol | undefined {
        if (cls?.kind === SymbolKind.Class) {
            return (
                cls.staticdeclaration[name] ??
                (cls.extendsuri &&
                    get_ownprop(find_class(doc, c.extends, c.extendsuri), name))
            );
        }
    }
}

export function reset_detect_cache() {
    hasdetectcache = {};
}

export function detectExpType(
    doc: Lexer,
    exp: string,
    pos: Position,
    types: { [type: string]: DocumentSymbol | boolean },
) {
    exp = exp.toLowerCase();
    if (exp.match(/^\s*[@#$](\w|[^\x00-\x7f])+$/)) {
        return (types[exp.trim()] = false);
    }
    searchcache = {};
    detectExp(doc, exp, pos).forEach(
        (tp) => (types[tp] = searchcache[tp] ?? false),
    );
}

export function detectVariableType(
    doc: Lexer,
    n: { node: DocumentSymbol; scope?: DocumentSymbol },
    pos?: Position,
) {
    let name = n.node.name.toLowerCase();
    const syms: DocumentSymbol[] = [],
        types: any = {};
    if (name.match(/^[$@#]([\w.]|[^\x00-\x7f])+$/)) {
        return [name];
    } else if (name.startsWith('a_')) {
        if (name === 'a_args') {
            return ['#array'];
        } else if (
            builtin_variable.includes(name) ||
            (isahk2_h && builtin_variable_h.includes(name))
        ) {
            return ['#string'];
        }
    }
    name = name.toUpperCase();
    if (n.scope) {
        let scope = n.scope;
        if (n.node.kind === SymbolKind.TypeParameter) {
            let s = scope;
            if (
                (scope = (scope as any).parent)?.kind === SymbolKind.Property &&
                (scope as any).parent?.kind === SymbolKind.Class
            ) {
                s = scope;
            }
            const ts = cvt_types(
                s.detail?.match(
                    new RegExp(`^@(param|arg)\\s+{(.*?)}\\s+${name}\\b`, 'mi'),
                )?.[2] ?? '',
            );
            if (
                ts &&
                (ts.forEach((t) => (types[t] = true)), !types['@object'])
            ) {
                return ts;
            }
        } else {
            syms.push(n.node);
        }
    } else {
        syms.push(n.node);
        for (const uri in doc.relevance) {
            const v = lexers[uri]?.declaration?.[name];
            if (v) {
                syms.push(v);
            }
        }
    }
    for (const sym of syms) {
        const ts = get_comment_types(sym);
        if (ts) {
            if ((ts.forEach((t) => (types[t] = true)), !types['@object'])) {
                return ts;
            } else {
                break;
            }
        }
    }
    let scope = pos ? doc.searchScopedNode(pos) : undefined;
    let ite = syms[0] as Variable;
    while (scope) {
        if (scope.kind === SymbolKind.Class) {
            scope = (<ClassNode>scope).parent;
        } else if (!(<FuncNode>scope).declaration?.[name]) {
            scope = (<FuncNode>scope).parent;
        } else {
            break;
        }
    }
    if (!scope && pos && pos !== n.node.selectionRange.end) {
        scope = doc as any;
    }
    for (const it of scope?.children ?? []) {
        if (name === it.name.toUpperCase()) {
            if (
                it.kind === SymbolKind.Variable ||
                it.kind === SymbolKind.TypeParameter
            ) {
                if (
                    pos &&
                    (it.selectionRange.end.line > pos.line ||
                        (it.selectionRange.end.line === pos.line &&
                            it.selectionRange.start.character > pos.character))
                ) {
                    break;
                }
                if ((<Variable>it).ref || (<Variable>it).returntypes) {
                    ite = it;
                }
            } else {
                return [name];
            }
        }
    }
    if (ite) {
        if (ite.ref) {
            const res = getFuncCallInfo(doc, ite.selectionRange.start);
            if (res) {
                const n = searchNode(
                    doc,
                    res.name,
                    ite.selectionRange.end,
                    SymbolKind.Variable,
                );
                if (n) {
                    const nn = n[0].node;
                    if (nn === ahkvars['REGEXMATCH']) {
                        if ((res.index = 2)) {
                            return ['#regexmatchinfo'];
                        }
                    } else if (ahkvars[res.name.toUpperCase()] === nn) {
                        return ['#number'];
                    }
                }
            }
            return [];
        } else {
            for (const s in ite.returntypes) {
                detectExp(doc, s, ite.range.end).forEach(
                    (tp) => (types[tp] = true),
                );
            }
        }
    }
    if (types['#any']) {
        return [];
    }
    return Object.keys(types);
}

function get_comment_types(it: DocumentSymbol, prop = false) {
    if (it.detail) {
        return cvt_types(
            (it.detail.match(
                new RegExp(
                    `^\\s*@${prop ? 'prop(erty)?' : '(var)'}\\s+{(.*?)}\\s+${
                        it.name
                    }\\b`,
                    'mi',
                ),
            ) ?? it.detail.match(/^\s*@(type)\s+{(.*?)}(?=\s|$)/im))?.[2] ?? '',
        );
    }
}

export function detectExp(doc: Lexer, exp: string, pos: Position): string[] {
    exp = exp.toLowerCase();
    if (exp.includes('=>')) {
        return [exp.trim()];
    }
    const tz = `${exp.trim()},${doc.uri},${pos.line},${pos.character}`;
    if (hasdetectcache[tz] !== undefined) {
        return hasdetectcache[tz] || [];
    }
    hasdetectcache[tz] = false;
    return (hasdetectcache[tz] = detect(doc, exp, pos, 0));
    function detect(
        doc: Lexer,
        exp: string,
        pos: Position,
        deep: number = 0,
    ): string[] {
        let t: string | RegExpMatchArray | null;
        const tps: string[] = [];
        exp = exp
            .replace(/#any(\(\d*\)|\[\]|\.(\w|[^\x00-\x7f])+)+/g, '#any')
            .replace(
                /(?<!([\w.$]|[^\x00-\x7f]))(true|false)(?!(\w|[^\x00-\x7f]))/gi,
                '#number',
            )
            .replace(
                /(?<!([\w.$]|[^\x00-\x7f]))(__proto__|constructor)(?!(\w|[^\x00-\x7f]))/g,
                '$$$2',
            )
            .replace(/\[\d*\]/g, '');
        while (
            (t = exp.replace(/\(((\(\d*\)|[^\(\)](?<!\(\d))+)\)/g, (...m) => {
                const ts = detect(doc, m[1], pos, deep + 1);
                return ts.length > 1 ? `[${ts.join(',')}]` : ts.pop() || '#any';
            })) !== exp
        ) {
            exp = t;
        }
        while (
            (t = exp.replace(
                /\s(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])\s*([+\-*/&|^]|\/\/|<<|>>|\*\*)\s*(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])\s*/g,
                ' #number ',
            )) !== exp
        ) {
            exp = t;
        }
        while (
            (t = exp.replace(
                /\s[+-]?(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])\s+\.\s+[+-]?(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])\s*/g,
                ' #string ',
            )) !== exp
        ) {
            exp = t;
        }
        while (
            (t = exp.replace(
                /\s(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])\s*(~=|<|>|[<>]=|!?=?=|\b(is|in|contains)\b)\s*(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])\s*/gi,
                ' #number ',
            )) !== exp
        ) {
            exp = t;
        }
        while (
            (t = exp.replace(
                /(not|!|~|\+|-)\s*(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])/g,
                ' #number ',
            )) !== exp
        ) {
            exp = t;
        }
        while (
            (t = exp.replace(
                /(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])\s*(\sand\s|\sor\s|&&|\|\||\?\?)\s*(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])/gi,
                (...m) => {
                    let ts: any = {};
                    let mt: RegExpMatchArray | null;
                    for (let i = 1; i < 5; i += 3) {
                        if ((mt = m[i].match(/^\[([^\[\]]+)\]$/))) {
                            mt[1].split(',').forEach((tp) => (ts[tp] = true));
                        } else {
                            ts[m[i]] = true;
                        }
                    }
                    if (ts['#any']) {
                        return '#any';
                    }
                    ts = Object.keys(ts);
                    return ts.length > 1
                        ? `[${ts.join(',')}]`
                        : ts.pop() || '#void';
                },
            )) !== exp
        ) {
            exp = t;
        }
        while (
            (t = exp.replace(
                /(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])\s*\?\s*(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])\s*:\s*(([$@#\w.]|[^\x00-\x7f]|\(\d*\))+|\[[^\[\]]+\])/,
                (...m) => {
                    let ts: any = {};
                    let mt: RegExpMatchArray | null;
                    for (let i = 3; i < 6; i += 2) {
                        if ((mt = m[i].match(/^\[([^\[\]]+)\]$/))) {
                            mt[1].split(',').forEach((tp) => (ts[tp] = true));
                        } else {
                            ts[m[i]] = true;
                        }
                    }
                    if (ts['#any']) {
                        return '#any';
                    }
                    ts = Object.keys(ts);
                    return ts.length > 1
                        ? `[${ts.join(',')}]`
                        : ts.pop() || '#void';
                },
            )) !== exp
        ) {
            exp = t;
        }
        if (deep === 0) {
            exp = exp.trimLeft();
            while (
                exp !==
                (t = exp.replace(
                    /((\w|[$@#.]|[^\x00-\x7f])+)\((\d*)\)/,
                    (...m) => {
                        const ns = searchNode(
                            doc,
                            m[1],
                            exp.trim() === m[0]
                                ? {
                                      line: pos.line,
                                      character: pos.character - exp.length,
                                  }
                                : pos,
                            m[1].includes('.')
                                ? SymbolKind.Method
                                : SymbolKind.Variable,
                        );
                        let s = '';
                        let ts: any = {};
                        const tk = doc.tokens[m[3]];
                        let c: RegExpMatchArray | null | undefined;
                        if (!ns) {
                            return '#void';
                        }
                        for (const it of ns) {
                            let n = it.node as FuncNode;
                            const uri = it.uri;
                            switch (n.kind) {
                                case SymbolKind.Property:
                                    if (
                                        (n as any).call?.kind ===
                                        SymbolKind.Method
                                    ) {
                                        n = (n as any).call;
                                    } else {
                                        const tps: any = {};
                                        if (
                                            get_comment_types(n, true)?.forEach(
                                                (tp) => (tps[tp] = true),
                                            )
                                        ) {
                                        } else if (lexers[uri]) {
                                            for (s in n.returntypes) {
                                                detectExpType(
                                                    lexers[uri],
                                                    s,
                                                    n.range.end,
                                                    tps,
                                                );
                                            }
                                        }
                                        if (tps['#any']) {
                                            return '#any';
                                        }
                                        for (const tp in tps) {
                                            if (tp.includes('=>')) {
                                                searchcache[tp] ??= gen_fat_fn(
                                                    tp,
                                                    uri,
                                                    n,
                                                    it.scope,
                                                );
                                            }
                                            if ((n = searchcache[tp]?.node)) {
                                                if (
                                                    n.kind ===
                                                        SymbolKind.Class ||
                                                    n.kind ===
                                                        SymbolKind.Function ||
                                                    n.kind === SymbolKind.Method
                                                ) {
                                                    for (const e in n.returntypes) {
                                                        detectExp(
                                                            lexers[uri],
                                                            e,
                                                            Position.is(
                                                                n.returntypes[
                                                                    e
                                                                ],
                                                            )
                                                                ? n.returntypes[
                                                                      e
                                                                  ]
                                                                : pos,
                                                        ).forEach(
                                                            (tp) =>
                                                                (ts[tp] = true),
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                        break;
                                    }
                                case SymbolKind.Method:
                                    c = n.full
                                        .toLowerCase()
                                        .match(/\(([^()]+)\)\s*([^()]+)/);
                                    if (c && c[1] === 'gui') {
                                        if (c[2] === 'add') {
                                            const ctls: {
                                                [key: string]: string;
                                            } = {
                                                dropdownlist: 'ddl',
                                                tab2: 'tab',
                                                tab3: 'tab',
                                                picture: 'pic',
                                            };
                                            if (
                                                tk?.data[0] === ' #string' &&
                                                (s = doc.tokens[
                                                    tk.next_token_offset
                                                ]?.content
                                                    .slice(1, -1)
                                                    .toLowerCase())
                                            ) {
                                                ts['gui.@' + (ctls[s] || s)] =
                                                    true;
                                            } else {
                                                ts['gui.@control'] = true;
                                            }
                                        } else {
                                            for (const t in n.returntypes) {
                                                ts[t] = true;
                                            }
                                        }
                                        break;
                                    }
                                case SymbolKind.Function:
                                    if (
                                        n === ahkvars['OBJBINDMETHOD'] &&
                                        tk?.data[1] === ' #string' &&
                                        allIdentifierChar.test(
                                            (s = tk?.data[0].trim() ?? ''),
                                        )
                                    ) {
                                        let t =
                                            doc.tokens[tk.paraminfo?.comma[0]!];
                                        if (
                                            t &&
                                            (t =
                                                doc.tokens[t.next_token_offset])
                                        ) {
                                            ts[
                                                s + '.' + t.content.slice(1, -1)
                                            ] = true;
                                        }
                                    } else if (lexers[uri]) {
                                        const m = cvt_types(
                                                n.detail?.match(
                                                    /^@returns?\s+{(.+?)}/im,
                                                )?.[1] ?? '',
                                            ),
                                            o: any = {};
                                        if (m) {
                                            m.forEach((s) => (o[s] = true));
                                            n.returntypes = o;
                                        }
                                        const pos = {
                                            line: n.range.end.line,
                                            character:
                                                n.range.end.character - 1,
                                        };
                                        for (const e in n.returntypes) {
                                            detectExp(
                                                lexers[uri],
                                                e,
                                                Position.is(n.returntypes[e])
                                                    ? n.returntypes[e]
                                                    : pos,
                                            ).forEach((tp) => {
                                                ts[tp] = true;
                                            });
                                        }
                                    }
                                    break;
                                case SymbolKind.Variable:
                                    if (lexers[uri]) {
                                        detectVariableType(
                                            lexers[uri],
                                            it,
                                            uri === doc.uri
                                                ? pos
                                                : it.node.selectionRange.end,
                                        ).forEach((tp) => {
                                            if (tp.includes('=>')) {
                                                searchcache[tp] ??= gen_fat_fn(
                                                    tp,
                                                    uri,
                                                    it.node,
                                                    it.scope,
                                                );
                                            }
                                            if ((n = searchcache[tp]?.node)) {
                                                if (
                                                    n.kind ===
                                                        SymbolKind.Class ||
                                                    n.kind ===
                                                        SymbolKind.Function ||
                                                    n.kind === SymbolKind.Method
                                                ) {
                                                    for (const e in n.returntypes) {
                                                        detectExp(
                                                            lexers[uri],
                                                            e,
                                                            Position.is(
                                                                n.returntypes[
                                                                    e
                                                                ],
                                                            )
                                                                ? n.returntypes[
                                                                      e
                                                                  ]
                                                                : pos,
                                                        ).forEach(
                                                            (tp) =>
                                                                (ts[tp] = true),
                                                        );
                                                    }
                                                }
                                            }
                                        });
                                    }
                                    break;
                                case SymbolKind.Class:
                                    if (lexers[uri]) {
                                        const call = get_class_call(
                                            n as any,
                                        ) as FuncNode;
                                        if (
                                            !(
                                                call.name.toLowerCase() ===
                                                    '__new' ||
                                                call.full?.startsWith(
                                                    '(Object) static Call(',
                                                )
                                            )
                                        ) {
                                            const m = cvt_types(
                                                    call.detail?.match(
                                                        /^@returns?\s+{(.+?)}/im,
                                                    )?.[1] ?? '',
                                                ),
                                                o: any = {};
                                            if (m) {
                                                m.forEach((s) => (o[s] = true));
                                                call.returntypes = o;
                                            }
                                            for (const e in call.returntypes) {
                                                detectExp(
                                                    lexers[uri],
                                                    e,
                                                    Position.is(
                                                        call.returntypes[e],
                                                    )
                                                        ? call.returntypes[e]
                                                        : pos,
                                                ).forEach(
                                                    (tp) => (ts[tp] = true),
                                                );
                                            }
                                            if (
                                                ts['@comobject'] &&
                                                tk?.data[0] === ' #string' &&
                                                (s = doc.tokens[
                                                    tk.next_token_offset
                                                ]?.content.slice(1, -1))
                                            ) {
                                                delete ts['@comobject'];
                                                delete ts['@comvalue'];
                                                ts[`@comobject<${s}>`] = true;
                                            }
                                            if (
                                                call.returntypes &&
                                                o['@this'] === undefined
                                            ) {
                                                break;
                                            }
                                        }
                                    }
                                    if (
                                        (s =
                                            Object.keys(
                                                n.returntypes || {
                                                    '#object': 0,
                                                },
                                            ).pop() || '')
                                    ) {
                                        ts[s] = true;
                                    }
                                    break;
                            }
                        }
                        ts = Object.keys(ts);
                        return ts.length > 1
                            ? `[${ts.join(',')}]`
                            : ts.pop() || '#void';
                    },
                ))
            ) {
                exp = t;
            }
        }
        const tpexp = exp.trim();
        let exps: string[] = [];
        let ts: any = {};
        if ((t = tpexp.match(/^\[([^\[\]]+)\]$/))) {
            const ts: any = {};
            t[1].split(',').forEach((tp) => (ts[tp] = true));
            tps.forEach((tp) => (ts[tp] = true));
            exps = Object.keys(ts);
        } else {
            exps = [tpexp];
        }
        if (deep) {
            return exps;
        }
        for (const ex of exps) {
            if (
                (t = ex.match(
                    /^([@#]?)(\$|\w|[^\x00-\x7f])+(\.[@#]?(\$|\w|[^\x00-\x7f])+)*$/,
                ))
            ) {
                let ll = '';
                let ttt: any, sym: any;
                if (searchcache[ex] || (t[1] && !t[3])) {
                    ts[ex] = true;
                } else {
                    for (const n of searchNode(
                        doc,
                        ex,
                        ex === tpexp
                            ? {
                                  line: pos.line,
                                  character: pos.character - ex.length,
                              }
                            : pos,
                        SymbolKind.Variable,
                    ) || []) {
                        switch ((sym = n.node).kind) {
                            case SymbolKind.TypeParameter:
                            case SymbolKind.Variable:
                                detectVariableType(
                                    lexers[n.uri],
                                    n,
                                    n.uri === doc.uri
                                        ? pos
                                        : n.node.selectionRange.end,
                                ).forEach(
                                    (tp) => (
                                        tp.includes('=>') &&
                                            (searchcache[tp] ??= gen_fat_fn(
                                                tp,
                                                n.uri,
                                                n.node,
                                                n.scope,
                                            )),
                                        (ts[tp] = true)
                                    ),
                                );
                                break;
                            case SymbolKind.Property:
                                if ((ttt = get_comment_types(sym, true))) {
                                    (ttt as string[]).forEach(
                                        (tp) => (
                                            tp.includes('=>') &&
                                                (searchcache[tp] ??= gen_fat_fn(
                                                    tp,
                                                    n.uri,
                                                    sym,
                                                    n.scope,
                                                )),
                                            (ts[tp] = true)
                                        ),
                                    );
                                } else if (
                                    (ttt = sym.call) &&
                                    doc.tokens[doc.document.offsetAt(pos)]
                                        ?.content === '('
                                ) {
                                    sym = ttt;
                                    ttt = true;
                                } else if (
                                    (ttt = (sym.get ?? sym).returntypes)
                                ) {
                                    for (const [exp, p] of Object.entries(
                                        ttt,
                                    )) {
                                        detectExp(
                                            lexers[n.uri] ?? doc,
                                            exp,
                                            Position.is(p) ? p : sym.range.end,
                                        ).forEach(
                                            (tp) => (
                                                tp.includes('=>') &&
                                                    (searchcache[tp] ??=
                                                        gen_fat_fn(
                                                            tp,
                                                            n.uri,
                                                            sym,
                                                            n.scope,
                                                        )),
                                                (ts[tp] = true)
                                            ),
                                        );
                                    }
                                }
                                if (ttt !== true) {
                                    break;
                                }
                            case SymbolKind.Method:
                                ttt = sym.full.match(/^\(([^()]+)\)/)?.[1];
                                ll = (
                                    (ttt
                                        ? (sym.static
                                              ? ttt
                                              : ttt.replace(
                                                    /([^.]+)$/,
                                                    '@$1',
                                                )) + '.'
                                        : '') + sym.name
                                ).toLowerCase();
                                ts[ll] = true;
                                searchcache[ll] = n;
                                break;
                            case SymbolKind.Function:
                                ts[
                                    (ll = ex.startsWith('$')
                                        ? ex
                                        : _name(n.node.name.toLowerCase()))
                                ] = true;
                                searchcache[ll] = n;
                                break;
                            case SymbolKind.Class:
                                ll = n.ref
                                    ? ((n.node as any).full || n.node.name)
                                          .replace(/([^.]+)$/, '@$1')
                                          .toLowerCase()
                                    : _name(ex);
                                ts[ll] = true;
                                searchcache[ll] = n;
                                break;
                        }
                    }
                }
            } else if (ex.startsWith('@comobject<')) {
                ts[ex] = true;
            }
        }
        ts = Object.keys(ts);
        return ts.length ? ts : ['#any'];
        function _name(name: string) {
            return name === '__proto__' || name === 'constructor'
                ? '$' + name
                : name;
        }
    }
}

function gen_fat_fn(
    def: string,
    uri: string,
    node: DocumentSymbol,
    scope?: DocumentSymbol,
) {
    if (def.startsWith('((')) {
        def = def.slice(1, -1);
    }
    const m = def.match(/^\(([^)]*)\)=>(.*)$/);
    if (m) {
        const d = new Lexer(
            TextDocument.create(
                '',
                'ahk2',
                0,
                `${node.name}(${m[1]})=>${m[2].includes('=>') ? 'void' : m[2]}`,
            ),
            undefined,
            -1,
        );
        d.parseScript();
        const n = d.declaration[node.name.toUpperCase()];
        if (n?.kind === SymbolKind.Function) {
            if (m[2].includes('=>')) {
                n.returntypes = { [m[2]]: true };
            }
            if (node.kind === SymbolKind.TypeParameter && scope) {
                const p = (scope as any).parent;
                if (
                    p?.parent?.kind === SymbolKind.Property &&
                    p.parent.parent?.kind === SymbolKind.Class
                ) {
                    scope = p.parent as DocumentSymbol;
                }
                formatMarkdowndetail(scope);
            } else {
                formatMarkdowndetail(node);
            }
            const detail = node.detail?.split('\n___\n').pop();
            if (detail) {
                n.detail = detail.trim();
            }
            return { node: n, uri };
        }
    }
}

export function searchNode(
    doc: Lexer,
    name: string,
    pos: Position | undefined,
    kind: SymbolKind,
    isstatic = true,
):
    | [
          {
              node: DocumentSymbol;
              uri: string;
              scope?: DocumentSymbol;
              ref?: boolean;
          },
      ]
    | undefined
    | null {
    let node: DocumentSymbol | undefined;
    let res:
            | {
                  node: DocumentSymbol;
                  uri: string;
                  scope?: DocumentSymbol;
                  fn_is_static?: boolean;
              }
            | undefined
            | false
            | null,
        t: any,
        uri = doc.uri;
    if (
        kind === SymbolKind.Method ||
        kind === SymbolKind.Property ||
        name.includes('.')
    ) {
        const p = name.toLowerCase().split('.');
        const nodes = searchNode(doc, p[0], pos, SymbolKind.Class);
        let i = 0;
        let ps = 0;
        if (!nodes || p.length < 2) {
            return undefined;
        }
        let n = nodes[0].node;
        const u = nodes[0].uri;
        uri = u || uri;
        if (nodes[0].ref && p[0].match(/^[^@#]/)) {
            p[0] = '@' + p[0];
        }
        if (n.kind === SymbolKind.Variable) {
            const tps = detectVariableType(
                    lexers[uri],
                    nodes[0],
                    doc.uri === u ? pos : n.selectionRange.end,
                ),
                rs: any = [],
                m = new Set<any>();
            for (const tp of tps) {
                searchNode(
                    lexers[uri],
                    name.replace(new RegExp('^' + p[0], 'i'), tp.toUpperCase()),
                    tp.match(/^[@#]/) ? undefined : pos,
                    kind,
                )?.forEach(
                    (it) => !m.has(it.node) && (m.add(it.node), rs.push(it)),
                );
            }
            if (rs.length) {
                return rs;
            } else {
                return undefined;
            }
        } else if ((ps = p.length - 1)) {
            let cc: ClassNode | undefined, fc: FuncNode | undefined;
            while (i < ps) {
                node = undefined;
                i++;
                if (
                    n.kind === SymbolKind.Function ||
                    n.kind === SymbolKind.Method
                ) {
                    fc = n as FuncNode;
                    if (i <= p.length && p[i] === 'call') {
                        if (
                            !(node = (ahkvars['FUNC'] as ClassNode)
                                ?.declaration['CALL'])
                        ) {
                            (node = Object.assign({}, n)).kind =
                                SymbolKind.Method;
                        } else {
                            uri = (ahkvars['FUNC'] as any).uri;
                        }
                        continue;
                    } else if (ahkvars['FUNC']) {
                        n = ahkvars['FUNC'];
                        p[i - 1] = '@' + p[i - 1].replace(/^[@#]/, '');
                    }
                } else if (n.kind === SymbolKind.Property) {
                    const tps: any = {},
                        rs: any = [],
                        m = new Set<any>();
                    if (
                        (t = get_comment_types((n = (n as any).get ?? n), true))
                    ) {
                        (t as string[]).forEach(
                            (tp) =>
                                (tps[tp.includes('=>') ? '@func' : tp] = true),
                        );
                    } else if ((t = (<Variable>n).returntypes)) {
                        for (const r in t) {
                            detectExpType(
                                lexers[uri],
                                r,
                                Position.is(t[r]) ? t[r] : n.selectionRange.end,
                                tps,
                            );
                        }
                    }
                    const nm = p.slice(i).join('.');
                    for (const tp in tps) {
                        searchNode(
                            lexers[uri],
                            tp + '.' + nm,
                            undefined,
                            kind,
                        )?.forEach(
                            (it) =>
                                !m.has(it.node) &&
                                (m.add(it.node), rs.push(it)),
                        );
                    }
                    if (rs.length) {
                        return rs;
                    }
                    return undefined;
                }
                if (n.kind === SymbolKind.Class) {
                    cc = n as ClassNode;
                    const ss = isstatic && i > 0 && !p[i - 1].match(/^[@#]/);
                    let _ = p[i].replace(/^[@#]/, '');
                    const bases: any[] = [];
                    node = get_class_member(
                        doc,
                        n as any,
                        _,
                        ss,
                        i === ps && kind === SymbolKind.Method,
                        bases,
                    );
                    if (node) {
                        const full = (node as Variable).full ?? '';
                        uri = (node as any).uri;
                        if (full === '(Class) Prototype') {
                            const cls = Object.assign({}, node) as ClassNode,
                                p = { line: 0, character: 0 },
                                range = { start: p, end: p };
                            cls.kind = SymbolKind.Class;
                            cls.declaration = {};
                            cls.staticdeclaration = {
                                __CLASS: Variable.create(
                                    '__Class',
                                    SymbolKind.Property,
                                    range,
                                ),
                            };
                            if (n !== (node as any).parent) {
                                cls.extends = (n as ClassNode).full.replace(
                                    /(^|\.)([^.]+)$/,
                                    '$1@$2',
                                );
                            } else {
                                cls.extends = '@object';
                            }
                            node = cls;
                            uri = cc.uri!;
                        } else if (node.name === 'Clone') {
                            if (n !== (node as any).parent) {
                                const t = full
                                    .toUpperCase()
                                    .match(/^\(([^()]+)\)\s+/);
                                if (t && ahkvars[t[1]]) {
                                    node = Object.assign({}, node);
                                    _ = (n as ClassNode).full.toUpperCase();
                                    (<FuncNode>node).returntypes = {
                                        [ss ? _ : _.replace(/([^.]+)$/, '@$1')]:
                                            true,
                                    };
                                    uri = cc.uri!;
                                }
                            }
                        } else if (fc && full.startsWith('(Func) Bind(')) {
                            const c = Object.assign({}, node) as FuncNode,
                                cl = fc.full.match(/^\s*\(([^()]+)\)/);
                            c.returntypes = {
                                [(
                                    (cl ? cl[1] + '.' : '') + fc.name
                                ).toUpperCase()]: true,
                            };
                            node = c;
                            uri = cc.uri!;
                        }
                    } else if (i === ps) {
                        if (kind === SymbolKind.Property) {
                            node = get_class_member(
                                doc,
                                n as any,
                                '__get',
                                ss,
                                true,
                                bases,
                            );
                        } else {
                            node = get_class_member(
                                doc,
                                n as any,
                                '__call',
                                ss,
                                true,
                                bases,
                            );
                        }
                    }
                    fc = undefined;
                }
                if (!node) {
                    break;
                } else {
                    n = node;
                }
            }
        }
        if (node) {
            if (
                kind === SymbolKind.Method &&
                node.kind === SymbolKind.Property
            ) {
                node = ((node as any).call ?? node) as DocumentSymbol;
            }
            return [{ node, uri }];
        } else {
            return undefined;
        }
    } else if (
        !(res = doc.searchNode(
            (name = name.replace(/^@/, '').toUpperCase()),
            pos,
            kind,
        )) ||
        res.fn_is_static
    ) {
        if (res === null) {
            return undefined;
        } else if (res === false) {
            return null;
        }
        res = searchIncludeNode(doc.relevance ?? {}, name) ?? res;
    } else if (
        res.node.kind === SymbolKind.Variable &&
        (!res.scope || !(res.node as Variable).def)
    ) {
        const t = searchIncludeNode(doc.relevance ?? {}, name);
        if (
            t &&
            (t.node.kind !== SymbolKind.Variable ||
                ((t.node as Variable).def && !(res.node as Variable).def))
        ) {
            res = t;
        }
    }
    name = name.replace(/^[#$]/, '');
    let tt = true;
    if (
        kind !== SymbolKind.Field &&
        (!res ||
            (res.node.kind === SymbolKind.Variable &&
                ((tt = !(res.node as Variable).def) || !res.scope))) &&
        (t =
            ahkvars[name] ??
            (tt ? lexers[ahkuris.winapi]?.declaration[name] : undefined))
    ) {
        return [{ uri: t.uri ?? ahkuris.winapi, node: t }];
    }
    return res ? [res] : undefined;
    function searchIncludeNode(list: { [uri: string]: string }, name: string) {
        let ret = undefined;
        let t;
        for (const uri in list) {
            if (
                (t = (
                    lexers[uri] ??
                    openAndParse(restorePath(list[uri]), false, true)
                )?.searchNode(name, undefined, kind))
            ) {
                if (t.node.kind !== SymbolKind.Variable) {
                    return t;
                } else if (
                    !ret ||
                    ((t.node as Variable).def && !(ret.node as Variable).def)
                ) {
                    ret = t;
                }
            }
        }
        return ret;
    }
}

export function getFuncCallInfo(doc: Lexer, position: Position, ci?: CallInfo) {
    let pos: Position, index: number, kind: SymbolKind;
    const tokens = doc.tokens,
        offset = doc.document.offsetAt(position);
    function get(pi: ParamInfo) {
        const tk = tokens[pi.offset];
        pos = doc.document.positionAt(pi.offset);
        if (tk.type === 'TK_WORD') {
            index = offset > pi.offset + tk.content.length ? 0 : -1;
        } else {
            index = 0;
            if (tk.content === '[') {
                kind = SymbolKind.Property;
            }
            if (!pi.name) {
                kind ??= SymbolKind.Null;
            }
        }
        if (index !== -1) {
            for (const c of pi.comma) {
                if (offset > c) {
                    ++index;
                } else {
                    break;
                }
            }
        }
        kind ??= pi.method ? SymbolKind.Method : SymbolKind.Function;
        return { name: pi.name ?? '', pos, index, kind };
    }
    if (ci?.paraminfo) {
        return get(ci.paraminfo);
    }
    let tk: Token | undefined = doc.find_token(offset);
    let nk = tk.previous_token;
    if (offset <= tk.offset && !(tk = nk)) {
        return;
    }
    if (
        tk.callinfo &&
        offset > tk.offset + tk.length &&
        position.line <= tk.callinfo.range.end.line
    ) {
        return get(tk.paraminfo!);
    }
    if (tk.topofline > 0) {
        return;
    }
    while (tk.topofline <= 0) {
        switch (tk.type) {
            case 'TK_END_BLOCK':
                tk = tokens[tk.previous_pair_pos!];
                break;
            case 'TK_END_EXPR':
                tk = tokens[(nk = tk).previous_pair_pos!];
                tk = tk?.previous_token;
                break;
            case 'TK_START_EXPR':
            case 'TK_COMMA':
                if (((nk = tk), tk.paraminfo)) {
                    return get(tk.paraminfo);
                } else if (nk.type === 'TK_COMMA') {
                    return;
                }
                break;
            case 'TK_OPERATOR':
                if (tk.content === '%' && !tk.next_pair_pos) {
                    tk = tokens[tk.previous_pair_pos!];
                }
            default:
                break;
        }
        if (!(tk = tk?.previous_token)) {
            break;
        }
        if (tk.callinfo && tk.paraminfo) {
            return get(tk.paraminfo);
        }
    }
}

export function getincludetable(fileuri: string): {
    count: number;
    list: { [uri: string]: string };
    main: string;
} {
    let list: { [uri: string]: string } = {};
    let count = 0;
    let has = false;
    let doc: Lexer;
    let res = { list, count, main: '' };
    for (const uri in lexers) {
        list = {};
        count = 0;
        has = uri === fileuri;
        traverseinclude(lexers[uri].include, uri);
        if (has && count > res.count) {
            res = { list, count, main: uri };
        }
    }
    if (res.count) {
        delete res.list[fileuri];
        if (res.main && res.main !== fileuri) {
            res.list[res.main] ??= URI.parse(res.main).fsPath;
        }
    }
    return res;
    function traverseinclude(include: any, cururi: string) {
        for (const uri in include) {
            if (fileuri === uri) {
                has = true;
                if (!list[cururi]) {
                    list[cururi] = URI.parse(cururi).fsPath;
                    count++;
                }
            }
            if (!list[uri] && (doc = lexers[uri])) {
                list[uri] = include[uri];
                count++;
                if (cururi !== uri) {
                    traverseinclude(doc.include, uri);
                }
            }
        }
    }
}

export function formatMarkdowndetail(
    node: DocumentSymbol,
    name?: string,
    overloads?: string[],
): string {
    const params: { [name: string]: string[] } = {};
    const details: string[] = [];
    let lastparam = '';
    let m: RegExpMatchArray | null;
    let detail = node.detail;
    const ols = overloads ?? [];
    let s;
    let code = 0;
    if (!detail) {
        return '';
    }
    detail
        .replace(/\{@link\s+(.*)\}/g, (...m) => {
            let s: string = m[1]?.trim() ?? '';
            const p = s.search(/[|\s]/);
            if (p !== -1) {
                const tag = s.substring(p + 1).trim();
                s = s.slice(0, p);
                if (tag) {
                    return `[${tag}](${s})`;
                }
            }
            return ` ${s} `;
        })
        .split(/\r?\n/)
        .forEach((line) => {
            if (line.startsWith('@')) {
                lastparam = '';
                if (code) {
                    if (code === 2) {
                        details.push('```');
                    }
                    code = 0;
                }
                if ((m = line.match(/^@(\S+)(.*)$/))) {
                    switch (m[1].toLowerCase()) {
                        case 'param':
                        case 'arg':
                            m[2].replace(
                                /^\s*({(.*?)}\s+)?(\[.*?\]|\S+)(.*)$/,
                                (...m) => {
                                    const t = m[4].replace(
                                        /^\s*[-—]\s*|\s*$/g,
                                        '',
                                    );
                                    if ((lastparam = m[3]).startsWith('[')) {
                                        m[3] = m[3]
                                            .substring(1)
                                            .replace(
                                                /^((\w|\.|[^\x00-\x7f])+).*$/,
                                                '$1',
                                            );
                                        lastparam = m[3].replace(/\..*$/, '');
                                    }
                                    s =
                                        `\n*@param* \`${m[3]}\`${
                                            m[2] ? `: *${m[2]}*` : ''
                                        }` + (t ? ' — ' + t : '');
                                    if (name === undefined || name === null) {
                                        details.push(s);
                                    }
                                    lastparam = lastparam.toUpperCase();
                                    (params[lastparam] ??= []).push(s);
                                    if (m[3].toUpperCase() === lastparam) {
                                        (params[lastparam] as any).types ??=
                                            m[2];
                                    }
                                    return '';
                                },
                            );
                            break;
                        case 'overload':
                            ols.push('_' + m[2].trim());
                            break;
                        case 'example':
                            s = m[2].replace(
                                /\s*<caption>(.*?)<\/caption>\s*/,
                                (...m) => {
                                    details.push('\n*@example* ' + m[1]);
                                    return '';
                                },
                            );
                            if (((code = 1), s === m[2])) {
                                s = m[2].replace(/\s*<caption>(.*)/, (...m) => {
                                    details.push('\n*@example* ' + m[1]);
                                    return '';
                                });
                                if (s !== m[2]) {
                                    break;
                                }
                                details.push('\n*@example*');
                            }
                            details.push('```ahk2' + (s ? '\n' + s : ''));
                            code = 2;
                            break;
                        case 'var':
                        case 'prop':
                        case 'property':
                            s = m[2]
                                .replace(
                                    /^\s*({(.*?)}\s+)?(\S+)(\s*[-—])?\s*/,
                                    (...m) => {
                                        return m[2]
                                            ? `\`${m[3]}\`: *${m[2]}* — `
                                            : m[3] + ' — ';
                                    },
                                )
                                .replace(/\s*—\s*$/, '');
                            details.push(`\n*@${m[1].toLowerCase()}* ${s}`);
                            break;
                        case 'return':
                        case 'returns':
                            m[2].replace(/^\s*{(.+?)}/, (...m) => {
                                const o: any = {},
                                    tps = cvt_types(m[1]);
                                if (tps) {
                                    tps.forEach((t) => (o[t] = true));
                                    (node as FuncNode).returntypes = o;
                                }
                                return '';
                            });
                        default:
                            s = m[2]
                                .replace(
                                    /^\s*({(.*?)}(?=\s|$))?(\s*[-—])?\s*/,
                                    '*$2* — ',
                                )
                                .replace(/\*\*(?= — )|\s*—\s*$/g, '');
                            details.push(`\n*@${m[1].toLowerCase()}* ${s}`);
                            break;
                    }
                } else {
                    details.push(line);
                }
            } else if (lastparam) {
                params[lastparam].push(line);
                if (name === undefined || name === null) {
                    details.push(line);
                }
            } else if (code === 1 && (s = line.indexOf('</caption>')) > -1) {
                details.push(
                    line.substring(0, s),
                    '```ahk2' +
                        ((s = line.substring(s + 10).trimLeft())
                            ? '\n' + s
                            : ''),
                );
                code = 2;
            } else {
                details.push(line);
            }
        });
    if (code === 2) {
        details.push('```');
    }
    (node as FuncNode).params?.forEach((it) => {
        const p = params[it.name.toUpperCase()];
        if (p) {
            if (p.length) {
                it.detail = p
                    .join('\n')
                    .replace(/ — ?/, '\n___\n')
                    .replace(/(?<!\\)\\@/g, '\n@')
                    .trimLeft();
            }
            const o: any = {},
                types = cvt_types((p as any).types ?? '');
            if (types) {
                it.returntypes = o;
                types.forEach((t) => (o[t] = true));
            }
        }
    });
    if (name !== undefined) {
        s = params[name.toUpperCase()]?.join('\n') ?? '';
        detail = s + '\n\n' + details.join('\n');
    } else if (!overloads && ols.length) {
        detail =
            '*@overload*\n```ahk2\n' +
            ols.map((it) => it.replace(/^_[^\W]*/, node.name)).join('\n') +
            '\n```\n' +
            (details.length ? '___\n' + details.join('\n') : '');
    } else {
        detail = details.join('\n');
    }
    return detail;
}

export function samenameerr(a: DocumentSymbol, b: DocumentSymbol): string {
    if (a.kind === b.kind) {
        if (a.kind === SymbolKind.Class) {
            return diagnostic.conflictserr('class', 'Class', a.name);
        } else if (a.kind === SymbolKind.Function) {
            return diagnostic.conflictserr('function', 'Func', a.name);
        }
        return diagnostic.dupdeclaration();
    } else {
        switch (b.kind) {
            case SymbolKind.Variable:
                return diagnostic.assignerr(
                    a.kind === SymbolKind.Function ? 'Func' : 'Class',
                    a.name,
                );
            case SymbolKind.Function:
                if (a.kind === SymbolKind.Variable) {
                    return diagnostic.assignerr('Func', a.name);
                }
                return diagnostic.conflictserr('function', 'Class', a.name);
            case SymbolKind.Class:
                if (a.kind === SymbolKind.Function) {
                    return diagnostic.conflictserr('class', 'Func', a.name);
                } else if (
                    a.kind === SymbolKind.Property ||
                    a.kind === SymbolKind.Method
                ) {
                    return diagnostic.dupdeclaration();
                }
                return diagnostic.assignerr('Class', a.name);
            case SymbolKind.Property:
            case SymbolKind.Method:
                return diagnostic.dupdeclaration();
        }
        return '';
    }
}

export function checksamenameerr(
    decs: { [name: string]: DocumentSymbol },
    arr: DocumentSymbol[],
    diags: any,
) {
    let _low = '';
    let vit: Variable;
    for (const it of arr) {
        if (!it.name || !it.selectionRange.end.character) {
            continue;
        }
        switch ((vit = it as Variable).kind) {
            case SymbolKind.Variable:
                vit.assigned ||= Boolean(vit.returntypes);
            case SymbolKind.Class:
            case SymbolKind.Function:
                if (!decs[(_low = it.name.toUpperCase())]) {
                    decs[_low] = it;
                } else if ((<any>decs[_low]).infunc) {
                    if (it.kind === SymbolKind.Variable) {
                        if (
                            vit.def &&
                            decs[_low].kind !== SymbolKind.Variable
                        ) {
                            diags.push({
                                message: diagnostic.assignerr(
                                    decs[_low].kind === SymbolKind.Function
                                        ? 'Func'
                                        : 'Class',
                                    it.name,
                                ),
                                range: it.selectionRange,
                                severity: DiagnosticSeverity.Error,
                            });
                            continue;
                        }
                    } else if ((<Variable>decs[_low]).def) {
                        diags.push({
                            message: diagnostic.assignerr(
                                it.kind === SymbolKind.Function
                                    ? 'Func'
                                    : 'Class',
                                it.name,
                            ),
                            range: decs[_low].selectionRange,
                            severity: DiagnosticSeverity.Error,
                        });
                    } else if (decs[_low].kind === SymbolKind.Function) {
                        diags.push({
                            message: samenameerr(decs[_low], it),
                            range: it.selectionRange,
                            severity: DiagnosticSeverity.Error,
                        });
                        continue;
                    }
                    decs[_low] = it;
                } else if (it.kind === SymbolKind.Variable) {
                    if (decs[_low].kind === SymbolKind.Variable) {
                        const t = decs[_low] as Variable;
                        if (vit.def && !t.def) {
                            decs[_low] = it;
                        } else {
                            t.assigned ||= vit.assigned;
                        }
                    } else if (vit.def) {
                        delete vit.def;
                        diags.push({
                            message: samenameerr(decs[_low], it),
                            range: it.selectionRange,
                            severity: DiagnosticSeverity.Error,
                        });
                    }
                } else {
                    if (decs[_low].kind === SymbolKind.Variable) {
                        if ((<Variable>decs[_low]).def) {
                            delete (<Variable>decs[_low]).def;
                            diags.push({
                                message: samenameerr(it, decs[_low]),
                                range: decs[_low].selectionRange,
                                severity: DiagnosticSeverity.Error,
                            });
                        }
                        decs[_low] = it;
                    } else if ((<Variable>decs[_low]).def !== false) {
                        diags.push({
                            message: samenameerr(decs[_low], it),
                            range: it.selectionRange,
                            severity: DiagnosticSeverity.Error,
                        });
                    } else if ((it as Variable).def !== false) {
                        decs[_low] = it;
                    }
                }
                break;
        }
    }
}

export function is_line_continue(
    lk: Token,
    tk: Token,
    parent?: DocumentSymbol,
): boolean {
    switch (lk.type) {
        case '':
        case 'TK_COMMA':
        case 'TK_EQUALS':
        case 'TK_START_EXPR':
            return true;
        case 'TK_OPERATOR':
            if (lk.ignore) {
                return false;
            }
            if (!lk.content.match(/^(%|\+\+|--)$/)) {
                return true;
            }
        default:
            switch (tk.type) {
                case 'TK_DOT':
                case 'TK_COMMA':
                case 'TK_EQUALS':
                    return true;
                case 'TK_OPERATOR':
                    return (
                        !tk.content.match(/^(!|~|not|%|\+\+|--)$/i) &&
                        (!parent ||
                            !tk.content.match(/^\w/) ||
                            parent.kind !== SymbolKind.Class)
                    );
                // case 'TK_END_BLOCK':
                // case 'TK_END_EXPR':
                // 	return false;
                case 'TK_STRING':
                    if (tk.ignore) {
                        return true;
                    }
                default:
                    return false;
            }
    }
}

export function update_commentTags(regexp: string) {
    const old = commentTags;
    try {
        commentTags = new RegExp(regexp, 'i');
    } catch (e: any) {
        commentTags = old;
        throw e;
    }
}

function cvt_types(tps: string) {
    if ((tps = tps.replace(/\s/g, ''))) {
        let t: string;
        const o: any = {};
        while ((t = tps.replace(/\(([^)]*)\)(?!\s*=>)/g, '$1')) !== tps) {
            tps = t;
        }
        tps.toLowerCase()
            .split(/(?<!=>\s*[^)]*)\|/)
            .forEach(
                (tp) =>
                    (o[
                        tp === 'void'
                            ? '#void'
                            : tp.includes('=>')
                            ? tp
                            : tp
                                  .replace(
                                      /(^|\.)([^.$@#]+(<[^>]+>)?)$/,
                                      '$1@$2',
                                  )
                                  .replace('$', '')
                    ] = true),
            );
        delete o[''];
        const a = Object.keys(o);
        if (a.length) {
            return a;
        }
    }
}
