/**
 * Minimal XML utilities for the WebDAV surface. Workers have no DOMParser,
 * so PROPFIND/PROPPATCH bodies are handled with a small namespace-aware
 * scanner: a well-formedness validator (litmus expects 400 for broken
 * bodies) plus element extraction that yields self-contained markup and
 * `{namespace}local` expanded names.
 */

/** A parsed element occurrence inside a `<prop>` block. */
export interface PropElement {
  /** Expanded name: `{namespace}local` (namespace "" = no namespace). */
  key: string;
  /** Local (unprefixed) name. */
  local: string;
  /** Original markup, made self-contained (declares every prefix it uses). */
  markup: string;
}

const DECL_RE = /\sxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** xmlns declarations inside an attribute string (prefix → uri; "" = default). */
export function declsIn(attrs: string): Map<string, string> {
  const decls = new Map<string, string>();
  DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECL_RE.exec(attrs)) !== null) {
    decls.set(m[1] ?? '', m[2] ?? m[3] ?? '');
  }
  return decls;
}

/** All xmlns declarations in a body, last occurrence wins. */
export function collectXmlScope(body: string): Map<string, string> {
  return declsIn(body);
}

/**
 * Rewrite `markup` so every namespace binding it relies on is declared
 * inside it: a `<prop>` result must stay valid when re-emitted under our
 * own response root, wherever the client declared the prefix.
 */
export function selfContain(markup: string, scope: Map<string, string>): string {
  const start = /^<([^\s/>]+)((?:[^>/"']|"[^"]*"|'[^']*')*)(\/?)>/.exec(markup);
  if (!start) return markup;
  const qname = start[1] ?? '';
  const attrs = start[2] ?? '';
  const decls = declsIn(attrs);
  const add: string[] = [];

  // Attribute-value escaping for a namespace URI the client may have written
  // with single quotes (`xmlns:p='urn:a"b"'`): interpolating it raw breaks
  // the quote pairing, and on the PROPPATCH path that malformed markup is
  // STORED and re-emitted by every later PROPFIND.
  const attr = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  // Every prefix used anywhere in the markup (elements and attributes).
  const used = new Set<string>();
  for (const m of markup.matchAll(/[<\s]([A-Za-z_][\w.-]*):/g)) {
    const pfx = m[1];
    if (pfx && pfx !== 'xmlns') used.add(pfx);
  }
  for (const pfx of used) {
    if (decls.has(pfx)) continue;
    const uri = scope.get(pfx);
    if (uri !== undefined && uri !== '') add.push(` xmlns:${pfx}="${attr(uri)}"`);
  }
  // Unprefixed root element relies on the default namespace in effect.
  if (!qname.includes(':') && !decls.has('')) {
    const uri = scope.get('');
    if (uri) add.push(` xmlns="${attr(uri)}"`);
  }
  if (add.length === 0) return markup;
  const end = start[0].length;
  // Insert before the '>' — and before the '/' of a self-closing tag, so
  // the markup stays valid (`<X:foo xmlns:X="..."/>`, never `/ ...>`).
  const insertAt = end - 1 - (start[3] === '/' ? 1 : 0);
  return markup.slice(0, insertAt) + add.join('') + markup.slice(insertAt);
}

/** Expanded-name lookup for one element start tag. */
export function resolveNs(
  qname: string,
  decls: Map<string, string>,
  scope: Map<string, string>,
): string {
  const idx = qname.indexOf(':');
  if (idx === -1) return decls.get('') ?? scope.get('') ?? '';
  const pfx = qname.slice(0, idx);
  return decls.get(pfx) ?? scope.get(pfx) ?? '';
}

/**
 * XML well-formedness + namespace validity check: matching (and correctly
 * prefixed) close tags, single root, declared prefixes, no empty prefix
 * bindings (`xmlns:p=""` is illegal; `xmlns=""` merely undeclares).
 * Returns an error reason, or null when the body is acceptable.
 */
export function validateXml(body: string): string | null {
  const tagStack: string[] = [];
  const scopeStack: Array<Map<string, string>> = [new Map()];
  let roots = 0;
  let i = 0;
  const n = body.length;

  // A raw `&` must open a well-formed entity reference; anything else makes
  // the document not XML (strict parsers reject it before we re-emit props).
  // Numeric references are checked against the legal character range too —
  // `&#0;` is shape-valid but must not survive into a property we store and
  // then re-emit in every later PROPFIND. Scan with a sticky regex on the
  // ORIGINAL string — slicing per `&` was O(n²) on entity-heavy bodies.
  const entityRe = /&(?:amp|lt|gt|apos|quot|#\d+|#x[0-9A-Fa-f]+);/y;
  const validChar = (code: number): boolean =>
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
  /**
   * @param bracketsContent false when `text` is a tag interior rather than
   * character data: `]]>` is banned only in content (XML 1.0 §2.4) and stays
   * legal inside a quoted attribute value (`<X:foo a="x]]>y">`).
   */
  const ampProblem = (text: string, bracketsContent = true): string | null => {
    let idx = text.indexOf('&');
    while (idx !== -1) {
      entityRe.lastIndex = idx;
      const m = entityRe.exec(text);
      if (!m) return 'bare & entity';
      const ref = m[0];
      if (ref[1] === '#') {
        const code = ref[2] === 'x' || ref[2] === 'X' ? parseInt(ref.slice(3), 16) : parseInt(ref.slice(2), 10);
        if (!validChar(code)) return 'invalid character reference';
      }
      idx = text.indexOf('&', idx + 1);
    }
    // `]]>` is banned in character data outside CDATA (XML 1.0 §2.4), and we
    // echo property text verbatim — accepting it makes OUR response unparseable.
    if (bracketsContent && text.includes(']]>')) return ']]> in character data';
    return null;
  };

  // Raw characters must satisfy the XML 1.0 §2.2 Char production too.
  // Numeric references were checked above, but a literal NUL/C0 control in a
  // PROPPATCH or LOCK body used to sail through, get STORED, and re-appear
  // raw in every later PROPFIND 207 — strict clients (rclone, libxml2/
  // gvfs, litmus) then fail the whole listing: a persistent, client-caused
  // browse DoS with no workaround. Surrogate pairs are checked as pairs so
  // astral-plane characters stay legal.
  for (let j = 0; j < n; ) {
    const code = body.charCodeAt(j);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = j + 1 < n ? body.charCodeAt(j + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return 'invalid character';
      j += 2;
      continue;
    }
    if (!validChar(code)) return 'invalid character';
    j += 1;
  }

  while (i < n) {
    const lt = body.indexOf('<', i);
    if (lt === -1) {
      // trailing text is fine, but not a bare '&' or a stray ']]>'
      const err = ampProblem(body.slice(i));
      if (err) return err;
      break;
    }
    const textErr = ampProblem(body.slice(i, lt));
    if (textErr) return textErr;
    if (body.startsWith('<!--', lt)) {
      const e = body.indexOf('-->', lt + 4);
      if (e === -1) return 'unterminated comment';
      const content = body.slice(lt + 4, e);
      // XML 1.0 §2.5: no `--` inside a comment, and it may not end in `-`.
      if (content.includes('--')) return '-- inside comment';
      if (content.endsWith('-')) return 'comment ends in -';
      i = e + 3;
      continue;
    }
    if (body.startsWith('<![CDATA[', lt)) {
      const e = body.indexOf(']]>', lt + 9);
      if (e === -1) return 'unterminated CDATA section';
      i = e + 3;
      continue;
    }
    if (body.startsWith('<?', lt)) {
      const e = body.indexOf('?>', lt + 2);
      if (e === -1) return 'unterminated processing instruction';
      i = e + 2;
      continue;
    }
    if (body.startsWith('<!', lt)) {
      const e = body.indexOf('>', lt + 2);
      if (e === -1) return 'unterminated declaration';
      i = e + 1;
      continue;
    }
    // Element: scan to '>' honoring quotes (a stray '<' inside is a parse
    // error; an unclosed quote swallows the rest and fails later).
    let j = lt + 1;
    let quote = '';
    while (j < n) {
      const c = body[j];
      if (quote) {
        // XML 1.0 §3.1: '<' MUST NOT appear in an attribute value — only
        // '&lt;'. Letting it through means we store/echo the attribute
        // verbatim and the client (and everyone reading a later PROPFIND)
        // gets an unparseable response.
        if (c === '<') return 'unescaped < in attribute value';
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '<') {
        return 'unbalanced markup';
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= n) return 'unterminated tag';
    const raw = body.slice(lt + 1, j);
    // Inside a tag the only legal '&' is in an attribute value, and there it
    // must still be an entity reference.
    const tagErr = ampProblem(raw, false);
    if (tagErr) return tagErr;
    i = j + 1;

    if (raw.startsWith('/')) {
      const qname = raw.slice(1).trim();
      if (tagStack.length === 0) return 'unmatched closing tag';
      if (tagStack.pop() !== qname) return 'mismatched closing tag';
      scopeStack.pop();
      continue;
    }

    const selfClose = raw.endsWith('/');
    const inner = selfClose ? raw.slice(0, -1) : raw;
    const nameMatch = /^\s*([^\s/>]+)/.exec(inner);
    if (!nameMatch) return 'invalid element name';
    const qname = nameMatch[1] ?? '';
    if (!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(qname)) {
      return 'invalid element name';
    }

    const parentScope = scopeStack[scopeStack.length - 1] ?? new Map<string, string>();
    const decls = declsIn(inner);
    for (const [pfx, uri] of decls) {
      if (pfx !== '' && uri === '') return 'empty namespace binding';
    }
    // A prefixed name must resolve; unprefixed elements/attributes are
    // legal in no namespace.
    const checkPrefix = (name: string): string | null => {
      const idx = name.indexOf(':');
      if (idx === -1) return null;
      const pfx = name.slice(0, idx);
      if (pfx === 'xmlns') return null;
      const uri = decls.get(pfx) ?? parentScope.get(pfx);
      return uri === undefined ? `undeclared prefix "${pfx}"` : null;
    };
    const bad = checkPrefix(qname);
    if (bad) return bad;
    const attrRe = /([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*=/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(inner)) !== null) {
      const attrBad = checkPrefix(am[1] ?? '');
      if (attrBad) return attrBad;
    }

    if (tagStack.length === 0) {
      roots++;
      if (roots > 1) return 'multiple root elements';
    }
    if (!selfClose) {
      tagStack.push(qname);
      const scope = new Map(parentScope);
      for (const [pfx, uri] of decls) scope.set(pfx, uri);
      scopeStack.push(scope);
    }
  }
  if (tagStack.length > 0) return 'unclosed elements';
  return null;
}

/**
 * Extract the top-level elements of an XML fragment (typically the inside
 * of a `<prop>` block) with expanded names and self-contained markup.
 * The fragment must already be validated.
 */
/**
 * Comments, CDATA, PIs and declarations are not elements: a flat tag scan
 * over them invents properties (`<!-- <D:displayname/> -->` would answer for
 * a prop the client never asked for, and inside a PROPPATCH <D:prop> would
 * silently CREATE a dead one). Returns the index just past the construct,
 * or `at` when there is nothing to skip.
 */
function skipConstruct(text: string, at: number): number {
  if (text.startsWith('<!--', at)) {
    const e = text.indexOf('-->', at + 4);
    return e === -1 ? text.length : e + 3;
  }
  if (text.startsWith('<![CDATA[', at)) {
    const e = text.indexOf(']]>', at + 9);
    return e === -1 ? text.length : e + 3;
  }
  if (text.startsWith('<?', at)) {
    const e = text.indexOf('?>', at + 2);
    return e === -1 ? text.length : e + 2;
  }
  if (text.startsWith('<!', at)) {
    const e = text.indexOf('>', at + 2);
    return e === -1 ? text.length : e + 1;
  }
  return at;
}

/**
 * Length (measured from `from`) of the run ending at the close tag of the
 * container whose start tag ended at `from`, or -1 if it never closes.
 * Skip-aware — close markup spelled inside a comment or CDATA section is
 * not a close tag — metachar-escaped (a dotted qname must not bind to
 * `</AXB:prop>`) and depth-counted (a nested `<X:g>…</X:g>` must not end
 * the outer container early, which would emit truncated markup that no
 * later 207 can parse).
 */
function findContainerEnd(text: string, from: number, qname: string): number {
  const esc = qname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagRe = new RegExp(`</?${esc}(?:\\s[^>]*)?/?>`, 'y');
  let cursor = from;
  let depth = 1;
  while (cursor < text.length) {
    const lt = text.indexOf('<', cursor);
    if (lt === -1) return -1;
    const skipped = skipConstruct(text, lt);
    if (skipped > lt) {
      cursor = skipped;
      continue;
    }
    tagRe.lastIndex = lt;
    const m = tagRe.exec(text);
    if (!m) {
      cursor = lt + 1;
      continue;
    }
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return lt + m[0].length - from;
    } else if (!m[0].endsWith('/>')) {
      depth += 1;
    }
    cursor = lt + m[0].length;
  }
  return -1;
}

export function parsePropElements(fragment: string, scope: Map<string, string>): PropElement[] {
  const out: PropElement[] = [];
  const nameRe = /^\s*([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/;

  let cursor = 0;
  while (cursor < fragment.length) {
    const lt = fragment.indexOf('<', cursor);
    if (lt === -1) break;
    const afterSkip = skipConstruct(fragment, lt);
    if (afterSkip > lt) {
      cursor = afterSkip;
      continue;
    }
    // Quote-aware scan to the tag's real '>' — an attribute value may legally
    // hold '>' (`a="x]]>y"`), which a `[^\s>]*`-style scan cuts through and
    // then echoes truncated markup into the response.
    let j = lt + 1;
    let quote = '';
    while (j < fragment.length) {
      const c = fragment[j]!;
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= fragment.length) break; // unterminated: validated upstream
    const raw = fragment.slice(lt + 1, j);
    cursor = j + 1;
    if (raw.startsWith('/')) continue; // close tag: not a property
    const selfClose = raw.endsWith('/');
    const inner = selfClose ? raw.slice(0, -1) : raw;
    const nm = nameRe.exec(inner);
    if (!nm) continue;
    const qname = nm[1]!;
    let markup = fragment.slice(lt, j + 1);
    if (!selfClose) {
      // Container element: consume through its close tag so nested tags
      // are not mistaken for separate properties.
      const end = findContainerEnd(fragment, cursor, qname);
      if (end > 0) {
        markup = fragment.slice(lt, cursor + end);
        cursor += end;
      }
    }
    const decls = declsIn(inner.slice(nm[0].length));
    const colon = qname.indexOf(':');
    const local = colon === -1 ? qname : qname.slice(colon + 1);
    const ns = resolveNs(qname, decls, scope);
    out.push({ key: `{${ns}}${local}`, local, markup: selfContain(markup, scope) });
  }
  return out;
}
