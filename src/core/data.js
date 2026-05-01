/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, getClient, KNOWN_PATHS, safeString } from '../connection.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MAX_OHLCV_BARS = 10000;
const MAX_TRADES = 20;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;
const DEFAULT_DOWNLOAD_TIMEOUT = 30000;
const DEFAULT_DOWNLOAD_POLL = 500;
const DEFAULT_PREVIEW_ROWS = 3;
const BACKGROUND_DOWNLOAD_WAIT = 5000;

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  values.push(current);
  return values;
}

function makePreviewColumns(columns) {
  const counts = new Map();
  return columns.map(column => {
    const count = (counts.get(column) || 0) + 1;
    counts.set(column, count);
    return count === 1 ? column : `${column} #${count}`;
  });
}

export function summarizeCsvFile(filePath, { preview_rows } = {}) {
  const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length === 0) {
    return {
      success: true,
      file_path: filePath,
      size_bytes: statSync(filePath).size,
      row_count: 0,
      column_count: 0,
      columns: [],
      preview_columns: [],
      preview_rows: [],
    };
  }

  const columns = parseCsvLine(lines[0]);
  const previewColumns = makePreviewColumns(columns);
  const limit = Math.max(0, preview_rows ?? DEFAULT_PREVIEW_ROWS);
  const previewRows = lines.slice(1, 1 + limit).map(line => {
    const values = parseCsvLine(line);
    const row = {};
    previewColumns.forEach((column, index) => {
      row[column] = values[index] ?? '';
    });
    return row;
  });

  return {
    success: true,
    file_path: filePath,
    size_bytes: statSync(filePath).size,
    row_count: Math.max(0, lines.length - 1),
    column_count: columns.length,
    columns,
    preview_columns: previewColumns,
    preview_rows: previewRows,
  };
}

export function normalizeDownloadOptions({ background_attempt } = {}) {
  return {
    background_attempt: background_attempt !== false,
  };
}

export function sanitizeDownloadFilename(filename) {
  const cleaned = String(filename || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim();
  const fallback = `tradingview_chart_data_${Date.now()}.csv`;
  const safeName = cleaned || fallback;
  return safeName.toLowerCase().endsWith('.csv') ? safeName : `${safeName}.csv`;
}

function uniqueCsvPath(downloadsDir, filename) {
  const safeName = sanitizeDownloadFilename(filename);
  const dot = safeName.toLowerCase().endsWith('.csv') ? safeName.length - 4 : safeName.length;
  const base = safeName.slice(0, dot);
  const ext = safeName.slice(dot) || '.csv';
  let candidate = join(downloadsDir, safeName);

  if (!existsSync(candidate)) return candidate;

  for (let i = 0; i < 100; i++) {
    const suffix = `${Date.now().toString(36)}_${i}`;
    candidate = join(downloadsDir, `${base}_${suffix}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not create a unique CSV filename in ${downloadsDir}`);
}

function writeCapturedCsv({ downloadsDir, filename, text }) {
  mkdirSync(downloadsDir, { recursive: true });
  const filePath = uniqueCsvPath(downloadsDir, filename);
  writeFileSync(filePath, text, 'utf8');
  return filePath;
}

function listCsvDownloads(downloadsDir, sinceMs) {
  if (!existsSync(downloadsDir)) return [];

  return readdirSync(downloadsDir)
    .filter(name => name.toLowerCase().endsWith('.csv'))
    .map(name => {
      const filePath = join(downloadsDir, name);
      const stat = statSync(filePath);
      return { filePath, name, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .filter(file => file.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function waitForDownloadedCsv({ downloadsDir, sinceMs, timeoutMs, pollMs }) {
  const start = Date.now();
  let candidate = null;
  let stableSize = -1;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    const files = listCsvDownloads(downloadsDir, sinceMs);
    if (files.length > 0) {
      const latest = files[0];
      if (!candidate || candidate.filePath !== latest.filePath || stableSize !== latest.size) {
        candidate = latest;
        stableSize = latest.size;
        stableCount = 0;
      } else {
        stableCount++;
      }

      if (stableCount >= 1 && latest.size > 0) {
        return latest.filePath;
      }
    }

    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for chart data CSV in ${downloadsDir}`);
}

async function mouseClickAt(x, y) {
  const client = await getClient();
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left' });
}

function domClickElementJS(kind) {
  return `
    (function() {
      var kind = ${safeString(kind)};
      function norm(s) {
        return (s || '').replace(/\\s+/g, ' ').trim();
      }
      function isVisible(el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      function describe(el, method) {
        var r = el.getBoundingClientRect();
        return {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          text: norm(el.textContent || el.innerText || ''),
          aria: norm(el.getAttribute('aria-label') || ''),
          dataName: norm(el.getAttribute('data-name') || ''),
          tag: el.tagName,
          method: method
        };
      }
      function findManageLayouts() {
        var el = document.querySelector('[data-name="save-load-menu"]');
        if (el && isVisible(el)) return el;
        var candidates = document.querySelectorAll('[aria-label="Manage layouts"]');
        var best = null;
        for (var i = 0; i < candidates.length; i++) {
          var candidate = candidates[i];
          if (!isVisible(candidate)) continue;
          var r = candidate.getBoundingClientRect();
          if (!best || r.x > best.r.x) best = { el: candidate, r: r };
        }
        return best ? best.el : null;
      }
      function matchesKind(el) {
        var text = norm(el.textContent || el.innerText || '');
        var aria = norm(el.getAttribute('aria-label') || '');
        if (kind === 'download-menu-item') {
          return aria === 'Download chart data' || text === 'Download chart data…' || text === 'Download chart data...';
        }
        if (kind === 'dialog-download-button' && text === 'Download') {
          var ancestor = el;
          for (var depth = 0; depth < 8 && ancestor; depth++, ancestor = ancestor.parentElement) {
            var ancestorText = norm(ancestor.textContent || ancestor.innerText || '');
            if (ancestorText.indexOf('Download chart data') !== -1) return true;
          }
        }
        return false;
      }
      function findGeneric() {
        if (kind === 'download-menu-item') {
          var menuItems = document.querySelectorAll('[aria-label="Download chart data"]');
          for (var m = 0; m < menuItems.length; m++) {
            if (isVisible(menuItems[m])) return menuItems[m];
          }
        }
        var els = document.querySelectorAll('[aria-label], [data-name], button, [role="button"], [role="menuitem"], div, span');
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          if (!isVisible(el)) continue;
          if (matchesKind(el)) return el;
        }
        return null;
      }
      function clickableTarget(el) {
        if (!el) return null;
        return el.closest('button,[role="button"],[role="menuitem"],[role="row"],[data-name]') || el;
      }
      function fireClick(el) {
        var target = clickableTarget(el);
        if (!target || !isVisible(target)) return null;
        try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        var details = describe(target, 'dom');
        var r = target.getBoundingClientRect();
        var x = r.x + r.width / 2;
        var y = r.y + r.height / 2;
        var opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          button: 0,
          buttons: 1
        };
        var events = ['pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup'];
        for (var i = 0; i < events.length; i++) {
          var type = events[i];
          var Ctor = type.indexOf('pointer') === 0 && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
          try { target.dispatchEvent(new Ctor(type, opts)); } catch (e) {}
        }
        if (typeof target.click === 'function') {
          try { target.click(); } catch (e) {}
        }
        return details;
      }

      var el = kind === 'manage-layouts' ? findManageLayouts() : findGeneric();
      return el ? fireClick(el) : null;
    })()
  `;
}

async function domClickElement(kind) {
  return evaluate(domClickElementJS(kind));
}

function installDownloadCaptureJS() {
  return `
    (function() {
      if (!window.__tvMcpDownloadCaptureOriginals) {
        window.__tvMcpDownloadCaptureOriginals = {
          createObjectURL: URL.createObjectURL.bind(URL),
          anchorClick: HTMLAnchorElement.prototype.click
        };

        URL.createObjectURL = function(obj) {
          var url = window.__tvMcpDownloadCaptureOriginals.createObjectURL(obj);
          try {
            if (obj && typeof obj.text === 'function') {
              window.__tvMcpDownloadCapture.records.push({
                url: url,
                blob: obj,
                type: obj.type || '',
                size: obj.size || 0,
                filename: '',
                clicked: false
              });
            }
          } catch (e) {}
          return url;
        };

        HTMLAnchorElement.prototype.click = function() {
          try {
            var state = window.__tvMcpDownloadCapture;
            var records = state && state.records || [];
            for (var i = records.length - 1; i >= 0; i--) {
              var rec = records[i];
              if (rec.url === this.href && this.download) {
                rec.filename = this.download;
                rec.clicked = true;
                return;
              }
            }
          } catch (e) {}
          return window.__tvMcpDownloadCaptureOriginals.anchorClick.apply(this, arguments);
        };
      }

      window.__tvMcpDownloadCapture = { records: [] };
      return true;
    })()
  `;
}

function restoreDownloadCaptureJS() {
  return `
    (function() {
      var originals = window.__tvMcpDownloadCaptureOriginals;
      if (!originals) return false;
      URL.createObjectURL = originals.createObjectURL;
      HTMLAnchorElement.prototype.click = originals.anchorClick;
      delete window.__tvMcpDownloadCaptureOriginals;
      delete window.__tvMcpDownloadCapture;
      return true;
    })()
  `;
}

function readCapturedDownloadJS() {
  return `
    (async function() {
      var records = window.__tvMcpDownloadCapture && window.__tvMcpDownloadCapture.records || [];
      var rec = null;
      for (var i = records.length - 1; i >= 0; i--) {
        if (records[i].blob && typeof records[i].blob.text === 'function') {
          rec = records[i];
          break;
        }
      }
      if (!rec) return null;
      var text = await rec.blob.text();
      return {
        filename: rec.filename || 'tradingview_chart_data.csv',
        clicked: !!rec.clicked,
        size: rec.size || text.length,
        type: rec.type || '',
        text: text
      };
    })()
  `;
}

function findElementCenterJS(kind) {
  if (kind === 'manage-layouts') {
    return `
      (function() {
        function isVisible(el) {
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        var el = document.querySelector('[data-name="save-load-menu"]');
        if (!el || !isVisible(el)) {
          var candidates = document.querySelectorAll('[aria-label="Manage layouts"]');
          var best = null;
          for (var i = 0; i < candidates.length; i++) {
            var candidate = candidates[i];
            if (!isVisible(candidate)) continue;
            var r = candidate.getBoundingClientRect();
            if (!best || r.x > best.r.x) best = { el: candidate, r: r };
          }
          if (best) el = best.el;
        }
        if (!el || !isVisible(el)) return null;
        var r = el.getBoundingClientRect();
        return {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          text: (el.textContent || el.innerText || '').replace(/\\s+/g, ' ').trim(),
          aria: el.getAttribute('aria-label') || '',
          dataName: el.getAttribute('data-name') || ''
        };
      })()
    `;
  }

  const predicate = kind === 'download-menu-item'
    ? `
      if (aria === 'Download chart data' || text === 'Download chart data…' || text === 'Download chart data...') {
        return true;
      }
    `
    : `
      if (text === 'Download') {
        var ancestor = el;
        for (var depth = 0; depth < 8 && ancestor; depth++, ancestor = ancestor.parentElement) {
          var ancestorText = norm(ancestor.textContent || ancestor.innerText || '');
          if (ancestorText.indexOf('Download chart data') !== -1) return true;
        }
      }
    `;

  return `
    (function() {
      function isVisible(el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      function norm(s) {
        return (s || '').replace(/\\s+/g, ' ').trim();
      }
      var els = document.querySelectorAll('[aria-label], [data-name], button, [role="button"], [role="menuitem"], div, span');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!isVisible(el)) continue;
        var r = el.getBoundingClientRect();
        var text = norm(el.textContent || el.innerText || '');
        var aria = norm(el.getAttribute('aria-label') || '');
        var dataName = norm(el.getAttribute('data-name') || '');
        ${predicate}
      }
      return null;
    })()
  `.replace(/return true;/g, `return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: text, aria: aria, dataName: dataName };`);
}

async function mouseClickDownloadChartDataMenuItem() {
  const existing = await evaluate(findElementCenterJS('download-menu-item'));
  if (existing) {
    await mouseClickAt(existing.x, existing.y);
    return { clicked: true, method: 'mouse', source: 'menu_item', ...existing };
  }

  const menu = await evaluate(findElementCenterJS('manage-layouts'));
  if (!menu) throw new Error('Manage layouts button not found');
  await mouseClickAt(menu.x, menu.y);

  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const item = await evaluate(findElementCenterJS('download-menu-item'));
    if (item) {
      await mouseClickAt(item.x, item.y);
      return { clicked: true, method: 'mouse', source: 'opened_manage_layouts', ...item };
    }
  }

  throw new Error('Download chart data menu item did not appear after opening Manage layouts');
}

async function mouseClickDialogDownloadButton() {
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const button = await evaluate(findElementCenterJS('dialog-download-button'));
    if (button) {
      await mouseClickAt(button.x, button.y);
      return { clicked: true, method: 'mouse', ...button };
    }
  }

  throw new Error('Download button did not appear in chart data dialog');
}

async function backgroundClickDownloadChartDataMenuItem() {
  const existing = await domClickElement('download-menu-item');
  if (existing) return { clicked: true, source: 'menu_item', ...existing };

  const menu = await domClickElement('manage-layouts');
  if (!menu) throw new Error('Manage layouts button not found');

  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const item = await domClickElement('download-menu-item');
    if (item) {
      return { clicked: true, source: 'opened_manage_layouts', menu, ...item };
    }
  }

  throw new Error('Download chart data menu item did not appear after background Manage layouts click');
}

async function backgroundClickDialogDownloadButton() {
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const button = await domClickElement('dialog-download-button');
    if (button) return { clicked: true, ...button };
  }

  throw new Error('Download button did not appear after background chart data menu click');
}

async function mouseDownloadFromCurrentState() {
  const visibleDialogButton = await evaluate(findElementCenterJS('dialog-download-button'));
  if (visibleDialogButton) {
    const dialog = await mouseClickDialogDownloadButton();
    return {
      click_strategy: 'mouse',
      clicks: { dialog },
    };
  }

  const menu = await mouseClickDownloadChartDataMenuItem();
  const dialog = await mouseClickDialogDownloadButton();
  return {
    click_strategy: 'mouse',
    clicks: { menu, dialog },
  };
}

async function backgroundDownloadFromCurrentState() {
  const menu = await backgroundClickDownloadChartDataMenuItem();
  const dialog = await backgroundClickDialogDownloadButton();
  return {
    click_strategy: 'background',
    clicks: { menu, dialog },
  };
}

async function captureBackgroundDownload({ downloadsDir }) {
  await evaluate(installDownloadCaptureJS());
  try {
    const clickResult = await backgroundDownloadFromCurrentState();

    for (let i = 0; i < 30; i++) {
      const captured = await evaluateAsync(readCapturedDownloadJS());
      if (captured?.text) {
        const filePath = writeCapturedCsv({
          downloadsDir,
          filename: captured.filename,
          text: captured.text,
        });
        return {
          filePath,
          clickResult: {
            ...clickResult,
            click_strategy: 'background_capture',
            background_attempted: true,
            fallback_used: false,
            download_method: 'captured_blob',
            captured_filename: captured.filename,
            captured_size: captured.size,
            captured_type: captured.type,
            captured_anchor_clicked: captured.clicked,
          },
        };
      }
      await sleep(100);
    }

    throw new Error('No captured CSV Blob after background download click');
  } finally {
    try { await evaluate(restoreDownloadCaptureJS()); } catch {}
  }
}

async function clickDownloadChartData({ background_attempt }) {
  if (background_attempt) {
    try {
      return {
        ...(await backgroundDownloadFromCurrentState()),
        background_attempted: true,
        fallback_used: false,
      };
    } catch (err) {
      return {
        ...(await mouseDownloadFromCurrentState()),
        background_attempted: true,
        fallback_used: true,
        background_error: err.message,
      };
    }
  }

  return {
    ...(await mouseDownloadFromCurrentState()),
    background_attempted: false,
    fallback_used: false,
  };
}

async function waitForNativeCsvAfterClick({ clickResult, downloadsDir, timeoutMs, pollMs }) {
  const sinceMs = Date.now() - 1000;
  try {
    return await waitForDownloadedCsv({
      downloadsDir,
      sinceMs,
      timeoutMs: clickResult.click_strategy === 'background' ? Math.min(timeoutMs, BACKGROUND_DOWNLOAD_WAIT) : timeoutMs,
      pollMs,
    });
  } catch (err) {
    if (clickResult.click_strategy !== 'background') throw err;
    const fallbackSinceMs = Date.now() - 1000;
    const fallbackClick = await mouseDownloadFromCurrentState();
    const filePath = await waitForDownloadedCsv({
      downloadsDir,
      sinceMs: fallbackSinceMs,
      timeoutMs,
      pollMs,
    });
    Object.assign(clickResult, {
      ...fallbackClick,
      background_attempted: true,
      fallback_used: true,
      background_error: err.message,
    });
    return filePath;
  }
}

export async function downloadChartData({
  downloads_dir,
  timeout_ms,
  poll_ms,
  preview_rows,
  background_attempt,
} = {}) {
  const options = normalizeDownloadOptions({ background_attempt });
  const downloadsDir = downloads_dir || join(homedir(), 'Downloads');
  const timeoutMs = timeout_ms || DEFAULT_DOWNLOAD_TIMEOUT;
  const pollMs = poll_ms || DEFAULT_DOWNLOAD_POLL;

  let filePath = null;
  let clickResult = null;
  let captureError = null;

  if (options.background_attempt) {
    try {
      const captured = await captureBackgroundDownload({ downloadsDir });
      filePath = captured.filePath;
      clickResult = captured.clickResult;
    } catch (err) {
      captureError = err;
    }
  }

  if (!filePath) {
    clickResult = await clickDownloadChartData(options);
    if (captureError) clickResult.capture_error = captureError.message;
    filePath = await waitForNativeCsvAfterClick({
      clickResult,
      downloadsDir,
      timeoutMs,
      pollMs,
    });
  }

  const summary = summarizeCsvFile(filePath, { preview_rows });
  return {
    ...summary,
    downloads_dir: downloadsDir,
    ...clickResult,
    source: 'tradingview_download_chart_data_ui',
  };
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: Math.round((Math.max(...highs) - Math.min(...lows)) * 100) / 100,
      change: Math.round((last.close - first.open) * 100) / 100,
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

export async function getStrategyResults() {
  const results = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && (s.reportData || s.performance)) { strat = s; break; }
        }
        if (!strat) return {metrics: {}, source: 'internal_api', error: 'No strategy found on chart. Add a strategy indicator first.'};
        var metrics = {};
        if (strat.reportData) {
          var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
          if (rd && typeof rd === 'object') {
            if (typeof rd.value === 'function') rd = rd.value();
            if (rd) { var keys = Object.keys(rd); for (var k = 0; k < keys.length; k++) { var val = rd[keys[k]]; if (val !== null && val !== undefined && typeof val !== 'function') metrics[keys[k]] = val; } }
          }
        }
        if (Object.keys(metrics).length === 0 && strat.performance) {
          var perf = strat.performance();
          if (perf && typeof perf.value === 'function') perf = perf.value();
          if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { var pval = perf[pkeys[p]]; if (pval !== null && pval !== undefined && typeof pval !== 'function') metrics[pkeys[p]] = pval; } }
        }
        return {metrics: metrics, source: 'internal_api'};
      } catch(e) { return {metrics: {}, source: 'internal_api', error: e.message}; }
    })()
  `);
  return { success: true, metric_count: Object.keys(results?.metrics || {}).length, source: results?.source, metrics: results?.metrics || {}, error: results?.error };
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const trades = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && (s.ordersData || s.reportData)) { strat = s; break; }
        }
        if (!strat) return {trades: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var orders = null;
        if (strat.ordersData) { orders = typeof strat.ordersData === 'function' ? strat.ordersData() : strat.ordersData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        if (!orders || !Array.isArray(orders)) {
          if (strat._orders) orders = strat._orders;
          else if (strat.tradesData) { orders = typeof strat.tradesData === 'function' ? strat.tradesData() : strat.tradesData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        }
        if (!orders || !Array.isArray(orders)) return {trades: [], source: 'internal_api', error: 'ordersData() returned non-array.'};
        var result = [];
        for (var t = 0; t < Math.min(orders.length, ${limit}); t++) {
          var o = orders[t];
          if (typeof o === 'object' && o !== null) {
            var trade = {};
            var okeys = Object.keys(o);
            for (var k = 0; k < okeys.length; k++) { var v = o[okeys[k]]; if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') trade[okeys[k]] = v; }
            result.push(trade);
          }
        }
        return {trades: result, source: 'internal_api'};
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return { success: true, trade_count: trades?.trades?.length || 0, source: trades?.source, trades: trades?.trades || [], error: trades?.error };
}

export async function getEquity() {
  const equity = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && (s.reportData || s.performance)) { strat = s; break; }
        }
        if (!strat) return {data: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var data = [];
        if (strat.equityData) {
          var eq = typeof strat.equityData === 'function' ? strat.equityData() : strat.equityData;
          if (eq && typeof eq.value === 'function') eq = eq.value();
          if (Array.isArray(eq)) data = eq;
        }
        if (data.length === 0 && strat.bars) {
          var bars = typeof strat.bars === 'function' ? strat.bars() : strat.bars;
          if (bars && typeof bars.lastIndex === 'function') {
            var end = bars.lastIndex(); var start = bars.firstIndex();
            for (var i = start; i <= end; i++) { var v = bars.valueAt(i); if (v) data.push({time: v[0], equity: v[1], drawdown: v[2] || null}); }
          }
        }
        if (data.length === 0) {
          var perfData = {};
          if (strat.performance) {
            var perf = strat.performance();
            if (perf && typeof perf.value === 'function') perf = perf.value();
            if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { if (/equity|drawdown|profit|net/i.test(pkeys[p])) perfData[pkeys[p]] = perf[pkeys[p]]; } }
          }
          if (Object.keys(perfData).length > 0) return {data: [], equity_summary: perfData, source: 'internal_api', note: 'Full equity curve not available via API; equity summary metrics returned instead.'};
        }
        return {data: data, source: 'internal_api'};
      } catch(e) { return {data: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return { success: true, data_points: equity?.data?.length || 0, source: equity?.source, data: equity?.data || [], equity_summary: equity?.equity_summary, note: equity?.note, error: equity?.error };
}

export async function getQuote({ symbol } = {}) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var sym = ${safeString(symbol || '')};
      if (!sym) { try { sym = api.symbol(); } catch(e) {} }
      if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
      var ext = {};
      try { ext = api.symbolExt() || {}; } catch(e) {}
      var bars = ${BARS_PATH};
      var quote = { symbol: sym };
      if (bars && typeof bars.lastIndex === 'function') {
        var last = bars.valueAt(bars.lastIndex());
        if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
      }
      try {
        var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
        var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
        if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
        if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
      } catch(e) {}
      try {
        var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
        if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
      } catch(e) {}
      if (ext.description) quote.description = ext.description;
      if (ext.exchange) quote.exchange = ext.exchange;
      if (ext.type) quote.type = ext.type;
      return quote;
    })()
  `);
  if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
  return { success: true, ...data };
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ name: name, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = v.y1 != null ? Math.round(v.y1 * 100) / 100 : null;
      const y2 = v.y2 != null ? Math.round(v.y2 * 100) / 100 : null;
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = v.y != null ? Math.round(v.y * 100) / 100 : null;
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1, v.y2) * 100) / 100 : null;
      const low = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1, v.y2) * 100) / 100 : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
