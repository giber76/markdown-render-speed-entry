// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM renderer whose
// output is byte-identical to marked 18.1.3 with default options (GFM on,
// breaks off, pedantic off). Written from scratch, in one session, for the
// make.fun markdown-render-speed-02 bounty. No state is kept between calls:
// every parse() renders its input alone, with no cache and no lookup keyed
// on the input.
//
// Layout: helpers (chars, escaping, entities, virtual columns), a block
// pass that builds a small block tree, and an inline pass that scans each
// paragraph once with the CommonMark delimiter-stack algorithm, with
// marked's departures layered on (single-tilde strikethrough, extended
// autolinks, disallowed raw HTML, the backtick-label link rule).

// ---------- character helpers (charCodeAt based, no regex in hot paths) ----------

function isSpaceCode(c) {
  // Unicode whitespace (CommonMark): ASCII whitespace plus NBSP and the
  // other Unicode spaces. NBSP (U+00A0) matters for emphasis flanking.
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
    c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288
  );
}
// Flanking punctuation for emphasis: ASCII punctuation except '~' (a
// strikethrough delimiter, not punctuation here), plus Unicode
// punctuation (P) and currency symbols (Sc). Non-ASCII math symbols
// (Sm, like '~') do not count.
const FLANK_PUNCT_RE = /[\p{P}\p{Sc}]/u;
function isFlankPunct(code, ch) {
  // '~' is ASCII punctuation (CommonMark lists it), so it counts for
  // flanking: a '_' run before a closing '~~' can close (without
  // this, `~~a __b__~~` leaves the '__' unpaired).
  if (code < 128) return isPunctCode(code);
  return FLANK_PUNCT_RE.test(ch);
}
function isDigitCode(c) {
  return c >= 48 && c <= 57;
}
function isAlphaCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnumCode(c) {
  return isAlphaCode(c) || isDigitCode(c);
}
function isHexCode(c) {
  return isDigitCode(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
// ASCII punctuation: !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isPunctCode(c) {
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126)
  );
}
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Count leading whitespace columns (tab advances to next multiple of 4).
// `base` is the absolute column the string starts at (tab stops are
// absolute, so a string sliced from a container must pass its pos.col).
// Returns [columns, index of first non-space char].
function measureIndent(s, base) {
  base = base || 0;
  let col = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      col += 4 - ((base + col) % 4);
      i++;
    } else break;
  }
  return [col, i];
}
// Virtual column of string index idx in s (tabs count to next multiple of 4).
function colAt(s, idx) {
  let col = 0;
  for (let i = 0; i < idx && i < s.length; i++) {
    if (s.charCodeAt(i) === 9) col += 4 - (col % 4);
    else col++;
  }
  return col;
}
// Substring of s starting at virtual column col. If col lands inside a tab,
// the tab's remainder becomes spaces (a straddled tab). `base` is the
// absolute column s starts at. Returns the string.
function sliceFromCol(s, col, base) {
  base = base || 0;
  let c = 0;
  let i = 0;
  while (i < s.length) {
    if (c >= col) return s.slice(i);
    const ch = s.charCodeAt(i);
    if (ch === 9) {
      const next = c + (4 - ((base + c) % 4));
      if (next > col) return ' '.repeat(next - col) + s.slice(i + 1);
      c = next;
      i++;
    } else {
      c++;
      i++;
    }
  }
  return '';
}
// Remove up to n columns of leading whitespace (spaces/tabs) from s,
// never removing non-whitespace. `base` is the absolute column s starts
// at (tab stops are absolute). Used to strip a fence's indent from a
// content line without eating content chars.
// marked's Dt (indentCodeCompensation): strip
// min(line-leading-ws-chars, fence-leading-ws-chars) CHARACTERS from
// the start of a fenced-code content line. Unlike stripLeadingWs
// (column-based), a leading tab counts as ONE character here, so a
// tab-led content line is stripped entirely whenever the fence has
// any indent (`   ```\n\tindented` -> `indented`, not ` indented`).
function dtStrip(s, fenceWsChars) {
  let lead = 0;
  while (lead < s.length && (s.charCodeAt(lead) === 32 || s.charCodeAt(lead) === 9)) lead++;
  if (lead === 0) return s;
  return s.slice(Math.min(lead, fenceWsChars));
}

function stripLeadingWs(s, n, base) {
  base = base || 0;
  let c = 0;
  let i = 0;
  while (i < s.length && c < n) {
    const ch = s.charCodeAt(i);
    if (ch === 32) {
      c++;
      i++;
    } else if (ch === 9) {
      const w = 4 - ((base + c) % 4);
      if (c + w > n) {
        // Tab straddles the indent boundary: keep its remainder as spaces.
        return ' '.repeat(c + w - n) + s.slice(i + 1);
      }
      c += w;
      i++;
    } else break;
  }
  return s.slice(i);
}
// Expand the leading whitespace run of s to spaces (a tab advances to
// the next multiple of 4 from `base`), leaving the rest untouched.
// Marked expands a list item line's leading whitespace this way before
// removing the item's content indent, so a tab anywhere in the run is
// expanded first and never survives past the cut verbatim.
function expandLeadingWs(s, base) {
  base = base || 0;
  let i = 0;
  let col = base;
  let out = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      out += ' ';
      col++;
      i++;
    } else if (c === 9) {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
      i++;
    } else break;
  }
  return i === 0 ? s : out + s.slice(i);
}
// Advance virtual column col by n columns inside s, returning the string
// index where that lands (a straddled tab counts as landing inside it).
function indexAtCol(s, col) {
  let c = 0;
  let i = 0;
  while (i < s.length && c < col) {
    const ch = s.charCodeAt(i);
    if (ch === 9) c += 4 - (c % 4);
    else c++;
    i++;
  }
  return i;
}

// ---------- escaping and entities ----------

// Escape &, <, > for text, leaving valid entities verbatim: a named
// reference &name; passes through unchanged (even an unknown name), and a
// numeric reference decodes (0, surrogates and values above 0x10FFFF become
// U+FFFD). A bare & that starts no valid reference becomes &amp;.
function escapeText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const ent = tryEntity(s, i);
      if (ent !== null) {
        out += s.slice(start, i) + ent[0];
        i = ent[1] - 1;
        start = ent[1];
      } else {
        out += s.slice(start, i) + '&amp;';
        start = i + 1;
      }
    } else if (c === 60) {
      out += s.slice(start, i) + '&lt;';
      start = i + 1;
    } else if (c === 62) {
      out += s.slice(start, i) + '&gt;';
      start = i + 1;
    } else if (c === 34) {
      out += s.slice(start, i) + '&quot;';
      start = i + 1;
    } else if (c === 39) {
      out += s.slice(start, i) + '&#39;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}
// Try to read a character reference at s[i] == '&'. Returns [replacement,
// index just past the reference] or null. Named references pass through
// verbatim; numeric ones decode.
function tryEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) {
    // numeric: &#123; or &#x1a; — decimal at most 7 digits, hex at most 6;
    // more digits means it is not an entity at all (literal text).
    let j = i + 2;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      hex = true;
      j++;
    }
    const ds = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? isHexCode(c) : isDigitCode(c)) j++;
      else break;
    }
    if (j === ds || j >= n || s.charCodeAt(j) !== 59) return null;
    if (j - ds > (hex ? 6 : 7)) return null;
    const num = parseInt(s.slice(ds, j), hex ? 16 : 10);
    let ch;
    if (!num || num > 0x10ffff || (num >= 0xd800 && num <= 0xdfff)) ch = '\uFFFD';
    else ch = String.fromCodePoint(num);
    return [ch, j + 1];
  }
  if (!isAlphaCode(c1)) return null;
  let j = i + 1;
  while (j < n && isAlnumCode(s.charCodeAt(j))) j++;
  if (j < n && s.charCodeAt(j) === 59) return [s.slice(i, j + 1), j + 1];
  return null;
}
// Escape &, <, >, " and ' with NO entity pass-through (for code spans and
// code blocks, whose content is literal: an & there is always &amp;).
function escapeCode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) {
      out += s.slice(start, i) + '&lt;';
      start = i + 1;
    } else if (c === 62) {
      out += s.slice(start, i) + '&gt;';
      start = i + 1;
    } else if (c === 34) {
      out += s.slice(start, i) + '&quot;';
      start = i + 1;
    } else if (c === 39) {
      out += s.slice(start, i) + '&#39;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}
// Escape an attribute value: & (bare), " < >. Entities inside pass through
// verbatim, as in text.
function escapeAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const ent = tryEntity(s, i);
      if (ent !== null) {
        out += s.slice(start, i) + ent[0];
        i = ent[1] - 1;
        start = ent[1];
      } else {
        out += s.slice(start, i) + '&amp;';
        start = i + 1;
      }
    } else if (c === 34) {
      out += s.slice(start, i) + '&quot;';
      start = i + 1;
    } else if (c === 60) {
      out += s.slice(start, i) + '&lt;';
      start = i + 1;
    } else if (c === 62) {
      out += s.slice(start, i) + '&gt;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}
// A link destination for href: percent-encode like encodeURI, then escape
// for an attribute. encodeURI leaves ;/?:@&=+$,# and % alone and encodes
// spaces and non-ASCII; the attribute escape then turns bare & into &amp;.
function escapeHref(dest) {
  // Percent-encode the destination, preserving valid %XX sequences
  // (an already-encoded `%20` must not become `%2520`). The one
  // exception is `%25` (an encoded percent sign), which decodes to `%`.
  // A literal '%' that is not part of a %XX sequence stays as '%' —
  // encodeURI would turn it into `%25`.
  let out = '';
  for (let i = 0; i < dest.length; i++) {
    const c = dest.charCodeAt(i);
    if (c === 37) {
      if (
        i + 2 < dest.length &&
        isHexCode(dest.charCodeAt(i + 1)) && isHexCode(dest.charCodeAt(i + 2))
      ) {
        if (dest.slice(i + 1, i + 3).toLowerCase() === '25') out += '%';
        else out += dest.slice(i, i + 3);
        i += 2;
      } else {
        out += '%';
      }
    } else {
      out += encodeURI(dest[i]);
    }
  }
  return escapeAttr(out);
}
// Decode entities in a string to plain text (used for link labels matched
// against reference definitions, and for image alt text): named references
// stay verbatim only when they are valid HTML names is NOT what marked does
// for labels — labels are matched after entity processing, so decode named
// references that are real entities and keep unknown ones literal. We keep
// it simple: decode numeric references, leave named ones as-is (they match
// the same way on both sides of a definition lookup).
function decodeForLabel(s) {
  // Decode entities only. Backslash escapes are NOT decoded for label
  // matching: a label `foo\!` does not match a reference `foo!`, and
  // `Foo*bar\]` matches only a reference written the same way.
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 38) {
      const ent = tryEntity(s, i);
      if (ent !== null && ent[0].length === 1 && ent[0] !== s.slice(i, ent[1])) {
        out += s.slice(start, i) + ent[0];
        i = ent[1] - 1;
        start = ent[1];
      }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}
// Normalize a link label for reference lookup: collapse internal whitespace
// (including newlines) to single spaces, trim, case-fold. Unicode case
// folding maps ß (U+00DF) and ẞ (U+1E9E) to "ss".
function normalizeLabel(s) {
  let out = '';
  let pendingSpace = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isSpaceCode(c)) {
      if (started) pendingSpace = true;
    } else {
      if (pendingSpace) {
        out += ' ';
        pendingSpace = false;
      }
      // Full case folding: ß (U+00DF) and ẞ (U+1E9E) both fold to "ss".
      if (c === 223 || c === 7838) out += 'ss';
      else out += s[i].toLowerCase();
      started = true;
    }
  }
  return out;
}

// ---------- block parsing ----------
// Builds a small block tree from the source. Follows the CommonMark block
// algorithm (open-block stack, container matching, lazy continuation), with
// GFM tables and task list items. Tabs are handled by virtual columns: a
// tab advances to the next multiple of 4, and a tab straddling a cut
// becomes spaces; tabs otherwise survive verbatim in text and fenced code.

function splitLines(src) {
  // Normalize CRLF and lone CR to LF, then split (no trailing empty line
  // is added for a final newline: "a\n" -> ["a"]).
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// The block parser state.
function newBlockState(refs) {
  return {
    refs,
    doc: { t: 'doc', children: [] },
    stack: null, // open blocks, root first; set in parseBlocks
    // List tight/loose tracking: the innermost open list and whether a
    // blank line has been seen inside the current item.
    blankSeen: false,
    // Blank lines awaiting looseness resolution: each entry is a
    // snapshot of the item chain open when the blank line arrived
    // (innermost first), each with its parent list's stack index.
    // Which item the blank sits in is decided by the next non-blank
    // line, so the marking is deferred until then.
    pendingBlanks: [],
  };
}
function stackTop(st) {
  return st.stack[st.stack.length - 1];
}
function addChild(st, node) {
  if (st.blankSeen) {
    node.blankBefore = true;
    st.blankSeen = false;
  }
  const top = stackTop(st);
  if (top.children) top.children.push(node);
  else top.children = [node];
  return node;
}
function pushBlock(st, node) {
  addChild(st, node);
  st.stack.push(node);
  return node;
}
// Close blocks from the top of the stack down to (and including) node.
function closeUpTo(st, node) {
  while (st.stack.length > 0) {
    const top = st.stack.pop();
    if (top === node) break;
  }
}
// Close the current leaf block (paragraph, code, html, table) if any.
function closeLeaf(st) {
  const top = stackTop(st);
  if (
    top &&
    (top.t === 'para' || top.t === 'code' || top.t === 'html' || top.t === 'table')
  ) {
    st.stack.pop();
  }
}

// Try to match the open containers against the line. `pos` is {s, col} for
// the line's current remainder. Returns the number of containers matched
// (containers that did not match are closed). The line remainder is
// advanced past each matched container's marker.
function matchContainers(st, pos) {
  let matched = 0;
  // stack[0] is the doc; containers start at index 1.
  for (let si = 1; si < st.stack.length; si++) {
    const node = st.stack[si];
    if (node.t === 'quote') {
      // Up to 3 spaces, then '>'.
      const [ind, idx] = measureIndent(pos.s, pos.col);
      if (ind > 3 || idx >= pos.s.length || pos.s.charCodeAt(idx) !== 62) break;
      // Consume the '>' and one following column of whitespace. Marked
      // expands the whole whitespace run after '>' (tabs to spaces)
      // and then drops one column of it. The run is expanded as if it
      // starts at its index in the current remainder (idx + 1): inside
      // a list item the remainder was already stripped, so a tab after
      // `>` expands from column 1 (`  > \tfoo` keeps two spaces), while
      // a top-level indented quote expands from its real column
      // (`  > \tfoo` keeps four). Using the absolute column mis-expands
      // the nested case; a constant 1 mis-expands the top-level one.
      let rest = pos.s.slice(idx + 1);
      let rcol = pos.col + ind + 1;
      if (rest.length > 0) {
        const ws = /^[ \t]+/.exec(rest);
        if (ws) {
          rest = expandLeadingWs(rest, idx + 1).slice(1);
          rcol++;
        }
      }
      pos.s = rest;
      pos.col = rcol;
      matched++;
    } else if (node.t === 'item') {
      // The line must be indented to the item's content column,
      // measured in columns from the start of the container-stripped
      // remainder. Marked re-lexes a list item's text, so the content
      // column is the marker's offset within the remainder plus the
      // marker-relative indent — the same for every line of the item,
      // whether the list is indented or nested in a block quote whose
      // markers differ in width from line to line.
      const [ind] = measureIndent(pos.s, pos.col);
      if (ind < node.contentCol) break;
      if (ind === 0 && pos.s.length > 0) {
        // No indentation at all: a lazy continuation line, not a match
        // for the item — but a paragraph inside the item may continue
        // lazily, which is handled by the caller. Here we do NOT match.
        break;
      }
      const strip = node.contentCol;
      if (strip > 0) {
        // Expand the leading whitespace run (tabs to spaces, absolute
        // stops) before removing the content indent, as marked does
        // when it builds a list item's text: a tab anywhere in the run
        // is expanded first, then the indent is removed from the
        // expanded string. Without this a tab past the cut survives
        // verbatim in fenced code (and paragraph text) inside items.
        pos.s = expandLeadingWs(pos.s, pos.col).slice(strip);
        pos.col += strip;
      }
      matched++;
    } else if (node.t === 'list') {
      // A list container has no marker of its own: it matches exactly
      // when the line belongs to one of its items (indented to the open
      // item's content indent) or starts a new item of the same kind.
      // Counting it unconditionally would let a following block (a
      // thematic break, a paragraph, ...) land inside the list.
      const item = st.stack[si + 1];
      let belongs = false;
      if (item && item.t === 'item') {
        const [ind] = measureIndent(pos.s, pos.col);
        if (ind >= item.contentCol) belongs = true;
      }
      if (!belongs) {
        const [ind, idx] = measureIndent(pos.s, pos.col);
        if (ind <= 3) {
          const rest = pos.s.slice(idx);
          // A thematic break is not a list item, even when it looks
          // like one (`* * *`).
          if (!isThematicBreak(rest)) {
            const lst = isListStart(rest);
            // A new item must sit within 3 columns of the list's own
            // marker column; a deeper marker starts a nested list.
            if (lst && lst.ordered === node.ordered && Math.abs(pos.col + ind - node.markerCol) <= 3) {
              const sameMarker =
                (lst.ordered && node.delim === rest.charAt(lst.markerLen - 1)) ||
                (!lst.ordered && node.markerChar === rest.charAt(0));
              if (sameMarker) belongs = true;
            }
          }
        }
      }
      if (!belongs) break;
      matched++;
    } else {
      break;
    }
  }
  return matched;
}

// Parse the whole source into a block tree. Returns {doc, refs}.
function parseBlocks(src) {
  const refs = new Map();
  const st = newBlockState(refs);
  st.stack = [st.doc];
  const lines = splitLines(src);
  for (let li = 0; li < lines.length; li++) {
    processLine(st, lines[li]);
  }
  // Finalize: close everything, resolving setext headings and link refs.
  while (st.stack.length > 1) {
    const top = st.stack.pop();
    if (top.t === 'para') finalizeParagraph(st, top);
  }
  resolveLooseLists(st.doc);
  return { doc: st.doc, refs };
}

// One line of input. pos tracks the line remainder and its virtual column.
function processLine(st, raw) {
  const pos = { s: raw, col: 0 };
  if (isBlankLine(raw)) {
    // A whitespace-only line that holds a tab is a table row (an
    // empty row, padded to the header's column count), not a blank
    // line: marked ends a table at a space-only or empty line, but a
    // tab-only line continues it as an empty row.
    if (raw.indexOf('\t') !== -1 && stackTop(st).t === 'table') {
      stackTop(st).rows.push(splitTableRow(raw));
      return;
    }
    processBlankLine(st, raw);
    return;
  }
  // Match open containers; close the ones that do not match.
  const depth = matchContainers(st, pos);
  // A non-blank line resolves any blank lines before it: which item
  // each blank sits in is decided by this line's containers.
  resolvePendingBlanks(st, depth);
  const tip = stackTop(st);
  // A blank remainder (the line held only container markers, e.g. a
  // bare `>` line) is a blank line inside the open containers. The
  // para branch (below) closes a paragraph for it and the fenced
  // branch absorbs it as content; for any other tip that is itself a
  // container (an item, list, or quote with no leaf child yet) it must
  // not close the list or quote — record it for looseness and return
  // without popping (`> * a` + fence + `>` + `> * b` keeps one list).
  const blankRemainder = pos.s.length === 0 || /^[ \t]+$/.test(pos.s);
  if (blankRemainder && (tip.t === 'item' || tip.t === 'list' || tip.t === 'quote')) {
    recordPendingBlank(st);
    st.blankSeen = true;
    return;
  }
  // A leaf whose containers all matched is at stack index depth+1.
  const fullyMatched = st.stack.length - 1 === depth + 1;
  if (tip.t === 'para') {
    if (fullyMatched) {
      if (tryContinueParagraph(st, tip, pos)) return;
      st.stack.pop();
      finalizeParagraph(st, tip);
    } else {
      // Some containers did not match: the line may still be a lazy
      // continuation of the paragraph. First strip the unmatched list
      // items in turn (outermost first), then check whether the
      // stripped line starts a block that can interrupt a paragraph —
      // a list start revealed only by the stripping must interrupt,
      // not continue the paragraph lazily.
      const lp = lazyStrip(st, pos, depth);
      // The line held only container markers (e.g. an empty quote line
      // inside a list item): it is a blank line inside the open
      // containers, not a paragraph continuation. Close the paragraph
      // and record the blank, but keep the list item open — the next
      // line decides whether it continues the item (cm-259: `>>` then
      // `>>     two` is a second paragraph in the same item).
      if ((lp.s.length === 0 || /^[ \t]+$/.test(lp.s)) && lp.hadItem) {
        st.stack.pop();
        finalizeParagraph(st, tip);
        recordPendingBlank(st);
        // The next block inside the item follows a blank line, so it
        // carries blankBefore (the looseness rule for two blocks in
        // one item reads that flag).
        st.blankSeen = true;
        return;
      }
      const [lind, lidx] = measureIndent(lp.s, lp.col);
      const lrest = lp.s.slice(lidx);
      // In this branch the paragraph's containers already failed to
      // match, so any list start is a new block, not a lazy
      // continuation — the "starts with 1" and "empty item" limits
      // only apply when a list would interrupt a paragraph that is
      // otherwise continuing.
      const interrupts =
        lind <= 3 &&
        (isInterruptStart(lrest, inListItem(st, tip)) || isListStart(lrest) !== null);
      if (interrupts) {
        // Interrupting block: close the paragraph, do not continue lazily.
      } else if (tryContinueParagraph(st, tip, { s: lp.s, col: lp.col }, true, { hadItem: lp.hadItem, reached: lp.reached })) {
        return;
      }
      while (st.stack.length > 1 + depth) {
        const t = st.stack.pop();
        if (t.t === 'para') finalizeParagraph(st, t);
      }
    }
  } else if (tip.t === 'code' && tip.fenced) {
    // A fenced code block absorbs lines even when their containers do
    // not match (e.g. a content line at column 0 inside a list item):
    // it ends only at its closing fence. But a line that fails to match
    // a blockquote is outside the quote and must not be absorbed. And
    // a line outside a list item must not be absorbed into an EMPTY
    // fence: the fence ends empty and the line starts a block outside
    // (`1. item` + ` ```toml` + `if col0` leaves an empty fence). Once
    // the fence already has content, outside lines are absorbed. A
    // BLANK remainder (the line held only container markers, e.g. a
    // bare `>` inside the fence) is always content — an empty line —
    // never a reason to close the fence.
    let inQuote = false;
    let inItem = false;
    for (let qi = depth + 1; qi < st.stack.length - 1; qi++) {
      if (st.stack[qi].t === 'quote') inQuote = true;
      if (st.stack[qi].t === 'item') inItem = true;
    }
    const blankRemainder = pos.s.length === 0 || /^[ \t]+$/.test(pos.s);
    if (!inQuote && !(inItem && tip.lines.length === 0 && !blankRemainder)) {
      const r = continueCode(st, tip, pos);
      if (r === true) return; // consumed as code content
      if (r === 'closed') {
        st.stack.pop();
        return; // closing fence consumed; do not reprocess the line
      }
    }
    while (st.stack.length > 1 + depth) {
      const t = st.stack.pop();
      if (t.t === 'para') finalizeParagraph(st, t);
    }
  } else if (
    (tip.t === 'code' || tip.t === 'html' || tip.t === 'table') &&
    fullyMatched
  ) {
    if (tip.t === 'code') {
      const r = continueCode(st, tip, pos);
      if (r === true) return; // consumed as code content
      if (r === 'closed') {
        st.stack.pop();
        return; // closing fence consumed; do not reprocess the line
      }
      st.stack.pop(); // not a code line; fall through to startBlocks
    } else if (tip.t === 'html') {
      if (continueHtml(st, tip, pos)) return; // consumed into the block
      st.stack.pop();
      return; // line was consumed into the html block; do not reprocess
    } else {
      if (continueTable(st, tip, pos)) return; // consumed as a row
      st.stack.pop(); // line not consumed; fall through to startBlocks
    }
  } else {
    while (st.stack.length > 1 + depth) {
      const t = st.stack.pop();
      if (t.t === 'para') finalizeParagraph(st, t);
    }
  }
  startBlocks(st, pos);
  st.blankSeen = false;
}

// Snapshot the item chain open now (innermost first) as a pending
// blank line, for deferred looseness resolution. Each entry records
// the item, its stack index, and its parent list's stack index.
function recordPendingBlank(st) {
  const chain = [];
  for (let i = st.stack.length - 1; i >= 1; i--) {
    const node = st.stack[i];
    if (node.t === 'item') {
      chain.push({ item: node, itemIdx: i, listIdx: i - 1 });
    } else if (node.t !== 'list') {
      break;
    }
  }
  if (chain.length > 0) st.pendingBlanks.push(chain);
}

// Resolve pending blank lines against the line that just matched
// `depth` containers. A blank loosens the deepest item in its
// snapshot that this line still belongs to: if the line continues
// the item itself, the blank sits between two blocks inside it; if
// it only matches the item's list, the blank sits between two items
// of that list. When the line leaves every snapshot list, the blank
// is trailing in the outermost item and loosens nothing.
function resolvePendingBlanks(st, depth) {
  if (st.pendingBlanks.length === 0) return;
  for (const chain of st.pendingBlanks) {
    for (const entry of chain) {
      if (entry.itemIdx <= depth || entry.listIdx <= depth) {
        entry.item.blankAfter = true;
        break;
      }
    }
  }
  st.pendingBlanks.length = 0;
}

function processBlankLine(st, raw) {
  // If the previous block was a kind 1-5 HTML block that just closed,
  // a truly EMPTY line after it strips its trailing newline. A
  // whitespace-only line (spaces/tabs) does not: marked keeps the
  // newline after `<!-- ... -->\n\t\npara` but drops it after
  // `<!-- ... -->\n\npara`.
  for (let i = st.stack.length - 1; i >= 0; i--) {
    const cont = st.stack[i];
    if (cont && cont.children && cont.children.length) {
      const lc = cont.children[cont.children.length - 1];
      if (lc.t === 'html' && lc.kind <= 5 && st.stack.indexOf(lc) === -1 && raw === '') {
        lc.followedByBlank = true;
      }
      break;
    }
  }
  // A blank line closes a paragraph and marks lists loose.
  const top = stackTop(st);
  if (top.t === 'para') {
    st.stack.pop();
    finalizeParagraph(st, top);
  } else if (top.t === 'code' && !top.fenced) {
    // A blank line inside an indented code block is kept, with the
    // code indent stripped (its remainder, if any, is content).
    top.lines.push(stripLeadingWs(raw || '', top.indent || 4, 0));
  } else if (top.t === 'code' && top.fenced) {
    // A blank line inside a fenced code block is content. For a
    // backtick fence marked's Dt strips up to the fence's leading
    // whitespace in CHARACTERS (a tab-led line is stripped entirely);
    // a tilde fence keeps it verbatim.
    if (top.fenceChar === 96) top.lines.push(dtStrip(raw || '', top.fenceWsChars || 0));
    else top.lines.push(raw || '');
  } else if (top.t === 'html') {
    // Kinds 1-5 can contain blank lines; kinds 6-7 end at one.
    if (top.kind <= 5) {
      top.lines.push('');
    } else {
      // A kind 6/7 block ending at a blank line renders with NO trailing
      // newline after its last line.
      top.endedAtBlank = true;
      st.stack.pop();
    }
  } else if (top.t === 'table') {
    st.stack.pop();
  }
  // A blank line closes open blockquotes (a line with no '>' marker is
  // outside the quote), but not lists. Pop everything from the top down
  // to and including the outermost open quote; containers below it stay.
  let qIdx = -1;
  for (let i = 1; i < st.stack.length; i++) {
    if (st.stack[i].t === 'quote') {
      qIdx = i;
      break;
    }
  }
  if (qIdx !== -1) {
    while (st.stack.length > qIdx) {
      const t = st.stack.pop();
      if (t.t === 'para') finalizeParagraph(st, t);
    }
  }
  // A blank line loosens a list, but which item it sits in is decided
  // by the next non-blank line (a blank after a nested sublist loosens
  // the outer list only when the next line leaves the sublist), so
  // record it for deferred resolution instead of marking now.
  recordPendingBlank(st);
  // An empty list item (no content blocks) closes on a blank line, so
  // following indented content does not belong to it. This runs after
  // the loose marking above, so the blank line still counts for it.
  {
    const t2 = stackTop(st);
    if (t2 && t2.t === 'item' && (!t2.children || t2.children.length === 0)) {
      st.stack.pop();
    }
  }
  st.blankSeen = true;
}

// Paragraph continuation: a non-blank line continues a paragraph unless it
// starts a block that can interrupt a paragraph. Returns true if consumed.
// `lazy` means the line is a lazy continuation (some containers did not
// match): it joins the paragraph even if it looks like a list item,
// because its indent already marks it as a continuation, not a new block.
// `info` (lazy only) describes the unmatched list items the line passed
// through: {hadItem, reached} — whether any unmatched item was open, and
// whether the line reached the innermost one.
function tryContinueParagraph(st, para, pos, lazy, info) {
  const s = pos.s;
  // A whitespace-only remainder (the line held only container markers
  // plus spaces) joins an open paragraph as a line of spaces; an empty
  // remainder is a blank line and does not continue it.
  if (s.length > 0 && /^[ \t]+$/.test(s)) {
    para.lines.push(s);
    para.lastLazy = !!lazy;
    return true;
  }
  const [ind, idx] = measureIndent(s, pos.col);
  if (ind > 3) {
    // Indented: lazy continuation (indented code cannot interrupt).
    // Marked merges such a line into the paragraph with 4 columns
    // stripped when the paragraph is lexed as inline text — inside a
    // list item, or as a lazy line of a blockquote chunk. A top-level
    // paragraph, or a fully matched blockquote paragraph, keeps the
    // indent verbatim.
    const parent = st.stack.length >= 2 ? st.stack[st.stack.length - 2] : null;
    if (lazy || (parent && parent.t === 'item')) {
      para.lines.push(stripLeadingWs(s, 4, pos.col));
    } else {
      para.lines.push(s);
    }
    para.lastLazy = !!lazy;
    return true;
  }
  const rest = s.slice(idx);
  if (rest.length === 0) return false;
  // Setext heading underline?
  if (isSetextLine(rest)) {
    if (lazy) {
      if (info && info.hadItem) {
        if (!info.reached) {
          // The line does not reach the innermost item: marked pads it
          // to 4 spaces in the item's text, then the code-merge in the
          // item's inline lexing strips them again, leaving the line
          // with its leading whitespace removed.
          para.lines.push(rest);
          para.lastLazy = true;
          return true;
        }
        // The line reaches the innermost item: it IS a setext
        // underline — fall through to the conversion below.
      } else {
        // Directly inside a blockquote: a lazy setext line is never a
        // heading. Marked's blockquoteSetextReplace indents it by 4
        // when the previous paragraph line was lazy too (same chunk),
        // and leaves it as-is when the previous line was matched.
        para.lines.push(para.lastLazy ? '    ' + rest : s);
        para.lastLazy = true;
        return true;
      }
    }
    // Reference definitions at the start of the paragraph are not part
    // of the heading text; strip them first. If nothing remains, there
    // is no heading — return false so the caller closes the paragraph
    // (finalizeParagraph removes it as all-ref-defs) and the underline
    // starts a new paragraph instead.
    const firstText = stripRefDefs(st, para.lines);
    if (firstText >= para.lines.length) {
      return false;
    }
    // Convert the paragraph to a setext heading. The content is the
    // remaining paragraph text with leading/trailing whitespace stripped.
    st.stack.pop();
    const level = rest.charCodeAt(0) === 61 ? 1 : 2;
    const node = { t: 'heading', level, text: para.lines.slice(firstText).join('\n').replace(/^[ \t\n]+|[ \t\n]+$/g, ''), setext: true };
    node.blankBefore = para.blankBefore;
    replaceNode(st, para, node);
    return true;
  }
  // Table delimiter row? A single-line paragraph followed by one becomes
  // a table (the header is the paragraph's line). The delimiter must
  // have the same number of columns as the header, or it is not a table.
  if (para.lines.length === 1) {
    const aligns = parseTableDelimiter(rest);
    const header = splitTableRow(para.lines[0]);
    if (aligns && aligns.length === header.length) {
      st.stack.pop();
      const node = {
        t: 'table',
        header,
        aligns,
        rows: [],
      };
      node.blankBefore = para.blankBefore;
      replaceNode(st, para, node);
      st.stack.push(node);
      return true;
    }
  }
  // A block that can interrupt a paragraph starts here: ATX heading,
  // fenced code, HTML block kinds 1-6, thematic break, blockquote, list.
  // (Link reference definitions do NOT interrupt; they are consumed when
  // the paragraph is finalized.) A lazy continuation is exempt: its
  // indent already marks it as a continuation, not a new block.
  // An ordered list must start at 1 to interrupt a top-level paragraph;
  // inside a list item any start number interrupts (it starts a new or
  // nested list).
  if (!lazy && isInterruptStart(rest, inListItem(st, para))) return false;
  para.lines.push(s);
  para.lastLazy = !!lazy;
  return true;
}

// Is `para` inside a list item (any ancestor on the stack is a list
// or an item)?
function inListItem(st, para) {
  for (let i = 1; i < st.stack.length; i++) {
    const n = st.stack[i];
    if (n === para) break;
    if (n.t === 'list' || n.t === 'item') return true;
  }
  return false;
}

// Strip the unmatched containers from a lazy continuation line, in
// order from the outermost unmatched container inward. Only list items
// strip anything: a line reaches an item when its (expanded) leading
// indent is at least the item's relative content indent; then that many
// columns are removed and the virtual column advances. A line that falls
// short of an item is left as-is and no deeper item is stripped.
// Returns {s, col, hadItem, reached}: the remainder and its column,
// whether any unmatched item was open, and whether the line reached the
// innermost unmatched item.
function lazyStrip(st, pos, depth) {
  let s = pos.s;
  let col = pos.col;
  let hadItem = false;
  let reached = true;
  for (let i = depth + 1; i < st.stack.length - 1; i++) {
    const node = st.stack[i];
    if (node.t !== 'item') continue;
    hadItem = true;
    // Expand the leading whitespace run (tabs to spaces) before
    // measuring, as marked does before slicing a list item's indent.
    const expanded = expandLeadingWs(s, col);
    const [ind] = measureIndent(expanded, col);
    if (ind >= node.contentCol) {
      s = stripLeadingWs(expanded, node.contentCol, col);
      col += node.contentCol;
    } else {
      reached = false;
      break;
    }
  }
  return { s, col, hadItem, reached };
}

// Is this line the start of a block that can interrupt a paragraph?
// `inList` is true when the paragraph is inside a list item: there an
// ordered list may start at any number (a top-level paragraph requires
// start 1).
function isInterruptStart(rest, inList) {
  const c = rest.charCodeAt(0);
  if (c === 35) return isAtxHeading(rest); // '#'
  if (c === 96 || c === 126) return isFenceStart(rest); // ` or ~
  if (c === 60) {
    const kind = htmlBlockKind(rest);
    return kind >= 1 && kind <= 6;
  }
  if (c === 42 || c === 45 || c === 95) {
    // A thematic break interrupts; otherwise a `-`/`*` line may still be
    // a list item, which also interrupts (fall through to the list check).
    if (isThematicBreak(rest)) return true;
  }
  if (c === 62) return true; // '>' blockquote
  if (c === 45 || c === 43 || c === 42 || isDigitCode(c)) {
    // A list interrupts a paragraph — unless the item is empty (a bare
    // marker with nothing after it cannot interrupt), or it is an
    // ordered list not starting at 1 (top-level paragraphs only).
    const lst = isListStart(rest);
    if (!lst) return false;
    if (lst.ordered && lst.start !== 1 && !inList) return false;
    const after = rest.slice(lst.markerLen);
    return after.replace(/[ \t]+$/, '').length > 0;
  }
  return false;
}
function isSetextLine(rest) {
  // A setext underline is a run of '=' (level 1) or '-' (level 2) with
  // only leading/trailing whitespace — no spaces inside the run.
  let i = 0;
  let j = rest.length;
  while (i < j && (rest.charCodeAt(i) === 32 || rest.charCodeAt(i) === 9)) i++;
  while (j > i && (rest.charCodeAt(j - 1) === 32 || rest.charCodeAt(j - 1) === 9)) j--;
  if (i >= j) return false;
  const c = rest.charCodeAt(i);
  if (c !== 61 && c !== 45) return false;
  for (let k = i; k < j; k++) {
    if (rest.charCodeAt(k) !== c) return false;
  }
  return true;
}
function isAtxHeading(rest) {
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6) return false;
  if (i >= rest.length) return true;
  const c = rest.charCodeAt(i);
  return c === 32 || c === 9;
}
function isFenceStart(rest) {
  const c = rest.charCodeAt(0);
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === c) i++;
  if (i < 3) return false;
  // A backtick fence's info string may not contain a backtick: a line
  // like ```inner backticks``` is not a fence at all (it is a paragraph
  // line holding an inline code span), so it must not interrupt a
  // paragraph either. A tilde fence has no such restriction.
  if (c === 96) return rest.indexOf('`', i) === -1;
  return true;
}
function isThematicBreak(rest) {
  const c = rest.charCodeAt(0);
  if (c !== 42 && c !== 45 && c !== 95) return false;
  let count = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest.charCodeAt(i);
    if (ch === c) count++;
    else if (ch !== 32 && ch !== 9) return false;
  }
  return count >= 3;
}
// Parse a list marker at the start of rest (after up to 3 spaces indent,
// which the caller has already stripped). Returns
// {ordered, start, markerLen, contentIndent} or null.
function isListStart(rest) {
  const c0 = rest.charCodeAt(0);
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    // Bullet: marker + at least one space/tab, or end of line.
    if (rest.length === 1) return { ordered: false, start: 0, markerLen: 1, contentIndent: 2 };
    const c1 = rest.charCodeAt(1);
    if (c1 !== 32 && c1 !== 9) return null;
    return { ordered: false, start: 0, markerLen: 1, contentIndent: -1 };
  }
  if (isDigitCode(c0)) {
    let i = 0;
    while (i < rest.length && isDigitCode(rest.charCodeAt(i))) i++;
    if (i === 0 || i > 9) return null;
    if (i >= rest.length) return null;
    const d = rest.charCodeAt(i);
    if (d !== 46 && d !== 41) return null;
    const start = parseInt(rest.slice(0, i), 10);
    if (rest.length === i + 1) return { ordered: true, start, markerLen: i + 1, contentIndent: i + 2 };
    const c1 = rest.charCodeAt(i + 1);
    if (c1 !== 32 && c1 !== 9) return null;
    return { ordered: true, start, markerLen: i + 1, contentIndent: -1 };
  }
  return null;
}
// HTML block kinds 1-7 (0 = not an HTML block start). rest is the line
// after up to 3 spaces of indent.
function htmlBlockKind(rest) {
  if (rest.charCodeAt(0) !== 60) return 0;
  const lower = rest.toLowerCase();
  // Kind 1: start tag of script/pre/style/textarea, tag name followed by
  // whitespace, '>' or end of line.
  const m1 = /^<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(rest);
  if (m1) return 1;
  if (lower.startsWith('<!--')) return 2;
  if (lower.startsWith('<?')) return 3;
  if (lower.startsWith('<!')) {
    const c = rest.length > 2 ? rest.charCodeAt(2) : 0;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 4;
    if (rest.startsWith('<![CDATA[')) return 5;
    return 0;
  }
  if (lower.startsWith('<![cdata[')) return 5;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (!m) return 0;
  const tag = m[1].toLowerCase();
  const afterIdx = m[0].length;
  const next = afterIdx < rest.length ? rest.charCodeAt(afterIdx) : -1;
  // Kind 6: a block tag, followed by space, tab, end of line, '>' or '/>'.
  if (BLOCK_TAGS.has(tag)) {
    if (
      next === -1 ||
      next === 32 ||
      next === 9 ||
      next === 62 ||
      (next === 47 && afterIdx + 1 < rest.length && rest.charCodeAt(afterIdx + 1) === 62)
    ) {
      return 6;
    }
    return 0;
  }
  // Kind 7: a complete open or closing tag, and nothing but whitespace
  // after it on the line.
  if (isCompleteTag(rest)) return 7;
  return 0;
}
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);
// Does this line satisfy the end condition for an HTML block of the
// given kind (kinds 1-5)? Used both when the block opens and when it
// continues.
function htmlEndOnLine(kind, line) {
  if (kind === 1) {
    const low = line.toLowerCase();
    return (
      low.indexOf('</script>') !== -1 ||
      low.indexOf('</pre>') !== -1 ||
      low.indexOf('</style>') !== -1 ||
      low.indexOf('</textarea>') !== -1
    );
  }
  if (kind === 2) return line.indexOf('-->') !== -1;
  if (kind === 3) return line.indexOf('?>') !== -1;
  if (kind === 4) return line.indexOf('>') !== -1;
  if (kind === 5) return line.indexOf(']]>') !== -1;
  return false;
}

// Replace node `old` with `replacement` in its parent's children.
function replaceNode(st, old, replacement) {
  for (let i = st.stack.length - 1; i >= 0; i--) {
    const parent = st.stack[i];
    if (parent.children) {
      const idx = parent.children.indexOf(old);
      if (idx !== -1) {
        parent.children[idx] = replacement;
        return;
      }
    }
  }
}

// Start new blocks from the line remainder. pos is {s, col}.
function startBlocks(st, pos) {
  const [ind, idx] = measureIndent(pos.s, pos.col);
  // A blank remainder (the line held only container markers) starts no
  // block — it is a blank line inside the container.
  if (pos.s.slice(idx).length === 0) return;
  if (ind > 3) {
    // Indented code (cannot interrupt a paragraph, but we only get here
    // when the tip is not a paragraph).
    const tip = stackTop(st);
    if (tip.t !== 'para') {
      const node = { t: 'code', fenced: false, info: '', lines: [sliceFromCol(pos.s, 4, pos.col)], indent: pos.col + 4 };
      pushBlock(st, node);
      return;
    }
  }
  const rest = pos.s.slice(idx);
  const baseCol = pos.col + ind;
  // ATX heading.
  if (rest.charCodeAt(0) === 35 && isAtxHeading(rest)) {
    let i = 0;
    while (i < rest.length && rest.charCodeAt(i) === 35) i++;
    const level = i;
    let text = rest.slice(i);
    // Strip all leading spaces/tabs.
    text = text.replace(/^[ \t]+/, '');
    // Strip trailing spaces and an optional closing sequence of #'s.
    text = text.replace(/[ \t]+$/, '');
    const m = /[ \t]+#+$/.exec(text);
    if (m) text = text.slice(0, m.index).replace(/[ \t]+$/, '');
    else {
      const m2 = /^#+$/.exec(text);
      if (m2) text = '';
    }
    addChild(st, { t: 'heading', level, text });
    return;
  }
  // Fenced code.
  if ((rest.charCodeAt(0) === 96 || rest.charCodeAt(0) === 126) && isFenceStart(rest)) {
    const fenceChar = rest.charCodeAt(0);
    let i = 0;
    while (i < rest.length && rest.charCodeAt(i) === fenceChar) i++;
    // A backtick fence's info string may not contain a backtick.
    const info = rest.slice(i).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (fenceChar === 96 && info.indexOf('`') !== -1) {
      // Not a fence; fall through to paragraph.
    } else {
      const node = { t: 'code', fenced: true, fenceChar, fenceLen: i, fenceIndent: ind, fenceWsChars: idx, indent: pos.col + ind, info, lines: [] };
      pushBlock(st, node);
      return;
    }
  }
  // HTML block (kinds 1-6 can interrupt a paragraph; kind 7 cannot, but
  // we only reach here when the tip is not a paragraph).
  if (rest.charCodeAt(0) === 60) {
    const kind = htmlBlockKind(rest);
    if (kind >= 1) {
      const node = { t: 'html', kind, lines: [pos.s] };
      if (kind <= 5 && htmlEndOnLine(kind, pos.s)) {
        // The block ends on its opening line (e.g. `<!-- x -->` or
        // `<style>…</style>`): add it as a closed child, not an open
        // container, so the next line starts a new block.
        addChild(st, node);
      } else {
        pushBlock(st, node);
      }
      return;
    }
  }
  // Thematic break.
  if (isThematicBreak(rest)) {
    addChild(st, { t: 'hr' });
    return;
  }
  // Blockquote.
  if (rest.charCodeAt(0) === 62) {
    const node = { t: 'quote', children: [] };
    pushBlock(st, node);
    // Consume the '>' and one following column of whitespace (the run
    // is expanded first, tabs to spaces, as in matchContainers).
    let r = rest.slice(1);
    let rcol = baseCol + 1;
    if (r.length > 0) {
      const ws = /^[ \t]+/.exec(r);
      if (ws) {
        r = expandLeadingWs(r, rcol).slice(1);
        rcol++;
      }
    }
    if (isBlankLine(r)) {
      // An empty quote line: the quote is open but has no content yet.
      return;
    }
    startBlocks(st, { s: r, col: rcol });
    return;
  }
  // List.
  const lst = isListStart(rest);
  if (lst) {
    startList(st, pos, rest, baseCol, lst);
    return;
  }
  // Otherwise, a paragraph. lastLazy tracks whether the most recent
  // line joined lazily (its containers did not match): marked splits a
  // block quote into chunks at matched lines, and a setext-looking lazy
  // line is indented only when the previous line was lazy too.
  const node = { t: 'para', lines: [pos.s], lastLazy: false };
  pushBlock(st, node);
}

function startList(st, pos, rest, baseCol, lst) {
  // Compute the content indent: marker width + spaces after it (1-4
  // columns); 5+ spaces means content indent is marker + 1 and the extra
  // spaces are content. An empty item has content indent marker + 1.
  const afterMarker = rest.slice(lst.markerLen);
  const [sp, spIdx] = measureIndent(afterMarker);
  let contentIndent;
  let content;
  if (afterMarker.length === 0 || isBlankLine(afterMarker)) {
    contentIndent = lst.markerLen + 1;
    content = '';
  } else if (sp >= 5) {
    contentIndent = lst.markerLen + 1;
    content = sliceFromCol(afterMarker, 1);
  } else {
    contentIndent = lst.markerLen + sp;
    content = afterMarker.slice(spIdx);
  }
  // The content indent is relative to the marker, but a continuation
  // line is measured from the start of the container-stripped
  // remainder, so what the item branch compares against is the
  // content's offset within that remainder: the marker's own offset
  // (the remainder's leading indent) plus the marker-relative indent.
  // Using only the marker-relative indent is wrong whenever the list
  // itself is indented (it strips too little, leaving a stray space
  // in paragraph text and matching lines that belong to a sibling
  // item); using absolute columns is wrong inside block quotes, where
  // the markers differ in width from line to line. This offset is the
  // quantity that is the same for every line of the item.
  const contentCol = measureIndent(pos.s, pos.col)[0] + contentIndent;
  const item = { t: 'item', children: [], contentIndent, contentCol, blankAfter: false };
  const tip = stackTop(st);
  let listNode = null;
  if (tip.t === 'list' && tip.ordered === lst.ordered && Math.abs(baseCol - tip.markerCol) <= 3) {
    // Same kind continues the list (bullet char and ordered delimiter
    // must match for a new list to start; we track the marker char).
    // The marker must sit within 3 columns of the list's own marker
    // column; a deeper marker starts a nested list instead.
    const sameMarker =
      (lst.ordered && tip.delim === rest.charAt(lst.markerLen - 1)) ||
      (!lst.ordered && tip.markerChar === rest.charAt(0));
    if (sameMarker) listNode = tip;
  }
  if (!listNode) {
    listNode = {
      t: 'list',
      ordered: lst.ordered,
      start: lst.ordered ? lst.start : 0,
      delim: lst.ordered ? rest.charAt(lst.markerLen - 1) : '',
      markerChar: lst.ordered ? '' : rest.charAt(0),
      markerCol: baseCol,
      tight: true,
      children: [],
    };
    pushBlock(st, listNode);
  }
  pushBlock(st, item);
  if (content !== '') {
    startBlocks(st, { s: content, col: pos.col + contentCol });
  }
  // If the content is empty, the item stays open for following lines.
}

// Continue a fenced or indented code block. Returns true if consumed.
// Expand tabs in a line to spaces, using absolute tab stops (every 4
// columns) starting from column `base`. Used for fenced code content,
// where tabs do not survive verbatim.
function expandTabs(s, base) {
  let out = '';
  let col = base;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9) {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += s[i];
      col++;
    }
  }
  return out;
}

function continueCode(st, code, pos) {
  if (code.fenced) {
    const [ind, idx] = measureIndent(pos.s, pos.col);
    const rest = pos.s.slice(idx);
    if (ind <= 3 && rest.charCodeAt(0) === code.fenceChar) {
      let i = 0;
      while (i < rest.length && rest.charCodeAt(i) === code.fenceChar) i++;
      if (i >= code.fenceLen) {
        // Closing fence: only whitespace may follow.
        let ok = true;
        for (let j = i; j < rest.length; j++) {
          const c = rest.charCodeAt(j);
          if (c !== 32 && c !== 9) {
            ok = false;
            break;
          }
        }
        if (ok) return 'closed'; // line consumed as the closing fence
      }
    }
    // Content line. marked's indent compensation (Dt) applies only
    // to BACKTICK fences: it strips up to the fence's leading
    // whitespace (in CHARACTERS, via dtStrip) from each content
    // line. A TILDE fence keeps its content verbatim (the regex
    // /^(\s+)(?:```)/ never matches `~~~`), so push the
    // post-container remainder as-is. (pos.s is already the remainder
    // after blockquote/list stripping; slicing it by pos.col would
    // drop real spaces.)
    if (code.fenceChar === 96) {
      code.lines.push(dtStrip(pos.s, code.fenceWsChars));
    } else {
      code.lines.push(pos.s);
    }
    return true;
  }
  // Indented code: needs 4+ columns of indent.
  const [ind] = measureIndent(pos.s, pos.col);
  if (ind >= 4) {
    code.lines.push(sliceFromCol(pos.s, 4, pos.col));
    return true;
  }
  return false;
}

// Continue an HTML block. Returns true if consumed (false closes it).
function continueHtml(st, html, pos) {
  const s = pos.s;
  html.lines.push(s);
  // Kinds 1-5 end when a line contains their closing marker; kinds 6
  // and 7 end at a blank line (handled by processBlankLine).
  if (html.kind <= 5 && htmlEndOnLine(html.kind, s)) return false;
  return true;
}

// Continue a table: any non-blank line that does not start another block
// is a row. Returns true if consumed.
function continueTable(st, table, pos) {
  const s = pos.s;
  const [ind, idx] = measureIndent(s, pos.col);
  if (ind > 3) {
    table.rows.push(splitTableRow(s));
    return true;
  }
  const rest = s.slice(idx);
  if (isInterruptStart(rest)) return false;
  table.rows.push(splitTableRow(s));
  return true;
}
// Parse a table delimiter row into alignments, or null. Each cell must
// be colons and dashes only, with at least one dash.
function parseTableDelimiter(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.charCodeAt(0) === 58 && c.charCodeAt(c.length - 1) === 58) aligns.push('center');
    else if (c.charCodeAt(c.length - 1) === 58) aligns.push('right');
    else if (c.charCodeAt(0) === 58) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}
// Split a table row line into cells: split on unescaped '|' outside code
// spans; a leading/trailing '|' is dropped.
function splitTableRow(line) {
  // Marked's de(): a pipe splits a cell unless it is escaped
  // (preceded by an odd run of backslashes). Code spans do NOT
  // protect a pipe: `| `a | b` | c |` splits into `a and b` (two
  // cells), so no code-span tracking here at all. Unescaped pipes
  // are marked with a space, the row is split on ' |', a leading /
  // trailing empty cell is dropped, and `\|` becomes a literal '|'.
  let t = '';
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 124) {
      let bs = 0;
      let p = i - 1;
      while (p >= 0 && line.charCodeAt(p) === 92) { bs++; p--; }
      t += bs % 2 === 1 ? '|' : ' |';
    } else {
      t += line[i];
    }
  }
  const parts = t.split(' |');
  if (parts.length > 0 && parts[0].trim() === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
  return parts.map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

// Strip leading link reference definitions from a paragraph's lines,
// registering them in st.refs. Returns the index of the first line
// that is not part of a reference definition.
function stripRefDefs(st, lines) {
  let i = 0;
  while (i < lines.length) {
    const parsed = parseRefDef(lines, i);
    if (!parsed) break;
    const label = normalizeLabel(decodeForLabel(parsed.label));
    if (label !== '' && !st.refs.has(label)) {
      st.refs.set(label, { dest: parsed.dest, title: parsed.title });
    }
    i = parsed.nextLine;
  }
  return i;
}

// Finalize a paragraph: extract leading link reference definitions; if
// nothing remains, remove the paragraph from its parent.
function finalizeParagraph(st, para) {
  const lines = para.lines;
  const i = stripRefDefs(st, lines);
  if (i >= lines.length) {
    // The whole paragraph was reference definitions: remove it.
    const parent = stackTop(st);
    if (parent && parent.children) {
      const idx = parent.children.indexOf(para);
      if (idx !== -1) parent.children.splice(idx, 1);
    }
    para.lines = [];
    para.dead = true;
  } else {
    para.lines = lines.slice(i);
  }
}

// Try to parse a link reference definition starting at lines[i].
// Returns {label, dest, title, nextLine} or null.
function parseRefDef(lines, i) {
  let line = lines[i];
  let p = 0;
  // Up to 3 spaces of indent.
  const [ind, idx] = measureIndent(line);
  if (ind > 3) return null;
  p = idx;
  if (p >= line.length || line.charCodeAt(p) !== 91) return null; // '['
  // Label: up to the next unescaped ']'. It may span lines; the
  // newlines become part of the label (collapsed by normalizeLabel).
  // Backslash escapes are kept raw in the label (they matter for
  // matching: `foo\!` is not `foo!`), but the escaped char does not
  // close the label.
  let lli = i;
  let lline = line;
  let j = p + 1;
  let label = '';
  let found = false;
  while (true) {
    while (j < lline.length) {
      const c = lline.charCodeAt(j);
      if (c === 92 && j + 1 < lline.length) {
        label += lline[j] + lline[j + 1];
        j += 2;
        continue;
      }
      if (c === 93) {
        found = true;
        break;
      }
      if (c === 91) return null;
      label += lline[j];
      j++;
    }
    if (found) break;
    // Continue the label on the next line.
    if (lli + 1 >= lines.length) break;
    lli++;
    lline = lines[lli];
    label += '\n';
    j = 0;
  }
  if (!found || label.length === 0 || label.length > 999) return null;
  // A label that normalizes to empty (only whitespace) is not a label.
  if (normalizeLabel(decodeForLabel(label)) === '') return null;
  j++; // past ']'
  // Skip whitespace; a ':' must follow on the same line as the ']'.
  line = lline;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j >= line.length || line.charCodeAt(j) !== 58) return null; // ':'
  j++;
  // Destination: may be on this line or the next. Track (line, char).
  let li = lli;
  let pos = j;
  const skipWs = () => {
    while (true) {
      while (pos < lines[li].length && (lines[li].charCodeAt(pos) === 32 || lines[li].charCodeAt(pos) === 9)) pos++;
      if (pos < lines[li].length) return true;
      if (li + 1 >= lines.length) return false;
      li++;
      pos = 0;
    }
  };
  if (!skipWs()) return null;
  line = lines[li];
  let dest = '';
  if (line.charCodeAt(pos) === 60) {
    // Angle-bracket destination: no <, > or newline inside; backslash
    // escapes resolve.
    let k = pos + 1;
    let ok = false;
    let d = '';
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (c === 62) {
        ok = true;
        break;
      }
      if (c === 60 || c === 10) break;
      if (c === 92 && k + 1 < line.length && isPunctCode(line.charCodeAt(k + 1))) {
        d += line[k + 1];
        k += 2;
        continue;
      }
      d += line[k];
      k++;
    }
    if (!ok) return null;
    dest = d;
    pos = k + 1;
  } else {
    // Bare destination: no spaces, balanced parens; backslash escapes
    // resolve to the escaped char.
    let k = pos;
    let depth = 0;
    let d = '';
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (c === 32 || c === 9) break;
      if (c === 92 && k + 1 < line.length && isPunctCode(line.charCodeAt(k + 1))) {
        d += line[k + 1];
        k += 2;
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      d += line[k];
      k++;
    }
    if (k === pos) return null;
    if (depth !== 0) return null;
    dest = d;
    pos = k;
  }
  // Optional title: may be on this line or the next, and may span
  // several lines (the newlines become part of the title). A title must
  // be preceded by whitespace (a space, tab, or newline) — a quote or
  // paren immediately after the destination is trailing garbage, not a
  // title.
  let title = null;
  const saveLi = li;
  const savePos = pos;
  if (skipWs()) {
    line = lines[li];
    const q = line.charCodeAt(pos);
    if (q === 34 || q === 39 || q === 40) {
      // No whitespace was skipped: the quote/paren touches the dest.
      if (li === saveLi && pos === savePos) return null;
      const close = q === 40 ? 41 : q;
      let k = pos + 1;
      let t = '';
      let ok = false;
      let curLi = li;
      let curLine = line;
      while (true) {
        while (k < curLine.length) {
          const c = curLine.charCodeAt(k);
          if (c === 92 && k + 1 < curLine.length && isPunctCode(curLine.charCodeAt(k + 1))) {
            t += curLine[k + 1];
            k += 2;
            continue;
          }
          if (c === close) {
            ok = true;
            break;
          }
          if (q === 40 && c === 40) break; // no nested ( in paren titles
          t += curLine[k];
          k++;
        }
        if (ok) break;
        // The closing quote is not on this line: continue on the next.
        if (curLi + 1 >= lines.length) break;
        if (q === 40) break; // paren titles do not span lines
        curLi++;
        curLine = lines[curLi];
        t += '\n';
        k = 0;
      }
      if (ok) {
        title = t;
        li = curLi;
        pos = k + 1;
      } else {
        // Not a valid title: rewind (the definition ends here).
        li = saveLi;
        pos = savePos;
        title = null;
      }
    } else {
      li = saveLi;
      pos = savePos;
    }
  }
  // Only whitespace may follow on the final line. If a title was found
  // but garbage follows it on a later line than the destination, the
  // title is dropped and the definition ends after the destination —
  // the title line stays as paragraph content. (If the title is on the
  // same line as the destination, the whole definition fails.)
  line = lines[li];
  let p2 = pos;
  while (p2 < line.length) {
    const c = line.charCodeAt(p2);
    if (c !== 32 && c !== 9) {
      if (title !== null && li > saveLi) {
        return { label, dest, title: null, nextLine: saveLi + 1 };
      }
      return null;
    }
    p2++;
  }
  return { label, dest, title, nextLine: li + 1 };
}

// Resolve tight/loose for lists: a list is loose if any of its items is
// separated by a blank line from the next item, or contains two block
// children separated by a blank line.
function resolveLooseLists(node) {
  if (!node.children) return;
  if (node.t === 'list') {
    let loose = false;
    const items = node.children;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.blankAfter && i + 1 < items.length) loose = true;
      // Two block children separated by a blank line inside the item.
      if (item.children && item.children.length > 1) {
        for (let k = 1; k < item.children.length; k++) {
          if (item.children[k].blankBefore) loose = true;
        }
      }
    }
    node.tight = !loose;
  }
  for (const child of node.children) resolveLooseLists(child);
}


// ---------- inline parsing (round-2 hand-written) ----------
// Inline content is scanned into a flat part list; links nest their label
// parts as children. Emphasis is resolved after the scan (so a delimiter
// inside a link label can pair within the label, while one trapped by a
// formed link never pairs outward). Bare-URL autolinks are tentative:
// they render as links only if no enclosing link claims them.
//
// Part kinds: t=text, d=delimiter run, c=code span, a=link, i=image,
// u=tentative autolink, h=raw inline html, b=hard break, e=em, s=strong,
// x=del. A link/image part carries kids (its label parts).

// Render one inline string to HTML. refs maps a normalized label to
// {dest, title}.
function renderInline(src, refs) {
  const S = {
    src,
    refs,
    parts: [],
    dels: [], // delimiter records {ch, run, rem, open, close, node, at}
    opens: [], // link openers {node, img, at, start}
    masks: [], // [start, end] source ranges whose delimiters are suppressed
    pos: 0,
    lit: '',
  };
  scanInline(S);
  flushLit(S);
  resolveEmphasis(S);
  return partsHtml(S.parts, S);
}

// Flush pending literal text into a text part.
function flushLit(S) {
  if (S.lit !== '') {
    S.parts.push({ k: 't', s: S.lit });
    S.lit = '';
  }
}
function pushPart(S, part) {
  flushLit(S);
  S.parts.push(part);
  return part;
}
function addLit(S, s) {
  S.lit += s;
}

// Record an emphasis delimiter run as its own part and in the delim list.
function addDelim(S, ch, run, open, close) {
  flushLit(S);
  const rec = { ch, run, rem: run, open, close, node: null, at: S.pos };
  const part = { k: 'd', rec };
  rec.node = part;
  S.parts.push(part);
  S.dels.push(rec);
  return rec;
}

// Scan a code span starting at S.pos (a backtick). Returns true and leaves
// S.pos past the span, or false (caller emits a literal backtick).
function scanCodeSpan(S) {
  const src = S.src;
  const n = src.length;
  let j = S.pos;
  while (j < n && src.charCodeAt(j) === 96) j++;
  const ticks = j - S.pos;
  let k = j;
  while (k < n) {
    if (src.charCodeAt(k) === 96) {
      let m = k;
      while (m < n && src.charCodeAt(m) === 96) m++;
      if (m - k === ticks) {
        let content = src.slice(j, k);
        if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
        if (
          content.length >= 2 &&
          content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32 &&
          content.trim() !== ''
        ) {
          content = content.slice(1, -1);
        }
        pushPart(S, { k: 'c', s: content });
        S.pos = m;
        return true;
      }
      k = m;
    } else {
      k++;
    }
  }
  return false;
}

// Main inline scan.
function scanInline(S) {
  const src = S.src;
  const n = src.length;
  while (S.pos < n) {
    const c = src.charCodeAt(S.pos);
    if (c === 92) {
      // Backslash: escape punctuation, or a hard break before a newline.
      // An escaped HTML-special char is pre-escaped so the renderer does
      // not mistake it for an entity start (e.g. \&ouml; -> &amp;ouml;).
      if (S.pos + 1 < n) {
        const d = src.charCodeAt(S.pos + 1);
        if (d === 10) {
          pushPart(S, { k: 'b' });
          S.pos += 2;
          // A hard break consumes the next line's leading whitespace.
          while (S.pos < n && (src.charCodeAt(S.pos) === 32 || src.charCodeAt(S.pos) === 9)) S.pos++;
          continue;
        }
        if (isPunctCode(d)) {
          const ch = src[S.pos + 1];
          // Only '&' is pre-escaped: a raw '&' here would let the
          // renderer mistake following text for an entity. The other
          // HTML-special chars are added raw and escaped on render.
          if (ch === '&') addLit(S, '&amp;');
          else addLit(S, ch);
          S.pos += 2;
          continue;
        }
      }
      addLit(S, '\\');
      S.pos++;
      continue;
    }
    if (c === 96) {
      // Code span.
      if (scanCodeSpan(S)) continue;
      // No matching closing run: the whole backtick run is literal
      // text (a shorter run inside it must not pair up on its own).
      let j = S.pos;
      while (j < n && src.charCodeAt(j) === 96) j++;
      addLit(S, src.slice(S.pos, j));
      S.pos = j;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) {
      // Emphasis / strikethrough delimiter run.
      let j = S.pos;
      while (j < n && src.charCodeAt(j) === c) j++;
      const run = j - S.pos;
      if (c === 126 && run >= 3) {
        // A run of 3+ tildes never strikes: literal text.
        addLit(S, src.slice(S.pos, j));
        S.pos = j;
        continue;
      }
      const before = S.pos > 0 ? src.charCodeAt(S.pos - 1) : 10;
      const after = j < n ? src.charCodeAt(j) : 10;
      const beforeCh = S.pos > 0 ? src[S.pos - 1] : '';
      const afterCh = j < n ? src[j] : '';
      const lf = !isSpaceCode(after) && (!isFlankPunct(after, afterCh) || isSpaceCode(before) || isFlankPunct(before, beforeCh));
      const rf = !isSpaceCode(before) && (!isFlankPunct(before, beforeCh) || isSpaceCode(after) || isFlankPunct(after, afterCh));
      let open = false;
      let close = false;
      if (c === 42) {
        open = lf;
        close = rf;
      } else if (c === 95) {
        open = lf && (!rf || isFlankPunct(before, beforeCh));
        close = rf && (!lf || isFlankPunct(after, afterCh));
      } else {
        open = lf;
        close = rf;
      }
      addDelim(S, c === 42 ? '*' : c === 95 ? '_' : '~', run, open, close);
      S.pos = j;
      continue;
    }
    if (c === 91 || (c === 33 && S.pos + 1 < n && src.charCodeAt(S.pos + 1) === 91)) {
      // '[' or '![': a link/image opener.
      const img = c === 33;
      const at = img ? S.pos + 1 : S.pos;
      flushLit(S);
      const node = { k: 't', s: img ? '![' : '[' };
      S.parts.push(node);
      S.opens.push({ node, img, at, start: S.parts.length });
      S.pos = at + 1;
      continue;
    }
    if (c === 93) {
      // ']': try to form a link from the nearest opener.
      if (tryLink(S)) continue;
      addLit(S, ']');
      S.pos++;
      continue;
    }
    if (c === 60) {
      // '<': autolink, email autolink, or inline HTML.
      if (tryAngle(S)) continue;
      addLit(S, '&lt;');
      S.pos++;
      continue;
    }
    if (c === 38) {
      // '&': character reference.
      const ent = tryEntity(src, S.pos);
      if (ent !== null) {
        addLit(S, ent[0]);
        S.pos = ent[1];
        continue;
      }
      addLit(S, '&amp;');
      S.pos++;
      continue;
    }
    if (c === 10) {
      // Newline: hard break if the line ends with 2+ spaces, else soft.
      if (S.lit.length >= 2) {
        let k = S.lit.length;
        let spaces = 0;
        while (k > 0 && S.lit.charCodeAt(k - 1) === 32) {
          spaces++;
          k--;
        }
        if (spaces >= 2) {
          S.lit = S.lit.slice(0, k);
          pushPart(S, { k: 'b' });
          S.pos++;
          // A hard break consumes the next line's leading whitespace.
          while (S.pos < n && (src.charCodeAt(S.pos) === 32 || src.charCodeAt(S.pos) === 9)) S.pos++;
          continue;
        }
      }
      addLit(S, '\n');
      S.pos++;
      continue;
    }
    if (c === 64) {
      // '@': possible email autolink (local part is behind us).
      if (tryEmail(S)) continue;
      addLit(S, '@');
      S.pos++;
      continue;
    }
    // Possible bare-URL autolink start (www. or a scheme).
    if ((c === 119 && src.startsWith('www.', S.pos)) || isAlphaCode(c)) {
      if (tryBareUrl(S)) continue;
    }
    addLit(S, src[S.pos]);
    S.pos++;
  }
  flushLit(S);
}

// Find the ']' closing a link label starting just after '[' at `from`,
// using marked's toggle rule: every backtick run flips code-span state,
// and ']' only counts when not in a code span and at bracket level 0.
// Returns the index or -1.
function findLabelEndToggle(src, from) {
  let level = 0;
  let inCode = false;
  let codeTicks = 0;
  let i = from;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    if (c === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const ticks = j - i;
      if (inCode) {
        // Only a run of the same length closes the span; a shorter
        // or longer run inside it is literal content (a single
        // backtick inside a double-backtick span must not flip the
        // state, or the label end after the span is missed).
        if (ticks === codeTicks) {
          inCode = false;
          codeTicks = 0;
        }
      } else {
        inCode = true;
        codeTicks = ticks;
      }
      i = j;
      continue;
    }
    if (inCode) {
      i++;
      continue;
    }
    if (c === 91) {
      level++;
      i++;
      continue;
    }
    if (c === 93) {
      if (level === 0) return i;
      level--;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Find the ']' closing a link label starting just after '[' at `from`,
// with proper code-span matching (a run of N backticks closes only at a
// run of exactly N). Returns the index or -1.
function findLabelEndProper(src, from) {
  let level = 0;
  let i = from;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    if (c === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const ticks = j - i;
      let k = j;
      let closed = false;
      while (k < n) {
        if (src.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && src.charCodeAt(m) === 96) m++;
          if (m - k === ticks) {
            i = m;
            closed = true;
            break;
          }
          k = m;
        } else {
          k++;
        }
      }
      if (!closed) i = j; // unclosed run is literal; keep scanning
      continue;
    }
    if (c === 91) {
      level++;
      i++;
      continue;
    }
    if (c === 93) {
      if (level === 0) return i;
      level--;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Does the label source src[from..to] hold a code span whose content
// contains a backtick? (Such a span is what defeats the toggle scan.)
function labelHasDirtySpan(src, from, to) {
  let i = from;
  while (i < to) {
    if (src.charCodeAt(i) === 96) {
      let j = i;
      while (j < to && src.charCodeAt(j) === 96) j++;
      const ticks = j - i;
      let k = j;
      let closed = false;
      while (k < to) {
        if (src.charCodeAt(k) === 96) {
          let m = k;
          while (m < to && src.charCodeAt(m) === 96) m++;
          if (m - k === ticks) {
            if (src.slice(j, k).indexOf('`') !== -1) return true;
            i = m;
            closed = true;
            break;
          }
          k = m;
        } else {
          k++;
        }
      }
      if (!closed) return false;
      continue;
    }
    i++;
  }
  return false;
}

// Does the label source src[from..to] hold a code span whose content
// contains a backtick AND whose closing run does not end exactly at
// `to` (the label's `]`)? Marked's label regex matches such a dirty
// span only when its closing run sits immediately before `]` (the
// ``+(?=\]) alternative); a dirty span mid-label, with text after it
// before `]`, defeats the label match, so the link does not form
// (`[a `` x ` y `` b](url)` stays literal, while
// `[a `` x ` y ``](url)` links).
function labelHasDirtySpanNotAtEnd(src, from, to) {
  let i = from;
  while (i < to) {
    if (src.charCodeAt(i) === 96) {
      let j = i;
      while (j < to && src.charCodeAt(j) === 96) j++;
      const ticks = j - i;
      let k = j;
      let closed = false;
      while (k < to) {
        if (src.charCodeAt(k) === 96) {
          let m = k;
          while (m < to && src.charCodeAt(m) === 96) m++;
          if (m - k === ticks) {
            if (src.slice(j, k).indexOf('`') !== -1 && m !== to) return true;
            i = m;
            closed = true;
            break;
          }
          k = m;
        } else {
          k++;
        }
      }
      if (!closed) return false;
      continue;
    }
    i++;
  }
  return false;
}

// Parse `(dest "title")` starting at src[i] === '('. Returns
// {dest, title, end} (end is just past ')') or null.
function parseInlineDest(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
  if (j >= n) return null;
  let dest = '';
  if (src.charCodeAt(j) === 60) {
    // Angle-bracket destination: no unescaped '<', '>' or newline
    // inside. A backslash escapes the next char (so `\>` does not end
    // the destination).
    let k = j + 1;
    let out = '';
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 10) return null;
      if (c === 60) return null;
      if (c === 62) break;
      if (c === 92 && k + 1 < n && isPunctCode(src.charCodeAt(k + 1))) {
        out += src[k + 1];
        k += 2;
        continue;
      }
      out += src[k];
      k++;
    }
    if (k >= n || src.charCodeAt(k) !== 62) return null;
    dest = out;
    j = k + 1;
  } else {
    let depth = 0;
    let k = j;
    let out = '';
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 40) {
        depth++;
        out += '(';
        k++;
        continue;
      }
      if (c === 41) {
        if (depth === 0) break;
        depth--;
        out += ')';
        k++;
        continue;
      }
      if (c === 92 && k + 1 < n && isPunctCode(src.charCodeAt(k + 1))) {
        out += src[k + 1];
        k += 2;
        continue;
      }
      out += src[k];
      k++;
    }
    // An empty destination is valid (the link's href is "").
    if (k === j && src.charCodeAt(k) !== 41) return null;
    if (depth !== 0) return null;
    dest = out;
    j = k;
  }
  while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
  let title = null;
  if (j < n && (src.charCodeAt(j) === 34 || src.charCodeAt(j) === 39 || src.charCodeAt(j) === 40)) {
    const q = src.charCodeAt(j);
    if (q === 40) {
      let k = j + 1;
      let out = '';
      let ok = false;
      while (k < n) {
        const c = src.charCodeAt(k);
        if (c === 92 && k + 1 < n && isPunctCode(src.charCodeAt(k + 1))) {
          out += src[k + 1];
          k += 2;
          continue;
        }
        if (c === 40) return null;
        if (c === 41) {
          ok = true;
          break;
        }
        out += src[k];
        k++;
      }
      if (!ok) return null;
      title = out;
      j = k + 1;
    } else {
      let k = j + 1;
      let out = '';
      let ok = false;
      while (k < n) {
        const c = src.charCodeAt(k);
        if (c === 92 && k + 1 < n && isPunctCode(src.charCodeAt(k + 1))) {
          out += src[k + 1];
          k += 2;
          continue;
        }
        if (c === q) {
          ok = true;
          break;
        }
        out += src[k];
        k++;
      }
      if (!ok) return null;
      title = out;
      j = k + 1;
    }
    while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
  }
  if (j >= n || src.charCodeAt(j) !== 41) return null;
  return { dest, title, end: j + 1 };
}

// Try to form a link/image from the nearest opener at the ']' at S.pos.
// Returns true and advances S.pos past the link, or false.
function tryLink(S) {
  const src = S.src;
  const n = src.length;
  if (S.opens.length === 0) return false;
  flushLit(S);
  const op = S.opens[S.opens.length - 1];
  const labelStart = op.at + 1;
  const labelEnd = S.pos;
  const after = S.pos + 1;

  function lookupRef(labelSrc) {
    const key = normalizeLabel(decodeForLabel(labelSrc));
    if (key === '') return null;
    return S.refs.get(key) || null;
  }
  // Build the link/image part from the label parts. Tentative autolinks
  // inside a formed link's label become plain text.
  function build(dest, title) {
    const kids = S.parts.slice(op.start);
    for (const p of kids) if (p.k === 'u') p.live = false;
    const part = op.img
      ? { k: 'i', src: dest, title, kids }
      : { k: 'a', href: dest, title, kids };
    S.parts.length = op.start - 1;
    S.parts.push(part);
    const idx = S.opens.indexOf(op);
    S.opens.length = idx;
    return part;
  }

  // A link cannot contain another link: if this opener's label already
  // holds a formed link, the outer link does not form (the brackets
  // stay literal). Images may contain links in their alt text, so this
  // applies to link openers only.
  if (!op.img) {
    for (let pi = op.start; pi < S.parts.length; pi++) {
      if (S.parts[pi].k === 'a') {
        S.opens.pop();
        return false;
      }
    }
  }

  if (after < n && src.charCodeAt(after) === 40) {
    // Inline link: '(' follows ']'. A label holding a dirty code
    // span mid-label (not ending at this ']') never forms a link in
    // marked, so bail out before the destination parse — but mask the
    // label first, so its `_`/`*` delimiters cannot pair as emphasis
    // either (ref leaves them literal: `[at _node <code>…</code>_`).
    if (labelHasDirtySpanNotAtEnd(src, labelStart, labelEnd)) {
      S.masks.push([op.at, S.pos + 1]);
      S.opens.pop();
      return false;
    }
    const t = findLabelEndToggle(src, labelStart);
    if (t === S.pos) {
      const d = parseInlineDest(src, after);
      if (d) {
        build(d.dest, d.title);
        S.pos = d.end;
        return true;
      }
      // Destination failed: fall back to a shortcut reference.
      const ref = lookupRef(src.slice(labelStart, labelEnd));
      if (ref) {
        build(ref.dest, ref.title);
        S.pos = S.pos + 1;
        return true;
      }
      S.opens.pop();
      return false;
    }
    // Toggle scan disagrees: find the proper label end.
    const p = findLabelEndProper(src, labelStart);
    if (p === -1) {
      S.opens.pop();
      return false;
    }
    if (p !== S.pos) {
      // This ']' is not the label's closer (inside a code span or
      // nested): leave the opener for the real closer.
      return false;
    }
    // Proper closer is this ']', but the toggle scan failed: the label
    // holds a dirty code span. Mask the label so its delimiters cannot
    // pair, then try the inline destination first (the toggle being
    // wrong does not make the `](...)` invalid), falling back to the
    // shortcut reference (reference links do not use the toggle scan).
    if (labelHasDirtySpan(src, labelStart, labelEnd)) {
      S.masks.push([op.at, S.pos + 1]);
    }
    const d = parseInlineDest(src, after);
    if (d) {
      build(d.dest, d.title);
      S.pos = d.end;
      return true;
    }
    const ref = lookupRef(src.slice(labelStart, labelEnd));
    if (ref) {
      build(ref.dest, ref.title);
      S.pos = S.pos + 1;
      return true;
    }
    S.opens.pop();
    return false;
  }
  if (after < n && src.charCodeAt(after) === 91) {
    // Full or collapsed reference: '[' follows ']'.
    const secondEnd = findLabelEndProper(src, after + 1);
    if (secondEnd !== -1) {
      const secondLabel = src.slice(after + 1, secondEnd);
      const ref = secondLabel === ''
        ? lookupRef(src.slice(labelStart, labelEnd))
        : lookupRef(secondLabel);
      if (ref) {
        build(ref.dest, ref.title);
        S.pos = secondEnd + 1;
        return true;
      }
      // A full reference whose label is not defined does not fall back
      // to a shortcut: the outer brackets stay literal.
      S.opens.pop();
      return false;
    }
    // No closing ']' for the second label: not a full reference, so
    // the first label may still be a shortcut reference.
    const ref = lookupRef(src.slice(labelStart, labelEnd));
    if (ref) {
      build(ref.dest, ref.title);
      S.pos = S.pos + 1;
      return true;
    }
    S.opens.pop();
    return false;
  }
  // Shortcut reference.
  const ref = lookupRef(src.slice(labelStart, labelEnd));
  if (ref) {
    build(ref.dest, ref.title);
    S.pos = S.pos + 1;
    return true;
  }
  S.opens.pop();
  return false;
}

// The contiguous literal text ending at S.pos (pending text plus any
// trailing text parts), used to find an email local part.
function textTail(S) {
  let tail = S.lit;
  for (let k = S.parts.length - 1; k >= 0; k--) {
    const p = S.parts[k];
    if (p.k === 't') tail = p.s + tail;
    else break;
  }
  return tail;
}
// Remove `count` chars from the end of the pending / trailing text.
// Text parts and emphasis delimiter runs both contribute characters;
// a delimiter whose run is fully removed is dropped from the list.
function removeTextSuffix(S, count) {
  let need = count;
  if (S.lit.length >= need) {
    S.lit = S.lit.slice(0, S.lit.length - need);
    return;
  }
  need -= S.lit.length;
  S.lit = '';
  for (let k = S.parts.length - 1; k >= 0 && need > 0; k--) {
    const p = S.parts[k];
    if (p.k === 't') {
      if (p.s.length >= need) {
        p.s = p.s.slice(0, p.s.length - need);
        need = 0;
      } else {
        need -= p.s.length;
        p.s = '';
      }
    } else if (p.k === 'd') {
      const take = Math.min(need, p.rec.rem);
      p.rec.rem -= take;
      need -= take;
      if (p.rec.rem === 0) {
        const di = S.dels.indexOf(p.rec);
        if (di !== -1) S.dels.splice(di, 1);
        S.parts.splice(k, 1);
      }
    } else {
      break;
    }
  }
  while (S.parts.length > 0) {
    const last = S.parts[S.parts.length - 1];
    if (last.k === 't' && last.s === '') S.parts.pop();
    else break;
  }
}

// '<' at S.pos: an autolink, an email autolink, or inline HTML.
// Validate the inner content of an open tag (tag name + attributes).
// Returns true if it is a well-formed open tag: a letter-start name,
// attributes each preceded by whitespace, and an optional '/' at the
// end. Used by tryAngle and by the kind-7 HTML block check.
function validateTagAttrs(inner) {
  const tagMatch = /^([A-Za-z][A-Za-z0-9-]*)/.exec(inner);
  if (!tagMatch) return false;
  const rest = inner.slice(tagMatch[0].length);
  let r = 0;
  const rn = rest.length;
  while (r < rn) {
    const wsStart = r;
    while (r < rn && (rest.charCodeAt(r) === 32 || rest.charCodeAt(r) === 9 || rest.charCodeAt(r) === 10)) r++;
    const hadWs = r > wsStart;
    if (r >= rn) break;
    if (rest.charCodeAt(r) === 47) {
      // '/': nothing may follow it except the closing '>'.
      r++;
      if (r !== rn) return false;
      break;
    }
    // An attribute name must be preceded by whitespace.
    if (!hadWs) return false;
    const am = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(rest.slice(r));
    if (!am) return false;
    r += am[0].length;
    // Whitespace may separate the name from '='; only consume it when
    // a '=' actually follows.
    let q = r;
    while (q < rn && (rest.charCodeAt(q) === 32 || rest.charCodeAt(q) === 9 || rest.charCodeAt(q) === 10)) q++;
    if (q < rn && rest.charCodeAt(q) === 61) {
      r = q + 1;
      while (r < rn && (rest.charCodeAt(r) === 32 || rest.charCodeAt(r) === 9 || rest.charCodeAt(r) === 10)) r++;
      if (r >= rn) return false;
      const qc = rest.charCodeAt(r);
      if (qc === 34 || qc === 39) {
        const qq = rest[r];
        r++;
        while (r < rn && rest[r] !== qq) r++;
        if (r >= rn) return false;
        r++;
      } else {
        while (r < rn) {
          const vc = rest.charCodeAt(r);
          if (vc === 32 || vc === 9 || vc === 10 || vc === 34 || vc === 39 || vc === 61 || vc === 60 || vc === 62 || vc === 96) break;
          r++;
        }
      }
    }
  }
  return true;
}

// Validate a complete tag on one line (kind 7 HTML block): exactly one
// open or closing tag plus trailing whitespace. A closing tag may not
// carry attributes.
function isCompleteTag(rest) {
  let j = 1;
  let quote = 0;
  const n = rest.length;
  while (j < n) {
    const c = rest.charCodeAt(j);
    if (quote !== 0) {
      if (c === quote) quote = 0;
      j++;
      continue;
    }
    if (c === 34 || c === 39) {
      quote = c;
      j++;
      continue;
    }
    if (c === 62) break;
    if (c === 60) return false;
    j++;
  }
  if (j >= n) return false;
  if (!/^[ \t]*$/.test(rest.slice(j + 1))) return false;
  const inner = rest.slice(1, j);
  if (inner.length === 0) return false;
  if (inner.charCodeAt(0) === 47) {
    // Closing tag: name + optional whitespace only.
    return /^[A-Za-z][A-Za-z0-9-]*[ \t]*$/.test(inner.slice(1));
  }
  return validateTagAttrs(inner);
}

function tryAngle(S) {
  const src = S.src;
  const n = src.length;
  const i = S.pos;
  // CDATA: <![CDATA[ ... ]]> — content may hold '<' and '>'.
  if (src.startsWith('<![CDATA[', i)) {
    const end = src.indexOf(']]>', i + 9);
    if (end !== -1) {
      pushPart(S, { k: 'h', s: src.slice(i, end + 3) });
      S.pos = end + 3;
      return true;
    }
    return false;
  }
  // Comment: <!-- ... --> — content may hold '<' and '>'. An abruptly
  // closed comment (<!--> or <!--->) ends at its own '>'.
  if (src.startsWith('<!--', i)) {
    if (src.charCodeAt(i + 4) === 62) {
      pushPart(S, { k: 'h', s: src.slice(i, i + 5) });
      S.pos = i + 5;
      return true;
    }
    if (src.charCodeAt(i + 4) === 45 && src.charCodeAt(i + 5) === 62) {
      pushPart(S, { k: 'h', s: src.slice(i, i + 6) });
      S.pos = i + 6;
      return true;
    }
    const end = src.indexOf('-->', i + 4);
    if (end !== -1) {
      pushPart(S, { k: 'h', s: src.slice(i, end + 3) });
      S.pos = end + 3;
      return true;
    }
    return false;
  }
  // Find the closing '>' (quote-aware; a '<' before it fails).
  // Newlines are allowed inside a tag (as whitespace between the name
  // and attributes); autolinks reject them via their own checks.
  let j = i + 1;
  let quote = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (quote !== 0) {
      if (c === quote) quote = 0;
      j++;
      continue;
    }
    if (c === 34 || c === 39) {
      quote = c;
      j++;
      continue;
    }
    if (c === 62) break;
    if (c === 60) return false;
    j++;
  }
  if (j >= n) return false;
  const inner = src.slice(i + 1, j);
  if (inner.length === 0) return false;
  // URI autolink: scheme:...
  if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(inner) && !/\s/.test(inner)) {
    pushPart(S, { k: 'w', href: inner, text: inner });
    S.pos = j + 1;
    return true;
  }
  // Email autolink.
  if (/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(inner)) {
    pushPart(S, { k: 'w', href: 'mailto:' + inner, text: inner });
    S.pos = j + 1;
    return true;
  }
  if (inner.charCodeAt(0) === 33) {
    // Comment, declaration, or CDATA.
    if (inner.startsWith('!--') && inner.endsWith('--') && inner.length >= 3) {
      pushPart(S, { k: 'h', s: src.slice(i, j + 1) });
      S.pos = j + 1;
      return true;
    }
    if (/^!\[CDATA\[/.test(inner) && inner.endsWith(']]')) {
      pushPart(S, { k: 'h', s: src.slice(i, j + 1) });
      S.pos = j + 1;
      return true;
    }
    if (/^[A-Za-z][A-Za-z0-9 ]*$/.test(inner.slice(1))) {
      pushPart(S, { k: 'h', s: src.slice(i, j + 1) });
      S.pos = j + 1;
      return true;
    }
    return false;
  }
  if (inner.charCodeAt(0) === 63) {
    // Processing instruction: ends with '?'.
    if (inner.charCodeAt(inner.length - 1) === 63) {
      pushPart(S, { k: 'h', s: src.slice(i, j + 1) });
      S.pos = j + 1;
      return true;
    }
    return false;
  }
  // A tag: optional '/', a letter-start name, then attributes. Marked
  // emits even the GFM-disallowed tags raw, so they are not rejected here.
  const tagMatch = /^(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(inner);
  if (!tagMatch) return false;
  if (tagMatch[1] === '/') {
    // Closing tag: name + optional whitespace only.
    if (/^[ \t\n]*$/.test(inner.slice(tagMatch[0].length))) {
      pushPart(S, { k: 'h', s: src.slice(i, j + 1) });
      S.pos = j + 1;
      return true;
    }
    return false;
  }
  if (!validateTagAttrs(inner)) return false;
  pushPart(S, { k: 'h', s: src.slice(i, j + 1) });
  S.pos = j + 1;
  return true;
}

// Is the source position inside an emphasis/strikethrough delimiter run
// that can still pair (open or close, with run left)? Such a run is a
// structural delimiter, not literal text.
function isActiveDelimPos(S, pos) {
  for (const r of S.dels) {
    if ((r.open || r.close) && r.rem > 0 && pos >= r.at && pos < r.at + r.run) return true;
  }
  return false;
}

// Is there an unmatched opener of the given delimiter char?
function hasOpenDelim(S, ch) {
  for (const r of S.dels) {
    if (r.ch === ch && r.open && r.rem > 0 && !isMasked(S, r.at)) return true;
  }
  return false;
}

// Is the nearest open link label already holding a formed link? A
// link cannot contain a link, so when the label already holds one the
// outer link cannot form and a bare URL/email inside it is a real
// autolink; when it holds none, the bare URL/email is suppressed so
// the label closer stays available for the outer link (marked lexes
// a link label with autolinks off). Images may hold links in alt
// text, so an image opener never suppresses.
function labelBlocksOuterLink(S) {
  if (S.opens.length === 0) return false;
  const op = S.opens[S.opens.length - 1];
  if (op.img) return false;
  for (let pi = op.start; pi < S.parts.length; pi++) {
    if (S.parts[pi].k === 'a') return true;
  }
  return false;
}

// '@' at S.pos: a bare email autolink (local part is behind us).
// The local part is read from the SOURCE text before '@': a backslash
// escape breaks it (e.g. `foo\+@bar.example.com` forms no link), so the
// rendered text tail must not be used.
function tryEmail(S) {
  // Inside a link label that can still form, a bare email is plain
  // text (the label closer must stay available for the outer link).
  // See tryBareUrl: the gating stays; doc-39 is a known casualty.
  if (S.opens.length > 0 && !labelBlocksOuterLink(S)) return false;
  const src = S.src;
  // Domain: marked's bare-email pattern (labels may hold '_' and '-',
  // at least one dot, last char alnum).
  const dm = /^[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+/.exec(src.slice(S.pos + 1));
  if (!dm) return false;
  const domain = dm[0];
  // The email must not be followed by a word char or '-'. A trailing
  // '_' is allowed only when it closes an open '_' emphasis run
  // (otherwise it is a literal '_' extending the word, and the email
  // does not form).
  const after = S.pos + 1 + domain.length;
  if (after < src.length) {
    const ac = src.charCodeAt(after);
    if (ac === 45 || isAlnumCode(ac)) return false;
    if (ac === 95 && !hasOpenDelim(S, '_')) return false;
  }
  // Scan backwards in the source for the maximal run of valid local
  // characters immediately before '@', stopping at an active
  // delimiter run (a '*' or '_' that opens/closes emphasis is not
  // part of the address; a dead delimiter run is literal text).
  let start = S.pos;
  while (start > 0) {
    const pc = src.charCodeAt(start - 1);
    if (!/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/.test(src[start - 1])) break;
    if ((pc === 42 || pc === 95 || pc === 126) && isActiveDelimPos(S, start - 1)) break;
    start--;
  }
  if (start === S.pos) return false;
  // A backslash immediately before the run breaks the local part.
  if (start > 0 && src.charCodeAt(start - 1) === 92) return false;
  const local = src.slice(start, S.pos);
  if (local.charCodeAt(0) === 46 || local.charCodeAt(local.length - 1) === 46) return false;
  if (local.indexOf('..') !== -1) return false;
  const email = local + '@' + domain;
  removeTextSuffix(S, local.length);
  // Tentative autolink: live on its own, but muted to plain text
  // inside a link label (marked does not link a bare email there).
  pushPart(S, { k: 'u', href: 'mailto:' + email, text: email, live: true });
  S.pos = S.pos + 1 + domain.length;
  return true;
}

// Strip trailing punctuation from a bare URL per GFM.
// Is `name` (the part between '&' and ';') a valid entity reference?
// Numeric references (#123, #x1F) are valid; named references must be a
// known HTML entity.
function isValidEntityName(name) {
  if (name.length === 0) return false;
  if (name.charCodeAt(0) === 35) {
    const rest = name.slice(1);
    if (rest.length === 0) return false;
    if (rest.charCodeAt(0) === 120 || rest.charCodeAt(0) === 88) {
      return /^[0-9A-Fa-f]+$/.test(rest.slice(1)) && rest.length - 1 <= 6;
    }
    return /^[0-9]+$/.test(rest) && rest.length <= 7;
  }
  return COMMON_ENTITIES.has(name);
}
const COMMON_ENTITIES = new Set([
  'amp', 'lt', 'gt', 'quot', 'apos', 'nbsp', 'copy', 'reg', 'trade',
  'hellip', 'mdash', 'ndash', 'laquo', 'raquo', 'lsquo', 'rsquo', 'ldquo',
  'rdquo', 'sbquo', 'bdquo', 'dagger', 'Dagger', 'permil', 'lsaquo',
  'rsaquo', 'euro', 'pound', 'yen', 'cent', 'curren', 'brvbar', 'sect',
  'uml', 'ordf', 'ordm', 'para', 'middot', 'cedil', 'iexcl', 'iquest',
  'szlig', 'agrave', 'aacute', 'acirc', 'atilde', 'auml', 'aring', 'aelig',
  'ccedil', 'egrave', 'eacute', 'ecirc', 'euml', 'igrave', 'iacute',
  'icirc', 'iuml', 'ntilde', 'ograve', 'oacute', 'ocirc', 'otilde', 'ouml',
  'oslash', 'ugrave', 'uacute', 'ucirc', 'uuml', 'yacute', 'yuml', 'thorn',
  'yuml', 'fnof', 'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta',
  'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron',
  'Pi', 'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho',
  'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega', 'thetasym',
  'upsih', 'piv', 'bull', 'hellip', 'prime', 'Prime', 'oline', 'frasl',
  'weierp', 'image', 'real', 'alefsym', 'larr', 'uarr', 'rarr', 'darr',
  'harr', 'crarr', 'lArr', 'uArr', 'rArr', 'dArr', 'hArr', 'forall',
  'part', 'exist', 'empty', 'nabla', 'isin', 'notin', 'ni', 'prod',
  'sum', 'minus', 'lowast', 'radic', 'prop', 'infin', 'ang', 'and', 'or',
  'cap', 'cup', 'int', 'there4', 'sim', 'cong', 'asymp', 'ne', 'equiv',
  'le', 'ge', 'sub', 'sup', 'nsub', 'sube', 'supe', 'oplus', 'otimes',
  'perp', 'sdot', 'lceil', 'rceil', 'lfloor', 'rfloor', 'lang', 'rang',
  'loz', 'spades', 'clubs', 'hearts', 'diams', 'OElig', 'oelig', 'Scaron',
  'scaron', 'Yuml', 'circ', 'tilde', 'ensp', 'emsp', 'thinsp', 'zwnj',
  'zwj', 'lrm', 'rlm', 'ndash', 'mdash', 'lsquo', 'rsquo', 'sbquo',
  'ldquo', 'rdquo', 'bdquo', 'dagger', 'Dagger', 'permil', 'lsaquo',
  'rsaquo', 'euro',
]);

// Marked's _backpedal for a bare URL: the URL is the longest prefix
// segmentable into runs of URL chars, balanced paren groups, '&', and
// runs of punctuation that do not reach the end. An unmatched '('
// ends the URL (its content has no closer), and a trailing run of
// punctuation (? ! . , : ; * _ ~ ) is dropped. This is what stops a
// bare URL inside a link label from swallowing the label closer and
// the destination after it.
function stripBareUrlTail(url) {
  const n = url.length;
  let i = 0;
  while (i < n) {
    const c = url.charCodeAt(i);
    if (c === 40) {
      // '(' opens a balanced group '(' + [^)]* + ')'. With no closer
      // the URL ends before it.
      let j = i + 1;
      while (j < n && url.charCodeAt(j) !== 41) j++;
      if (j >= n) break;
      i = j + 1;
      continue;
    }
    if (c === 38) {
      // '&' not starting an entity (name; at the end) is one chunk.
      let j = i + 1;
      while (j < n && isAlnumCode(url.charCodeAt(j))) j++;
      if (j < n && url.charCodeAt(j) === 59 && j + 1 >= n) break;
      i++;
      continue;
    }
    if (isBackpedalPunct(c)) {
      // A punctuation run is a chunk only when it does not reach the
      // end of the URL (a trailing run is dropped).
      let j = i;
      while (j < n && isBackpedalPunct(url.charCodeAt(j))) j++;
      if (j >= n) break;
      i = j;
      continue;
    }
    // A run of URL chars (not punctuation).
    while (i < n && !isBackpedalPunct(url.charCodeAt(i))) i++;
  }
  return url.slice(0, i);
}

// Punctuation for the bare-URL backpedal: ? ! . , : ; * _ ' " ~ ( ) &.
// (The punctuation-run chunk excludes '(' and '&'.)
function isBackpedalPunct(c) {
  return (
    c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
    c === 42 || c === 95 || c === 39 || c === 34 || c === 126 ||
    c === 40 || c === 41 || c === 38
  );
}

// A bare URL starting at S.pos: 'www.' or a scheme. Tentative autolink.
// It must start at a word boundary: a letter or digit immediately
// before it means it is part of a larger word (e.g. `ailto:` inside
// `mailto:`), not an autolink.
function tryBareUrl(S) {
  // Inside a link label that can still form, a bare URL is plain
  // text (the label closer must stay available for the outer link).
  // build() sets inner 'u' parts live=false when the outer link
  // forms, but letting the URL form here breaks the label-end
  // finding in many docs; the gating stays. (doc-39, where the
  // outer reference does not resolve, is a known casualty.)
  if (S.opens.length > 0 && !labelBlocksOuterLink(S)) return false;
  const src = S.src;
  const n = src.length;
  if (S.pos > 0 && isAlnumCode(src.charCodeAt(S.pos - 1))) return false;
  let url = '';
  if (src.startsWith('www.', S.pos)) {
    const m = /^www\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*/.exec(src.slice(S.pos));
    if (!m) return false;
    const domain = m[0];
    const labels = domain.split('.');
    if (!/^[A-Za-z]{2,}$/.test(labels[labels.length - 1])) return false;
    // The URL runs on past the domain to the next space or '<': a
    // trailing backslash is part of it (www.flux.com\ links with
    // the '\' percent-encoded, not a hard break).
    let urlEnd = S.pos + domain.length;
    {
      let k = urlEnd;
      while (k < n) {
        const c = src.charCodeAt(k);
        if (c === 32 || c === 9 || c === 10 || c === 60) break;
        k++;
      }
      urlEnd = k;
    }
    url = stripBareUrlTail(src.slice(S.pos, urlEnd));
    if (url.length === 0) return false;
    const href = 'http://' + url;
    pushPart(S, { k: 'u', href, text: url, live: true });
    S.pos = S.pos + url.length;
    return true;
  }
  const m = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(src.slice(S.pos));
  if (!m) return false;
  const scheme = m[0].toLowerCase();
  // mailto: and xmpp: carry an email address: validate it with the
  // same rules as a bare email (single-letter TLD ok; a trailing '-'
  // or '_' invalidates the whole link; a trailing '.' or '/' is
  // excluded). xmpp: allows one '/resource' segment after the email.
  if (scheme === 'mailto:' || scheme === 'xmpp:') {
    const emailStart = S.pos + m[0].length;
    const em = /^([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)/.exec(src.slice(emailStart));
    if (!em) return false;
    const local = em[1];
    const domain = em[2];
    if (local.charCodeAt(0) === 46 || local.charCodeAt(local.length - 1) === 46) return false;
    if (local.indexOf('..') !== -1) return false;
    const lastDot = domain.lastIndexOf('.');
    if (lastDot === -1) return false;
    if (!/^[A-Za-z]+$/.test(domain.slice(lastDot + 1))) return false;
    let end = emailStart + em[0].length;
    if (end < n) {
      const ac = src.charCodeAt(end);
      if (ac === 45 || ac === 95 || isAlnumCode(ac)) return false;
    }
    // xmpp: one '/resource' segment (no further '/').
    if (scheme === 'xmpp:' && end < n && src.charCodeAt(end) === 47) {
      let k = end + 1;
      while (k < n) {
        const c = src.charCodeAt(k);
        if (c === 32 || c === 9 || c === 10 || c === 60 || c === 47) break;
        k++;
      }
      if (k > end + 1) end = k;
    }
    url = src.slice(S.pos, end);
    if (url.length <= m[0].length) return false;
    pushPart(S, { k: 'u', href: url, text: url, live: true });
    S.pos = S.pos + url.length;
    return true;
  }
  // A bare scheme URL is only http://, https:// or ftp:// (marked's
  // protocol list): `types:\` is not a URL at all, and a scheme
  // without `://` never autolinks.
  const sch = scheme.slice(0, -1);
  if (sch !== 'http' && sch !== 'https' && sch !== 'ftp') return false;
  if (S.pos + m[0].length + 2 > n || src.charCodeAt(S.pos + m[0].length) !== 47 || src.charCodeAt(S.pos + m[0].length + 1) !== 47) return false;
  let k = S.pos + m[0].length;
  if (k >= n) return false;
  // The URL runs to the next space or '<'. A backslash before a
  // newline is part of the URL (it percent-encodes to %5C), not a
  // hard break: https://img.shields.io.\ links with the '\' in it.
  while (k < n) {
    const c = src.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c === 60) break;
    k++;
  }
  url = stripBareUrlTail(src.slice(S.pos, k));
  if (url.length <= m[0].length) return false;
  pushPart(S, { k: 'u', href: url, text: url, live: true });
  S.pos = S.pos + url.length;
  return true;
}

// Is source index `at` inside a masked range (a failed backtick label)?
function isMasked(S, at) {
  for (const m of S.masks) {
    if (at >= m[0] && at < m[1]) return true;
  }
  return false;
}

// Resolve emphasis within one flat part list. Returns the new list.
function resolveList(parts, S) {
  const recs = S.dels.filter((r) => parts.indexOf(r.node) !== -1);
  for (let ci = 0; ci < recs.length; ci++) {
    const closer = recs[ci];
    if (!closer.close || closer.rem <= 0) continue;
    if (isMasked(S, closer.at)) continue;
    if (parts.indexOf(closer.node) === -1) continue;
    // A closer run can pair with several openers in turn (a run of 3
    // closes a strong and then an em: `*foo**bar***`, cm-415). The
    // inner-closer block below applies only to the closer's FIRST
    // pairing; once it has paired, later openers are free.
    let firstPair = true;
    while (closer.rem > 0) {
      let opener = null;
      // True once this closer was blocked by the inner-pair rule for
      // some opener: it may still pair with a farther opener, but
      // only as a strong (use 2). Pairing as an em (use 1) would
      // steal a delimiter from a strong opener that must form a
      // strong with a later closer.
      let wasBlocked = false;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const o = recs[oi];
        if (!o.open || o.rem <= 0) continue;
        if (o.ch !== closer.ch) continue;
        if (parts.indexOf(o.node) === -1) continue;
        if (isMasked(S, o.at)) continue;
        if (closer.ch === '~') {
          if (o.rem !== closer.rem) continue;
        } else {
          const both = (o.open && o.close) || (closer.open && closer.close);
          if (
            both &&
            (o.rem + closer.rem) % 3 === 0 &&
            !(o.rem % 3 === 0 && closer.rem % 3 === 0)
          ) {
            continue;
          }
        }
        // A spent closer between this opener and the closer, if it
        // can both open and close and closed an inner emphasis whose
        // opener cannot itself close (it is open-only, e.g. preceded
        // by a space; `*foo**bar**baz*`, cm-411, still forms), blocks
        // the pairing — but only when the inner level differs from
        // the outer level the opener wants (an em inside an em, or a
        // strong inside a strong, still forms: `*a *b*c*`,
        // `**a **b**c**`) AND the pairing would be an em (use 1):
        // a leftover single `*` must not steal a delimiter from a
        // `**` opener (`**a *render*use* public library**` keeps
        // its strong; `**a *b **c**d* e**` keeps its strong), while
        // a strong pairing is never blocked (`**by command
        // *tool*one***` forms its strong, the extra `*` landing
        // inside). `*a **b**c*` and `**a *b*c**` leave the outer
        // pair literal; `*a **b** c*` (inner closer followed by a
        // space, so it cannot open) pairs it. When the block fires
        // for this opener, the closer moves on to a farther opener
        // — but only a strong pairing may use it (see wasBlocked
        // above).
        if (firstPair && ci > 0 && closer.ch !== '~') {
          const outerLevel = o.run >= 2 ? 2 : 1;
          let blocked = false;
          for (let k = oi + 1; k < ci; k++) {
            const d = recs[k];
            if (
              d.ch === closer.ch && d.open && d.close && d.rem === 0 &&
              d.pairedOpener && !d.pairedOpener.close &&
              (d.run >= 2 ? 2 : 1) !== outerLevel &&
              Math.min(o.rem, closer.rem) < 2
            ) { blocked = true; break; }
          }
          if (blocked) { wasBlocked = true; continue; }
          // An intervening delimiter that can both open and close
          // and is still active (it was itself blocked from pairing
          // by the rule of 3) cannot be skipped past: `*a **b**c**d*`
          // leaves the final `*` literal. A spent delimiter
          // (rem 0) or one that cannot open does not block this way.
          // As above, the closer is abandoned, not retried farther.
          if (oi < ci - 1) {
            const d2 = recs[ci - 1];
            if (d2.ch === closer.ch && d2.open && d2.close && d2.rem > 0) break;
          }
        }
        // A closer already blocked once may only pair onward as a
        // strong; an em pairing here would steal a delimiter from
        // the strong opener.
        if (wasBlocked && closer.ch !== '~' && Math.min(o.rem, closer.rem) < 2) break;
        opener = o;
        break;
      }
      if (!opener) break;
      let use;
      if (closer.ch === '~') use = closer.rem;
      else {
        use = Math.min(opener.rem, closer.rem);
        if (use > 2) use = 2;
      }
      const tag = closer.ch === '~' ? 'x' : use === 2 ? 's' : 'e';
      const oiPos = parts.indexOf(opener.node);
      const ciPos = parts.indexOf(closer.node);
      if (oiPos === -1 || ciPos === -1 || oiPos >= ciPos) break;
      const kids = parts.slice(oiPos + 1, ciPos);
      const wrap = { k: tag, kids };
      opener.rem -= use;
      closer.rem -= use;
      // Remember which opener this closer paired with, so a later
      // closer can tell whether the pair it closed was open-only
      // (its opener cannot close) — the inner-closer block below.
      closer.pairedOpener = opener;
      firstPair = false;
      const next = parts.slice(0, oiPos);
      if (opener.rem > 0) next.push(opener.node);
      next.push(wrap);
      if (closer.rem > 0) next.push(closer.node);
      for (let t = ciPos + 1; t < parts.length; t++) next.push(parts[t]);
      parts = next;
    }
  }
  return parts;
}

// Resolve emphasis across the whole inline tree: link labels first (their
// delimiters pair within the label), then the top level.
function resolveEmphasis(S) {
  function walk(parts) {
    for (const p of parts) {
      if ((p.k === 'a' || p.k === 'i') && p.kids) {
        p.kids = resolveList(walk(p.kids), S);
      }
    }
    return parts;
  }
  S.parts = resolveList(walk(S.parts), S);
}

// Render a list of inline parts to HTML.
function partsHtml(parts, S) {
  let out = '';
  for (const p of parts) {
    switch (p.k) {
      case 't':
        out += escapeText(p.s);
        break;
      case 'd':
        out += p.rec.ch.repeat(p.rec.rem);
        break;
      case 'c':
        out += '<code>' + escapeCode(p.s) + '</code>';
        break;
      case 'a':
        out += '<a href="' + escapeHref(p.href) + '"';
        if (p.title != null) out += ' title="' + escapeAttr(p.title) + '"';
        out += '>' + partsHtml(p.kids, S) + '</a>';
        break;
      case 'i':
        out += '<img src="' + escapeHref(p.src) + '" alt="' + escapeAttr(plainText(p.kids)) + '"';
        if (p.title != null) out += ' title="' + escapeAttr(p.title) + '"';
        out += '>';
        break;
      case 'u':
        if (p.live) out += '<a href="' + escapeHref(p.href) + '">' + escapeText(p.text) + '</a>';
        else out += escapeText(p.text);
        break;
      case 'w':
        // Angle autolink (<scheme:...> or <email>): always a live
        // link, even inside a link label (marked nests it). Unlike a
        // formed link it does not block an outer link from forming,
        // and unlike a tentative autolink it is not muted by build().
        out += '<a href="' + escapeHref(p.href) + '">' + escapeText(p.text) + '</a>';
        break;
      case 'h':
        out += p.s;
        break;
      case 'b':
        out += '<br>';
        break;
      case 'e':
        out += '<em>' + partsHtml(p.kids, S) + '</em>';
        break;
      case 's':
        out += '<strong>' + partsHtml(p.kids, S) + '</strong>';
        break;
      case 'x':
        out += '<del>' + partsHtml(p.kids, S) + '</del>';
        break;
    }
  }
  return out;
}

// The plain-text content of inline parts (for image alt text).
function plainText(parts) {
  let out = '';
  for (const p of parts) {
    switch (p.k) {
      case 't':
        out += p.s;
        break;
      case 'd':
        out += p.rec.ch.repeat(p.rec.rem);
        break;
      case 'c':
        out += p.s;
        break;
      case 'a':
      case 'e':
      case 's':
      case 'x':
      case 'i':
        out += plainText(p.kids);
        break;
      case 'u':
      case 'w':
        out += p.text;
        break;
      case 'b':
        out += '\n';
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------- block rendering ----------
// Resolve backslash escapes (\ + punctuation -> the punctuation).
function unescapeStr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isPunctCode(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}
// Render one block node (and its children) into `out` (an array of strings).
function renderBlocks(node, refs, out) {
  switch (node.t) {
    case 'doc':
      for (const ch of node.children) renderBlocks(ch, refs, out);
      break;
    case 'para': {
      if (node.dead) break;
      out.push('<p>' + renderInline(node.lines.join('\n'), refs) + '</p>\n');
      break;
    }
    case 'heading':
      out.push('<h' + node.level + '>' + renderInline(node.text, refs) + '</h' + node.level + '>\n');
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'html':
      // HTML blocks render their lines raw. The trailing newline was
      // decided in parse() (kind 1-5 keep it; kind 6-7 drop it unless
      // the block is the document's last block with a final newline).
      out.push(node.lines.join('\n') + (node.trailingNl ? '\n' : ''));
      break;
    case 'code': {
      let lines = node.lines;
      if (!node.fenced) {
        // An indented code block keeps interior blank lines but not
        // trailing ones.
        let end = lines.length;
        while (end > 0 && lines[end - 1] === '') end--;
        lines = lines.slice(0, end);
      } else if (lines.length > 0 && lines[lines.length - 1] === '') {
        // A fenced code block drops exactly one trailing empty line
        // (the newline before the closing fence is the block's own).
        lines = lines.slice(0, -1);
      }
      let content = lines.join('\n');
      if (lines.length > 0) content += '\n';
      const lang = unescapeStr((node.info || '').split(/\s+/)[0]);
      const cls = lang ? ' class="language-' + escapeAttr(lang) + '"' : '';
      out.push('<pre><code' + cls + '>' + escapeCode(content) + '</code></pre>\n');
      break;
    }
    case 'quote':
      out.push('<blockquote>\n');
      for (const ch of node.children) renderBlocks(ch, refs, out);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      let attrs = '';
      if (node.ordered && node.start !== 1) attrs = ' start="' + node.start + '"';
      out.push('<' + tag + attrs + '>\n');
      for (const ch of node.children) renderItem(ch, node.tight, refs, out);
      out.push('</' + tag + '>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let i = 0; i < node.header.length; i++) {
        const a = node.aligns[i];
        out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(node.header[i], refs) + '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length > 0) {
        out.push('<tbody>');
        for (const row of node.rows) {
          out.push('<tr>\n');
          // Rows are padded with empty cells (or truncated) to the
          // header's column count.
          for (let i = 0; i < node.header.length; i++) {
            const a = node.aligns[i];
            const cell = i < row.length ? row[i] : '';
            out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(cell, refs) + '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody></table>\n');
      } else {
        out.push('</table>\n');
      }
      break;
    }
    default:
      break;
  }
}

// Render one list item. In a tight list, paragraph children render as
// bare inline content; in a loose list they keep their <p> tags.
// A task list item begins with `[ ] ` or `[x] ` (case-insensitive):
// the marker is replaced by a checkbox input.
function renderItem(item, tight, refs, out) {
  out.push('<li>');
  const kids = item.children;
  for (let i = 0; i < kids.length; i++) {
    const ch = kids[i];
    if (ch.t === 'para') {
      let text = ch.lines.join('\n');
      let box = '';
      if (i === 0) {
        if (text.startsWith('[ ] ')) {
          box = '<input disabled="" type="checkbox"> ';
          text = text.slice(4);
        } else if (text.startsWith('[x] ') || text.startsWith('[X] ')) {
          box = '<input checked="" disabled="" type="checkbox"> ';
          text = text.slice(4);
        }
      }
      if (tight) out.push(box + renderInline(text, refs));
      else out.push('<p>' + box + renderInline(text, refs) + '</p>\n');
    } else {
      renderBlocks(ch, refs, out);
    }
  }
  out.push('</li>\n');
}

// Top-level entry: markdown string -> HTML string.
function lastBlock(node) {
  const kids = node.children || node.items;
  if (kids && kids.length) return lastBlock(kids[kids.length - 1]);
  return node;
}

// Walk the block tree, calling fn on every node.
function walkBlocks(node, fn) {
  fn(node);
  const kids = node.children || node.items;
  if (kids) for (const k of kids) walkBlocks(k, fn);
}

function parse(md) {
  const { doc, refs } = parseBlocks(md);
  // An HTML block's trailing newline: kinds 1-5 keep the closing line's
  // newline; kinds 6-7 drop it unless the block is the very last block
  // in the document (and then only if the input ends with a newline).
  // A block followed by a blank line never keeps its trailing newline.
  const endsWithNl = md.length === 0 || md.charCodeAt(md.length - 1) === 10;
  const last = lastBlock(doc);
  walkBlocks(doc, (node) => {
    if (node.t !== 'html') return;
    if (node.followedByBlank) node.trailingNl = false;
    else if (node === last) node.trailingNl = endsWithNl;
    else node.trailingNl = node.kind <= 5;
  });
  const out = [];
  renderBlocks(doc, refs, out);
  return out.join('');
}
module.exports = { parse };
