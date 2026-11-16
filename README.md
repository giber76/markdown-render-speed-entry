# markdown-render-speed-entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/giber76/markdown-render-speed-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/giber76/markdown-render-speed-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Round-2 rebuild: the inline parser, block renderer, and driver were
rewritten by hand in a fresh recorded session after the round-1 entry
was rejected on provenance (not quality), so every counted line is
authored in that session.

A fast, dependency-free CommonMark 0.31.2 + GFM renderer whose output is
byte-identical to marked 18.1.3 with default options (GFM on, breaks off).
Written from scratch for the make.fun `markdown-render-speed-02` bounty.

## Layout

- `parse.js` — the renderer. `parse(markdown)` returns the HTML string.
  Two passes: a block pass builds a small block tree (headings, fences,
  lists, block quotes, tables, HTML blocks, link reference definitions)
  and an inline pass scans each paragraph once, resolving links, code
  spans, autolinks and emphasis with the CommonMark delimiter-stack
  algorithm. No state is kept between calls: every case is rendered from
  its own text alone.
- `main.ts` — the driver the harness runs. Reads `/input/cases.json`,
  renders each case with `parse`, writes `/output/html.json`.

## Design notes

- Tabs are handled by virtual columns (a tab advances to the next multiple
  of 4, and a tab straddling a cut becomes spaces), so tabs survive
  verbatim inside code and paragraph text, exactly as marked keeps them.
- Named character references pass through verbatim; numeric references
  decode (0 and surrogates become U+FFFD, values above 0x10FFFF are not
  references). Link destinations are percent-encoded with `encodeURI` and
  attribute-escaped; titles and fence info strings keep entities as-is.
- Extended autolinks (`www.`, `http`/`https`/`ftp`/`mailto`, emails) follow
  the GFM trailing-punctuation, paren-balance and entity rules, and are
  suppressed inside link text (angle autolinks are not).
- No caching, no lookup tables keyed on input, no network, no WASM.

## Local grading

From the unpacked kit:

```
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver docker
```
