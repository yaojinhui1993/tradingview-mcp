import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { summarizeCsvFile } from '../src/core/data.js';

describe('chart data CSV summary', () => {
  it('summarizes columns, row count, and preview rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-download-test-'));
    const file = join(dir, 'BATS_ORCL, 5_test.csv');
    writeFileSync(
      file,
      [
        'time,open,high,low,close,Trend Strength',
        '1777474500,164.33,164.7,164.2,164.335,47.17',
        '1777474800,164.32,164.42,163.93,164,45.82',
      ].join('\n')
    );

    try {
      const summary = summarizeCsvFile(file, { preview_rows: 1 });

      assert.equal(summary.file_path, file);
      assert.equal(summary.row_count, 2);
      assert.equal(summary.column_count, 6);
      assert.deepEqual(summary.columns, ['time', 'open', 'high', 'low', 'close', 'Trend Strength']);
      assert.deepEqual(summary.preview_rows, [
        {
          time: '1777474500',
          open: '164.33',
          high: '164.7',
          low: '164.2',
          close: '164.335',
          'Trend Strength': '47.17',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps duplicate CSV columns distinct in preview rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-download-test-'));
    const file = join(dir, 'duplicate_columns.csv');
    writeFileSync(
      file,
      [
        'time,LUCID Connector,LUCID Connector',
        '1777474500,2,1075970050',
      ].join('\n')
    );

    try {
      const summary = summarizeCsvFile(file, { preview_rows: 1 });

      assert.deepEqual(summary.columns, ['time', 'LUCID Connector', 'LUCID Connector']);
      assert.deepEqual(summary.preview_columns, ['time', 'LUCID Connector', 'LUCID Connector #2']);
      assert.deepEqual(summary.preview_rows, [
        {
          time: '1777474500',
          'LUCID Connector': '2',
          'LUCID Connector #2': '1075970050',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
