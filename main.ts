import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

// Round-2 entry point: read the scored cases, render each to HTML, and
// write the results array. Input/output dirs come from the environment
// (the harness sets MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR).
const inDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const cases = JSON.parse(readFileSync(inDir + '/cases.json', 'utf8'));
const out = new Array(cases.length);
for (let i = 0; i < cases.length; i++) out[i] = parse(cases[i].markdown);
mkdirSync(outDir, { recursive: true });
writeFileSync(outDir + '/html.json', JSON.stringify(out));
