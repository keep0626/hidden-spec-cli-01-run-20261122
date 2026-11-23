// mend: applies AI-written edits in four formats to a tree of text files.
// Written from SPEC.md for hidden-spec-cli-01-run-20261122. Node 22, stdlib only.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse failure: exit 2, `error: parse <line>`. */
class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** One edit that failed: exit 1, `error: <code> <path>`. */
class Fail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

interface FileParts {
  lines: string[];
  brk: string;
  ends: boolean;
}

/** Split a file's text at its own line break. */
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], brk: '\n', ends: false };
  const nl = text.indexOf('\n');
  const brk = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let ends = false;
  if (text.endsWith(brk)) {
    parts.pop();
    ends = true;
  }
  return { lines: parts, brk, ends };
}

/** Join lines the way the file was written; a file of no lines is written empty. */
function joinFile(lines: string[], brk: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(brk) + (ends ? brk : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** All 0-based positions where O occurs in lines at tier, at or after `from`. */
function occurrences(O: string[], lines: string[], tier: number, from: number, endOnly: boolean): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const want = O.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    if (endOnly && i + O.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j], tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0..2, or 0 only when strict) where O occurs at least once. */
function findTier(
  O: string[],
  lines: string[],
  strict: boolean,
  from = 0,
  endOnly = false,
): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(O, lines, t, from, endOnly);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of a replacement: whether it is a context line, and its index in O when it is. */
interface NewItem {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/**
 * Build the replacement lines for a matched block. Context lines are written as
 * the file's own matched lines; at tier 2 every other non-empty line that starts
 * with O's first line's leading whitespace has that prefix swapped for the
 * file's first matched line's leading whitespace.
 */
function buildNew(N: NewItem[], O: string[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const f = O.length > 0 ? leadWs(fileLines[at]) : '';
  const p = O.length > 0 ? leadWs(O[0]) : '';
  for (const it of N) {
    if (it.ctx) {
      out.push(fileLines[at + it.oIndex]);
    } else if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(p)) {
      out.push(f + it.text.slice(p.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

/** Split parsed body items into O items (context + old) and N items (context + new). */
function splitItems(items: { kind: string; text: string }[]): {
  o: string[];
  n: NewItem[];
} {
  const o: string[] = [];
  const n: NewItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      n.push({ text: it.text, ctx: true, oIndex: o.length });
      o.push(it.text);
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'new') {
      n.push({ text: it.text, ctx: false, oIndex: -1 });
    }
    // 'mark' (`\ No newline at end of file`) lines carry no line of their own.
  }
  return { o, n };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type EditFn = (tree: Tree) => void;

/** Section 4: detect the patch format, or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** One JSON edit object (SPEC section 9), or throws ParseErr at its line. */
function jsonEdit(v: unknown, line: number): EditFn {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ParseErr(line);
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') throw new ParseErr(line);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseErr(line);
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseErr(line);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseErr(line);
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseErr(line);
    if (typeof o.new_str !== 'string') throw new ParseErr(line);
    const atLine = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      if (atLine < 0 || atLine > f.lines.length) throw new Fail('no-match', p);
      const next = [...f.lines.slice(0, atLine), ...add, ...f.lines.slice(atLine)];
      tree.set(p, joinFile(next, f.brk, f.ends));
    };
  }
  throw new ParseErr(line);
}

/** Section 9: parse the patch as JSON (array form or JSON Lines). */
function parseJSON(lines: string[], text: string): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseErr(1);
  if (text.trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseErr(first + 1);
    if (arr.length === 0) throw new ParseErr(1);
    return arr.map((v) => jsonEdit(v, first + 1));
  }
  const edits: EditFn[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (blank(lines[i])) continue;
    let v: unknown;
    try {
      v = JSON.parse(lines[i]);
    } catch {
      throw new ParseErr(i + 1);
    }
    edits.push(jsonEdit(v, i + 1));
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

interface UHunk {
  a: number;
  items: Array<{ kind: string; text: string }>;
}

interface USection {
  oldP: string | undefined;
  newP: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  create: boolean;
  del: boolean;
  hasPair: boolean;
  hunks: UHunk[];
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(items: Array<{ kind: string; text: string }>): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'ctx' || items[i].kind === 'new') last = i;
  }
  return last >= 0 && items[last + 1] !== undefined && items[last + 1].kind === 'mark';
}

/** True when a `\` line follows the hunk's last `+` line. */
function backslashAfterLastPlus(items: Array<{ kind: string; text: string }>): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'new') last = i;
  }
  return last >= 0 && items[last + 1] !== undefined && items[last + 1].kind === 'mark';
}

/** Apply a section's hunks in order to a file's text (SPEC section 6). */
function applyHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  let f = splitFile(text);
  let lines = f.lines;
  let ends = f.ends;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitItems(h.items);
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const atEnd = at === lines.length;
      const repl = buildNew(n, o, lines, at, 0);
      lines = [...lines.slice(0, at), ...repl, ...lines.slice(at)];
      if (atEnd) ends = !backslashAfterLast(h.items);
      d += n.length;
    } else {
      const found = findTier(o, lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const touchesEnd = best + o.length === lines.length;
      const repl = buildNew(n, o, lines, best, found.tier);
      lines = [...lines.slice(0, best), ...repl, ...lines.slice(best + o.length)];
      if (touchesEnd) ends = !backslashAfterLast(h.items);
      d += n.length - o.length;
    }
  }
  return joinFile(lines, f.brk, ends);
}

/** One unified section as one edit. */
function unifiedSectionEdit(sec: USection, strict: boolean): EditFn {
  let oldP: string | undefined;
  let newP: string | undefined;
  if (sec.hasPair) {
    oldP = sec.oldP;
    newP = sec.newP;
  } else if (sec.renameFrom !== undefined || sec.renameTo !== undefined) {
    oldP = sec.renameFrom;
    newP = sec.renameTo;
  } else {
    oldP = sec.diffOld;
    newP = sec.diffNew;
  }
  const oldNull = oldP === undefined || oldP === '/dev/null';
  const newNull = newP === undefined || newP === '/dev/null';
  const create = oldNull || sec.create;
  const del = !create && (newNull || sec.del);
  return (tree) => {
    if (create) {
      const np = newP!;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      let ends = true;
      for (let i = sec.hunks.length - 1; i >= 0; i--) {
        const items = sec.hunks[i].items;
        if (items.some((it) => it.kind === 'new')) {
          ends = !backslashAfterLastPlus(items);
          break;
        }
      }
      tree.set(np, plus.length === 0 ? '' : plus.join('\n') + (ends ? '\n' : ''));
      return;
    }
    if (del) {
      const op = oldP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.set(op, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    if (tree.get(op) === null) throw new Fail('missing', op);
    const move = op !== np;
    if (move && tree.get(np) !== null) throw new Fail('exists', np);
    const before = tree.get(op)!;
    const after = applyHunks(before, sec.hunks, strict, op);
    tree.set(op, null);
    if (move) tree.moves.push([op, np]);
    tree.set(np, after);
  };
}

/** Section 6: parse a unified diff into one edit per section. */
function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const fresh = (): USection => ({
    oldP: undefined,
    newP: undefined,
    diffOld: undefined,
    diffNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    create: false,
    del: false,
    hasPair: false,
    hunks: [],
  });
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
  const isDiff = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  const headerPath = (line: string): string => {
    const rest = line.slice(4);
    const tab = rest.indexOf('\t');
    return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  };
  const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const sections: USection[] = [];
  let sec: USection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isDiff(line)) {
      const dm = diffRe.exec(line);
      if (!dm) throw new ParseErr(i + 1);
      if (sec) sections.push(sec);
      sec = fresh();
      sec.diffOld = dm[1];
      sec.diffNew = dm[2];
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldRaw = headerPath(line);
      const newRaw = headerPath(lines[i + 1]);
      if (sec !== null && inHeader && !sec.hasPair) {
        sec.oldP = stripPrefix(oldRaw);
        sec.newP = stripPrefix(newRaw);
        sec.hasPair = true;
      } else {
        if (sec) sections.push(sec);
        sec = fresh();
        sec.oldP = stripPrefix(oldRaw);
        sec.newP = stripPrefix(newRaw);
        sec.hasPair = true;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseErr(i + 1);
      const hm = hunkRe.exec(line);
      if (!hm) throw new ParseErr(i + 1);
      const a = Number(hm[1]);
      const items: Array<{ kind: string; text: string }> = [];
      let j = i + 1;
      while (j < lines.length) {
        const L = lines[j];
        if (isDiff(L)) break;
        if (L.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (L === '') {
          items.push({ kind: 'ctx', text: '' });
          j++;
          continue;
        }
        const c = L[0];
        if (c === ' ') {
          items.push({ kind: 'ctx', text: L.slice(1) });
          j++;
          continue;
        }
        if (c === '-') {
          items.push({ kind: 'old', text: L.slice(1) });
          j++;
          continue;
        }
        if (c === '+') {
          items.push({ kind: 'new', text: L.slice(1) });
          j++;
          continue;
        }
        if (c === '\\') {
          items.push({ kind: 'mark', text: L.slice(1) });
          j++;
          continue;
        }
        break;
      }
      while (items.length > 0 && items[items.length - 1].kind === 'ctx' && items[items.length - 1].text === '') {
        items.pop();
      }
      sec.hunks.push({ a, items });
      inHeader = false;
      i = j;
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) throw new ParseErr(i + 2);
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.create = true;
      else if (line.startsWith('deleted file mode')) sec.del = true;
      i++;
      continue;
    }
    i++;
  }
  if (sec) sections.push(sec);
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Section 7: parse SEARCH/REPLACE blocks into one edit per block. */
function parseSR(lines: string[], strict: boolean): EditFn[] {
  const blocks: Array<{ path: string; oldLines: string[]; newLines: string[]; line: number }> = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (true) {
    let s = -1;
    for (let k = prevEnd; k < lines.length; k++) {
      if (lines[k].trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let p: string | null = null;
    for (let k = s - 1; k >= prevEnd; k--) {
      const t = lines[k].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) {
      if (prevPath !== null) p = prevPath;
      else throw new ParseErr(s + 1);
    }
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k].trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new ParseErr(s + 1);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseErr(s + 1);
    blocks.push({ path: p, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep), line: s + 1 });
    prevPath = p;
    prevEnd = rep + 1;
  }
  if (blocks.length === 0) throw new ParseErr(1);
  return blocks.map((b) => {
    const oldLines = b.oldLines;
    const newLines = b.newLines;
    const path = b.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      const f = splitFile(cur);
      const found = findTier(oldLines, f.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.pos.length > 1) throw new Fail('ambiguous', path);
      const at = found.pos[0];
      const nItems: NewItem[] = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
      const repl = buildNew(nItems, oldLines, f.lines, at, found.tier);
      const next = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldLines.length)];
      tree.set(path, joinFile(next, f.brk, f.ends));
    };
  });
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: Array<{ kind: string; text: string }>;
}

interface VSection {
  kind: string;
  path: string;
  body: string[];
  bodyLines: number[];
  startLine: number;
}

/** One V4A section as one edit. */
function v4aSectionEdit(s: VSection, strict: boolean): EditFn {
  const path = s.path;
  if (s.kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < s.body.length; k++) {
      const L = s.body[k];
      if (L.startsWith('+')) fileLines.push(L.slice(1));
      else if (L === '') fileLines.push('');
      else throw new ParseErr(s.bodyLines[k] + 1);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'del') {
    for (let k = 0; k < s.body.length; k++) {
      if (!blank(s.body[k])) throw new ParseErr(s.bodyLines[k] + 1);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.set(path, null);
    };
  }
  let moveTo: string | undefined;
  let body = s.body;
  let bodyLines = s.bodyLines;
  if (body.length > 0 && body[0].startsWith('*** Move to: ')) {
    moveTo = body[0].slice('*** Move to: '.length).trim();
    body = body.slice(1);
    bodyLines = bodyLines.slice(1);
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = 0; k < body.length; k++) {
    const L = body[k];
    const ln = bodyLines[k] + 1;
    if (L.startsWith('@@')) {
      if (cur) chunks.push(cur);
      const anchor = L.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
    } else if (L === '*** End of File') {
      if (!cur) throw new ParseErr(ln);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (L === '' || L[0] === ' ' || L[0] === '-' || L[0] === '+') {
      if (!cur) {
        if (chunks.length === 0) cur = { anchor: null, eof: false, items: [] };
        else throw new ParseErr(ln);
      }
      if (L === '') cur.items.push({ kind: 'ctx', text: '' });
      else if (L[0] === ' ') cur.items.push({ kind: 'ctx', text: L.slice(1) });
      else if (L[0] === '-') cur.items.push({ kind: 'old', text: L.slice(1) });
      else cur.items.push({ kind: 'new', text: L.slice(1) });
    } else {
      throw new ParseErr(ln);
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0 && moveTo === undefined) throw new ParseErr(s.startLine);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== undefined) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const f = splitFile(curText);
    let flines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier([ch.anchor], flines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0] + 1;
      }
      const { o, n } = splitItems(ch.items);
      if (o.length === 0) {
        const at = ch.eof ? flines.length : cursor;
        const repl = buildNew(n, o, flines, at, 0);
        flines = [...flines.slice(0, at), ...repl, ...flines.slice(at)];
        cursor = at + repl.length;
      } else {
        const found = findTier(o, flines, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const at = found.pos[0];
        const repl = buildNew(n, o, flines, at, found.tier);
        flines = [...flines.slice(0, at), ...repl, ...flines.slice(at + o.length)];
        cursor = at + repl.length;
      }
    }
    const out = joinFile(flines, f.brk, f.ends);
    tree.set(path, null);
    if (moveTo !== undefined) tree.moves.push([path, moveTo]);
    tree.set(moveTo ?? path, out);
  };
}

/** Section 8: parse a V4A patch into one edit per section. */
function parseV4A(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const ADD = '*** Add File: ';
  const DEL = '*** Delete File: ';
  const UPD = '*** Update File: ';
  const isSecStart = (l: string): boolean => l.startsWith(ADD) || l.startsWith(DEL) || l.startsWith(UPD);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i])) {
      i++;
      continue;
    }
    const L = lines[i];
    let kind: string;
    let path: string;
    if (L.startsWith(ADD)) {
      kind = 'add';
      path = L.slice(ADD.length).trim();
    } else if (L.startsWith(DEL)) {
      kind = 'del';
      path = L.slice(DEL.length).trim();
    } else if (L.startsWith(UPD)) {
      kind = 'upd';
      path = L.slice(UPD.length).trim();
    } else {
      throw new ParseErr(i + 1);
    }
    const body: string[] = [];
    const bodyLines: number[] = [];
    let j = i + 1;
    while (j < last && !isSecStart(lines[j])) {
      body.push(lines[j]);
      bodyLines.push(j);
      j++;
    }
    while (body.length > 0 && blank(body[body.length - 1])) {
      body.pop();
      bodyLines.pop();
    }
    sections.push({ kind, path, body, bodyLines, startLine: i + 1 });
    i = j;
  }
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => v4aSectionEdit(s, strict));
}

interface RunResult {
  code: number;
  out: string[];
}

function usageResult(): RunResult {
  return { code: 2, out: ['error: usage'] };
}

function run(argv: string[]): RunResult {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional: string[] = [];
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return usageResult();
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return usageResult();
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return usageResult();
        seenFormat = true;
        format = a.slice('--format='.length);
        if (!FORMATS.includes(format)) return usageResult();
      } else {
        return usageResult();
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return usageResult();
  let text: string;
  const patchArg = positional[0];
  try {
    text = patchArg === undefined || patchArg === '-' ? readFileSync(0, 'utf8') : readFileSync(patchArg, 'utf8');
  } catch {
    return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  let fmt = format;
  if (fmt === null || fmt === 'auto') {
    fmt = detect(lines);
    if (fmt === null) return { code: 2, out: ['error: format'] };
  }
  let edits: EditFn[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines, strict);
    else if (fmt === 'search-replace') edits = parseSR(lines, strict);
    else if (fmt === 'v4a') edits = parseV4A(lines, strict);
    else edits = parseJSON(lines, text);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const e of edits) {
    try {
      e(tree);
    } catch (err) {
      if (err instanceof Fail) fails.push(err);
      else throw err;
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // Output rows: one per path whose bytes changed; a successful move prints R.
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rows: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const v = tree.now.get(p);
      if (v !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

