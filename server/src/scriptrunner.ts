import { spawnSync } from 'child_process';
import { ahkpath_cur, extsettings } from './common';
import { existsSync } from 'fs';

export function runscript(script: string, out?: Function): boolean {
    const executePath = ahkpath_cur || extsettings.InterpreterPath;
    if (existsSync(executePath)) {
        const process = spawnSync(
            `\"${executePath}\" /CP65001 /ErrorStdOut=utf-8 *`,
            [],
            {
                cwd: executePath.replace(/[\\/].+?$/, ''),
                shell: true,
                input: script,
            },
        );
        if (process) {
            if (out) {
                out((process.stdout ?? '').toString());
            }
            return true;
        }
    }
    return false;
}
