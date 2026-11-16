// parse.js — a fast CommonMark 0.31.2 + GFM renderer, byte-compatible with
// marked 18.1.3's defaults (GFM on, breaks off). Written from scratch for
// the markdown-render-speed competition: no dependencies, no marked code.
//
// Design: two passes over the document. The block pass splits the input
// into lines (columns are virtual: a tab advances to the next multiple of
// 4, and a tab straddling a cut becomes spaces), builds a small block
// tree and collects link reference definitions document-wide. The inline
// pass scans each paragraph's text once, building a flat node list with
// delimiter runs, links and code spans, then resolves emphasis with the
// CommonMark delimiter-stack algorithm and renders the tree.
//
// Speed notes: the hot path is inline scanning of long README paragraphs,
// so it is index-driven (no per-character regexes), text runs are
// accumulated in a plain string buffer, and emphasis processing works on
// short per-paragraph node arrays.

const PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
}

// Unicode whitespace (Zs) plus the ASCII set, for flanking decisions.
function isWs(ch) {
  if (!ch) return true; // beginning / end of line count as whitespace
  const c = ch.charCodeAt(0);
  if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c) return true;
  if (c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000) return true;
  return false;
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(ch) {
  if (!ch) return false;
  if (PUNCT.indexOf(ch) >= 0) return true;
  const c = ch.charCodeAt(0);
  // Common Unicode punctuation the documents use: dashes, quotes, ellipsis.
  if ((c >= 0x2000 && c <= 0x206f) || c === 0x00ab || c === 0x00bb || c === 0x00a1 || c === 0x00bf ||
      (c >= 0x2e00 && c <= 0x2e7f) || (c >= 0x3001 && c <= 0x303f) || c === 0x00b7) return true;
  // Spec: punctuation is ASCII punct + Unicode P or S (e.g. £ U+00A3 is Sc).
  if (c > 127) return PUNCT_RE.test(ch);
  return false;
}

// ASCII punctuation only. Backslash escapes in CommonMark only work
// before ASCII punctuation: a backslash before a non-ASCII punctuation
// character (e.g. \«) is literal.
function isPunctAscii(ch) {
  return !!ch && PUNCT.indexOf(ch) >= 0;
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isAlpha(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isAlnum(ch) {
  return isAlpha(ch) || isDigit(ch);
}

// Escape text for HTML content / attribute values, preserving things that
// already look like character references (&name; &#123; &#xAB;). This is
// what marked does for link destinations, titles and fence info strings.
const ENT_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/;
function escAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      const m = ENT_RE.exec(s.slice(i, i + 12));
      if (m && m.index === 0) { out += m[0]; i += m[0].length; continue; }
      out += '&amp;'; i++; continue;
    }
    if (ch === '<') { out += '&lt;'; i++; continue; }
    if (ch === '>') { out += '&gt;'; i++; continue; }
    if (ch === '"') { out += '&quot;'; i++; continue; }
    if (ch === "'") { out += '&#39;'; i++; continue; }
    out += ch; i++;
  }
  return out;
}

// Plain escape for code spans / code blocks: every & is escaped.
function escCode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// Escape one decoded character reference result for text output.
function escChar(ch) {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '"') return '&quot;';
  if (ch === "'") return '&#39;';
  return ch;
}

// Decode a character reference starting at s[i] === '&'. Returns
// {len, text} where text is the (already escaped) replacement, or null
// when there is no valid reference here. Named references pass through
// verbatim; numeric ones decode (0 and surrogates become U+FFFD, values
// above 0x10FFFF are not references at all).
function decodeEntity(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return null;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const ds = j;
    while (j < n && (hex ? /[0-9a-fA-F]/.test(s[j]) : isDigit(s[j]))) j++;
    if (j === ds || j >= n || s[j] !== ';') return null;
    const val = parseInt(s.slice(ds, j), hex ? 16 : 10);
    if (val > 0x10ffff) return null;
    let cp = val;
    if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return { len: j - i + 1, text: escChar(String.fromCodePoint(cp)) };
  }
  if (!isAlpha(s[j])) return null;
  while (j < n && isAlnum(s[j])) j++;
  if (j >= n || s[j] !== ';') return null;
  return { len: j - i + 1, text: s.slice(i, j + 1) };
}

// Percent-encode a link destination the way marked does: encodeURI, except
// a literal '%' is left alone (marked does not encode it); encodeURI turns
// '%' into '%25', so undo exactly that substitution afterwards.
function encodeHref(s) {
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch (e) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80 && /[A-Za-z0-9\-_.!~*'();\/?:@&=+$,#%]/.test(s[i])) out += s[i];
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out += '%' + ((cp >> 18) | 0xf0).toString(16).toUpperCase() +
            '%' + (((cp >> 12) & 0x3f) | 0x80).toString(16).toUpperCase() +
            '%' + (((cp >> 6) & 0x3f) | 0x80).toString(16).toUpperCase() +
            '%' + ((cp & 0x3f) | 0x80).toString(16).toUpperCase();
          i++;
        } else out += '%EF%BF%BD';
      } else if (c >= 0xdc00 && c <= 0xdfff) out += '%EF%BF%BD';
      else if (c < 0x80) out += '%' + c.toString(16).toUpperCase().padStart(2, '0');
      else if (c < 0x800) out += '%' + ((c >> 6) | 0xc0).toString(16).toUpperCase() + '%' + ((c & 0x3f) | 0x80).toString(16).toUpperCase();
      else out += '%' + ((c >> 12) | 0xe0).toString(16).toUpperCase() + '%' + (((c >> 6) & 0x3f) | 0x80).toString(16).toUpperCase() + '%' + ((c & 0x3f) | 0x80).toString(16).toUpperCase();
    }
    return out;
  }
}

function hrefOf(dest) {
  return escAttr(encodeHref(dest));
}

// Normalise a link label: trim, collapse internal whitespace, lowercase.
function normalizeLabel(s) {
  // Unicode case folding for label matching (CommonMark): ß/ẞ -> ss, ς -> σ.
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
    .replace(/\u00df/g, 'ss').replace(/\u1e9e/g, 'ss').replace(/\u03c2/g, '\u03c3');
}

// ---- line / column helpers (tabs advance to the next multiple of 4) ----

// Columns of leading whitespace in s, and the char index where it ends.
function leadIndent(s) {
  let col = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { col += 1; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { col, idx: i };
}

// Remove n virtual columns from the start of s. A tab straddling the cut
// becomes spaces for the remainder of the tab.
function stripCols(s, n) {
  if (n <= 0) return s;
  let col = 0;
  let i = 0;
  while (i < s.length && col < n) {
    const ch = s[i];
    if (ch === ' ') { col += 1; i++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else {
        // Tab straddles the cut: keep the unconsumed part as spaces.
        return ' '.repeat(col + w - n) + s.slice(i + 1);
      }
    } else break;
  }
  return s.slice(i);
}

// Remove n virtual columns from the start of s (s[0] is at absolute
// column col0), as when a container prefix is stripped. A tab straddling
// the cut becomes spaces, and the leading whitespace tabs that remain
// are expanded to spaces using their absolute columns: a tab's width is
// fixed by its column in the source line, so it survives container
// stripping (e.g. "-\t\tfoo" leaves a code block of "  foo", and
// ">\t\tfoo" a code block of "  foo"). Tabs after the first
// non-whitespace character are preserved untouched.
function cut(s, n, col0) {
  if (n <= 0) return s;
  let col = col0;
  let i = 0;
  let out = '';
  const target = col0 + n;
  while (i < s.length && col < target) {
    const ch = s[i];
    if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= target) { col += w; i++; }
      else { out += ' '.repeat(col + w - target); col += w; i++; }
    } else { col++; i++; }
  }
  // expand the leading whitespace tabs of the remainder
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) {
    if (s[j] === ' ') { out += ' '; col++; j++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; j++; }
  }
  return out + s.slice(j);
}

function leadingSpaces(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  return i;
}

function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

function trimRight(s) {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
  return s.slice(0, e);
}

// ---- block parsing ----

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

function matchAtx(s) {
  if (s.charCodeAt(0) !== 35) return null; // '#'
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 35) i++;
  if (i > 6) return null;
  if (i === s.length) return { level: i, text: '' };
  const c = s[i];
  if (c !== ' ' && c !== '\t') return null;
  let text = s.slice(i).trim();
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+$/, '');
  return { level: i, text };
}

function matchHr(s) {
  let i = 0;
  let ch = '';
  let count = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (ch === '') {
      if (c !== '*' && c !== '-' && c !== '_') return false;
      ch = c; count = 1; i++; continue;
    }
    if (c !== ch) return false;
    count++; i++;
  }
  return count >= 3;
}

function matchSetext(s) {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i >= s.length) return 0;
  const ch = s[i];
  if (ch !== '=' && ch !== '-') return 0;
  let j = i;
  while (j < s.length && s[j] === ch) j++;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  if (j !== s.length) return 0;
  return ch === '=' ? 1 : 2;
}

function matchFence(s) {
  const c0 = s.charCodeAt(0);
  if (c0 !== 96 && c0 !== 126) return null; // ` ~
  const ch = s[0];
  let i = 0;
  while (i < s.length && s[i] === ch) i++;
  if (i < 3) return null;
  const info = trimRight(s.slice(i)).trim();
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  return { ch, len: i, info };
}

function isClosingFence(s, fence) {
  let i = 0;
  while (i < s.length && s[i] === fence.ch) i++;
  if (i < fence.len) return false;
  while (i < s.length) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
    i++;
  }
  return true;
}

// Match an HTML tag starting at s[0]; returns its end index, or -1.
function matchHtmlTag(s) {
  let i = 0;
  if (s[i] !== '<') return -1;
  i++;
  let close = false;
  if (s[i] === '/') { close = true; i++; }
  if (i >= s.length || !isAlpha(s[i])) return -1;
  while (i < s.length && (isAlnum(s[i]) || s[i] === '-')) i++;
  if (close) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
    return s[i] === '>' ? i + 1 : -1;
  }
  while (i < s.length) {
    const c = s[i];
    if (c === '>') return i + 1;
    if (c === '/' && s[i + 1] === '>') return i + 2;
    if (c !== ' ' && c !== '\t' && c !== '\n') return -1;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
    if (i >= s.length) return -1;
    if (s[i] === '>' || (s[i] === '/' && s[i + 1] === '>')) continue;
    // attribute name (must follow whitespace)
    if (!(isAlpha(s[i]) || s[i] === '_' || s[i] === ':')) return -1;
    while (i < s.length && (isAlnum(s[i]) || s[i] === '_' || s[i] === ':' || s[i] === '.' || s[i] === '-')) i++;
    const afterName = i;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
    if (s[i] === '=') {
      i++;
      while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i];
        i++;
        while (i < s.length && s[i] !== q) i++;
        if (i >= s.length) return -1;
        i++;
      } else {
        if (i >= s.length) return -1;
        const vs = i;
        while (i < s.length && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '\n' && s[i] !== '"' && s[i] !== "'" && s[i] !== '=' && s[i] !== '<' && s[i] !== '>' && s[i] !== '`') i++;
        if (i === vs) return -1;
      }
    } else {
      // Boolean attribute: rewind to the whitespace so the loop top sees
      // the separator before the next attribute or delimiter.
      i = afterName;
    }
  }
  return -1;
}

// HTML block start: returns the type (1-7) or 0.
function matchHtmlStart(s) {
  if (s.charCodeAt(0) !== 60) return 0; // '<'
  const low = s.toLowerCase();
  if (low.startsWith('<script') || low.startsWith('<pre') || low.startsWith('<style') || low.startsWith('<textarea')) {
    const endIdx = low.startsWith('<script') ? 7 : low.startsWith('<textarea') ? 9 : low.startsWith('<pre') ? 4 : 6;
    const c = low.charAt(endIdx);
    if (c === '' || c === ' ' || c === '\t' || c === '>' || c === '\n') return 1;
  }
  if (low.startsWith('<!--')) return 2;
  if (low.startsWith('<?')) return 3;
  if (low.startsWith('<![cdata[')) return 5;
  if (s.startsWith('<!') && s.length > 2 && isAlpha(s[2])) return 4;
  // type 6: block tag
  let i = 1;
  let close = false;
  if (s[i] === '/') { close = true; i++; }
  let j = i;
  while (j < s.length && (isAlnum(s[j]) || s[j] === '-')) j++;
  const name = s.slice(i, j).toLowerCase();
  if (name && BLOCK_TAGS.has(name)) {
    const c = s[j];
    if (c === undefined || c === ' ' || c === '\t' || c === '>' || c === '/' || c === '\n') return 6;
  }
  // type 7: a complete tag and nothing else on the line
  const end = matchHtmlTag(s);
  if (end > 0 && trimRight(s.slice(end)) === '') return 7;
  return 0;
}

function matchListMarker(s, baseCol) {
  // s is the line after leading whitespace; baseCol is that whitespace's width.
  let ordered = false;
  let bullet = '';
  let delim = '';
  let start = 0;
  let mw = 0; // marker width in columns
  const c0 = s[0];
  if (c0 === '-' || c0 === '*' || c0 === '+') {
    bullet = c0; mw = 1;
  } else if (isDigit(c0)) {
    let i = 0;
    while (i < s.length && isDigit(s[i])) i++;
    if (i > 9 || i === 0) return null;
    const d = s[i];
    if (d !== '.' && d !== ')') return null;
    ordered = true; delim = d; start = parseInt(s.slice(0, i), 10); mw = i + 1;
  } else return null;
  // whitespace after the marker, measured in columns
  let col = baseCol + mw;
  let j = mw;
  let w = 0;
  let hasTab = false;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) {
    if (s[j] === ' ') { w += 1; col += 1; j++; }
    else { const adv = 4 - (col % 4); w += adv; col += adv; j++; hasTab = true; }
  }
  const empty = j >= s.length;
  if (!empty && w === 0) return null; // marker not followed by space
  let contentIndent;
  if (empty) contentIndent = baseCol + mw + 1;
  // A tab in the whitespace after the marker counts as a single column
  // for the content indent (so "-\ta" and "-\t\tfoo" both get indent 2);
  // five or more columns of whitespace do the same.
  else if (hasTab || w >= 5) contentIndent = baseCol + mw + 1;
  else contentIndent = baseCol + mw + w;
  return { ordered, bullet, delim, start, contentIndent };
}

function stripQuote(line) {
  const ind = leadIndent(line);
  if (ind.col > 3) return null;
  const s = line.slice(ind.idx);
  if (s.charCodeAt(0) !== 62) return null; // '>'
  // The prefix is the leading whitespace, '>', and one more column when
  // the next character is a space or tab (a tab is only partly consumed).
  const after = s[1];
  const n = (after === ' ' || after === '\t') ? ind.col + 2 : ind.col + 1;
  return cut(line, n, 0);
}

// ---- link reference definitions ----

// Scan a label starting at text[i] === '['. Returns {label, end} (end is
// the index just past ']') or null.
function scanLabel(text, i) {
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isPunctAscii(text[j + 1])) { j += 2; continue; }
    // An unescaped [ inside a label voids it (no nesting in labels).
    if (c === '[') return null;
    if (c === ']') {
      const raw = text.slice(i + 1, j);
      if (raw.length > 999) return null;
      return { label: raw, end: j + 1 };
    }
    j++;
  }
  return null;
}

function unescapeText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isPunctAscii(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// Parse a link destination starting at text[i]. Returns {dest, end} or null.
// end is the index just past the destination.
function parseDest(text, i) {
  const n = text.length;
  if (text[i] === '<') {
    let j = i + 1;
    while (j < n) {
      const c = text[j];
      if (c === '>') return { dest: unescapeText(text.slice(i + 1, j)), end: j + 1 };
      if (c === '<' || c === '\n' || c.charCodeAt(0) < 0x20 || c === '\x7f') return null;
      if (c === '\\' && j + 1 < n && isPunctAscii(text[j + 1])) { j += 2; continue; }
      j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isPunctAscii(text[j + 1])) { j += 2; continue; }
    if (c === '(') { depth++; j++; continue; }
    if (c === ')') { if (depth === 0) break; depth--; j++; continue; }
    if (isSpace(c) || c.charCodeAt(0) < 0x20 || c === '\x7f') break;
    j++;
  }
  if (j === i) return null;
  return { dest: unescapeText(text.slice(i, j)), end: j };
}

// Parse a link title starting at text[i] ('"' or '\'' or '(').
// Returns {title, end} or null.
function parseTitle(text, i) {
  const n = text.length;
  const q = text[i];
  const close = q === '(' ? ')' : q;
  let j = i + 1;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isPunctAscii(text[j + 1])) { j += 2; continue; }
    if (c === close) return { title: unescapeText(text.slice(i + 1, j)), end: j + 1 };
    j++;
  }
  return null;
}

// Skip whitespace with at most one newline. Returns the new index, or -1
// if two newlines (a blank line) were crossed.
function skipWs1(text, i) {
  const n = text.length;
  let nl = 0;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '\n') { nl++; if (nl > 1) return -1; i++; continue; }
    break;
  }
  return i;
}

// Try to parse one reference definition at text[pos] (start of a line).
// Returns {end, label, dest, title} with end at the '\n' (or end of text)
// after the definition, or null.
function parseOneRefDef(text, pos) {
  const n = text.length;
  let i = pos;
  // up to 3 spaces of indentation
  let ind = 0;
  while (i < n && text[i] === ' ' && ind < 3) { ind++; i++; }
  if (i < n && text[i] === '\t') return null;
  if (i >= n || text[i] !== '[') return null;
  const lab = scanLabel(text, i);
  if (!lab) return null;
  // Labels are matched literally (no backslash unescaping for matching).
  const label = normalizeLabel(lab.label);
  if (label === '') return null;
  i = lab.end;
  if (i >= n || text[i] !== ':') return null;
  i++;
  i = skipWs1(text, i);
  if (i < 0) return null;
  const d = parseDest(text, i);
  if (!d) return null;
  i = d.end;
  // Optional title: on the same line (then it must end the line, or the
  // definition fails), or on the next line (then a title that does not end
  // its line is simply not taken, and the definition stands without it).
  let title = null;
  let k = i;
  while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
  // A same-line title must be separated from the destination by whitespace.
  if (k > i && k < n && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    const t = parseTitle(text, k);
    if (!t) return null;
    let e = t.end;
    while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
    if (e < n && text[e] !== '\n') return null;
    title = t.title;
    i = e;
  } else if (k < n && text[k] === '\n') {
    let k2 = k + 1;
    // A next-line title may be indented by any amount.
    while (k2 < n && (text[k2] === ' ' || text[k2] === '\t')) k2++;
    if (k2 < n && (text[k2] === '"' || text[k2] === "'" || text[k2] === '(')) {
      const t = parseTitle(text, k2);
      if (t) {
        let e = t.end;
        while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
        if (e >= n || text[e] === '\n') { title = t.title; i = e; }
      }
    }
    if (title === null) i = k;
  } else {
    i = k;
  }
  // after the definition: only spaces/tabs, then a line end or end of text
  while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  if (i < n && text[i] !== '\n') return null;
  return { end: i, label, dest: d.dest, title };
}

// Strip leading reference definitions from text, adding them to refs.
// Returns the offset of the remaining text.
function stripRefDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    const d = parseOneRefDef(text, pos);
    if (!d) break;
    if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
    pos = d.end;
    if (pos < n && text[pos] === '\n') pos++;
    else break;
  }
  return pos;
}

// Whether the paragraph lines so far contain any non-definition text.
function hasNonDefContent(plines, refs) {
  const tmp = new Map();
  const pos = stripRefDefs(plines.join('\n'), tmp);
  return plines.join('\n').slice(pos).trim() !== '';
}

// ---- block tree ----

function interruptsParagraph(s, indCol, inListItem) {
  if (matchAtx(s)) return true;
  if (matchFence(s)) return true;
  if (matchHr(s)) return true;
  const ht = matchHtmlStart(s);
  if (ht >= 1 && ht <= 6) return true;
  if (s.charCodeAt(0) === 62) return true; // '>'
  const m = matchListMarker(s, indCol);
  if (m) {
    // An empty list item cannot interrupt a paragraph.
    let j = 0;
    if (!m.ordered) j = 1;
    else { while (j < s.length && isDigit(s[j])) j++; j++; }
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (j >= s.length) return false;
    if (!m.ordered) return true;
    // Inside a list item any ordered start interrupts; at the top
    // level only a list starting with 1 does.
    if (inListItem) return true;
    if (m.start === 1) return true;
  }
  return false;
}

// Could this line be a paragraph continuation line (for lazy continuation)?
function isParaLine(line) {
  if (isBlank(line)) return false;
  const ind = leadIndent(line);
  if (ind.col >= 4) return true; // indented code cannot interrupt a paragraph
  const s = line.slice(ind.idx);
  if (matchAtx(s)) return false;
  if (matchFence(s)) return false;
  if (matchHr(s)) return false;
  const ht = matchHtmlStart(s);
  if (ht >= 1 && ht <= 6) return false;
  if (s.charCodeAt(0) === 62) return false;
  if (matchListMarker(s, ind.col)) return false;
  if (matchSetext(s)) return false;
  if (isDelimiterRow(s)) return false;
  return true;
}

// Strip one layer of blockquote/list container from the start of s,
// returning the inner content, or null if s does not start a container.
function stripOneContainer(s) {
  const q = stripQuote(s);
  if (q !== null) return q;
  const ind = leadIndent(s);
  if (ind.col > 3) return null;
  const ss = s.slice(ind.idx);
  const lm = matchListMarker(ss, ind.col);
  if (!lm) return null;
  return cut(s, lm.contentIndent, 0);
}

// The innermost content of a (possibly nested-container) line.
function innermostLine(line) {
  let s = line;
  for (;;) {
    const inner = stripOneContainer(s);
    if (inner === null) break;
    s = inner;
  }
  return s;
}

// Is a paragraph open after this (possibly nested-container) line?
// Sees through nested blockquotes and list markers to the innermost line.
function paraOpenAfter(line, paraOpen) {
  return classifyParaLine(innermostLine(line), paraOpen);
}

// Whether a line may continue a paragraph as a lazy continuation inside
// a blockquote: not a blank line, not a hard block start (ATX, fence,
// thematic break, HTML block, table delimiter, list marker). A setext
// underline IS allowed (it becomes paragraph text).
function isLazyLine(line) {
  if (isParaLine(line)) return true;
  if (isBlank(line)) return false;
  const ind = leadIndent(line);
  if (ind.col >= 4) return false;
  const s = line.slice(ind.idx);
  if (matchSetext(s) && !matchHr(s)) return true;
  return false;
}

// Is a paragraph open after this line, given whether one was open before it?
function classifyParaLine(line, paraOpen) {
  if (isBlank(line)) return false;
  const ind = leadIndent(line);
  if (ind.col >= 4) return paraOpen;
  return isParaLine(line);
}

function splitTableRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  // drop empty edge cells from a leading / trailing pipe
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

function isDelimiterRow(line) {
  if (line.indexOf('|') < 0) return false;
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return false;
  }
  return true;
}

function parseBlocks(lines, refs, inListItem, inContainer, docEndsNL, lazy) {
  const out = [];
  let i = 0;
  const n = lines.length;
  // blankSep: a blank line separated two blocks at this level (used for
  // a list item's loose/tight call; blank lines inside a paragraph do
  // not count, because parseParagraph consumes them).
  let sawBlank = false;
  let blankSep = false;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { sawBlank = true; i++; continue; }
    if (sawBlank && out.length > 0) blankSep = true;
    sawBlank = false;
    const ind = leadIndent(line);
    if (ind.col >= 4) {
      // indented code block
      const clines = [];
      let j = i;
      let pending = [];
      while (j < n) {
        const l2 = lines[j];
        if (isBlank(l2)) { pending.push(stripCols(l2, 4)); j++; continue; }
        const ind2 = leadIndent(l2);
        if (ind2.col >= 4) {
          if (pending.length) { clines.push(...pending); pending = []; }
          clines.push(stripCols(l2, 4));
          j++;
          continue;
        }
        break;
      }
      out.push({ t: 'code', info: '', text: clines.join('\n') + '\n', fenced: false });
      i = j;
      continue;
    }
    const s = line.slice(ind.idx);
    const atx = matchAtx(s);
    if (atx) { out.push({ t: 'head', level: atx.level, text: atx.text }); i++; continue; }
    const fence = matchFence(s);
    if (fence) {
      const clines = [];
      let j = i + 1;
      while (j < n) {
        const l2 = lines[j];
        const ind2 = leadIndent(l2);
        if (ind2.col <= 3 && isClosingFence(l2.slice(ind2.idx), fence)) { j++; break; }
        clines.push(stripCols(l2, ind.col));
        j++;
      }
      out.push({ t: 'code', info: fence.info, text: clines.length ? clines.join('\n') + (clines[clines.length - 1] === '' ? '' : '\n') : '', fenced: true });
      i = j;
      continue;
    }
    if (matchHr(s)) { out.push({ t: 'hr' }); i++; continue; }
    const ht = matchHtmlStart(s);
    if (ht) {
      const blines = [line];
      let j = i + 1;
      let endedByBlank = false;
      if (ht === 1) {
        const tag = s.toLowerCase().startsWith('<script') ? 'script' : s.toLowerCase().startsWith('<textarea') ? 'textarea' : s.toLowerCase().startsWith('<style') ? 'style' : 'pre';
        const endRe = new RegExp('</' + tag + '\\s*>', 'i');
        if (!endRe.test(line)) {
          while (j < n) {
            blines.push(lines[j]);
            if (endRe.test(lines[j])) { j++; break; }
            j++;
          }
        }
      } else if (ht === 2) {
        if (line.indexOf('-->') < 0) {
          while (j < n) {
            blines.push(lines[j]);
            if (lines[j].indexOf('-->') >= 0) { j++; break; }
            j++;
          }
        }
      } else if (ht === 3) {
        if (line.indexOf('?>') < 0) {
          while (j < n) {
            blines.push(lines[j]);
            if (lines[j].indexOf('?>') >= 0) { j++; break; }
            j++;
          }
        }
      } else if (ht === 4) {
        if (line.indexOf('>') < 0) {
          while (j < n) {
            blines.push(lines[j]);
            if (lines[j].indexOf('>') >= 0) { j++; break; }
            j++;
          }
        }
      } else if (ht === 5) {
        if (line.indexOf(']]>') < 0) {
          while (j < n) {
            blines.push(lines[j]);
            if (lines[j].indexOf(']]>') >= 0) { j++; break; }
            j++;
          }
        }
      } else {
        // types 6 and 7 run to a blank line
        while (j < n && !isBlank(lines[j])) { blines.push(lines[j]); j++; }
        if (j < n) endedByBlank = true;
      }
      let trailingNL;
      if (ht >= 6) trailingNL = !endedByBlank;
      // A whitespace-only line after the block still leaves a trailing
      // newline in marked's output; only a truly empty line suppresses
      // it ("<!--...-->\n \nBar" keeps "\n" after "-->", while
      // "<!--...-->\n\nBar" does not).
      else trailingNL = j >= n || lines[j].length > 0;
      // Inside a blockquote/list item, an HTML block that runs to the end
      // of the container's lines carries no trailing newline (marked).
      if (inContainer && j >= n) trailingNL = false;
      // At the top level, a block running to the end of the document gets
      // a trailing newline only if the document itself ends with one.
      if (!inContainer && j >= n) trailingNL = !!docEndsNL;
      out.push({ t: 'html', text: blines.join('\n') + (trailingNL ? '\n' : '') });
      i = j;
      continue;
    }
    const q = stripQuote(line);
    if (q !== null) {
      const qlines = [q];
      // Indices of qlines that are lazy continuations: they must not
      // interrupt the paragraph they continue when the quote's content
      // is re-parsed. A line that was itself lazy in the outer context
      // stays lazy inside the quote.
      const qlazy = new Set();
      if (lazy && lazy.has(i)) qlazy.add(0);
      let j = i + 1;
      let paraOpen = paraOpenAfter(q, false);
      // Fence state inside the quote: code-block content lines are not
      // paragraph lines, so they must not leave paraOpen true (a lazy
      // line after a code block does not continue the quote).
      let inFence = null;
      const fq = matchFence(q);
      if (fq) { inFence = fq; paraOpen = false; }
      while (j < n) {
        const l2 = lines[j];
        const q2 = stripQuote(l2);
        if (q2 !== null) {
          qlines.push(q2);
          if (lazy && lazy.has(j)) qlazy.add(qlines.length - 1);
          if (inFence) {
            if (isClosingFence(q2, inFence)) inFence = null;
            paraOpen = false;
          } else {
            const fq2 = matchFence(q2);
            if (fq2) { inFence = fq2; paraOpen = false; }
            else paraOpen = paraOpenAfter(q2, paraOpen);
          }
          j++;
          continue;
        }
        // A truly blank line (no > marker) ends the blockquote.
        if (isBlank(l2)) break;
        // Lazy continuation: only while a paragraph is open.
        if (paraOpen && isLazyLine(l2)) {
          // A setext underline as a lazy line becomes paragraph text,
          // indented 4 so it is not read as a heading underline.
          if (matchSetext(l2) && !matchHr(l2)) {
            qlines.push('    ' + l2);
          } else if (leadIndent(l2).col >= 4) {
            // A lazy line indented 4+ loses exactly 4 columns.
            qlines.push(stripCols(l2, 4));
          } else {
            qlines.push(l2);
          }
          qlazy.add(qlines.length - 1);
          j++;
          continue;
        }
        break;
      }
      out.push({ t: 'quote', children: parseBlocks(qlines, refs, false, true, undefined, qlazy).blocks });
      i = j;
      continue;
    }
    const lm = matchListMarker(s, ind.col);
    if (lm) {
      const res = parseList(lines, i, lm, refs, lazy);
      out.push(res.node);
      i = res.next;
      continue;
    }
    // paragraph (with setext heading / table / reference definitions)
    // The first line of a list item's paragraph loses its leading
    // whitespace (a tab after the marker leaves partial spaces).
    const firstStrip = (inListItem && i === 0) ? leadingSpaces(line) : 0;
    const res = parseParagraph(lines, i, refs, inListItem, firstStrip, lazy, docEndsNL);
    if (res.node) out.push(res.node);
    i = res.next;
  }
  return { blocks: out, blankSep };
}

// Strip the continuation indent of a paragraph line inside a list item:
// the amount the item's first line lost, plus four more columns when
// the line is indented by four or more after that.
function paraContStrip(line, firstStrip) {
  // A lazy continuation line was kept verbatim, so its leading tabs
  // still need expanding to spaces (absolute columns) first.
  let s = line;
  if (s.indexOf('\t') >= 0) {
    let col = 0, i = 0, out = '';
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
      if (s[i] === ' ') { out += ' '; col++; i++; }
      else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    }
    s = out + s.slice(i);
  }
  const lead = leadingSpaces(s);
  if (lead < firstStrip) return s;
  let strip = firstStrip + (lead - firstStrip >= 4 ? 4 : 0);
  if (strip > lead) strip = lead;
  return s.slice(strip);
}

function parseParagraph(lines, i, refs, inListItem, firstStrip, lazy, docEndsNL) {
  const plines = [];
  let j = i;
  const n = lines.length;
  let setext = 0;
  // Indent of the last non-blank line collected (raw, before the
  // continuation strip): a blank line inside a list item does not break
  // the paragraph when that line and the next line are both indented
  // by four or more.
  let lastRawIndent = 0;
  while (j < n) {
    const raw = lines[j];
    if (isBlank(raw)) {
      // A tab-only line inside a table is a row of empty cells, not a
      // blank line: marked's table-body check only excludes space-only
      // lines ( *\n ), so a line of tabs is a table row.
      if (plines.length >= 2 && isDelimiterRow(plines[1]) && raw.indexOf('\t') >= 0) {
        plines.push(raw);
        lastRawIndent = raw.length;
        j++;
        continue;
      }
      // A trailing space-only line continues the paragraph when the
      // content does not end with a newline: marked's paragraph regex
      // only excludes a space-only line when a newline follows it
      // (cm-241: ">  " leaves a single space as the last line of the
      // quote's content, and it is paragraph text, not a blank line).
      if (plines.length > 0 && raw.length > 0 && j === n - 1 && !docEndsNL) {
        plines.push(inListItem ? paraContStrip(raw, firstStrip) : raw);
        lastRawIndent = raw.length;
        j++;
        continue;
      }
      if (inListItem && plines.length > 0 && lastRawIndent >= 4) {
        let k = j;
        while (k < n && isBlank(lines[k])) k++;
        if (k < n && leadIndent(lines[k]).col >= 4 && isParaLine(lines[k])) {
          while (j < k) { plines.push(''); j++; }
          continue;
        }
      }
      break;
    }
    const ind = leadIndent(raw);
    // Text of this line in the paragraph. Inside a list item the first
    // line loses its leading whitespace and continuation lines lose the
    // same amount plus four more columns when indented by four or more.
    let line = raw;
    if (inListItem) {
      if (plines.length === 0) {
        if (firstStrip > 0) line = raw.slice(firstStrip);
      } else {
        line = paraContStrip(raw, firstStrip);
      }
    }
    // A lazy continuation line (consumed as a paragraph continuation by
    // an outer blockquote or list item) is paragraph text: it cannot
    // start a new block, a setext heading, or interrupt the paragraph.
    if (lazy && lazy.has(j)) { plines.push(line); lastRawIndent = ind.col; j++; continue; }
    if (ind.col >= 4) { plines.push(line); lastRawIndent = ind.col; j++; continue; }
    const s = raw.slice(ind.idx);
    const st = matchSetext(s);
    if (st && plines.length > 0) {
      if (hasNonDefContent(plines, refs)) { setext = st; j++; break; }
      break;
    }
    if (plines.length > 0 && interruptsParagraph(s, ind.col, inListItem)) break;
    plines.push(line);
    lastRawIndent = ind.col;
    j++;
  }
  if (plines.length === 0) return { node: null, next: j };
  const joined = plines.join('\n');
  const pos = stripRefDefs(joined, refs);
  const text = joined.slice(pos);
  if (setext) {
    const htext = text.split('\n').map((l) => trimRight(l)).join('\n').trim();
    return { node: { t: 'head', level: setext, text: htext }, next: j };
  }
  if (text.trim() === '') return { node: null, next: j };
  const tlines = text.split('\n');
  if (tlines.length >= 2 && isDelimiterRow(tlines[1])) {
    const header = splitTableRow(tlines[0]);
    const aligns = splitTableRow(tlines[1]).map((c) => {
      const left = c.startsWith(':');
      const right = c.endsWith(':');
      if (left && right) return 'center';
      if (left) return 'left';
      if (right) return 'right';
      return null;
    });
    // GFM: the delimiter row must have exactly as many cells as the header.
    if (aligns.length !== header.length) return { node: { t: 'para', text }, next: j };
    const ncol = header.length;
    const rows = [];
    for (let r = 2; r < tlines.length; r++) {
      const cells = splitTableRow(tlines[r]);
      while (cells.length < ncol) cells.push('');
      rows.push(cells.slice(0, ncol));
    }
    return { node: { t: 'table', aligns, header, rows }, next: j };
  }
  return { node: { t: 'para', text }, next: j };
}

function parseList(lines, i, first, refs, lazy) {
  const n = lines.length;
  // Collect the span of lines belonging to this list. A line belongs to the
  // current item when indented by at least the item's content indent; a
  // list marker at a lower indent starts a new item of the same list.
  let end = i + 1;
  let pendingBlanks = 0;
  let blanksBetweenItems = false;
  let curIndent = first.contentIndent;
  // Whether the current item has any non-blank content. An empty item
  // followed by a blank line is closed: following indented content is
  // not part of it.
  let curHasContent = cut(lines[i], first.contentIndent, 0).trim() !== '';
  let paraOpen = paraOpenAfter(cut(lines[i], first.contentIndent, 0), false);
  // End of the span after the last non-blank line: trailing blank lines
  // are not part of the list, so the outer parser still sees them as
  // separators (which makes the list loose when they fall between blocks).
  let lastNonBlankEnd = i + 1;
  while (end < n) {
    const line = lines[end];
    if (isBlank(line)) { pendingBlanks++; paraOpen = false; end++; continue; }
    const ind = leadIndent(line);
    if (ind.col >= curIndent) {
      // An empty item closed by a blank line does not take indented content.
      if (pendingBlanks > 0 && !curHasContent) break;
      pendingBlanks = 0; curHasContent = true; paraOpen = paraOpenAfter(cut(line, curIndent, 0), paraOpen); end++; lastNonBlankEnd = end; continue;
    }
    if (ind.col <= 3) {
      // A thematic break ends the list; it is not a list item.
      if (matchHr(line.slice(ind.idx))) break;
      const m = matchListMarker(line.slice(ind.idx), ind.col);
      if (m && m.ordered === first.ordered && (m.ordered ? m.delim === first.delim : m.bullet === first.bullet)) {
        if (pendingBlanks > 0) blanksBetweenItems = true;
        pendingBlanks = 0;
        curIndent = m.contentIndent;
        curHasContent = cut(line, m.contentIndent, 0).trim() !== '';
        paraOpen = paraOpenAfter(cut(line, m.contentIndent, 0), false);
        end++;
        lastNonBlankEnd = end;
        continue;
      }
    }
    // lazy continuation: while a paragraph is open and no blank line is
    // pending, the line belongs to the item whatever its indent (an
    // indented line cannot interrupt a paragraph, e.g. "   - foo" then
    // "\tbar" is a continuation, not a code block).
    if (pendingBlanks === 0 && paraOpen && isLazyLine(line)) { end++; lastNonBlankEnd = end; continue; }
    break;
  }
  // Rewind past trailing blank lines so they are not swallowed by the list.
  if (pendingBlanks > 0) end = lastNonBlankEnd;
  // Split the span into items, each with its own content indent.
  const items = [];
  let cur = null;
  let curBlanks = 0;
  for (let k = i; k < end; k++) {
    const line = lines[k];
    const ind = leadIndent(line);
    let isItemStart = false;
    let m = null;
    if (!isBlank(line) && ind.col <= 3) {
      m = matchListMarker(line.slice(ind.idx), ind.col);
      if (m && m.ordered === first.ordered && (m.ordered ? m.delim === first.delim : m.bullet === first.bullet)) {
        // an item marker indented by the current item's content indent is
        // a nested list, not a new item of this list
        if (!cur || ind.col < cur.contentIndent) isItemStart = true;
      }
    }
    if (isItemStart) {
      if (cur) items.push(cur);
      // The first line's content: cut the marker plus its whitespace.
      // cut() (unlike stripCols) removes non-whitespace too, which is
      // what stops the item from re-entering parseList unchanged.
      cur = { lines: [cut(line, m.contentIndent, 0)], contentIndent: m.contentIndent, lazy: new Set() };
      if (lazy && lazy.has(k)) cur.lazy.add(0);
      curBlanks = 0;
      continue;
    }
    if (!cur) continue;
    if (isBlank(line)) { curBlanks++; cur.lines.push(''); continue; }
    curBlanks = 0;
    if (ind.col >= cur.contentIndent) {
      cur.lines.push(cut(line, cur.contentIndent, 0));
      if (lazy && lazy.has(k)) cur.lazy.add(cur.lines.length - 1);
    } else {
      cur.lines.push(line); // lazy continuation line, kept verbatim
      cur.lazy.add(cur.lines.length - 1);
    }
  }
  if (cur) items.push(cur);
  // Parse each item's content first: loose is decided by the blocks,
  // not the raw lines, because a blank line inside a paragraph (both
  // sides indented by four or more) does not separate two blocks.
  const parsed = items.map((it) => {
    const pb = parseBlocks(it.lines, refs, true, true, undefined, it.lazy);
    return { blocks: pb.blocks, blankSep: pb.blankSep };
  });
  let loose = blanksBetweenItems;
  if (!loose) {
    for (const it of parsed) if (it.blankSep) { loose = true; break; }
  }
  const node = {
    t: 'list', ordered: first.ordered, start: first.start,
    tight: !loose,
    items: parsed.map((it) => ({ blocks: it.blocks })),
  };
  return { node, next: end };
}

// ---- rendering ----

function renderInlineText(text, refs) {
  return renderInline(text, refs);
}

function renderBlocks(nodes, refs, tight) {
  let out = '';
  for (const node of nodes) out += renderBlock(node, refs, tight);
  return out;
}

function renderBlock(node, refs, tight) {
  switch (node.t) {
    case 'para': {
      if (tight) return renderInline(node.text, refs);
      return '<p>' + renderInline(node.text, refs) + '</p>\n';
    }
    case 'head':
      return '<h' + node.level + '>' + renderInline(node.text, refs) + '</h' + node.level + '>\n';
    case 'code': {
      let lang = '';
      if (node.fenced && node.info) {
        // First word of the info string, with backslash escapes unescaped.
        const w = unescapeText(node.info.split(/[ \t]/, 1)[0]);
        if (w) lang = ' class="language-' + escAttr(w) + '"';
      }
      return '<pre><code' + lang + '>' + escCode(node.text) + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'hr':
      return '<hr>\n';
    case 'quote':
      return '<blockquote>\n' + renderBlocks(node.children, refs, false) + '</blockquote>\n';
    case 'list': {
      let out = node.ordered
        ? (node.start !== 1 ? '<ol start="' + node.start + '">\n' : '<ol>\n')
        : '<ul>\n';
      for (const item of node.items) out += renderListItem(item, node, refs);
      out += node.ordered ? '</ol>\n' : '</ul>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < node.header.length; c++) {
        const a = node.aligns[c];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(node.header[c], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let c = 0; c < row.length; c++) {
            const a = node.aligns[c];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(row[c], refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
  }
  return '';
}

function renderListItem(item, list, refs) {
  // Task list item: first block a paragraph starting with [ ] / [x] / [X].
  let checkbox = '';
  let blocks = item.blocks;
  if (blocks.length && blocks[0].t === 'para') {
    const p = blocks[0];
    const m = /^\[( |x|X)\]([ \t]|$)/.exec(p.text);
    if (m) {
      checkbox = m[1] === ' ' ? '<input disabled="" type="checkbox">' : '<input checked="" disabled="" type="checkbox">';
      const rest = p.text.slice(3);
      blocks = [{ t: 'para', text: rest }].concat(blocks.slice(1));
    }
  }
  let inner = '';
  for (let b = 0; b < blocks.length; b++) {
    const blk = blocks[b];
    if (b === 0 && checkbox) {
      if (blk.t === 'para') {
        inner += list.tight
          ? checkbox + renderInline(blk.text, refs)
          : '<p>' + checkbox + renderInline(blk.text, refs) + '</p>\n';
        continue;
      }
    }
    inner += renderBlock(blk, refs, list.tight);
  }
  return '<li>' + inner + '</li>\n';
}

// ---- inline parsing ----

const EMAIL_LOCAL = "!#$%&'*+/=?^_`{|}~-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function isEmailLocal(ch) {
  return EMAIL_LOCAL.indexOf(ch) >= 0;
}

// Strip trailing punctuation / unbalanced ')' / entity-like ';' from an
// extended autolink, per the GFM rules.
function stripAutolinkTail(match) {
  if (match.endsWith(';')) {
    const amp = match.lastIndexOf('&', match.length - 2);
    if (amp >= 0) {
      const ent = match.slice(amp + 1, match.length - 1);
      if (/^[A-Za-z0-9]+$/.test(ent)) match = match.slice(0, amp);
    }
  }
  const P = '? ! . , : ; * _ ~';
  while (match.length && P.indexOf(match[match.length - 1]) >= 0) match = match.slice(0, -1);
  // Paren balance is left to backpedalAutolink (it matches balanced
  // (...) groups and treats a stray ')' as punctuation). Counting every
  // ')' here miscounts a literal ')' inside the URL (e.g. the ')' in
  // "...page=4)](./docs/create.md)") and strips the group's closer.
  while (match.length && P.indexOf(match[match.length - 1]) >= 0) match = match.slice(0, -1);
  return match;
}

// marked's GFM autolink backpedal: trims a raw URL match to the longest
// prefix made of non-punctuation runs and balanced (...) groups. This
// stops a URL before an unclosable '(' (e.g. "...io)](https://...)" ends
// at "...io)]"), which stripAutolinkTail alone does not do.
const AUTOLINK_BACKPEDAL = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedalAutolink(match) {
  let prev;
  do {
    prev = match;
    const m = AUTOLINK_BACKPEDAL.exec(match);
    match = m ? m[0] : '';
  } while (match !== prev);
  return match;
}

function tryWww(s, i) {
  if (!s.startsWith('www.', i)) return null;
  let j = i + 4;
  let labels = 0;
  while (true) {
    const ls = j;
    while (j < s.length && (isAlnum(s[j]) || s[j] === '-')) j++;
    if (j === ls) break;
    labels++;
    if (s[j] === '.') { j++; continue; }
    break;
  }
  if (labels === 0) return null;
  let k = j;
  while (k < s.length && !isSpace(s[k]) && s[k] !== '<' && s[k] !== '>') k++;
  let match = backpedalAutolink(stripAutolinkTail(s.slice(i, k)));
  if (match.length <= 4) return null;
  return { text: match, end: i + match.length, href: 'http://' + match };
}

function tryScheme(s, i, openUnderscore) {
  let j = i;
  while (j < s.length && (isAlnum(s[j]) || s[j] === '+' || s[j] === '-' || s[j] === '.')) j++;
  const len = j - i;
  if (len < 2 || len > 32 || s[j] !== ':') return null;
  const scheme = s.slice(i, j).toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'ftp') {
    if (s[j + 1] !== '/' || s[j + 2] !== '/') return null;
    let k = j + 3;
    while (k < s.length && !isSpace(s[k]) && s[k] !== '<' && s[k] !== '>') k++;
    if (k === j + 3) return null;
    const match = backpedalAutolink(stripAutolinkTail(s.slice(i, k)));
    if (match.length <= scheme.length + 3) return null;
    return { text: match, end: i + match.length, href: match };
  }
  if (scheme === 'mailto') {
    const em = tryEmail(s, j + 1, openUnderscore);
    if (!em) return null;
    const match = s.slice(i, em.end);
    return { text: match, end: em.end, href: match };
  }
  if (scheme === 'xmpp') {
    const em = tryEmail(s, j + 1, openUnderscore);
    if (!em) return null;
    let k = em.end;
    // marked's GFM url: xmpp:email optionally followed by ONE /[A-Za-z0-9@.]+ segment
    if (s[k] === '/') {
      let p = k + 1;
      while (p < s.length && (isAlnum(s[p]) || s[p] === '@' || s[p] === '.')) p++;
      if (p > k + 1) k = p;
    }
    const match = s.slice(i, k);
    return { text: match, end: k, href: match };
  }
  return null;
}

// Bare-email local part per marked's GFM url regex:
//   [A-Za-z0-9._+-]+ @ [A-Za-z0-9-_]+ ( . [A-Za-z0-9-_]* [A-Za-z0-9] )+ (?![\w-])
function isBareEmailLocal(ch) {
  return isAlnum(ch) || ch === '.' || ch === '_' || ch === '+' || ch === '-';
}

function tryEmail(s, i, openUnderscore) {
  let k = i;
  while (k < s.length && isBareEmailLocal(s[k])) k++;
  if (k === i) return null;
  if (k >= s.length || s[k] !== '@') return null;
  k++;
  // first domain label: [A-Za-z0-9-_]+
  let ds = k;
  while (k < s.length && (isAlnum(s[k]) || s[k] === '-' || s[k] === '_')) k++;
  if (k === ds) return null;
  // at least one .label group; each label ends with an alnum
  let groups = 0;
  while (k < s.length && s[k] === '.' && k + 1 < s.length) {
    let j = k + 1;
    while (j < s.length && (isAlnum(s[j]) || s[j] === '-' || s[j] === '_')) j++;
    let e = j;
    while (e > k + 1 && (s[e - 1] === '-' || s[e - 1] === '_')) e--;
    if (e === k + 1) break;
    k = e;
    groups++;
  }
  if (groups < 1) return null;
  // (?![\w-]): a trailing - or _ (or alnum) voids the autolink entirely,
  // EXCEPT a run of two or more '_' is an emphasis delimiter (the closing
  // __ of a strong span), and a single trailing '_' is one too when an
  // unmatched '_' opener stands before the email (the closing '_' of an
  // "_...email..._" span). The raw string still holds the delimiter, but
  // the email ends before it.
  if (k < s.length && (isAlnum(s[k]) || s[k] === '_' || s[k] === '-')) {
    if (s[k] === '_') {
      let r = k;
      while (r < s.length && s[r] === '_') r++;
      if (r - k >= 2 || openUnderscore) { /* delimiter run: allow */ }
      else return null;
    } else return null;
  }
  const match = s.slice(i, k);
  return { text: match, end: k, href: 'mailto:' + match };
}

// An angle-bracket autolink <...> starting at s[i] === '<'.
function tryAngleAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j < n && isAlpha(s[j])) {
    // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
    let k = j + 1;
    while (k < n && (isAlnum(s[k]) || s[k] === '+' || s[k] === '-' || s[k] === '.')) k++;
    if (k - j >= 2 && k - j <= 32 && s[k] === ':') {
      let e = k + 1;
      while (e < n && s[e] !== '>' && !isSpace(s[e]) && s[e].charCodeAt(0) >= 0x20 && s[e] !== '<') e++;
      if (e > k + 1 && s[e] === '>') {
        const url = s.slice(i + 1, e);
        return { href: url, label: escAttr(url), end: e + 1 };
      }
    }
  }
  // email
  let k = i + 1;
  while (k < n && isEmailLocal(s[k])) k++;
  if (k > i + 1 && s[k] === '@') {
    let e = k + 1;
    let labels = 0;
    let lastEnd = e;
    while (true) {
      const ls = e;
      while (e < n && (isAlnum(s[e]) || s[e] === '-')) e++;
      while (e > ls && s[e - 1] === '-') e--;
      if (e === ls) break;
      labels++;
      lastEnd = e;
      if (s[e] === '.' && e + 1 < n && isAlnum(s[e + 1])) { e++; continue; }
      break;
    }
    if (labels >= 1 && s[lastEnd] === '>') {
      const email = s.slice(i + 1, lastEnd);
      return { href: 'mailto:' + email, label: escAttr(email), end: lastEnd + 1 };
    }
  }
  return null;
}

function parseInlineLink(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j < n && s[j] === ')') return { href: '', title: null, end: j + 1 };
  const d = parseDest(s, j);
  if (!d) return null;
  j = d.end;
  while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j < n && s[j] === ')') return { href: d.dest, title: null, end: j + 1 };
  if (j < n && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const t = parseTitle(s, j);
    if (!t) return null;
    j = t.end;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j < n && s[j] === ')') return { href: d.dest, title: t.title, end: j + 1 };
    return null;
  }
  return null;
}

function scanInline(s, refs) {
  const nodes = [];
  const stack = []; // {nodeIdx, img, active, srcIdx}
  let buf = '';
  const flush = () => { if (buf) { nodes.push({ t: 'txt', s: buf }); buf = ''; } };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i];
    // --- extended autolinks (www. / scheme / email) ---
    // Suppressed inside an active link label: a link cannot contain a
    // link, and marked tokenizes labels with inLink set, so a www/email
    // address inside [label](url) stays plain text. Without this the
    // autolink swallows the closing ] and the destination, and the link
    // never forms. Angle autolinks (<...>) are NOT suppressed.
    const inLabel = stack.length > 0 && stack[stack.length - 1].active;
    if (!inLabel && !docInLink && (ch === 'w' || isAlpha(ch) || isEmailLocal(ch))) {
      const prev = i > 0 ? s[i - 1] : '';
      if (i === 0 || isWs(prev) || isPunct(prev)) {
        let m = null;
        if (ch === 'w') m = tryWww(s, i);
        // Whether an unmatched '_' opener stands before this position
        // (a delimiter node that can open): a trailing '_' after an
        // email is then its closing delimiter, not a word character.
        let openUnderscore = false;
        for (const nd of nodes) if (nd.t === 'd' && nd.ch === '_' && nd.canOpen) { openUnderscore = true; break; }
        if (!m && isAlpha(ch)) m = tryScheme(s, i, openUnderscore);
        // An email is not attempted mid-word (prev char an email-local
        // char), but a delimiter just consumed as a token (e.g. the __
        // of __...__) is a token boundary, not part of the word: buf is
        // empty after the delimiter was flushed, so allow it there.
        // An email never starts with '__': that is a strong delimiter,
        // not part of the local part (a single leading '_' is).
        if (!m && isBareEmailLocal(ch) && !(ch === '_' && s[i + 1] === '_') &&
            (i === 0 || buf === '' || !isBareEmailLocal(s[i - 1]))) m = tryEmail(s, i, openUnderscore);
        if (m) {
          flush();
          nodes.push({ t: 'xlink', href: m.href, label: escAttr(m.text) });
          i = m.end;
          continue;
        }
      }
    }
    if (ch === '\n') {
      let sp = 0;
      let k = i - 1;
      while (k >= 0 && s[k] === ' ') { sp++; k--; }
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        nodes.push({ t: 'br' });
        i++;
        // A hard break strips the next line's leading whitespace.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < n && s[i + 1] === '\n') {
        flush(); nodes.push({ t: 'br' }); i += 2;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      }
      if (i + 1 < n && isPunctAscii(s[i + 1])) { buf += escChar(s[i + 1]); i += 2; continue; }
      buf += '\\'; i++; continue;
    }
    if (ch === '`') {
      let m = 0;
      while (i + m < n && s[i + m] === '`') m++;
      // find a run of exactly m backticks
      let j = i + m;
      let close = -1;
      while (j < n) {
        if (s[j] === '`') {
          let r = 0;
          while (j + r < n && s[j + r] === '`') r++;
          if (r === m) { close = j; break; }
          j += r;
          continue;
        }
        j++;
      }
      if (close < 0) { buf += '`'.repeat(m); i += m; continue; }
      let content = s.slice(i + m, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ t: 'code', s: content });
      i = close + m;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let m = 0;
      while (i + m < n && s[i + m] === ch) m++;
      // GFM strikethrough is 1-2 tildes only; a run of 3+ is literal text.
      if (ch === '~' && m > 2) { buf += '~'.repeat(m); i += m; continue; }
      const prev = i > 0 ? s[i - 1] : '';
      const next = i + m < n ? s[i + m] : '';
      const leftFlank = next !== '' && !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
      const rightFlank = prev !== '' && !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || isPunct(prev));
        canClose = rightFlank && (!leftFlank || isPunct(next));
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      flush();
      nodes.push({ t: 'd', ch, len: m, canOpen, canClose });
      i += m;
      continue;
    }
    if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const img = ch === '!';
      flush();
      nodes.push({ t: 'open', img, href: null, title: null });
      stack.push({ nodeIdx: nodes.length - 1, img, active: true, srcIdx: i });
      i += img ? 2 : 1;
      continue;
    }
    if (ch === ']') {
      if (stack.length === 0) { buf += ']'; i++; continue; }
      const top = stack[stack.length - 1];
      if (!top.active) { stack.pop(); buf += ']'; i++; continue; }
      const openerNode = nodes[top.nodeIdx];
      let formed = null;
      // A [label] after ] that parses syntactically blocks the shortcut
      // even when the label is undefined (cm-571); a failed inline link
      // does not block it (cm-568).
      let refLabelParsed = false;
      if (s[i + 1] === '(') formed = parseInlineLink(s, i + 1);
      if (!formed && s[i + 1] === '[') {
        const lab = scanLabel(s, i + 1);
        if (lab) {
          refLabelParsed = true;
          let label = normalizeLabel(lab.label);
          if (label === '') label = normalizeLabel(s.slice(top.srcIdx + (top.img ? 2 : 1), i));
          if (label !== '' && refs.has(label)) {
            const r = refs.get(label);
            formed = { href: r.dest, title: r.title, end: lab.end };
          }
        }
      }
      if (!formed && !refLabelParsed) {
        const label = normalizeLabel(s.slice(top.srcIdx + (top.img ? 2 : 1), i));
        if (label !== '' && refs.has(label)) {
          const r = refs.get(label);
          formed = { href: r.dest, title: r.title, end: i + 1 };
        }
      }
      if (formed) {
        // Extended autolinks do not survive inside link text: turn them
        // back into plain text (angle autolinks keep their links).
        for (let k = top.nodeIdx + 1; k < nodes.length; k++) {
          if (nodes[k].t === 'xlink') nodes[k] = { t: 'txt', s: nodes[k].label };
        }
        flush();
        openerNode.href = formed.href;
        openerNode.title = formed.title === undefined ? null : formed.title;
        nodes.push({ t: 'close' });
        stack.length = stack.length - 1;
        if (!top.img) { for (const e of stack) if (!e.img) e.active = false; }
        i = formed.end;
        continue;
      }
      stack.pop();
      buf += ']';
      i++;
      continue;
    }
    if (ch === '<') {
      const al = tryAngleAutolink(s, i);
      if (al) {
        flush();
        nodes.push({ t: 'alink', href: al.href, label: al.label });
        i = al.end;
        continue;
      }
      if (s.startsWith('<!--', i)) {
        if (s.startsWith('<!-->', i)) { flush(); nodes.push({ t: 'html', s: '<!-->' }); i += 5; continue; }
        if (s.startsWith('<!--->', i)) { flush(); nodes.push({ t: 'html', s: '<!--->' }); i += 6; continue; }
        const e = s.indexOf('-->', i + 4);
        if (e >= 0) { flush(); nodes.push({ t: 'html', s: s.slice(i, e + 3) }); i = e + 3; continue; }
      } else if (s.startsWith('<?', i)) {
        const e = s.indexOf('?>', i + 2);
        if (e >= 0) { flush(); nodes.push({ t: 'html', s: s.slice(i, e + 2) }); i = e + 2; continue; }
      } else if (s.startsWith('<![CDATA[', i)) {
        const e = s.indexOf(']]>', i + 9);
        if (e >= 0) { flush(); nodes.push({ t: 'html', s: s.slice(i, e + 3) }); i = e + 3; continue; }
      } else if (s.startsWith('<!', i) && i + 2 < n && isAlpha(s[i + 2])) {
        const e = s.indexOf('>', i + 3);
        if (e >= 0) { flush(); nodes.push({ t: 'html', s: s.slice(i, e + 1) }); i = e + 1; continue; }
      } else {
        const end = matchHtmlTag(s.slice(i));
        if (end > 0) {
          const tag = s.slice(i, i + end);
          // marked's startATag is /^<a /i (a space, i.e. attributes):
          // a bare <a> does not set inLink. </a> clears it.
          if (/^<a[ \t]/i.test(tag)) docInLink = true;
          else if (/^<\/a[ \t>]/i.test(tag)) docInLink = false;
          flush(); nodes.push({ t: 'html', s: tag }); i += end; continue;
        }
      }
      buf += '&lt;';
      i++;
      continue;
    }
    if (ch === '&') {
      const e = decodeEntity(s, i);
      if (e) { buf += e.text; i += e.len; continue; }
      buf += '&amp;';
      i++;
      continue;
    }
    if (ch === '"') { buf += '&quot;'; i++; continue; }
    if (ch === "'") { buf += '&#39;'; i++; continue; }
    if (ch === '>') { buf += '&gt;'; i++; continue; }
    buf += ch;
    i++;
  }
  flush();
  return nodes;
}

function buildTree(nodes) {
  const root = [];
  const stack = [];
  let cur = root;
  for (const nd of nodes) {
    if (nd.t === 'open') {
      if (nd.href !== null) {
        const frame = { open: nd, children: [] };
        stack.push(frame);
        cur = frame.children;
      } else {
        cur.push({ t: 'txt', s: nd.img ? '![' : '[' });
      }
      continue;
    }
    if (nd.t === 'close') {
      if (!stack.length) { cur.push(nd); continue; }
      const frame = stack.pop();
      const open = frame.open;
      const linkNode = open.img
        ? { t: 'img', href: open.href, title: open.title, altNodes: frame.children }
        : { t: 'link', href: open.href, title: open.title, children: frame.children };
      cur = stack.length ? stack[stack.length - 1].children : root;
      cur.push(linkNode);
      continue;
    }
    cur.push(nd);
  }
  return root;
}

// True when a middle (nodes between a single-* opener and closer) holds
// a ** strong formed from an open-only opener and an ambiguous closer,
// and the text right after that strong does not start with whitespace.
// See the note in processEmphasis.
function isBlockedByStrong(middle) {
  for (let k = 0; k < middle.length; k++) {
    const nd = middle[k];
    if (nd.t !== 'strong' || !nd.oo || !nd.ca) continue;
    const next = middle[k + 1];
    if (next && next.t === 'txt' && next.s !== '' && !isWs(next.s[0])) return true;
  }
  return false;
}

// The CommonMark delimiter-stack algorithm, run per inline container.
function processEmphasis(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link' && nd.children) processEmphasis(nd.children);
    else if (nd.t === 'img' && nd.altNodes) processEmphasis(nd.altNodes);
    else if ((nd.t === 'em' || nd.t === 'strong' || nd.t === 'strike') && nd.children) processEmphasis(nd.children);
  }
  const delims = [];
  for (const nd of nodes) if (nd.t === 'd') delims.push(nd);
  let di = 0;
  while (di < delims.length) {
    const closer = delims[di];
    if (closer.len === 0 || !closer.canClose) { di++; continue; }
    let matched = false;
    let openerRemoved = false;
    for (let oi = di - 1; oi >= 0; oi--) {
      const opener = delims[oi];
      if (opener.len === 0 || !opener.canOpen || opener.ch !== closer.ch) continue;
      if ((opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose)) {
        const sum = opener.len + closer.len;
        if (sum % 3 === 0 && !(opener.len % 3 === 0 && closer.len % 3 === 0)) continue;
      }
      const oiIdx = nodes.indexOf(opener);
      const ciIdx = nodes.indexOf(closer);
      if (oiIdx < 0 || ciIdx < 0 || ciIdx <= oiIdx) continue;
      const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      const middle = nodes.slice(oiIdx + 1, ciIdx);
      const tag = closer.ch === '~' ? 'strike' : (use === 2 ? 'strong' : 'em');
      // marked's *-emphasis quirk: a single-* closer does not match a
      // single-* opener when, between them, a ** strong was formed from
      // an opener that can only open (preceded by whitespace) and a
      // closer that can also open (followed by a non-space), and the
      // text after that strong does not start with whitespace
      // ("*a **b**c*" stays literal, "*a **b** c*" forms <em>). The
      // flags are recorded on the strong node for this check.
      if (use === 1 && closer.ch === '*' && isBlockedByStrong(middle)) continue;
      const strongNode = { t: tag, children: middle };
      if (tag === 'strong' && closer.ch === '*') {
        strongNode.oo = opener.canOpen && !opener.canClose;
        strongNode.ca = closer.canOpen && closer.canClose;
      }
      nodes.splice(oiIdx + 1, ciIdx - oiIdx - 1, strongNode);
      opener.len -= use;
      closer.len -= use;
      if (opener.len === 0) {
        const idx = nodes.indexOf(opener);
        if (idx >= 0) nodes.splice(idx, 1);
        delims.splice(oi, 1);
        openerRemoved = true;
      }
      if (closer.len === 0) {
        const idx = nodes.indexOf(closer);
        if (idx >= 0) nodes.splice(idx, 1);
        delims.splice(di - (openerRemoved ? 1 : 0), 1);
      }
      matched = true;
      break;
    }
    if (!matched) { di++; continue; }
    if (closer.len > 0) di = di - (openerRemoved ? 1 : 0);
    else di = di - (openerRemoved ? 1 : 0);
  }
}

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'txt': out += nd.s; break;
      case 'd': out += nd.ch.repeat(nd.len); break;
      case 'code': out += escCode(nd.s); break;
      case 'html': out += escCode(nd.s); break;
      case 'em': case 'strong': case 'strike': out += plainText(nd.children); break;
      case 'link': out += plainText(nd.children); break;
      case 'img': out += plainText(nd.altNodes); break;
      case 'alink': case 'xlink': out += nd.label; break;
      default: break;
    }
  }
  return out;
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'txt': out += nd.s; break;
      case 'd': out += nd.ch.repeat(nd.len); break;
      case 'code': out += '<code>' + escCode(nd.s) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'em': out += '<em>' + renderNodes(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.children) + '</strong>'; break;
      case 'strike': out += '<del>' + renderNodes(nd.children) + '</del>'; break;
      case 'link':
        out += '<a href="' + hrefOf(nd.href) + '"' +
          (nd.title !== null && nd.title !== undefined ? ' title="' + escAttr(nd.title) + '"' : '') +
          '>' + renderNodes(nd.children) + '</a>';
        break;
      case 'img':
        out += '<img src="' + hrefOf(nd.href) + '" alt="' + plainText(nd.altNodes) + '"' +
          (nd.title !== null && nd.title !== undefined ? ' title="' + escAttr(nd.title) + '"' : '') + '>';
        break;
      case 'alink': case 'xlink':
        out += '<a href="' + hrefOf(nd.href) + '">' + nd.label + '</a>';
        break;
      default: break;
    }
  }
  return out;
}

function renderInline(text, refs) {
  if (!text) return '';
  const tree = buildTree(scanInline(text, refs));
  processEmphasis(tree);
  return renderNodes(tree);
}

// ---- entry point ----

// Document-level "inside an <a> tag" flag, mirroring marked's Lexer state.
// An unclosed inline <a ...> tag disables GFM autolinks (www/scheme/
// email) in this and all later blocks until a </a> is seen; angle
// autolinks and explicit [x](url) links are unaffected. Reset per parse.
let docInLink = false;

export function parse(markdown) {
  const s = markdown.replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  // A trailing newline does not add a blank line: "a\n" is one line, not
  // two. Without this the phantom "" wrongly terminates HTML blocks.
  const docEndsNL = s.endsWith('\n');
  if (docEndsNL) lines.pop();
  docInLink = false;
  const refs = new Map();
  const blocks = parseBlocks(lines, refs, false, false, docEndsNL).blocks;
  return renderBlocks(blocks, refs, false);
}
