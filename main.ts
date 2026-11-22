// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 3: a file's lines, its line break, and its final break.    */
/* ------------------------------------------------------------------ */

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/* ------------------------------------------------------------------ */
/* Section 5: three-tier line matching and applying a replacement.     */
/* ------------------------------------------------------------------ */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function tierOf(tier: number): (s: string) => string {
  return tier === 0 ? (s: string) => s : tier === 1 ? stripTrail : stripBoth;
}

function occurrencesAt(lines: string[], O: string[], tier: number): number[] {
  const tf = tierOf(tier);
  const o = O.map(tf);
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (tf(lines[i + j]!) !== o[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier at which O occurs (0 only when strict), with its positions. */
function findTier(lines: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const pos = occurrencesAt(lines, O, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line (the file's own matched line at O index j) or a new line. */
type NPiece = { ctx: number } | { text: string };

interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** a `\` line follows this body line */
  backslash: boolean;
  /** the raw patch line was empty (for trimming trailing empty body lines) */
  rawEmpty: boolean;
}

/** Split a chunk/hunk body into O (old lines) and N (new lines, with context tracked). */
function buildON(body: BodyLine[]): { O: string[]; N: NPiece[] } {
  const O: string[] = [];
  const N: NPiece[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ ctx: O.length - 1 });
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else {
      N.push({ text: b.text });
    }
  }
  return { O, N };
}

/** Replace lines[i..i+O.length) with N. Context lines come from the file; at tier 2 the other lines are re-indented. */
function applyReplace(lines: string[], i: number, O: string[], N: NPiece[], tier: number): string[] {
  const F = O.length > 0 ? leadingWs(lines[i]!) : '';
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  const out: string[] = [];
  for (const piece of N) {
    if ('ctx' in piece) {
      out.push(lines[i + piece.ctx]!);
    } else {
      let t = piece.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return [...lines.slice(0, i), ...out, ...lines.slice(i + O.length)];
}

/** The moves a patch made, for the `R old -> new` output lines. */
const moves: Array<[string, string]> = [];

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                           */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** the -A number of the header */
  a: number;
  body: BodyLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noNlAfterLastCtxOrNew: boolean;
}

interface UniSection {
  /** old path from the `--- ` line, null when /dev/null, undefined when no pair */
  dashOld: string | null | undefined;
  /** new path from the `+++ ` line, null when /dev/null, undefined when no pair */
  dashNew: string | null | undefined;
  /** old path from `rename from`, undefined when absent */
  renameOld: string | undefined;
  /** new path from `rename to`, undefined when absent */
  renameNew: string | undefined;
  /** old path from the `diff --git` line, undefined when the section did not start there */
  gitOld: string | undefined;
  /** new path from the `diff --git` line, undefined when the section did not start there */
  gitNew: string | undefined;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ ` (up to the first tab, spaces removed, a/ or b/ removed). */
function dashPath(raw: string): string {
  const cut = raw.split('\t')[0]!;
  const t = cut.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Collect one hunk's body starting at lines[start]; returns the body and the next index. */
function parseHunkBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      if (l[0] === '\\') {
        if (body.length > 0) body[body.length - 1]!.backslash = true;
      } else if (l === '') {
        body.push({ kind: 'ctx', text: '', backslash: false, rawEmpty: true });
      } else if (l[0] === ' ') {
        body.push({ kind: 'ctx', text: l.slice(1), backslash: false, rawEmpty: false });
      } else if (l[0] === '-') {
        body.push({ kind: 'old', text: l.slice(1), backslash: false, rawEmpty: false });
      } else {
        body.push({ kind: 'new', text: l.slice(1), backslash: false, rawEmpty: false });
      }
      i++;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
  return { body, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const startSection = (gitOld: string | undefined, gitNew: string | undefined): void => {
    if (cur !== null) sections.push(cur);
    cur = { dashOld: undefined, dashNew: undefined, renameOld: undefined, renameNew: undefined, gitOld, gitNew, creation: false, deletion: false, hunks: [] };
    inHeader = true;
  };
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = dashPath(l.slice(4));
      const newP = dashPath(lines[i + 1]!.slice(4));
      if (cur === null || !inHeader) {
        startSection(undefined, undefined);
        cur!.dashOld = oldP === '/dev/null' ? null : oldP;
        cur!.dashNew = newP === '/dev/null' ? null : newP;
      } else {
        cur.dashOld = oldP === '/dev/null' ? null : oldP;
        cur.dashNew = newP === '/dev/null' ? null : newP;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = parseHunkBody(lines, i + 1);
      let noNl = false;
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
          noNl = body[k]!.backslash;
          break;
        }
      }
      cur.hunks.push({ a: Number(m[1]), body, noNlAfterLastCtxOrNew: noNl });
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) {
        if (cur.renameOld === undefined) cur.renameOld = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        if (cur.renameNew === undefined) cur.renameNew = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) {
        cur.creation = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.deletion = true;
      }
      i++;
      continue;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);

  const applyHunks = (text: string, hunks: Hunk[], path: string): string => {
    let { lines: fl, br, final } = splitFile(text);
    let d = 0;
    for (const h of hunks) {
      const { O, N } = buildON(h.body);
      if (O.length > 0) {
        const found = findTier(fl, O, strict);
        if (found === null) throw new Fail('no-match', path);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        for (const pos of found.pos) {
          if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
        }
        const runsToEnd = best + O.length === fl.length;
        fl = applyReplace(fl, best, O, N, found.tier);
        if (runsToEnd) final = !h.noNlAfterLastCtxOrNew;
        d += N.length - O.length;
      } else {
        const p = Math.min(h.a + d, fl.length);
        const ins = N.map((piece) => (piece as { text: string }).text);
        fl = [...fl.slice(0, p), ...ins, ...fl.slice(p)];
        if (p === fl.length) final = !h.noNlAfterLastCtxOrNew;
        d += N.length;
      }
    }
    return joinFile(fl, br, final);
  };

  return sections.map((sec) => {
    // Path priority: the ---/+++ pair, then rename from/to, then the diff --git paths.
    const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld;
    const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew;
    const isCreate = sec.creation || oldP === null;
    const isDelete = !isCreate && (sec.deletion || newP === null);
    return (tree: Tree) => {
      if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate) {
        const p = newP as string;
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let noNl = false;
        let seenPlus = false;
        for (const h of sec.hunks) {
          for (const b of h.body) {
            if (b.kind === 'new') {
              plus.push(b.text);
              noNl = b.backslash;
              seenPlus = true;
            }
          }
        }
        void seenPlus;
        const content = plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n');
        tree.now.set(p, content);
        return;
      }
      if (isDelete) {
        const p = oldP as string;
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (oldP !== newP) {
        const op = oldP as string;
        const np = newP as string;
        if (tree.get(op) === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const result = applyHunks(tree.get(op)!, sec.hunks, op);
        tree.now.set(np, result);
        tree.now.set(op, null);
        moves.push([op, np]);
        return;
      }
      const p = oldP as string;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(tree.get(p)!, sec.hunks, p));
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                   */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevReplaceIdx = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevReplaceIdx; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trimStart().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let sep = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          sep = j;
          break;
        }
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      }
      if (sep === -1) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, rep) });
      prevPath = path;
      prevReplaceIdx = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return blocks.map((b) => {
    return (tree: Tree) => {
      const p = b.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (b.oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const { lines: fl, br, final } = splitFile(text);
      const found = findTier(fl, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const N: NPiece[] = b.newLines.map((t) => ({ text: t }));
      tree.now.set(p, joinFile(applyReplace(fl, found.pos[0]!, b.oldLines, N, found.tier), br, final));
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                             */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  /** null when the chunk has no anchor */
  anchor: string | null;
  body: BodyLine[];
  /** the chunk was ended by a `*** End of File` line */
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** Add File: the file's lines */
  lines: string[];
  /** Update File: the Move to path, null when absent */
  moveTo: string | null;
  chunks: V4AChunk[];
  /** 1-based line of the Update File line (for the no-chunk-no-move error) */
  updateLine: number;
}

/** First line at or after `from` equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const tf = tierOf(t);
    const a = tf(anchor);
    for (let i = from; i < lines.length; i++) {
      if (tf(lines[i]!) === a) return i;
    }
  }
  return null;
}

/** First occurrence of O at or after `from`, at the first tier with one (EOF: only one ending at the last line). */
function findFrom(lines: string[], O: string[], from: number, strict: boolean, eof: boolean): { pos: number; tier: number } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const pos = occurrencesAt(lines, O, t).filter((i) => i >= from && (!eof || i + O.length === lines.length));
    if (pos.length > 0) return { pos: pos[0]!, tier: t };
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const isAdd = l.startsWith('*** Add File: ');
    const isDelete = l.startsWith('*** Delete File: ');
    const isUpdate = l.startsWith('*** Update File: ');
    if (!isAdd && !isDelete && !isUpdate) throw new Exit2(`error: parse ${i + 1}`);
    const kind = isAdd ? 'add' : isDelete ? 'delete' : 'update';
    const prefix = isAdd ? '*** Add File: ' : isDelete ? '*** Delete File: ' : '*** Update File: ';
    const path = l.slice(prefix.length).trim();
    const startLine = i + 1;
    const content: string[] = [];
    let j = i + 1;
    while (j < last) {
      const cl = lines[j]!;
      if (cl.startsWith('*** Add File: ') || cl.startsWith('*** Delete File: ') || cl.startsWith('*** Update File: ')) break;
      content.push(cl);
      j++;
    }
    while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < content.length; k++) {
        const cl = content[k]!;
        if (cl === '') fileLines.push('');
        else if (cl.startsWith('+')) fileLines.push(cl.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      sections.push({ kind: 'add', path, lines: fileLines, moveTo: null, chunks: [], updateLine: startLine });
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      sections.push({ kind: 'delete', path, lines: [], moveTo: null, chunks: [], updateLine: startLine });
    } else {
      let moveTo: string | null = null;
      let at = 0;
      if (content.length > 0 && content[0]!.startsWith('*** Move to: ')) {
        moveTo = content[0]!.slice('*** Move to: '.length).trim();
        at = 1;
      }
      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;
      for (let k = at; k < content.length; k++) {
        const cl = content[k]!;
        const lineNo = i + 2 + k;
        if (cl.startsWith('@@')) {
          if (curChunk !== null) chunks.push(curChunk);
          const anchor = cl.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
        } else if (cl === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${lineNo}`);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
        } else if (cl === '' || cl[0] === ' ' || cl[0] === '-' || cl[0] === '+') {
          if (curChunk === null) curChunk = { anchor: null, body: [], eof: false };
          if (cl === '') curChunk.body.push({ kind: 'ctx', text: '', backslash: false, rawEmpty: true });
          else if (cl[0] === ' ') curChunk.body.push({ kind: 'ctx', text: cl.slice(1), backslash: false, rawEmpty: false });
          else if (cl[0] === '-') curChunk.body.push({ kind: 'old', text: cl.slice(1), backslash: false, rawEmpty: false });
          else curChunk.body.push({ kind: 'new', text: cl.slice(1), backslash: false, rawEmpty: false });
        } else {
          throw new Exit2(`error: parse ${lineNo}`);
        }
      }
      if (curChunk !== null) chunks.push(curChunk);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      sections.push({ kind: 'update', path, lines: [], moveTo, chunks, updateLine: startLine });
    }
    i = j;
  }
  return sections.map((sec) => {
    return (tree: Tree) => {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (sec.kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      let { lines: fl, br, final } = splitFile(text);
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          const idx = findAnchor(fl, ch.anchor, cursor, strict);
          if (idx === null) throw new Fail('no-match', p);
          cursor = idx + 1;
        }
        const { O, N } = buildON(ch.body);
        if (O.length > 0) {
          const found = findFrom(fl, O, cursor, strict, ch.eof);
          if (found === null) throw new Fail('no-match', p);
          fl = applyReplace(fl, found.pos, O, N, found.tier);
          cursor = found.pos + N.length;
        } else {
          const pos = ch.eof ? fl.length : cursor;
          const ins = N.map((piece) => (piece as { text: string }).text);
          fl = [...fl.slice(0, pos), ...ins, ...fl.slice(pos)];
          cursor = pos + N.length;
        }
      }
      const result = joinFile(fl, br, final);
      if (sec.moveTo !== null) {
        tree.now.set(sec.moveTo, result);
        tree.now.set(p, null);
        moves.push([p, sec.moveTo]);
      } else {
        tree.now.set(p, result);
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  moves.length = 0;
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: Array<{ key: string; line: string }> = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      changed.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
