/**
 * External-editor helper — spawn $VISUAL / $EDITOR (or a configured
 * command) on a temp file seeded with the current editor buffer, then
 * read the edited contents back.
 *
 * Resolution priority:
 *   configured (from Core/SDK defaults or `/editor`) >
 *   $VISUAL > $EDITOR > undefined (caller handles "no editor" toast).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function resolveEditorCommand(configured?: string | null): string | undefined {
  const candidates = [configured, process.env['VISUAL'], process.env['EDITOR']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.trim();
    }
  }
  return undefined;
}

/**
 * Launch `command` (tokenised via a shell) against a temp file seeded
 * with `initialText`. Returns the edited contents on success, or
 * `undefined` if the editor exited non-zero / the file disappeared.
 *
 * The command is passed to `/bin/sh -c "<cmd> <tmpfile>"` so users can
 * supply argv-style strings like `"code --wait"` or `"nvim +set ft=markdown"`.
 */
export async function editInExternalEditor(
  initialText: string,
  command: string,
): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-edit-'));
  const file = join(dir, 'prompt.md');
  await writeFile(file, initialText, 'utf-8');
  try {
      const code = await new Promise<number>((resolve, reject) => {
      const args = parseCommand(command);
      if (args.length === 0) {
        reject(new Error('Empty editor command'));
        return;
      }
      const [cmd, ...cmdArgs] = args;
      const child = spawn(cmd, [...cmdArgs, file], { stdio: 'inherit' });
      child.on('exit', (c) => { resolve(c ?? 0); });
      child.on('error', reject);
    });
    if (code !== 0) return undefined;
    return await readFile(file, 'utf-8');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    });
  }
}

function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (inQuotes) {
      if (char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuotes = true;
      quoteChar = char;
    } else if (char === ' ' || char === '\t') {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}
