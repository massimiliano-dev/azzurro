/**
 * Parser/valutatore OData minimale per $filter e $orderby, usato sia da
 * Microsoft Graph (applications, users, ...) sia da ARM ($filter su risorse,
 * roleAssignments, activity log).
 */
import { HttpError } from './errors.ts';

export type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'path'; p: string[] }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'not'; e: Node }
  | { t: 'in'; e: Node; list: Node[] }
  | { t: 'lambda'; path: string[]; kind: 'any' | 'all'; v: string; body: Node | null };

type Tok = { k: 'id' | 'str' | 'num' | 'lit' | 'p'; v: any };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw bad('Unterminated string literal');
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ k: 'str', v: s });
      continue;
    }
    if ('(),/:'.includes(ch)) { out.push({ k: 'p', v: ch }); i++; continue; }
    const rest = src.slice(i);
    const guid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.exec(rest);
    if (guid) { out.push({ k: 'lit', v: guid[0] }); i += guid[0].length; continue; }
    const dt = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?/.exec(rest);
    if (dt && dt[0].length > 4) { out.push({ k: 'lit', v: dt[0] }); i += dt[0].length; continue; }
    const num = /^-?\d+(\.\d+)?/.exec(rest);
    if (num) { out.push({ k: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_@$][A-Za-z0-9_.@$#-]*/.exec(rest);
    if (id) { out.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    throw bad(`Unexpected character '${ch}' in filter`);
  }
  return out;
}

function bad(msg: string): HttpError {
  return new HttpError(400, 'BadRequest', `Invalid filter clause: ${msg}`);
}

const CMP = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);

export function parseFilter(src: string): Node {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const isId = (v: string) => peek()?.k === 'id' && peek().v.toLowerCase() === v;
  const expectP = (v: string) => {
    if (peek()?.k !== 'p' || peek().v !== v) throw bad(`expected '${v}'`);
    pos++;
  };

  function parseOr(): Node {
    let l = parseAnd();
    while (isId('or')) { pos++; l = { t: 'bin', op: 'or', l, r: parseAnd() }; }
    return l;
  }
  function parseAnd(): Node {
    let l = parseNot();
    while (isId('and')) { pos++; l = { t: 'bin', op: 'and', l, r: parseNot() }; }
    return l;
  }
  function parseNot(): Node {
    if (isId('not')) { pos++; return { t: 'not', e: parseNot() }; }
    return parseCmp();
  }
  function parseCmp(): Node {
    const l = parsePrimary();
    const p = peek();
    if (p?.k === 'id' && CMP.has(p.v.toLowerCase())) {
      pos++;
      return { t: 'bin', op: p.v.toLowerCase(), l, r: parsePrimary() };
    }
    if (isId('in')) {
      pos++;
      expectP('(');
      const list: Node[] = [];
      while (!(peek()?.k === 'p' && peek().v === ')')) {
        list.push(parsePrimary());
        if (peek()?.k === 'p' && peek().v === ',') pos++;
      }
      expectP(')');
      return { t: 'in', e: l, list };
    }
    return l;
  }
  function parsePrimary(): Node {
    const tok = toks[pos++];
    if (!tok) throw bad('unexpected end');
    if (tok.k === 'p' && tok.v === '(') {
      const e = parseOr();
      expectP(')');
      return e;
    }
    if (tok.k === 'str' || tok.k === 'num' || tok.k === 'lit') return { t: 'lit', v: tok.v };
    if (tok.k === 'id') {
      const low = tok.v.toLowerCase();
      if (low === 'true') return { t: 'lit', v: true };
      if (low === 'false') return { t: 'lit', v: false };
      if (low === 'null') return { t: 'lit', v: null };
      if (peek()?.k === 'p' && peek().v === '(') {
        pos++;
        const args: Node[] = [];
        while (!(peek()?.k === 'p' && peek().v === ')')) {
          args.push(parseOr());
          if (peek()?.k === 'p' && peek().v === ',') pos++;
          else if (!(peek()?.k === 'p' && peek().v === ')')) throw bad('expected , or )');
        }
        expectP(')');
        return { t: 'call', name: low, args };
      }
      const path = [tok.v];
      while (peek()?.k === 'p' && peek().v === '/') {
        pos++;
        const seg = toks[pos++];
        if (seg?.k !== 'id') throw bad('expected property after /');
        const sl = seg.v.toLowerCase();
        if ((sl === 'any' || sl === 'all') && peek()?.k === 'p' && peek().v === '(') {
          pos++;
          if (peek()?.k === 'p' && peek().v === ')') { pos++; return { t: 'lambda', path, kind: sl, v: '', body: null }; }
          const v = toks[pos++];
          if (v?.k !== 'id') throw bad('expected lambda variable');
          expectP(':');
          const body = parseOr();
          expectP(')');
          return { t: 'lambda', path, kind: sl, v: v.v, body };
        }
        path.push(seg.v);
      }
      return { t: 'path', p: path };
    }
    throw bad(`unexpected token ${tok.v}`);
  }

  const node = parseOr();
  if (pos < toks.length) throw bad(`unexpected token '${toks[pos].v}'`);
  return node;
}

export function getPathCI(obj: any, path: string[]): unknown {
  let cur = obj;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (seg in cur) { cur = cur[seg]; continue; }
    const low = seg.toLowerCase();
    const key = Object.keys(cur).find((k) => k.toLowerCase() === low);
    cur = key === undefined ? undefined : cur[key];
  }
  return cur;
}

export type FilterFunctions = Record<string, (args: unknown[], obj: any) => unknown>;

function norm(v: unknown): unknown {
  if (typeof v === 'string') return v.toLowerCase();
  return v;
}

function compare(op: string, a: unknown, b: unknown): boolean {
  const x = norm(a);
  const y = norm(b);
  switch (op) {
    case 'eq': return x === y || (x == null && y == null);
    case 'ne': return !(x === y || (x == null && y == null));
  }
  if (x == null || y == null) return false;
  const xs = typeof x === 'string' && typeof y === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x) ? Date.parse(x) : x;
  const ys = typeof x === 'string' && typeof y === 'string' && /^\d{4}-\d{2}-\d{2}/.test(y) ? Date.parse(y) : y;
  switch (op) {
    case 'gt': return (xs as any) > (ys as any);
    case 'ge': return (xs as any) >= (ys as any);
    case 'lt': return (xs as any) < (ys as any);
    case 'le': return (xs as any) <= (ys as any);
  }
  return false;
}

export function evaluate(node: Node, obj: any, fns: FilterFunctions = {}, vars: Record<string, unknown> = {}): unknown {
  switch (node.t) {
    case 'lit': return node.v;
    case 'path': {
      const [head, ...rest] = node.p;
      if (head in vars) return rest.length ? getPathCI(vars[head], rest) : vars[head];
      return getPathCI(obj, node.p);
    }
    case 'not': return !evaluate(node.e, obj, fns, vars);
    case 'in': {
      const v = norm(evaluate(node.e, obj, fns, vars));
      return node.list.some((n) => norm(evaluate(n, obj, fns, vars)) === v);
    }
    case 'bin': {
      if (node.op === 'and') return !!evaluate(node.l, obj, fns, vars) && !!evaluate(node.r, obj, fns, vars);
      if (node.op === 'or') return !!evaluate(node.l, obj, fns, vars) || !!evaluate(node.r, obj, fns, vars);
      return compare(node.op, evaluate(node.l, obj, fns, vars), evaluate(node.r, obj, fns, vars));
    }
    case 'lambda': {
      const [head, ...rest] = node.path;
      const coll = head in vars ? getPathCI(vars[head], rest) : getPathCI(obj, node.path);
      const arr = Array.isArray(coll) ? coll : [];
      if (!node.body) return arr.length > 0;
      const test = (item: unknown) => !!evaluate(node.body!, obj, fns, { ...vars, [node.v]: item });
      return node.kind === 'any' ? arr.some(test) : arr.every(test);
    }
    case 'call': {
      const custom = fns[node.name];
      const args = node.args.map((a) => evaluate(a, obj, fns, vars));
      if (custom) return custom(args, obj);
      const s = (i: number) => String(args[i] ?? '').toLowerCase();
      switch (node.name) {
        case 'startswith': return args[0] != null && s(0).startsWith(s(1));
        case 'endswith': return args[0] != null && s(0).endsWith(s(1));
        case 'contains':
          if (Array.isArray(args[0])) return args[0].some((x) => norm(x) === norm(args[1]));
          return args[0] != null && s(0).includes(s(1));
        case 'substringof': return args[1] != null && s(1).includes(s(0));
        case 'tolower': return s(0);
        case 'toupper': return String(args[0] ?? '').toUpperCase();
        case 'length': return Array.isArray(args[0]) ? args[0].length : String(args[0] ?? '').length;
      }
      throw bad(`unsupported function ${node.name}`);
    }
  }
}

export function applyFilter<T>(items: T[], filter: string | undefined | null, fns: FilterFunctions = {}): T[] {
  if (!filter || !filter.trim()) return items;
  const ast = parseFilter(filter);
  return items.filter((it) => !!evaluate(ast, it, fns));
}

export function applyOrderBy<T>(items: T[], orderby: string | undefined | null): T[] {
  if (!orderby) return items;
  const keys = orderby.split(',').map((p) => {
    const [field, dir] = p.trim().split(/\s+/);
    return { path: field.split('/'), desc: dir?.toLowerCase() === 'desc' };
  });
  return [...items].sort((a, b) => {
    for (const k of keys) {
      const x = getPathCI(a, k.path);
      const y = getPathCI(b, k.path);
      if (x === y) continue;
      if (x == null) return k.desc ? 1 : -1;
      if (y == null) return k.desc ? -1 : 1;
      const c = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y, undefined, { sensitivity: 'base' }) : (x as any) < (y as any) ? -1 : 1;
      if (c !== 0) return k.desc ? -c : c;
    }
    return 0;
  });
}

export function applySelect(obj: any, select: string | undefined | null, always: string[] = ['id']): any {
  if (!select) return obj;
  const fields = select.split(',').map((f) => f.trim()).filter(Boolean);
  const out: any = {};
  for (const k of Object.keys(obj)) if (k.startsWith('@odata')) out[k] = obj[k];
  for (const f of [...always, ...fields]) {
    const key = Object.keys(obj).find((k) => k.toLowerCase() === f.toLowerCase());
    if (key) out[key] = obj[key];
    else if (!(f in out)) out[f] = null;
  }
  return out;
}
