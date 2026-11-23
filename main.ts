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

/** A file as lines: its break, its lines, whether it ends with a break. */
interface LineFile {
  br: string;
  lines: string[];
  fin: boolean;
}
function parseFile(t: string): LineFile {
  if (t === '') return { br: '\n', lines: [], fin: false };
  const i = t.indexOf('\n');
  const br = i > 0 && t[i - 1] === '\r' ? '\r\n' : '\n';
  const parts = t.split(br);
  const fin = t.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, fin };
}
function renderFile(f: LineFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}
const stripEnd = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const normLine = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? stripEnd(s) : stripBoth(s));
/** Positions where O occurs in fl at one tier. */
function occsAt(fl: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= fl.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(fl[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2; only 0 when strict) with an occurrence at or after `from`. */
function findTier(fl: string[], o: string[], strict: boolean, from: number, eof: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occsAt(fl, o, t).filter((i) => i >= from);
    if (eof) occ = occ.filter((i) => i + o.length === fl.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line: ' ' context, '-' old, '+' new. `noeol` when a `\` line follows it. */
interface BodyLine {
  k: string;
  t: string;
  noeol: boolean;
}const oldOf = (items: BodyLine[]): string[] => items.filter((it) => it.k !== '+').map((it) => it.t);
const newOf = (items: BodyLine[]): string[] => items.filter((it) => it.k !== '-').map((it) => it.t);

/** Re-indent one new line at tier 2 (SPEC section 5). */
function reindent(line: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/** N for a match at pos: context lines as the file's own, '+' lines re-indented at tier 2. */
function buildNew(fl: string[], pos: number, items: BodyLine[], tier: number): string[] {
  const o = oldOf(items);
  const f = o.length > 0 ? leadWs(fl[pos]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.k === '+') {
      out.push(reindent(it.t, tier, f, p));
    } else {
      if (it.k === ' ') out.push(fl[pos + oi]!);
      oi += 1;
    }
  }
  return out;
}

/** N for a plain old/new pair (SEARCH/REPLACE): every new line re-indented at tier 2. */
function buildNewPlain(o: string[], n: string[], fl: string[], pos: number, tier: number): string[] {
  const f = leadWs(fl[pos]!);
  const p = leadWs(o[0]!);
  return n.map((l) => reindent(l, tier, f, p));
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

/** One unified hunk: its old start line and its body lines. */
interface Hunk {
  a: number;
  items: BodyLine[];
}
interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  gitOld: string | null;
  gitNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const diffGitPaths = (l: string): [string, string] | null => {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
  return m === null ? null : [m[1]!, m[2]!];
};
const hunkHead = (l: string): number | null => {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  return m === null ? null : Number(m[1]);
};
/** Path after `--- `/`+++ `: up to the first tab, surrounding spaces removed, a/ or b/ stripped. */
const dashPath = (l: string): string | null => {
  const raw = l.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
};

/** Parse a unified patch into edits (SPEC section 6). */
function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;
  let seenHunk = false;
  const startSection = (gitOld: string | null, gitNew: string | null, pairOld?: string | null, pairNew?: string | null): void => {
    cur = { pairOld, pairNew, gitOld, gitNew, renFrom: null, renTo: null, create: false, remove: false, hunks: [] };
    secs.push(cur);
    hunk = null;
    seenHunk = false;
  };
  const closeHunk = (): void => {
    if (hunk !== null) {
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.k === ' ' && last.t === '') hunk.items.pop();
        else break;
      }
      hunk = null;
    }
  };
  const isPairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (hunk !== null) {
      if (l.startsWith('diff --git ')) {
        closeHunk();
        const g = diffGitPaths(l);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(g[0], g[1]);
        i += 1;
        continue;
      }
      if (isPairAt(i)) {
        closeHunk();
        startSection(null, null, dashPath(l), dashPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        if (l[0] === '\\') {
          const last = hunk.items[hunk.items.length - 1];
          if (last !== undefined) last.noeol = true;
        } else if (l === '') hunk.items.push({ k: ' ', t: '', noeol: false });
        else hunk.items.push({ k: l[0]!, t: l.slice(1), noeol: false });
        i += 1;
        continue;
      }
      closeHunk();
      continue; // reprocess this line outside the body
    }
    if (l.startsWith('diff --git ')) {
      const g = diffGitPaths(l);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(g[0], g[1]);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || seenHunk || cur.pairOld !== undefined) startSection(null, null, dashPath(l), dashPath(lines[i + 1]!));
      else {
        cur.pairOld = dashPath(l);
        cur.pairNew = dashPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (!seenHunk) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('rename from ')) {
      cur.renFrom = l.slice(12).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      cur.renTo = l.slice(10).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      cur.create = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      cur.remove = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = hunkHead(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a, items: [] };
      cur.hunks.push(hunk);
      seenHunk = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  closeHunk();
  return secs.map((s) => unifiedEdit(s, strict, moves));
}

/** Apply a section's hunks to a file's lines (SPEC section 6). */
function applyHunks(f: LineFile, hunks: Hunk[], strict: boolean, path: string): LineFile {
  let lines = f.lines.slice();
  let fin = f.fin;
  let d = 0;
  for (const h of hunks) {
    const o = oldOf(h.items);
    const n = newOf(h.items);
    if (o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...n, ...lines.slice(pos)];
      if (atEnd) {
        let lastPlus: BodyLine | undefined;
        for (const it of h.items) if (it.k === '+') lastPlus = it;
        fin = lastPlus === undefined ? true : !lastPlus.noeol;
      }
    } else {
      const found = findTier(lines, o, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const atEnd = pos + o.length === lines.length;
      const repl = buildNew(lines, pos, h.items, found.tier);
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + o.length)];
      if (atEnd) {
        let last: BodyLine | undefined;
        for (const it of h.items) if (it.k === ' ' || it.k === '+') last = it;
        fin = last === undefined ? true : !last.noeol;
      }
    }
    d += n.length - o.length;
  }
  return { br: f.br, lines, fin };
}

function unifiedEdit(s: Section, strict: boolean, moves: [string, string][]): Edit {
  // ---/+++ pair wins, then rename, then diff --git.
  const oldP = s.pairOld !== undefined ? s.pairOld : (s.renFrom ?? s.gitOld);
  const newP = s.pairNew !== undefined ? s.pairNew : (s.renTo ?? s.gitNew);
  const create = s.create || oldP === null;
  const remove = !create && (s.remove || newP === null);
  const move = !create && !remove && oldP !== null && newP !== null && oldP !== newP;
  const path = move || remove ? oldP! : create ? newP! : oldP!;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    if (create) {
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const ls: string[] = [];
      let fin = true;
      for (const h of s.hunks) {
        for (const it of h.items) {
          if (it.k === '+') {
            ls.push(it.t);
            fin = !it.noeol;
          }
        }
      }
      tree.now.set(newP!, ls.length === 0 ? '' : ls.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (remove) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    const cur = tree.get(oldP!);
    if (cur === null) throw new Fail('missing', oldP!);
    if (move && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const out = applyHunks(parseFile(cur), s.hunks, strict, oldP!);
    const text = renderFile(out);
    if (move) {
      tree.now.set(newP!, text);
      tree.now.set(oldP!, null);
      moves.push([oldP!, newP!]);
    } else {
      tree.now.set(oldP!, text);
    }
  };
}

/** Parse SEARCH/REPLACE blocks into edits (SPEC section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldL = lines.slice(s + 1, eq);
    const newL = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldL.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newL.length === 0 ? '' : newL.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = parseFile(cur);
      const found = findTier(f.lines, oldL, strict, 0, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const repl = buildNewPlain(oldL, newL, f.lines, pos, found.tier);
      const out = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + oldL.length)];
      tree.now.set(p, renderFile({ br: f.br, lines: out, fin: f.fin }));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: optional anchor, EOF flag, body lines. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyLine[];
}

/** Parse a V4A patch into edits (SPEC section 8). */
function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const addP = '*** Add File: ';
  const delP = '*** Delete File: ';
  const updP = '*** Update File: ';
  const isHead = (l: string): boolean => l.startsWith(addP) || l.startsWith(delP) || l.startsWith(updP);
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isHead(l)) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i;
    const kind = l.startsWith(addP) ? 'add' : l.startsWith(delP) ? 'del' : 'upd';
    const path = l.slice(kind === 'add' ? addP.length : kind === 'del' ? delP.length : updP.length).trim();
    i += 1;
    const raw: { t: string; n: number }[] = [];
    while (i < last && !isHead(lines[i]!)) {
      raw.push({ t: lines[i]!, n: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
    if (kind === 'add') {
      const fl: string[] = [];
      for (const r of raw) {
        if (r.t === '') fl.push('');
        else if (r.t[0] === '+') fl.push(r.t.slice(1));
        else throw new Exit2(`error: parse ${r.n}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      });
      continue;
    }
    if (kind === 'del') {
      for (const r of raw) {
        if (!blank(r.t)) throw new Exit2(`error: parse ${r.n}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    // Update: optional Move to first, then chunks.
    let moveTo: string | null = null;
    let j = 0;
    if (j < raw.length && raw[j]!.t.startsWith('*** Move to: ')) {
      moveTo = raw[j]!.t.slice(13).trim();
      j += 1;
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    for (; j < raw.length; j++) {
      const r = raw[j]!;
      const t = r.t;
      if (t.startsWith('@@')) {
        chunk = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), eof: false, items: [] };
        chunks.push(chunk);
      } else if (t === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${r.n}`);
        chunk.eof = true;
        chunk = null;
      } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
        if (chunk === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${r.n}`);
          chunk = { anchor: null, eof: false, items: [] };
          chunks.push(chunk);
        }
        if (t === '') chunk.items.push({ k: ' ', t: '', noeol: false });
        else chunk.items.push({ k: t[0]!, t: t.slice(1), noeol: false });
      } else {
        throw new Exit2(`error: parse ${r.n}`);
      }
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine + 1}`);
    const p = path;
    const mv = moveTo;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
      const f = parseFile(cur);
      let ls = f.lines.slice();
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          let at = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            for (let k = cursor; k < ls.length; k++) {
              if (normLine(ls[k]!, t) === normLine(ch.anchor, t)) {
                at = k;
                break;
              }
            }
            if (at >= 0) break;
          }
          if (at < 0) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const o = oldOf(ch.items);
        if (o.length === 0) {
          const n = newOf(ch.items);
          const pos = ch.eof ? ls.length : cursor;
          ls = [...ls.slice(0, pos), ...n, ...ls.slice(pos)];
          cursor = pos + n.length;
        } else {
          const found = findTier(ls, o, strict, cursor, ch.eof);
          if (found === null) throw new Fail('no-match', p);
          const pos = found.occ[0]!;
          const repl = buildNew(ls, pos, ch.items, found.tier);
          ls = [...ls.slice(0, pos), ...repl, ...ls.slice(pos + o.length)];
          cursor = pos + repl.length;
        }
      }
      const text = renderFile({ br: f.br, lines: ls, fin: f.fin });
      if (mv !== null) {
        tree.now.set(mv, text);
        tree.now.set(p, null);
        moves.push([p, mv]);
      } else {
        tree.now.set(p, text);
      }
    });
  }
  return edits;
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
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
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
  const rows: { key: string; text: string }[] = [];
  const paired = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      paired.add(oldP);
      paired.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
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
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
