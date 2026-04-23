#!/usr/bin/env bun
// Usage: bun scripts/gen-coverage-badge.ts <line-pct>
//
// Writes docs/coverage.svg with the given percentage and rewrites the
// <img>/<a> pair in README.md so the README badge, the static SVG, and
// shields.io URL stay in sync. Called by .github/workflows/ci.yml on push
// to main.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const raw = process.argv[2];
if (!raw) {
  console.error("usage: gen-coverage-badge.ts <line-pct>");
  process.exit(2);
}

const pct = Math.round(Number(raw));
if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
  console.error(`invalid pct: ${raw}`);
  process.exit(2);
}

// shields.io colour bands — matches their own thresholds roughly
function color(n: number): string {
  if (n >= 90) return "#4ADE80"; // bright green
  if (n >= 75) return "#97CA00"; // green
  if (n >= 60) return "#A4A61D"; // yellow-green
  if (n >= 45) return "#DFB317"; // yellow
  return "#E05D44"; // red
}

const c = color(pct);
const label = `${pct}%`;
const labelWidth = 63;
const valueWidth = Math.max(32, 16 + label.length * 7);
const total = labelWidth + valueWidth;
const labelTextLen = 530;
const valueTextLen = Math.max(210, label.length * 60 + 40);
const valueTextX = (labelWidth + valueWidth / 2) * 10;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="coverage: ${label}">
  <title>coverage: ${label}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${total}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${c}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="325" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${labelTextLen}">coverage</text>
    <text x="325" y="140" transform="scale(.1)" fill="#fff" textLength="${labelTextLen}">coverage</text>
    <text aria-hidden="true" x="${valueTextX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${valueTextLen}">${label}</text>
    <text x="${valueTextX}" y="140" transform="scale(.1)" fill="#fff" textLength="${valueTextLen}">${label}</text>
  </g>
</svg>
`;

const repoRoot = new URL("..", import.meta.url).pathname;
writeFileSync(join(repoRoot, "docs/coverage.svg"), svg);

const readmePath = join(repoRoot, "README.md");
const readme = readFileSync(readmePath, "utf8");
const shieldsUrl = `https://img.shields.io/badge/coverage-${pct}%25-${c.replace("#", "")}.svg`;
const updated = readme
  .replace(
    /https:\/\/img\.shields\.io\/badge\/coverage-\d+%25-[0-9a-fA-F]+\.svg/,
    shieldsUrl,
  )
  .replace(/alt="Coverage \d+%"/, `alt="Coverage ${pct}%"`);
if (updated !== readme) writeFileSync(readmePath, updated);

console.log(`badge updated: ${pct}% (${c})`);
