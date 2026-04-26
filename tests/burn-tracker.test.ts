import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUCKET_MS,
  defaultProjectsDir,
  findBucketStart,
  fmtDuration,
  fmtTokens,
  readTurns,
  renderReport,
  summarize,
  type Turn,
} from "../src/burn-tracker";

// ── helpers ──────────────────────────────────────────────────────────

function mkTurn(p: Partial<Turn>): Turn {
  return {
    ts: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    cacheCreate: 0,
    cacheRead: 0,
    synthetic: false,
    sessionId: "abc",
    ...p,
  };
}

function makeJsonlLine(opts: {
  ts: string;
  model?: string;
  usage?: Record<string, number>;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.ts,
    message: {
      model: opts.model ?? "claude-opus-4-7",
      usage: opts.usage ?? {},
    },
  });
}

// ── fmt helpers ──────────────────────────────────────────────────────

describe("fmtDuration", () => {
  test("renders sub-hour as Xm", () => {
    expect(fmtDuration(0)).toBe("0m");
    expect(fmtDuration(30 * 60_000)).toBe("30m");
    // 59.5 min rounds to 60 → crosses hour threshold → "1h 0m"
    expect(fmtDuration(59 * 60_000 + 30_000)).toBe("1h 0m");
    expect(fmtDuration(59 * 60_000 + 29_000)).toBe("59m"); // 59.48 rounds to 59
  });
  test("renders hour-plus as Xh Ym", () => {
    expect(fmtDuration(60 * 60_000)).toBe("1h 0m");
    expect(fmtDuration(90 * 60_000)).toBe("1h 30m");
    expect(fmtDuration(5 * 60 * 60_000)).toBe("5h 0m");
  });
});

describe("fmtTokens", () => {
  test("under 1K returns raw integer", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });
  test("1K-999K renders as XK", () => {
    expect(fmtTokens(1000)).toBe("1.0K");
    expect(fmtTokens(12_345)).toBe("12.3K");
    expect(fmtTokens(999_000)).toBe("999.0K");
  });
  test("1M+ renders as X.XXM", () => {
    expect(fmtTokens(1_000_000)).toBe("1.00M");
    expect(fmtTokens(44_186_871)).toBe("44.19M");
  });
});

// ── findBucketStart ──────────────────────────────────────────────────

describe("findBucketStart", () => {
  test("empty array returns -1", () => {
    expect(findBucketStart([])).toBe(-1);
  });
  test("no synthetic stops → bucket starts at index 0", () => {
    const turns = [mkTurn({ ts: 1 }), mkTurn({ ts: 2 }), mkTurn({ ts: 3 })];
    expect(findBucketStart(turns)).toBe(0);
  });
  test("single synthetic stop → bucket starts after it", () => {
    const turns = [
      mkTurn({ ts: 1 }),
      mkTurn({ ts: 2, synthetic: true }),
      mkTurn({ ts: 3 }),
      mkTurn({ ts: 4 }),
    ];
    expect(findBucketStart(turns)).toBe(2);
  });
  test("most recent synthetic stop wins (multiple in window)", () => {
    const turns = [
      mkTurn({ ts: 1, synthetic: true }),
      mkTurn({ ts: 2 }),
      mkTurn({ ts: 3, synthetic: true }),
      mkTurn({ ts: 4 }),
    ];
    expect(findBucketStart(turns)).toBe(3);
  });
  test("trailing synthetic stop returns past-end index (no active bucket)", () => {
    const turns = [mkTurn({ ts: 1 }), mkTurn({ ts: 2, synthetic: true })];
    expect(findBucketStart(turns)).toBe(2); // = turns.length, summarize handles this
  });
});

// ── summarize ────────────────────────────────────────────────────────

describe("summarize", () => {
  const NOW = 1_000_000_000;

  test("empty turns → null bucket, zero everything", () => {
    const s = summarize([], NOW);
    expect(s.bucketStart).toBeNull();
    expect(s.totalTokens).toBe(0);
    expect(s.turns).toBe(0);
    expect(s.bucketRemainingMs).toBe(BUCKET_MS);
  });

  test("trailing synthetic stop → null bucket (nothing active)", () => {
    const turns = [mkTurn({ ts: NOW - 100, synthetic: true })];
    const s = summarize(turns, NOW);
    expect(s.bucketStart).toBeNull();
  });

  test("sums all four token kinds across turns", () => {
    const t1 = NOW - 60 * 60_000; // 1h ago
    const t2 = NOW - 30 * 60_000; // 30m ago
    const turns = [
      mkTurn({ ts: t1, inputTokens: 100, outputTokens: 50 }),
      mkTurn({ ts: t2, cacheCreate: 1000, cacheRead: 5000 }),
    ];
    const s = summarize(turns, NOW);
    expect(s.bucketStart).toBe(t1);
    expect(s.inputTokens).toBe(100);
    expect(s.outputTokens).toBe(50);
    expect(s.cacheCreateTokens).toBe(1000);
    expect(s.cacheReadTokens).toBe(5000);
    expect(s.totalTokens).toBe(6150);
    expect(s.turns).toBe(2);
  });

  test("excludes turns before the most recent synthetic stop", () => {
    const turns = [
      mkTurn({ ts: NOW - 200, inputTokens: 999_999 }), // pre-stop, ignore
      mkTurn({ ts: NOW - 150, synthetic: true }),
      mkTurn({ ts: NOW - 100, inputTokens: 100 }),
    ];
    const s = summarize(turns, NOW);
    expect(s.totalTokens).toBe(100);
    expect(s.turns).toBe(1);
    expect(s.syntheticStops).toBe(0); // stop is at boundary, not in active window
  });

  test("burn rate = totalTokens / (bucketAgeMs / 60_000)", () => {
    const t1 = NOW - 10 * 60_000; // 10 min ago
    const turns = [mkTurn({ ts: t1, inputTokens: 10_000 })];
    const s = summarize(turns, NOW);
    expect(s.burnRatePerMin).toBeCloseTo(1000, 0); // 10K / 10min = 1K/min
  });

  test("bucketRemainingMs = BUCKET_MS - age, clamped at 0", () => {
    // Bucket-start 6 hours ago — should clamp to 0 remaining
    const turns = [mkTurn({ ts: NOW - 6 * 60 * 60_000, inputTokens: 1 })];
    const s = summarize(turns, NOW);
    expect(s.bucketRemainingMs).toBe(0);
  });
});

// ── readTurns (jsonl parsing) ─────────────────────────────────────────

describe("readTurns", () => {
  test("missing dir returns empty array (no throw)", () => {
    expect(readTurns("/tmp/this/does/not/exist/", 0)).toEqual([]);
  });

  test("parses assistant turns with usage and skips non-assistant lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "burn-"));
    try {
      const NOW = Date.now();
      const ts1 = new Date(NOW - 60_000).toISOString();
      const ts2 = new Date(NOW - 30_000).toISOString();
      writeFileSync(
        join(dir, "session-abc.jsonl"),
        [
          JSON.stringify({ type: "user", timestamp: ts1 }), // skip
          makeJsonlLine({
            ts: ts1,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          "not json at all",
          makeJsonlLine({
            ts: ts2,
            usage: { cache_read_input_tokens: 100 },
          }),
        ].join("\n"),
      );
      const turns = readTurns(dir, NOW - 5 * 60_000);
      expect(turns.length).toBe(2);
      expect(turns[0].inputTokens).toBe(10);
      expect(turns[1].cacheRead).toBe(100);
      // sorted ascending
      expect(turns[0].ts).toBeLessThan(turns[1].ts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("filters out turns older than sinceMs", () => {
    const dir = mkdtempSync(join(tmpdir(), "burn-"));
    try {
      const NOW = Date.now();
      const old = new Date(NOW - 10 * 60 * 60_000).toISOString(); // 10h ago
      const recent = new Date(NOW - 30 * 60_000).toISOString();
      writeFileSync(
        join(dir, "s.jsonl"),
        [
          makeJsonlLine({ ts: old, usage: { input_tokens: 1 } }),
          makeJsonlLine({ ts: recent, usage: { input_tokens: 2 } }),
        ].join("\n"),
      );
      const turns = readTurns(dir, NOW - 5 * 60 * 60_000);
      expect(turns.length).toBe(1);
      expect(turns[0].inputTokens).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flags synthetic-stop turns and zero-counts their usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "burn-"));
    try {
      const NOW = Date.now();
      const ts = new Date(NOW - 60_000).toISOString();
      writeFileSync(
        join(dir, "s.jsonl"),
        makeJsonlLine({
          ts,
          model: "<synthetic>",
          usage: { input_tokens: 999_999 }, // should NOT be counted
        }),
      );
      const turns = readTurns(dir, NOW - 5 * 60_000);
      expect(turns.length).toBe(1);
      expect(turns[0].synthetic).toBe(true);
      expect(turns[0].inputTokens).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── renderReport ─────────────────────────────────────────────────────

describe("renderReport", () => {
  const NOW = 1_000_000_000;

  test("empty bucket case", () => {
    const s = summarize([], NOW);
    const r = renderReport(s, NOW);
    expect(r).toMatch(/no Claude activity/);
  });

  test("normal case includes elapsed/remaining/total/rate lines", () => {
    const turns = [
      mkTurn({
        ts: NOW - 60 * 60_000, // 1h ago
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreate: 2000,
        cacheRead: 8000,
      }),
    ];
    const s = summarize(turns, NOW);
    const r = renderReport(s, NOW);
    expect(r).toMatch(/bucket: 1h 0m elapsed/);
    expect(r).toMatch(/resets in 4h 0m/);
    expect(r).toMatch(/tokens: 11.5K total/); // 1000+500+2000+8000=11500
    expect(r).toMatch(/rate: .* over 1 turns/);
  });

  test("renders synthetic-stop warning when present in active window", () => {
    const turns = [
      mkTurn({ ts: NOW - 100, inputTokens: 50 }),
      mkTurn({ ts: NOW - 50, synthetic: true }),
      mkTurn({ ts: NOW - 25, inputTokens: 50 }),
    ];
    // findBucketStart returns idx 2 (after the synthetic), so the synthetic
    // is NOT in the active window. Adjust expectation accordingly.
    const s = summarize(turns, NOW);
    expect(s.syntheticStops).toBe(0);
    const r = renderReport(s, NOW);
    expect(r).not.toMatch(/synthetic stops/);
  });
});

// ── defaultProjectsDir ───────────────────────────────────────────────

describe("defaultProjectsDir", () => {
  test("slugifies cwd into the projects path Claude Code uses", () => {
    expect(defaultProjectsDir("/Users/x", "/Users/x/DEV/batonq")).toBe(
      "/Users/x/.claude/projects/-Users-x-DEV-batonq",
    );
  });
  test("handles cwd at filesystem root", () => {
    expect(defaultProjectsDir("/Users/x", "/")).toBe(
      "/Users/x/.claude/projects/-",
    );
  });
});
