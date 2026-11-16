import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

// Round-5 entry point: read the scored cases, render each to HTML, and
// write the results array. Input/output dirs come from the environment
// (the harness sets MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR). Round 5
// finished the renderer at 720/720: a bare URL/email inside a link
// label is now allowed only when no containing label can resolve
// (labelCanForm mirrors tryLink's decision, and a greedy URL pops any
// opener whose closer it ate), and a blank line no longer gets
// absorbed into a paragraph that is so far only reference definitions
// (a split ref def inside a list item must not swallow the paragraph
// after it). A removed ref-def paragraph still counts toward list
// looseness when it followed a blank line inside an item. The speed
// work is next: the emStrong mask is the known cost (~0.09x), and the
// top-10 line on the live board sits near 0.71x vs marked.
const inDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const cases = JSON.parse(readFileSync(inDir + '/cases.json', 'utf8'));
const out = new Array(cases.length);
// Round 5: render in input order; each case is independent (no state
// is kept between parse calls), so the loop is a plain sequential pass.
// The emStrong masking (Ot + blockSkip) is computed per paragraph in
// renderInline and consulted only by the top-level emphasis scan, so
// link labels keep their own emphasis. The bare-URL label prediction
// (`labelCanForm`) caches its static resolution on the opener — the
// label end, suffix and reference never change while a paragraph is
// scanned — and only re-checks whether a link has formed inside the
// label, which keeps the 125k in-label URL probes cheap.
for (let i = 0; i < cases.length; i++) out[i] = parse(cases[i].markdown);
mkdirSync(outDir, { recursive: true });
writeFileSync(outDir + '/html.json', JSON.stringify(out));
