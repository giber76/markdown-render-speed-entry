// The program the harness runs: node /bot/main.ts (Node 22, types are
// stripped natively). It reads every case from /input/cases.json, renders
// each one alone with parse() from parse.js, and writes the HTML strings,
// in the cases' order, to /output/html.json.
//
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output. Nothing here reads the clock, the network, or
// anything outside /bot, /input, /output and /tmp, and parse() keeps no
// state between cases: each case is rendered from its own text alone.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];

const html = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
