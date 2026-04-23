'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView, Menu } = obsidian;

let cmView = null, cmState = null;
try {
  cmView = require('@codemirror/view');
  cmState = require('@codemirror/state');
} catch (e) {
  console.warn('[ClozePlus] CodeMirror modules not available:', e);
}

/* ========================= Utils ========================= */

const todayDays = () => Math.floor(Date.now() / 86400000);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ensureArray = (v) => Array.isArray(v) ? v : (v == null ? [] : [v]);
const getActiveMarkdownView = (app) => app.workspace.getActiveViewOfType(MarkdownView);
const getCurrentFile = (app) => app.workspace.getActiveFile();
const getCurrentFilePath = (app) => getCurrentFile(app)?.path || null;
const trimStr = (s, n = 120) => (s = String(s ?? ''), s.length > n ? s.slice(0, n) + '…' : s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cssVarName = (k) => `--cloze-plus-${k}`;
const makeUnderlineMask = (text) => '_'.repeat(Math.max(4, Math.min(12, String(text || '').length)));
const normalizeText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const safeRect = (el) => { try { return el.getBoundingClientRect(); } catch (e) { return null; } };
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rafThrottle = (fn) => { let raf = 0; return (...args) => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; fn(...args); }); }; };
const failColorClass = (n) => n >= 4 ? 'fail-4' : n === 3 ? 'fail-3' : n === 2 ? 'fail-2' : n === 1 ? 'fail-1' : '';
const rColorClass = (R) => R >= 0.9 ? 'r-high' : R >= 0.7 ? 'r-mid' : R >= 0.5 ? 'r-low' : 'r-vlow';
const joinPath = (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/');
const decodeEscaped = (s) => String(s ?? '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
const tsvQuote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

function stripMarkdownMarks(s) {
  let out = String(s || '');
  out = out.replace(/\{\{([^}]+)\}\}/g, '$1');
  out = out.replace(/==([^=]+)==/g, '$1');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/<u>([^<]+)<\/u>/gi, '$1');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1');
  out = out.replace(/(?<!_)_([^_]+)_(?!_)/g, '$1');
  out = out.replace(/(?<!!)\[([^\]]+)\](?!\()/g, '$1');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  return out;
}

function splitMarkdownTableRow(line) {
  let s = String(line || '').trim();
  if (!s.startsWith('|') || !s.endsWith('|')) return [];
  s = s.slice(1, -1);
  return s.split('|').map(x => x.trim());
}

function normalizeCellPlain(s) {
  return normalizeText(stripMarkdownMarks(s).replace(/\n+/g, ' '));
}

function domTextWithBreaks(root) {
  let out = '';

  const walk = (node) => {
    if (!node) return;

    if (node.nodeType === 3) {
      out += node.nodeValue || '';
      return;
    }

    if (node.nodeType !== 1) return;

    const el = node;
    if (el.classList?.contains('cloze-table-overlay')) return;

    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }

    for (const child of Array.from(node.childNodes || [])) {
      walk(child);
    }
  };

  walk(root);
  return out;
}

function rowPlainFromMarkdownLine(line) {
  return normalizeText(splitMarkdownTableRow(line).map(normalizeCellPlain).join(' | '));
}

function rowPlainFromDomCells(cells) {
  return normalizeText(cells.map(c => normalizeCellPlain(domTextWithBreaks(c))).join(' | '));
}

function isTableSeparatorLine(line) {
  const cells = splitMarkdownTableRow(line);
  return !!cells.length && cells.every(c => /^:?-{2,}:?$/.test(c.replace(/\s+/g, '')));
}

function isMarkdownTableLine(line) {
  return /^\s*\|.*\|\s*$/.test(String(line || ''));
}

function countOccurrencesBefore(haystack, needle, beforeIndex) {
  if (!needle) return 0;
  const re = new RegExp(escapeRegExp(needle), 'g');
  const part = haystack.slice(0, Math.max(0, beforeIndex));
  let c = 0;
  while (re.exec(part)) c++;
  return c;
}

function findNthOccurrenceIndex(haystack, needle, n) {
  if (!needle || n < 1) return -1;
  let idx = -1, from = 0;
  for (let i = 0; i < n; i++) {
    idx = haystack.indexOf(needle, from);
    if (idx < 0) return -1;
    from = idx + needle.length;
  }
  return idx;
}

function sanitizePathReadable(filePath) {
  return String(filePath || '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/[\\/]/g, '__')
    .replace(/\s+/g, ' ')
    .trim();
}

async function ensureFolder(adapter, dir) {
  const parts = String(dir || '').split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!(await adapter.exists(cur))) {
      try { await adapter.mkdir(cur); } catch (e) {}
    }
  }
}

function renderTemplate(tpl, data) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (_, key) => String(data[key] ?? ''));
}

function titleToTag(s) {
  return normalizeText(s).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
}

/* ========================= Default Settings ========================= */

const DEFAULT_SETTINGS = {
  enableHighlight: true,
  enableBold: false,
  enableUnderline: false,
  enableItalic: false,
  enableBracket: false,
  enableCurly: true,

  tagFilter: '',
  defaultHide: true,
  fixedWidth: false,

  enableDivider: true,
  dividerPosition: 50,

  requestedRetention: 0.9,
  fsrsMaxInterval: 365,
  fsrsFirstAgain: 1,
  fsrsFirstHard: 2,
  fsrsFirstGood: 3,
  fsrsFirstEasy: 5,

  hiddenBaseColor: '#8b5cf6',
  shownBaseColor: '#d1d5db',
  fail1Color: '#2ecc71',
  fail2Color: '#3498db',
  fail3Color: '#f1c40f',
  fail4Color: '#e74c3c',
  colorStyle: 'underline',
  underlineWidth: 2,
  hiddenHighlightAlpha: 22,
  shownHighlightAlpha: 16,
  panelItemGap: 2,

  enableTableCompat: true,
  lockPanelListInMode: true,

  storageMode: 'single',
  dataLocation: 'plugin',
  dataUseExportDir: false,
  dataVaultDir: 'ClozePlus-Data',
  dataSingleFileName: 'cloze-data.json',
  dataPerFileDirName: 'cloze-data',

  exportProfile: 'anki-tsv',
  exportTextMode: 'anki-cloze',
  exportSeparator: '\\n\\n\\n\\n',
  exportDir: 'ClozePlus-Exports',
  exportFrontTemplate: '{{content}}',
  exportBackTemplate: '{{source}}',
  exportTags: 'clozeplus',
  exportGroupByHeading: true,
  exportHeadingAsTag: false,

  debug: false
};

/* ========================= Logger ========================= */

class DebugLogger {
  constructor(plugin) {
    this.plugin = plugin;
    this.buf = [];
    this.counts = Object.create(null);
    this.maxRows = 150;
  }

  on() {
    return !!this.plugin.settings?.debug;
  }

  simp(v, d = 0) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return trimStr(v, 220);
    if (Array.isArray(v)) return { len: v.length, sample: v.slice(0, 4).map(x => this.simp(x, d + 1)) };

    if (typeof v === 'object') {
      if (d >= 2) return '[Object]';
      const o = {};
      for (const k of Object.keys(v)) {
        if (!['raw', 'content', 'html', 'docText'].includes(k)) {
          o[k] = this.simp(v[k], d + 1);
        }
      }
      return o;
    }

    return String(v);
  }

  log(tag, data = {}) {
    if (!this.on()) return;
    const row = { t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), tag, ...this.simp(data) };
    this.buf.push(row);
    this.counts[tag] = (this.counts[tag] || 0) + 1;
    if (this.buf.length > this.maxRows) this.buf.shift();
    console.log('[ClozePlus]', row);
  }

  report() {
    return JSON.stringify({ counts: this.counts, recent: this.buf }, null, 2);
  }

  async copy() {
    try {
      await navigator.clipboard.writeText(this.report());
      new Notice(`已复制调试日志 ${this.buf.length} 条`);
    } catch {
      new Notice('复制日志失败');
    }
  }

  clear() {
    this.buf = [];
    this.counts = Object.create(null);
    new Notice('调试日志已清空');
  }
}

/* ========================= FSRS ========================= */

class FSRS {
  constructor(plugin, requestedRetention = 0.9) {
    this.plugin = plugin;
    this.requestedRetention = requestedRetention;
    this.w = [0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.6160, 0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567];
  }

  clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  forgettingCurve(e, s) {
    return Math.pow(1 + e / (9 * s), -1);
  }

  initStability(r) {
    return Math.max(0.1, this.w[r - 1]);
  }

  initDifficulty(r) {
    return this.clamp(this.w[4] - Math.exp(this.w[5] * (r - 1)) + 1, 1, 10);
  }

  meanReversion(i, c) {
    return 0.8 * c + 0.2 * i;
  }

  nextDifficulty(d, r) {
    return this.clamp(this.meanReversion(this.w[4], d - this.w[6] * (r - 3)), 1, 10);
  }

  nextRecallStability(d, s, r, rating) {
    const hardPenalty = rating === 2 ? this.w[15] : 1;
    const easyBonus = rating === 4 ? this.w[16] : 1;
    return s * (
      1 +
      Math.exp(this.w[8]) *
      (11 - d) *
      Math.pow(s, -this.w[9]) *
      (Math.exp((1 - r) * this.w[10]) - 1) *
      hardPenalty *
      easyBonus
    );
  }

  nextForgetStability(d, s, r) {
    return this.clamp(
      this.w[11] *
      Math.pow(d, -this.w[12]) *
      (Math.pow(s + 1, this.w[13]) - 1) *
      Math.exp((1 - r) * this.w[14]),
      0.1,
      s
    );
  }

  stabilityToInterval(s) {
    return Math.min(
      Math.max(1, Math.round(9 * s * (1 / this.requestedRetention - 1))),
      this.plugin.settings.fsrsMaxInterval || 365
    );
  }

  createFirstCard(rating, today) {
    const p = {
      1: this.plugin.settings.fsrsFirstAgain,
      2: this.plugin.settings.fsrsFirstHard,
      3: this.plugin.settings.fsrsFirstGood,
      4: this.plugin.settings.fsrsFirstEasy
    };

    return {
      due: today + Math.max(1, p[rating] || 1),
      stability: this.initStability(rating),
      difficulty: this.initDifficulty(rating),
      elapsed_days: 0,
      scheduled_days: Math.max(1, p[rating] || 1),
      reps: 1,
      lapses: rating === 1 ? 1 : 0,
      state: rating === 1 ? 'relearning' : 'review',
      last_review: today,
      last_rating: rating
    };
  }

  review(card, rating, today) {
    if (!card || !card.reps) return this.createFirstCard(rating, today);

    const elapsed = Math.max(0, today - (card.last_review || today));
    const r = this.forgettingCurve(elapsed, card.stability || 0.1);
    const difficulty = this.nextDifficulty(card.difficulty || 5, rating);

    let stability;
    let lapses = card.lapses || 0;

    if (rating === 1) {
      stability = this.nextForgetStability(card.difficulty || 5, card.stability || 0.1, r);
      lapses++;
    } else {
      stability = this.nextRecallStability(card.difficulty || 5, card.stability || 0.1, r, rating);
    }

    const interval = this.stabilityToInterval(stability);

    return {
      due: today + interval,
      stability,
      difficulty,
      elapsed_days: elapsed,
      scheduled_days: interval,
      reps: (card.reps || 0) + 1,
      lapses,
      state: rating === 1 ? 'relearning' : 'review',
      last_review: today,
      last_rating: rating
    };
  }

  currentR(card, today) {
    if (!card || !card.reps) return 1;
    return this.forgettingCurve(Math.max(0, today - (card.last_review || today)), card.stability || 0.1);
  }

  previewIntervals(card) {
    const today = todayDays();
    if (!card || !card.reps) {
      return {
        1: this.plugin.settings.fsrsFirstAgain,
        2: this.plugin.settings.fsrsFirstHard,
        3: this.plugin.settings.fsrsFirstGood,
        4: this.plugin.settings.fsrsFirstEasy
      };
    }

    const out = {};
    for (const r of [1, 2, 3, 4]) {
      out[r] = Math.max(1, this.review(card, r, today).due - today);
    }
    return out;
  }
}

/* ========================= Data Manager ========================= */

class DataManager {
  constructor(plugin) {
    this.plugin = plugin;
    this.reviewData = {};
    this.cardMap = {};
  }

  get storageMode() {
    return this.plugin.settings.storageMode || 'single';
  }

  get dataLocation() {
    return this.plugin.settings.dataLocation || 'plugin';
  }

  get useVaultStorage() {
    return this.dataLocation === 'vault';
  }

  get privatePerFileDir() {
    return joinPath(
      this.plugin.app.vault.configDir,
      'plugins',
      this.plugin.manifest.id,
      'cloze-data'
    );
  }

  normalizeVaultDir(dir, fallback = 'ClozePlus-Data') {
    let s = String(dir || '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/+/g, '/')
      .trim();

    return s || fallback;
  }

  get vaultRootDir() {
    const s = this.plugin.settings;

    const raw = s.dataUseExportDir
      ? (s.exportDir || 'ClozePlus-Exports')
      : (s.dataVaultDir || 'ClozePlus-Data');

    return this.normalizeVaultDir(
      raw,
      s.dataUseExportDir ? 'ClozePlus-Exports' : 'ClozePlus-Data'
    );
  }

  get singleFileName() {
    const name = String(this.plugin.settings.dataSingleFileName || 'cloze-data.json').trim();
    return name || 'cloze-data.json';
  }

  get perFileDirName() {
    let name = String(this.plugin.settings.dataPerFileDirName || 'cloze-data')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/+/g, '/')
      .trim();

    return name || 'cloze-data';
  }

  getSingleStorePath() {
    return joinPath(this.vaultRootDir, this.singleFileName);
  }

  getPerFileStoreDir() {
    return this.useVaultStorage
      ? joinPath(this.vaultRootDir, this.perFileDirName)
      : this.privatePerFileDir;
  }

  get dataDir() {
    return this.getPerFileStoreDir();
  }

  getStorageDescription() {
    if (this.useVaultStorage) {
      if (this.storageMode === 'single') {
        return `库内单一 data：${this.getSingleStorePath()}`;
      }
      return `库内每文件独立 json：${this.getPerFileStoreDir()}/`;
    }

    if (this.storageMode === 'single') {
      return '插件私有 data.json：保存在插件数据中';
    }

    return `插件私有每文件独立 json：${this.privatePerFileDir}/`;
  }

  fileNameFor(filePath) {
    return `${sanitizePathReadable(filePath)}.json`;
  }

  filePathFor(filePath, dir = null) {
    return joinPath(dir || this.getPerFileStoreDir(), this.fileNameFor(filePath));
  }

  hasPayloadData(reviewData, cardMap) {
    return (
      Object.keys(reviewData || {}).length > 0 ||
      Object.keys(cardMap || {}).length > 0
    );
  }

  setPayload(payload) {
    const reviewData = payload?.reviewData && typeof payload.reviewData === 'object'
      ? payload.reviewData
      : {};

    const cardMap = payload?.cardMap && typeof payload.cardMap === 'object'
      ? payload.cardMap
      : {};

    if (!this.hasPayloadData(reviewData, cardMap)) return false;

    this.reviewData = reviewData;
    this.cardMap = cardMap;
    return true;
  }

  loadSingleFromRaw(raw) {
    return this.setPayload({
      reviewData: raw?.reviewData || {},
      cardMap: raw?.cardMap || {}
    });
  }

  async readJson(path) {
    const adapter = this.plugin.app.vault.adapter;

    try {
      if (!(await adapter.exists(path))) return null;
      return JSON.parse(await adapter.read(path));
    } catch (e) {
      console.warn('[ClozePlus] read json failed:', path, e);
      return null;
    }
  }

  async loadSingleFromVault() {
    const payload = await this.readJson(this.getSingleStorePath());
    if (!payload) return false;
    return this.setPayload(payload);
  }

  async loadPerFileFromDir(dir) {
    const adapter = this.plugin.app.vault.adapter;

    try {
      if (!(await adapter.exists(dir))) return false;

      const list = await adapter.list(dir);
      const reviewData = {};
      const cardMap = {};

      for (const f of list.files || []) {
        if (!f.endsWith('.json')) continue;

        try {
          const obj = JSON.parse(await adapter.read(f));
          if (!obj?.filePath) continue;

          reviewData[obj.filePath] = obj.reviewData || {};
          cardMap[obj.filePath] = obj.cardMap || { groups: {}, nextSeq: 1 };
        } catch (e) {
          console.warn('[ClozePlus] load per-file json failed:', f, e);
        }
      }

      if (!this.hasPayloadData(reviewData, cardMap)) return false;

      this.reviewData = reviewData;
      this.cardMap = cardMap;
      return true;
    } catch (e) {
      console.warn('[ClozePlus] load per-file dir failed:', dir, e);
      return false;
    }
  }

  async loadSelectedStorage(raw) {
    if (this.useVaultStorage) {
      return this.storageMode === 'single'
        ? await this.loadSingleFromVault()
        : await this.loadPerFileFromDir(this.getPerFileStoreDir());
    }

    return this.storageMode === 'single'
      ? this.loadSingleFromRaw(raw)
      : await this.loadPerFileFromDir(this.privatePerFileDir);
  }

  async loadOppositeStorageInSameLocation(raw) {
    if (this.useVaultStorage) {
      return this.storageMode === 'single'
        ? await this.loadPerFileFromDir(this.getPerFileStoreDir())
        : await this.loadSingleFromVault();
    }

    return this.storageMode === 'single'
      ? await this.loadPerFileFromDir(this.privatePerFileDir)
      : this.loadSingleFromRaw(raw);
  }

  async saveMigrated(message) {
    try {
      await this.save();
      if (message) new Notice(message);
    } catch (e) {
      console.warn('[ClozePlus] migrate save failed:', e);
      new Notice('旧数据已读取，但写入新位置失败，请检查数据目录设置');
    }
  }

  async load() {
    const raw = (await this.plugin.loadData()) || {};

    this.reviewData = {};
    this.cardMap = {};

    if (await this.loadSelectedStorage(raw)) {
      return;
    }

    if (await this.loadOppositeStorageInSameLocation(raw)) {
      await this.saveMigrated('已根据当前数据设置迁移旧数据');
      return;
    }

    if (this.useVaultStorage) {
      if (this.loadSingleFromRaw(raw)) {
        await this.saveMigrated('已从旧版单一 data 迁移到库内数据目录');
        return;
      }

      if (await this.loadPerFileFromDir(this.privatePerFileDir)) {
        await this.saveMigrated('已从旧版每文件独立 json 迁移到库内数据目录');
        return;
      }
    } else {
      if (await this.loadSingleFromVault()) {
        await this.saveMigrated('已从库内单一 data 迁移到当前数据位置');
        return;
      }

      if (await this.loadPerFileFromDir(joinPath(this.vaultRootDir, this.perFileDirName))) {
        await this.saveMigrated('已从库内每文件独立 json 迁移到当前数据位置');
        return;
      }
    }
  }

  async savePluginRaw(payload) {
    await this.plugin.saveData(payload);
  }

  async saveSingleToVault() {
    const adapter = this.plugin.app.vault.adapter;
    const root = this.vaultRootDir;

    await ensureFolder(adapter, root);

    const payload = {
      version: 1,
      type: 'cloze-plus-single-data',
      updated: Date.now(),
      reviewData: this.reviewData || {},
      cardMap: this.cardMap || {}
    };

    await adapter.write(
      this.getSingleStorePath(),
      JSON.stringify(payload, null, 2)
    );
  }

  async savePerFileToDir(dir) {
    const adapter = this.plugin.app.vault.adapter;

    await ensureFolder(adapter, dir);

    const files = new Set([
      ...Object.keys(this.reviewData || {}),
      ...Object.keys(this.cardMap || {})
    ]);

    for (const filePath of files) {
      const payload = {
        version: 1,
        type: 'cloze-plus-file-data',
        updated: Date.now(),
        filePath,
        reviewData: this.reviewData[filePath] || {},
        cardMap: this.cardMap[filePath] || { groups: {}, nextSeq: 1 }
      };

      await adapter.write(
        this.filePathFor(filePath, dir),
        JSON.stringify(payload, null, 2)
      );
    }
  }

  async save() {
    const settingsPayload = {
      settings: this.plugin.settings
    };

    if (this.useVaultStorage) {
      if (this.storageMode === 'single') {
        await this.saveSingleToVault();
      } else {
        await this.savePerFileToDir(this.getPerFileStoreDir());
      }

      await this.savePluginRaw(settingsPayload);
      return;
    }

    if (this.storageMode === 'single') {
      await this.savePluginRaw({
        settings: this.plugin.settings,
        reviewData: this.reviewData,
        cardMap: this.cardMap
      });
      return;
    }

    await this.savePerFileToDir(this.privatePerFileDir);
    await this.savePluginRaw(settingsPayload);
  }

  getFile(filePath) {
    if (!this.reviewData[filePath]) this.reviewData[filePath] = {};
    return this.reviewData[filePath];
  }

  getCardMapFile(filePath) {
    if (!this.cardMap[filePath]) {
      this.cardMap[filePath] = { groups: {}, nextSeq: 1 };
    }
    return this.cardMap[filePath];
  }

  allocateStableIds(filePath, items) {
    const mapFile = this.getCardMapFile(filePath);
    const grouped = new Map();

    for (const item of items) {
      const key = `${item.type}|${item.raw}|${item.text}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    }

    for (const [key, arrItems] of grouped.entries()) {
      if (!mapFile.groups[key]) mapFile.groups[key] = [];
      const arr = mapFile.groups[key];
      while (arr.length < arrItems.length) arr.push(`cp-${mapFile.nextSeq++}`);
      arrItems.forEach((it, i) => { it.id = arr[i]; });
    }

    return items;
  }

  getRecord(filePath, id) {
    const file = this.getFile(filePath);
    if (!file[id]) {
      file[id] = {
        text: '',
        failCount: 0,
        history: [],
        inFsrs: false,
        fsrs: null,
        locator: null
      };
    }
    return file[id];
  }

  async recordAction(filePath, id, text, action, locator = null) {
    const r = this.getRecord(filePath, id);
    r.text = text;
    r.history.push({ action, time: Date.now() });

    if (action === '✘') r.failCount = (r.failCount || 0) + 1;
    else if (action === '✔' && r.failCount > 0) r.failCount--;
    else if (action === '➕') {
      r.inFsrs = true;
      if (!r.fsrs) {
        r.fsrs = {
          due: todayDays(),
          stability: 0.1,
          difficulty: 5,
          elapsed_days: 0,
          scheduled_days: 0,
          reps: 0,
          lapses: 0,
          state: 'new',
          last_review: 0,
          last_rating: 0
        };
      }
    } else if (action === '➖') {
      r.inFsrs = false;
      r.fsrs = null;
      r.failCount = (r.failCount || 0) + 1;
    }

    r.locator = ((r.failCount || 0) > 0 || r.inFsrs) ? (locator || r.locator) : null;
    await this.save();
    return r;
  }

  async rateFsrs(filePath, id, rating, fsrs, locator = null) {
    const r = this.getRecord(filePath, id);
    r.fsrs = fsrs.review(r.fsrs, rating, todayDays());
    r.inFsrs = true;
    r.history.push({ action: 'fsrs:' + rating, time: Date.now() });
    r.locator = locator || r.locator;
    await this.save();
    return r;
  }

  async removeFromFsrs(filePath, id, locator = null) {
    const r = this.getRecord(filePath, id);
    r.inFsrs = false;
    r.fsrs = null;
    r.failCount = (r.failCount || 0) + 1;
    r.history.push({ action: 'fsrs:remove', time: Date.now() });
    r.locator = locator || r.locator;
    await this.save();
    return r;
  }

  async deleteRecord(filePath, id) {
    const file = this.getFile(filePath);
    if (file && Object.prototype.hasOwnProperty.call(file, id)) {
      delete file[id];
    }
    await this.save();
  }

  async clearReviewData(filePath) {
    const file = this.getFile(filePath);
    for (const id of Object.keys(file)) {
      file[id].failCount = 0;
      if (!file[id].inFsrs) file[id].locator = null;
      file[id].history = (file[id].history || []).filter(h => String(h.action).startsWith('fsrs'));
    }
    await this.save();
  }

  async clearFsrsData(filePath) {
    const file = this.getFile(filePath);
    for (const id of Object.keys(file)) {
      file[id].inFsrs = false;
      file[id].fsrs = null;
      if ((file[id].failCount || 0) <= 0) file[id].locator = null;
      file[id].history = (file[id].history || []).filter(h => !String(h.action).startsWith('fsrs'));
    }
    await this.save();
  }

  getFsrsCards(filePath, filter, fsrs) {
    const file = this.getFile(filePath);
    const today = todayDays();
    const res = [];

    for (const id of Object.keys(file)) {
      const rec = file[id];
      if (!rec.inFsrs) continue;
      const due = rec.fsrs ? rec.fsrs.due : today;
      const R = rec.fsrs ? fsrs.currentR(rec.fsrs, today) : 1;

      const ok = filter === 'all'
        || (filter === 'today+overdue' && due <= today)
        || (filter === 'today' && due === today)
        || (filter === 'overdue' && due < today);

      if (ok) res.push({ id, rec, R });
    }

    return res;
  }
}

/* ========================= Parser ========================= */

class ClozeParser {
  constructor(plugin) {
    this.plugin = plugin;
  }

  getPatterns() {
    const s = this.plugin.settings;
    const p = [];

    if (s.enableCurly) p.push({ type: 'curly', regex: /\{\{([^}]+)\}\}/g, extract: m => m[1] });
    if (s.enableHighlight) p.push({ type: 'highlight', regex: /==([^=]+)==/g, extract: m => m[1] });
    if (s.enableBold) p.push({ type: 'bold', regex: /\*\*([^*]+)\*\*/g, extract: m => m[1] });
    if (s.enableUnderline) p.push({ type: 'underline', regex: /<u>([^<]+)<\/u>/gi, extract: m => m[1] });
    if (s.enableItalic) p.push({ type: 'italic', regex: /(?<!\*)\*([^*]+)\*(?!\*)|(?<!_)_([^_]+)_(?!_)/g, extract: m => m[1] || m[2] });
    if (s.enableBracket) p.push({ type: 'bracket', regex: /(?<!!)\[([^\]]+)\](?!\()/g, extract: m => m[1] });

    return p;
  }

  parse(text, filePath) {
    const spans = [];
    const patterns = this.getPatterns();

    for (const pat of patterns) {
      pat.regex.lastIndex = 0;
      let m;
      while ((m = pat.regex.exec(text)) !== null) {
        const from = m.index;
        const to = from + m[0].length;
        if (spans.some(s => from < s.to && to > s.from)) continue;

        const clozeText = pat.extract(m);
        if (!clozeText || !String(clozeText).trim()) continue;

        spans.push({
          from,
          to,
          raw: m[0],
          text: clozeText,
          type: pat.type,
          filePath,
          line: 0,
          lineText: '',
          rowPlain: '',
          inTable: false,
          tableCol: -1,
          tableCellMarkdown: '',
          tableCellPlain: '',
          tableOccurrence: 1,
          seqInLine: 0,
          headingPath: [],
          contextBefore: '',
          contextAfter: ''
        });
      }
    }

    spans.sort((a, b) => a.from - b.from);
    this.markMeta(spans, text);
    return this.plugin.dataManager.allocateStableIds(filePath, spans);
  }

  markMeta(spans, text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') starts.push(i + 1);
    }

    const lineOf = (offset) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= offset) lo = mid + 1;
        else hi = mid - 1;
      }
      return Math.max(0, hi);
    };

    const headings = [];
    for (let line = 0; line < starts.length; line++) {
      const start = starts[line];
      const end = text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start);
      const lineText = text.slice(start, end);
      const m = /^(#{1,6})\s+(.*)$/.exec(lineText);
      if (m) headings.push({ line, level: m[1].length, title: normalizeText(m[2]) });
    }

    const lineBuckets = new Map();

    for (const span of spans) {
      const line = lineOf(span.from);
      const start = starts[line];
      const end = text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start);
      const lineText = text.slice(start, end);

      span.line = line;
      span.lineText = lineText;
      span.inTable = isMarkdownTableLine(lineText) && !isTableSeparatorLine(lineText);
      span.rowPlain = span.inTable ? rowPlainFromMarkdownLine(lineText) : '';

      if (span.inTable) {
        const rel = span.from - start;
        const before = lineText.slice(0, rel);
        span.tableCol = Math.max(0, (before.match(/\|/g) || []).length - 1);

        const cells = splitMarkdownTableRow(lineText);
        if (span.tableCol >= 0 && span.tableCol < cells.length) {
          span.tableCellMarkdown = cells[span.tableCol];
          span.tableCellPlain = normalizeCellPlain(cells[span.tableCol]);

          const mdCell = String(span.tableCellMarkdown || '');
          const rawPos = mdCell.indexOf(span.raw);
          const plainCell = String(stripMarkdownMarks(mdCell).replace(/\n+/g, ' '));
          const beforeRawMd = rawPos >= 0 ? mdCell.slice(0, rawPos) : '';
          const beforeRawPlain = String(stripMarkdownMarks(beforeRawMd).replace(/\n+/g, ' '));

          span.tableOccurrence = countOccurrencesBefore(beforeRawPlain, span.text, beforeRawPlain.length) + 1;
          if (findNthOccurrenceIndex(plainCell, span.text, span.tableOccurrence) < 0) {
            span.tableOccurrence = 1;
          }
        }
      }

      const key = `${line}|${span.type}|${normalizeText(span.text)}`;
      const idx = (lineBuckets.get(key) || 0) + 1;
      lineBuckets.set(key, idx);
      span.seqInLine = idx;

      const stack = [];
      for (const h of headings) {
        if (h.line > line) break;
        while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
        stack.push(h);
      }
      span.headingPath = stack.map(x => x.title);

      const pos = lineText.indexOf(span.raw);
      if (pos >= 0) {
        span.contextBefore = normalizeText(lineText.slice(Math.max(0, pos - 20), pos));
        span.contextAfter = normalizeText(lineText.slice(pos + span.raw.length, pos + span.raw.length + 20));
      }
    }
  }
}

/* ========================= Popup ========================= */

class PopupManager {
  constructor(plugin) {
    this.plugin = plugin;
    this.current = null;
    this.outside = null;
  }

  close() {
    if (this.current) this.current.remove();
    this.current = null;

    if (this.outside) {
      document.removeEventListener('pointerdown', this.outside, true);
      document.removeEventListener('click', this.outside, true);
    }

    this.outside = null;
  }

  makeButton(text, cls, title, handler) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `cloze-popup-btn cp-action-btn ${cls}`;
    b.textContent = text;
    b.title = title;
    b.dataset.cpStopJump = '1';

    if (this.plugin.bindQuietActionButton) {
      this.plugin.bindQuietActionButton(b, handler);
    } else {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await handler(e);
      });
    }

    return b;
  }

  showCloze(anchor, span) {
    this.close();

    const popup = document.createElement('div');
    popup.className = 'cloze-popup';

    [
      ['✔', 'btn-correct', '记住了', '✔'],
      ['✘', 'btn-wrong', '没记住', '✘'],
      ['➕', 'btn-add', '加入记忆曲线', '➕']
    ].forEach(([txt, cls, title, act]) => {
      popup.appendChild(this.makeButton(txt, cls, title, async () => {
        await this.plugin.handleClozeAction(span, act, anchor);
        this.close();
      }));
    });

    this.place(popup, anchor);
  }

  showFsrs(anchor, span) {
    this.close();

    const filePath = this.plugin.getCurrentFilePath();
    const rec = filePath ? this.plugin.dataManager.getRecord(filePath, span.id) : null;
    const card = rec ? rec.fsrs : null;
    const p = this.plugin.fsrs.previewIntervals(card);

    const popup = document.createElement('div');
    popup.className = 'cloze-fsrs-popup';

    [
      [`重来${p[1]}d`, 'btn-again', 1],
      [`困难${p[2]}d`, 'btn-hard', 2],
      [`记得${p[3]}d`, 'btn-good', 3],
      [`简单${p[4]}d`, 'btn-easy', 4]
    ].forEach(([txt, cls, rating]) => {
      popup.appendChild(this.makeButton(txt, cls, txt, async () => {
        await this.plugin.handleFsrsRating(span, rating, anchor);
        this.close();
      }));
    });

    popup.appendChild(this.makeButton('➖', 'btn-remove', '移出记忆曲线', async () => {
      await this.plugin.removeFromFsrs(span, anchor);
      this.close();
    }));

    this.place(popup, anchor);
  }

  place(popup, anchor) {
    popup.style.visibility = 'hidden';
    popup.style.position = 'fixed';
    popup.style.zIndex = '10050';
    document.body.appendChild(popup);
    this.current = popup;

    const rect = anchor.getBoundingClientRect();
    const pw = popup.offsetWidth || 320;
    const ph = popup.offsetHeight || 48;
    const vw = innerWidth;
    const vh = innerHeight;

    let left = rect.left + rect.width / 2 - pw / 2;
    let top = rect.bottom + 8;

    if (left + pw > vw - 8) left = vw - pw - 8;
    if (left < 8) left = 8;
    if (top + ph > vh - 8) top = rect.top - ph - 8;
    if (top < 8) top = 8;

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.style.visibility = 'visible';

    setTimeout(() => {
      this.outside = (e) => {
        if (!popup.contains(e.target) && e.target !== anchor) {
          this.close();
        }
      };

      document.addEventListener('pointerdown', this.outside, true);
      document.addEventListener('click', this.outside, true);
    }, 0);
  }
}

/* ========================= Divider ========================= */

class DividerLine {
  constructor(plugin) {
    this.plugin = plugin;
    this.el = null;
    this.bound = null;
    this.listeners = [];
  }

  addListener(target, type, fn, options = true) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn, options);
    this.listeners.push([target, type, fn, options]);
  }

  show() {
    if (this.el) return;

    this.el = document.createElement('div');
    this.el.className = 'cloze-divider-line';
    document.body.appendChild(this.el);
    this.updatePosition();

    this.bound = rafThrottle(() => this.onScroll());

    this.addListener(document, 'scroll', this.bound, true);
    this.addListener(document, 'touchmove', this.bound, { capture: true, passive: true });
    this.addListener(document, 'touchend', this.bound, true);
    this.addListener(window, 'resize', this.bound, true);

    if (window.visualViewport) {
      this.addListener(window.visualViewport, 'scroll', this.bound, true);
      this.addListener(window.visualViewport, 'resize', this.bound, true);
    }

    setTimeout(() => this.onScroll(), 60);
  }

  hide() {
    if (this.el) this.el.remove();
    this.el = null;

    for (const [target, type, fn, options] of this.listeners) {
      try {
        target.removeEventListener(type, fn, options);
      } catch (e) {}
    }

    this.listeners = [];
    this.bound = null;
  }

  updatePosition() {
    if (this.el) this.el.style.top = this.plugin.settings.dividerPosition + 'vh';
  }

  onScroll() {
    if (!this.el || this.plugin.currentMode !== 'learn') return;

    try {
      this.plugin.readingProcessor?.refreshActive?.(true);
    } catch (e) {}

    const dividerY = this.el.getBoundingClientRect().top;

    this.plugin.clozeElements.forEach(entry => {
      const el = entry.el;
      if (!el || !document.body.contains(el)) return;

      const rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;

      const centerY = rect.top + rect.height / 2;
      const above = centerY < dividerY;
      const st = this.plugin.getRevealState(entry.span.id);

      if (above) {
        this.plugin.setRevealState(entry.span.id, true, false);
        this.plugin.applyRevealToElement(entry, true);
      } else if (!st.manual) {
        this.plugin.setRevealState(entry.span.id, false, false);
        this.plugin.applyRevealToElement(entry, false);
      }
    });

    this.plugin.refreshPanelsOnly();
  }
}

const getPanelDisplayText = (plugin, span) => (
  plugin.getRevealState(span.id).revealed ? span.text : makeUnderlineMask(span.text)
);

/* ========================= Generic Panel ========================= */

class ListPanel {
  constructor(plugin, mode) {
    this.plugin = plugin;
    this.mode = mode;
    this.el = null;
    this.currentIndex = 0;
    this.filteredItems = [];
    this.currentFilter = mode === 'review' ? 'unmastered' : 'today+overdue';
  }

  title() {
    return this.mode === 'review' ? '🔄 复习' : '🧠 记忆曲线复习';
  }

  panelClass() {
    return this.mode === 'review' ? 'cloze-review-panel' : 'cloze-fsrs-panel';
  }

  build() {
    const panel = document.createElement('div');
    panel.className = this.panelClass();
    panel.innerHTML = `
      <div class="cloze-panel-header">
        <span>${this.title()}</span>
        <span class="cloze-panel-close cp-action-btn" data-cp-stop-jump="1">✕</span>
      </div>
      <div class="cloze-panel-body">
        <select class="cloze-panel-select">
          ${this.mode === 'review'
            ? `<option value="unmastered">未掌握</option><option value="ge2">≥2次错误</option><option value="ge3">≥3次错误</option><option value="eq4">4次错误</option>`
            : `<option value="all">所有复习</option><option value="today+overdue">本日到期 + 过期</option><option value="today">本日到期</option><option value="overdue">过期</option>`
          }
        </select>
        <div class="cloze-panel-progress-text" data-role="progress-text"></div>
        <div class="cloze-panel-progress-bar"><div class="cloze-panel-progress-fill" data-role="progress-fill"></div></div>
        <div class="cloze-panel-list" data-role="item-list"></div>
      </div>
      <div class="cloze-panel-footer">
        <div class="cloze-panel-footer-row">
          <button class="cloze-panel-btn cp-action-btn" data-act="export" data-cp-stop-jump="1">导出当前列表</button>
          <button class="cloze-panel-btn btn-danger cp-action-btn" data-act="clear" data-cp-stop-jump="1">${this.mode === 'review' ? '清空记录' : '清空记忆'}</button>
        </div>
        <div class="cloze-panel-footer-row">
          <button class="cloze-panel-btn cp-action-btn" data-act="prev" data-cp-stop-jump="1">⬆ 上一个</button>
          <button class="cloze-panel-btn cp-action-btn" data-act="next" data-cp-stop-jump="1">⬇ 下一个</button>
        </div>
      </div>
    `;

    this.plugin.bindQuietActionButton(panel.querySelector('.cloze-panel-close'), () => this.plugin.exitMode());

    const select = panel.querySelector('.cloze-panel-select');
    select.value = this.currentFilter;
    select.addEventListener('change', () => {
      this.currentFilter = select.value;
      this.currentIndex = 0;
      this.refresh();
    });

    this.plugin.bindQuietActionButton(panel.querySelector('[data-act="export"]'), async () => {
      await this.plugin.exportCardsFromSpans(this.filteredItems.map(x => x.span.id), `${this.mode}-${this.currentFilter}`);
    });

    this.plugin.bindQuietActionButton(panel.querySelector('[data-act="clear"]'), async () => {
      const fp = this.plugin.getCurrentFilePath();
      if (!fp) return;

      const ok = confirm(this.mode === 'review' ? '确定清空当前文件的复习记录？' : '确定清空当前文件的记忆曲线记录？');
      if (!ok) return;

      if (this.mode === 'review') await this.plugin.dataManager.clearReviewData(fp);
      else await this.plugin.dataManager.clearFsrsData(fp);

      this.refresh();
      this.plugin.refreshAllViews();
    });

    this.plugin.bindQuietActionButton(panel.querySelector('[data-act="prev"]'), () => this.navigate(-1));
    this.plugin.bindQuietActionButton(panel.querySelector('[data-act="next"]'), () => this.navigate(1));

    return panel;
  }

  show() {
    if (this.el) this.el.remove();
    this.el = this.build();
    document.body.appendChild(this.el);
    this.makeDrag();
    this.refresh();
  }

  hide() {
    if (this.el) this.el.remove();
    this.el = null;
  }

  collectItems() {
    const fp = this.plugin.getCurrentFilePath();
    if (!fp) return [];

    const all = this.plugin.getPanelSpans();
    let docIdx = 1;
    const arr = [];

    if (this.mode === 'review') {
      for (const span of all) {
        const rec = this.plugin.dataManager.getRecord(fp, span.id);
        const fc = rec.failCount || 0;

        const ok = this.currentFilter === 'unmastered'
          ? fc > 0
          : this.currentFilter === 'ge2'
            ? fc >= 2
            : this.currentFilter === 'ge3'
              ? fc >= 3
              : fc >= 4;

        if (ok) {
          arr.push({
            span,
            rec,
            docIdx,
            fc,
            locator: rec.locator || this.plugin.buildLocator(span)
          });
        }

        docIdx++;
      }
    } else {
      const map = new Map(this.plugin.dataManager.getFsrsCards(fp, this.currentFilter, this.plugin.fsrs).map(x => [x.id, x]));
      for (const span of all) {
        if (map.has(span.id)) {
          const card = map.get(span.id);
          arr.push({
            span,
            rec: card.rec,
            docIdx,
            R: card.R,
            locator: card.rec.locator || this.plugin.buildLocator(span)
          });
        }
        docIdx++;
      }
    }

    return arr;
  }

  refresh() {
    if (!this.el) return;

    this.filteredItems = this.collectItems();
    if (this.currentIndex >= this.filteredItems.length) {
      this.currentIndex = Math.max(0, this.filteredItems.length - 1);
    }

    const pt = this.el.querySelector('[data-role="progress-text"]');
    const pf = this.el.querySelector('[data-role="progress-fill"]');
    if (pt) pt.textContent = `共 ${this.filteredItems.length} 项`;
    if (pf) pf.style.width = this.filteredItems.length ? '100%' : '0%';

    const list = this.el.querySelector('[data-role="item-list"]');
    list.innerHTML = '';

    this.filteredItems.forEach((item, i) => {
      list.appendChild(this.renderItem(item, i));
    });
  }

  renderItem(item, i) {
    const row = document.createElement('div');
    row.className = `cloze-panel-item ${this.mode === 'review' ? failColorClass(item.fc) : rColorClass(item.R)}`;
    row.dataset.panelClozeId = item.span.id;

    if (i === this.currentIndex) row.classList.add('is-active');

    const idx = document.createElement('span');
    idx.className = 'cloze-panel-item-idx';
    idx.textContent = `-${item.docIdx}`;

    const text = document.createElement('span');
    text.className = 'cloze-panel-item-text';
    text.textContent = getPanelDisplayText(this.plugin, item.span);
    text.title = item.span.text;

    row.appendChild(idx);
    row.appendChild(text);

    row.addEventListener('click', async (evt) => {
      if (this.plugin.isUiActionTarget(evt.target)) return;
      if (row.dataset.cpLongPressFired === '1') {
        delete row.dataset.cpLongPressFired;
        return;
      }

      this.currentIndex = i;
      await this.plugin.jumpToCloze(item.span.id, item.locator);
      this.updateActive();
    });

    row.addEventListener('contextmenu', (evt) => {
      this.openContextMenu(item, i, row, evt);
    });

    this.bindLongPress(row, item, i);

    return row;
  }

  bindLongPress(row, item, i) {
    let timer = 0;
    let sx = 0;
    let sy = 0;

    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
    };

    row.addEventListener('pointerdown', (evt) => {
      if (evt.pointerType !== 'touch') return;
      if (this.plugin.isUiActionTarget(evt.target)) return;

      sx = evt.clientX;
      sy = evt.clientY;
      clear();

      timer = window.setTimeout(() => {
        timer = 0;
        row.dataset.cpLongPressFired = '1';
        setTimeout(() => {
          if (row.dataset.cpLongPressFired === '1') delete row.dataset.cpLongPressFired;
        }, 900);
        this.openContextMenu(item, i, row, evt);
      }, 560);
    });

    row.addEventListener('pointermove', (evt) => {
      if (!timer) return;
      if (Math.abs(evt.clientX - sx) > 12 || Math.abs(evt.clientY - sy) > 12) clear();
    });

    row.addEventListener('pointerup', clear);
    row.addEventListener('pointercancel', clear);
    row.addEventListener('pointerleave', clear);
  }

  openContextMenu(item, i, row, evt) {
    this.plugin.consumeUiEvent(evt);

    const menu = new Menu();

    menu.addItem(mi => {
      mi.setTitle('显示答案');
      try { mi.setIcon('eye'); } catch (e) {}
      mi.onClick(() => {
        this.revealItem(item, row);
      });
    });

    menu.addItem(mi => {
      mi.setTitle('跳转位置');
      try { mi.setIcon('locate'); } catch (e) {}
      mi.onClick(async () => {
        this.currentIndex = i;
        await this.plugin.jumpToCloze(item.span.id, item.locator);
        this.updateActive();
      });
    });

    menu.addSeparator();

    menu.addItem(mi => {
      mi.setTitle('删除条目');
      try { mi.setIcon('trash'); } catch (e) {}
      mi.onClick(async () => {
        const ok = confirm(
          this.mode === 'review'
            ? `确定删除该复习条目？\n\n${item.span.text}`
            : `确定删除该记忆曲线条目？\n\n${item.span.text}`
        );

        if (!ok) return;

        await this.plugin.deletePanelRecord(item.span.id);
        this.refresh();
      });
    });

    try {
      if (typeof menu.showAtMouseEvent === 'function' && evt?.type === 'contextmenu') {
        menu.showAtMouseEvent(evt);
      } else {
        menu.showAtPosition({
          x: evt?.clientX || innerWidth / 2,
          y: evt?.clientY || innerHeight / 2
        });
      }
    } catch (e) {
      menu.showAtPosition({
        x: evt?.clientX || innerWidth / 2,
        y: evt?.clientY || innerHeight / 2
      });
    }
  }

  revealItem(item, row) {
    this.plugin.setRevealState(item.span.id, true, true);

    const text = row?.querySelector?.('.cloze-panel-item-text');
    if (text) {
      text.textContent = item.span.text;
      row.classList.add('is-answer-shown');
    }

    this.plugin.syncClozeVisual(item.span.id);
  }

  navigate(dir) {
    if (!this.filteredItems.length) return;

    this.currentIndex = (this.currentIndex + dir + this.filteredItems.length) % this.filteredItems.length;
    const item = this.filteredItems[this.currentIndex];
    this.plugin.jumpToCloze(item.span.id, item.locator);
    this.updateActive();
  }

  updateActive() {
    if (!this.el) return;
    this.el.querySelectorAll('.cloze-panel-item').forEach((el, i) => {
      el.classList.toggle('is-active', i === this.currentIndex);
    });
  }

  makeDrag() {
    const header = this.el?.querySelector('.cloze-panel-header');
    if (!header) return;

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cloze-panel-close')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const sx = e.clientX;
      const sy = e.clientY;
      const rect = this.el.getBoundingClientRect();
      const sl = rect.left;
      const st = rect.top;

      const move = (ev) => {
        this.el.style.left = sl + (ev.clientX - sx) + 'px';
        this.el.style.top = st + (ev.clientY - sy) + 'px';
        this.el.style.right = 'auto';
        this.el.style.bottom = 'auto';
      };

      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
      };

      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
  }
}

/* ========================= Reading Processor ========================= */

class ReadingViewProcessor {
  constructor(plugin) {
    this.plugin = plugin;
    this.observer = null;
    this.timer = null;
    this.onScroll = rafThrottle(() => {
      if (this.plugin.currentMode !== 'normal') this.refreshActive(true);
    });
  }

  start() {
    this.stop();
    this.observer = new MutationObserver(() => {
      if (this.plugin.currentMode !== 'normal') this.schedule();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('scroll', this.onScroll, true);
  }

  stop() {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    document.removeEventListener('scroll', this.onScroll, true);
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refreshActive(false);
    }, 100);
  }

  forceRefreshSeries() {
    [40, 160, 400].forEach(d => setTimeout(() => this.refreshActive(false), d));
  }

  getRoot() {
    const leaf = this.plugin.getActiveLeaf();
    const c = leaf?.containerEl || leaf?.view?.containerEl || null;
    return c?.querySelector('.markdown-reading-view, .markdown-preview-view') || null;
  }

  collect(root, visibleOnly) {
    const out = [];
    const push = (sel, type) => root.querySelectorAll(sel).forEach(el => {
      if (!(el instanceof HTMLElement)) return;
      if (el.closest('.cloze-reading-wrap')) return;
      if (el.closest('code, pre, mjx-container, .math, .math-block')) return;

      if (visibleOnly) {
        const rr = root.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        if (er.bottom < rr.top - 1200 || er.top > rr.bottom + 1200) return;
      }

      const text = normalizeText(el.textContent || '');
      if (!text) return;
      out.push({ el, type, text });
    });

    if (this.plugin.settings.enableHighlight) push('mark', 'highlight');
    if (this.plugin.settings.enableBold) push('strong', 'bold');
    if (this.plugin.settings.enableItalic) push('em', 'italic');
    if (this.plugin.settings.enableUnderline) push('u', 'underline');

    return out;
  }

  map(candidates, spans) {
    const pool = new Map();
    const used = new Set();
    const local = new Map();
    const res = [];

    for (const s of spans) {
      if (!['highlight', 'bold', 'italic', 'underline'].includes(s.type)) continue;
      const key = `${s.type}|${normalizeText(s.text)}`;
      if (!pool.has(key)) pool.set(key, []);
      pool.get(key).push(s);
    }

    for (const c of candidates) {
      const key = `${c.type}|${normalizeText(c.text)}`;
      const n = (local.get(key) || 0) + 1;
      local.set(key, n);

      const arr = pool.get(key) || [];
      const span = arr.find(s => !used.has(s.id) && s.seqInLine === n) || arr.find(s => !used.has(s.id));
      if (!span) continue;

      used.add(span.id);
      res.push({ el: c.el, span });
    }

    return res;
  }

  ensureWrap(sourceEl, span) {
    const ex = sourceEl.closest('.cloze-reading-wrap');
    if (ex && ex.dataset.clozeId === span.id) return this.updateWrap(ex, span);

    const rec = this.plugin.dataManager.getRecord(span.filePath, span.id);

    const wrap = document.createElement('span');
    wrap.className = 'cloze-reading-wrap';
    wrap.dataset.clozeId = span.id;

    const original = sourceEl.cloneNode(true);
    original.classList.add('cloze-reading-original');

    const hint = document.createElement('span');
    hint.className = 'cloze-hint cloze-reading-hint';
    hint.dataset.clozeId = span.id;
    hint.dataset.clozeText = span.text;
    hint.textContent = span.text;

    if (this.plugin.settings.fixedWidth) hint.classList.add('fixed-width');
    const fc = failColorClass(rec.failCount || 0);
    if (fc) hint.classList.add(fc);

    if (!this.plugin.revealState.has(span.id)) {
      this.plugin.setRevealState(span.id, !this.plugin.shouldHideSpan(span), false);
    }

    const st = this.plugin.getRevealState(span.id);
    hint.classList.add(st.revealed ? 'is-revealed' : 'is-hidden');
    original.style.display = st.revealed ? '' : 'none';

    hint.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.plugin.handleReadingLikeClick(hint, original, span);
    };

    wrap.appendChild(original);
    wrap.appendChild(hint);
    sourceEl.replaceWith(wrap);

    this.plugin.registerClozeElement(span.id, hint, span, 'reading', original);
    this.plugin.registerReadingDomIndex(span.id, hint, wrap, original);
  }

  updateWrap(wrap, span) {
    const hint = wrap.querySelector(':scope > .cloze-reading-hint');
    const original = wrap.querySelector(':scope > .cloze-reading-original');
    if (!hint) return;

    const rec = this.plugin.dataManager.getRecord(span.filePath, span.id);
    hint.dataset.clozeId = span.id;
    hint.dataset.clozeText = span.text;
    hint.textContent = span.text;
    hint.classList.remove('fail-1', 'fail-2', 'fail-3', 'fail-4');

    const fc = failColorClass(rec.failCount || 0);
    if (fc) hint.classList.add(fc);

    const st = this.plugin.getRevealState(span.id);
    hint.classList.toggle('is-hidden', !st.revealed);
    hint.classList.toggle('is-revealed', st.revealed);
    if (original) original.style.display = st.revealed ? '' : 'none';

    this.plugin.registerClozeElement(span.id, hint, span, 'reading', original);
    this.plugin.registerReadingDomIndex(span.id, hint, wrap, original);
  }

  process(root, filePath, visibleOnly) {
    if (!(root instanceof HTMLElement)) return;

    const spans = this.plugin.getLiveStableSpans(filePath);
    if (!spans.length) return;

    this.map(this.collect(root, visibleOnly), spans).forEach(m => this.ensureWrap(m.el, m.span));

    root.querySelectorAll('.cloze-reading-wrap').forEach(w => {
      const s = spans.find(x => x.id === w.dataset.clozeId);
      if (s) this.updateWrap(w, s);
    });
  }

  refreshActive(visibleOnly = false) {
    if (this.plugin.currentMode === 'normal') return;

    const root = this.getRoot();
    const fp = this.plugin.getCurrentFilePath();
    if (!root || !fp) return;

    this.process(root, fp, visibleOnly);
  }

  unwrapAll() {
    document.querySelectorAll('.cloze-reading-wrap').forEach(w => {
      const original = w.querySelector(':scope > .cloze-reading-original');
      if (!original) return;
      original.classList.remove('cloze-reading-original');
      original.style.display = '';
      w.replaceWith(original);
    });
  }
}

/* ========================= Table Processor 极限兼容版 ========================= */

class LivePreviewTableWidgetProcessor {
  constructor(plugin) {
    this.plugin = plugin;
    this.observer = null;
    this.timer = null;
    this.isRefreshing = false;
    this.onScroll = rafThrottle(() => {
      if (this.plugin.currentMode !== 'normal') this.refreshActiveEditor();
    });
  }

  start() {
    this.stop();
    this.observer = new MutationObserver(() => {
      if (this.plugin.currentMode !== 'normal') this.schedule();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('scroll', this.onScroll, true);
  }

  stop() {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    document.removeEventListener('scroll', this.onScroll, true);
    this.removeAllOverlays();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refreshActiveEditor();
    }, 100);
  }

  forceRefreshSeries() {
    [60, 180, 420].forEach(d => setTimeout(() => this.refreshActiveEditor(), d));
  }

  getRoot() {
    return getActiveMarkdownView(this.plugin.app)?.editor?.cm?.dom || null;
  }

  removeAllOverlays() {
    const root = this.getRoot() || document;
    root.querySelectorAll('.cloze-table-cell-overlay-host').forEach(h => h.classList.remove('cloze-table-cell-overlay-host'));
    root.querySelectorAll('.cloze-table-overlay').forEach(el => el.remove());
  }

  refreshActiveEditor() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      if (!this.plugin.settings.enableTableCompat) return;
      if (this.plugin.currentMode === 'normal') return this.removeAllOverlays();

      const root = this.getRoot();
      const fp = this.plugin.getCurrentFilePath();
      if (!root || !fp) return;

      const spans = this.plugin.getLiveStableSpans(fp).filter(s => s.inTable);
      if (!spans.length) return this.removeAllOverlays();

      let wrapped = 0;
      let cellCount = 0;

      for (const table of Array.from(root.querySelectorAll('.cm-table-widget table'))) {
        for (const row of Array.from(table.querySelectorAll('tr'))) {
          const cells = Array.from(row.querySelectorAll('td,th'));
          cellCount += cells.length;
          wrapped += this.processRow(cells, spans);
        }
      }

      this.cleanupStale(root, spans);
      this.plugin.logger.log('table refresh', {
        tableSpanCount: spans.length,
        cellCount,
        wrapped
      });
    } finally {
      this.isRefreshing = false;
    }
  }

  cleanupStale(root, spans) {
    const ids = new Set(spans.map(s => s.id));
    root.querySelectorAll('.cloze-table-overlay').forEach(el => {
      if (!ids.has(el.dataset.clozeId || '')) el.remove();
    });
  }

  compactText(s) {
    return normalizeText(s)
      .replace(/[\s\u00a0\u200b-\u200f\u2028\u2029\ufeff]+/g, '')
      .trim();
  }

  processRow(cells, spans) {
    if (!cells.length) return 0;

    const rowPlain = rowPlainFromDomCells(cells);
    if (!rowPlain) return 0;

    const rowSpans = spans.filter(s => s.rowPlain === rowPlain);
    if (!rowSpans.length) return 0;

    let count = 0;
    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col];
      if (!(cell instanceof HTMLElement)) continue;

      const cellPlain = normalizeCellPlain(domTextWithBreaks(cell));
      if (!cellPlain) continue;

      const candidates = rowSpans.filter(s => {
        if (s.tableCol !== col) return false;
        const spanCellPlain = normalizeText(s.tableCellPlain || '');
        const spanCellCompact = this.compactText(s.tableCellPlain || '');
        const samePlain = spanCellPlain === cellPlain;
        const sameCompact = !!spanCellCompact && spanCellCompact === this.compactText(cellPlain);
        if (!samePlain && !sameCompact) return false;
        return String(s.tableCellMarkdown || '').includes(String(s.raw || ''));
      }).sort((a, b) => (
        ((a.tableOccurrence || 1) - (b.tableOccurrence || 1)) ||
        (normalizeText(b.text).length - normalizeText(a.text).length)
      ));

      if (!candidates.length) {
        this.cleanupCell(cell, new Set());
        continue;
      }

      count += this.syncCell(cell, candidates);
    }

    return count;
  }

  cleanupCell(cell, validIds) {
    cell.querySelectorAll(':scope > .cloze-table-overlay').forEach(el => {
      if (!validIds.has(el.dataset.clozeId || '')) el.remove();
    });
    if (!cell.querySelector(':scope > .cloze-table-overlay')) {
      cell.classList.remove('cloze-table-cell-overlay-host');
    }
  }

  syncCell(cell, spans) {
    const hostRect = safeRect(cell);
    if (!hostRect || hostRect.width <= 0 || hostRect.height <= 0) return 0;

    const validIds = new Set(spans.map(s => s.id));
    this.cleanupCell(cell, validIds);

    const flow = this.buildTextFlow(cell);
    if (!flow.fullText) return 0;

    const usedBoxes = [];
    cell.querySelectorAll(':scope > .cloze-table-overlay').forEach(g => {
      const r = {
        left: parseFloat(g.dataset.boxLeft || '0') || 0,
        top: parseFloat(g.dataset.boxTop || '0') || 0,
        width: parseFloat(g.dataset.boxWidth || '0') || 0,
        height: parseFloat(g.dataset.boxHeight || '0') || 0
      };
      if (r.width > 0 && r.height > 0) usedBoxes.push(r);
    });

    let count = 0;
    for (const span of spans) {
      const existed = cell.querySelector(`:scope > .cloze-table-overlay[data-cloze-id="${span.id}"]`);
      if (existed) {
        this.updateGroupState(existed, span);
        count++;
        continue;
      }

      const hit = this.findBestHit(flow, span, usedBoxes, hostRect, cell);
      if (!hit) continue;

      if (this.mountGroup(cell, span, hit)) {
        usedBoxes.push(hit.box);
        count++;
      }
    }

    return count;
  }

  buildTextFlow(cell) {
    const segments = [];
    let fullText = '';

    const pushText = (node, raw) => {
      if (!raw) return;
      const start = fullText.length;
      fullText += raw;
      segments.push({ node, start, end: fullText.length, text: raw });
    };

    const walk = (node) => {
      if (!node) return;

      if (node.nodeType === 3) {
        if (!node.parentElement) return;
        if (node.parentElement.closest('.cloze-table-overlay')) return;
        pushText(node, node.nodeValue || '');
        return;
      }

      if (node.nodeType !== 1) return;

      const el = node;
      if (el.closest('.cloze-table-overlay')) return;

      if (el.tagName === 'BR') {
        fullText += '\n';
        return;
      }

      for (const child of Array.from(node.childNodes || [])) {
        walk(child);
      }
    };

    for (const child of Array.from(cell.childNodes || [])) {
      walk(child);
    }

    return { fullText, segments };
  }

  allOccurrenceIndices(haystack, needle) {
    const out = [];
    if (!needle) return out;

    let from = 0;
    while (from < haystack.length) {
      const idx = haystack.indexOf(needle, from);
      if (idx < 0) break;
      out.push(idx);
      from = idx + Math.max(1, needle.length);
    }

    return out;
  }

  compactOccurrenceIndices(flow, needle) {
    const out = [];
    const target = this.compactText(needle);
    if (!target) return out;

    let compact = '';
    const map = [];
    for (const seg of flow.segments || []) {
      const text = String(seg.text || '');
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/[\s\u00a0\u200b-\u200f\u2028\u2029\ufeff]/.test(ch)) continue;
        compact += ch;
        map.push(seg.start + i);
      }
    }

    let from = 0;
    while (from < compact.length) {
      const idx = compact.indexOf(target, from);
      if (idx < 0) break;
      const start = map[idx];
      const end = map[Math.min(map.length - 1, idx + target.length - 1)] + 1;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) out.push({ idx: start, end });
      from = idx + Math.max(1, target.length);
    }

    return out;
  }

  rankOccurrences(fullText, span, indices) {
    const occ = span.tableOccurrence || 1;
    const beforeKey = normalizeText(span.contextBefore || '').slice(-12);
    const afterKey = normalizeText(span.contextAfter || '').slice(0, 12);

    return indices.map((idx, i) => {
      const order = i + 1;
      const before = normalizeText(fullText.slice(Math.max(0, idx - 30), idx));
      const after = normalizeText(fullText.slice(idx + span.text.length, idx + span.text.length + 30));

      let score = 0;
      if (order === occ) score += 200;
      score -= Math.abs(order - occ) * 12;
      if (beforeKey && before.includes(beforeKey)) score += 40;
      if (afterKey && after.includes(afterKey)) score += 40;
      if (normalizeText(span.text).length >= 4) score += 6;

      return { idx, score };
    }).sort((a, b) => b.score - a.score || a.idx - b.idx);
  }

  mapOffset(segments, offset) {
    for (const seg of segments) {
      if (offset >= seg.start && offset < seg.end) {
        return { node: seg.node, localOffset: offset - seg.start };
      }
    }

    if (segments.length) {
      const last = segments[segments.length - 1];
      return { node: last.node, localOffset: Math.max(0, last.text.length - 1) };
    }

    return null;
  }

  rectHit(flow, start, end, hostRect) {
    const sm = this.mapOffset(flow.segments, start);
    const em = this.mapOffset(flow.segments, Math.max(start + 1, end - 1));
    if (!sm || !em) return null;

    try {
      const range = document.createRange();
      range.setStart(sm.node, sm.localOffset);
      range.setEnd(em.node, em.localOffset + 1);

      const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      if (!rects.length) return null;

      const relRects = rects.map(r => ({
        left: Math.max(0, r.left - hostRect.left - 1),
        top: Math.max(0, r.top - hostRect.top - 1),
        width: Math.max(6, Math.min(hostRect.width, r.width + 2)),
        height: Math.max(14, Math.min(hostRect.height, r.height + 2))
      }));

      const left = Math.min(...relRects.map(r => r.left));
      const top = Math.min(...relRects.map(r => r.top));
      const right = Math.max(...relRects.map(r => r.left + r.width));
      const bottom = Math.max(...relRects.map(r => r.top + r.height));

      return {
        rects: relRects,
        box: {
          left,
          top,
          width: Math.max(8, right - left),
          height: Math.max(16, bottom - top)
        }
      };
    } catch (e) {
      return null;
    }
  }

  boxUsed(hit, used) {
    const b = hit.box || hit;
    return used.some(r => {
      const ox = Math.max(0, Math.min(r.left + r.width, b.left + b.width) - Math.max(r.left, b.left));
      const oy = Math.max(0, Math.min(r.top + r.height, b.top + b.height) - Math.max(r.top, b.top));
      return ox > 4 && oy > 4;
    });
  }

  findBestHit(flow, span, usedBoxes, hostRect, cell) {
    const fullText = flow.fullText;
    if (!fullText) return null;

    const directIndices = this.allOccurrenceIndices(fullText, span.text)
      .map(idx => ({ idx, end: idx + span.text.length, direct: true }));
    const compactIndices = this.compactOccurrenceIndices(flow, span.text)
      .filter(x => !directIndices.some(d => d.idx === x.idx && d.end === x.end));
    const hits = [...directIndices, ...compactIndices];

    if (!hits.length) {
      if (this.compactText(domTextWithBreaks(cell)) === this.compactText(span.text)) {
        return {
          rects: [{ left: 0, top: 0, width: hostRect.width, height: hostRect.height }],
          box: { left: 0, top: 0, width: hostRect.width, height: hostRect.height }
        };
      }
      return null;
    }

    const rankedDirect = this.rankOccurrences(fullText, span, directIndices.map(x => x.idx))
      .map(item => directIndices.find(x => x.idx === item.idx) || { idx: item.idx, end: item.idx + span.text.length });
    const ranked = [...rankedDirect, ...compactIndices];

    for (const item of ranked) {
      const hit = this.rectHit(flow, item.idx, item.end, hostRect);
      if (hit && !this.boxUsed(hit, usedBoxes)) return hit;
    }

    for (const item of hits) {
      const hit = this.rectHit(flow, item.idx, item.end, hostRect);
      if (hit) return hit;
    }

    return null;
  }

  updateGroupState(group, span) {
    const rec = this.plugin.dataManager.getRecord(span.filePath, span.id);
    group.dataset.clozeId = span.id;
    group.dataset.clozeText = span.text;

    const textEl = group.querySelector(':scope > .cloze-table-overlay-text');
    if (textEl) {
      textEl.textContent = span.text;
      textEl.classList.remove('fail-1', 'fail-2', 'fail-3', 'fail-4');
      const fc = failColorClass(rec.failCount || 0);
      if (fc) textEl.classList.add(fc);
    }

    if (!this.plugin.revealState.has(span.id)) {
      this.plugin.setRevealState(span.id, !this.plugin.shouldHideSpan(span), false);
    }

    const st = this.plugin.getRevealState(span.id);
    group.classList.toggle('is-hidden', !st.revealed);
    group.classList.toggle('is-revealed', st.revealed);

    if (textEl) {
      textEl.classList.toggle('is-hidden', !st.revealed);
      textEl.classList.toggle('is-revealed', st.revealed);
    }

    this.plugin.registerClozeElement(span.id, textEl || group, span, 'table-overlay', null);
    if (textEl instanceof HTMLElement) {
      this.plugin.updateClozeVisualElement(textEl, span, rec);
    }
  }

  mountGroup(cell, span, hit) {
    cell.classList.add('cloze-table-cell-overlay-host');

    const rec = this.plugin.dataManager.getRecord(span.filePath, span.id);

    const group = document.createElement('span');
    group.className = 'cloze-table-overlay';
    group.dataset.clozeId = span.id;
    group.dataset.clozeText = span.text;
    group.dataset.boxLeft = String(hit.box.left);
    group.dataset.boxTop = String(hit.box.top);
    group.dataset.boxWidth = String(hit.box.width);
    group.dataset.boxHeight = String(hit.box.height);
    group.style.left = '0px';
    group.style.top = '0px';
    group.style.right = '0px';
    group.style.bottom = '0px';

    for (const r of hit.rects) {
      const mask = document.createElement('span');
      mask.className = 'cloze-table-overlay-mask';
      mask.style.left = r.left + 'px';
      mask.style.top = r.top + 'px';
      mask.style.width = r.width + 'px';
      mask.style.height = r.height + 'px';
      group.appendChild(mask);
    }

    const textEl = document.createElement('span');
    textEl.className = 'cloze-table-overlay-text cloze-hint';
    textEl.dataset.clozeId = span.id;
    textEl.dataset.clozeText = span.text;
    textEl.textContent = this.plugin.shouldHideSpan(span) ? makeUnderlineMask(span.text) : span.text;

    const rects = (Array.isArray(hit.rects) ? hit.rects : [])
      .filter(r => r && r.width > 1 && r.height > 1);

    const unionLeft = rects.length ? Math.min(...rects.map(r => r.left)) : hit.box.left;
    const unionTop = rects.length ? Math.min(...rects.map(r => r.top)) : hit.box.top;
    const unionRight = rects.length ? Math.max(...rects.map(r => r.left + r.width)) : (hit.box.left + hit.box.width);
    const unionBottom = rects.length ? Math.max(...rects.map(r => r.top + r.height)) : (hit.box.top + hit.box.height);
    const unionWidth = Math.max(1, unionRight - unionLeft);
    const unionHeight = Math.max(1, unionBottom - unionTop);

    textEl.style.left = unionLeft + 'px';
    textEl.style.top = unionTop + 'px';
    textEl.style.width = unionWidth + 'px';
    textEl.style.height = unionHeight + 'px';

    const firstHeight = rects[0]?.height || unionHeight;
    const isMultiline = rects.length > 1 || unionHeight > firstHeight * 1.35;
    textEl.classList.toggle('is-multiline', isMultiline);
    textEl.style.whiteSpace = isMultiline ? 'normal' : 'nowrap';
    textEl.style.wordBreak = isMultiline ? 'break-all' : 'normal';
    textEl.style.overflow = 'hidden';
    textEl.style.alignItems = isMultiline ? 'flex-start' : 'center';
    textEl.style.lineHeight = isMultiline ? '1.35' : 'normal';

    if (this.plugin.settings.fixedWidth) textEl.classList.add('fixed-width');
    const fc = failColorClass(rec.failCount || 0);
    if (fc) textEl.classList.add(fc);

    if (!this.plugin.revealState.has(span.id)) {
      this.plugin.setRevealState(span.id, !this.plugin.shouldHideSpan(span), false);
    }

    const st = this.plugin.getRevealState(span.id);
    group.classList.add(st.revealed ? 'is-revealed' : 'is-hidden');
    textEl.classList.add(st.revealed ? 'is-revealed' : 'is-hidden');

    const clicker = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.plugin.handleReadingLikeClick(textEl, null, span);
    };

    textEl.addEventListener('click', clicker);
    group.querySelectorAll('.cloze-table-overlay-mask').forEach(m => m.addEventListener('click', clicker));

    group.appendChild(textEl);
    cell.appendChild(group);
    this.plugin.registerClozeElement(span.id, textEl, span, 'table-overlay', null);
    this.plugin.updateClozeVisualElement(textEl, span, rec);
    return true;
  }

  findElementById(id) {
    const root = this.getRoot();
    if (!root) return null;

    return root.querySelector(`.cloze-table-overlay[data-cloze-id="${id}"] .cloze-table-overlay-text`)
      || root.querySelector(`.cloze-table-overlay[data-cloze-id="${id}"]`);
  }
}

/* ========================= CM6 ========================= */

function buildCM6Extension(plugin) {
  if (!cmView || !cmState) return null;

  const { ViewPlugin, Decoration, WidgetType } = cmView;
  const { RangeSetBuilder } = cmState;

  class ClozeWidget extends WidgetType {
    constructor(span, pluginRef) {
      super();
      this.span = span;
      this.pluginRef = pluginRef;
    }

    toDOM() {
      const span = this.span;
      const pluginRef = this.pluginRef;
      const rec = pluginRef.dataManager.getRecord(span.filePath, span.id);

      const el = document.createElement('span');
      el.className = 'cloze-hint';
      el.dataset.clozeId = span.id;
      el.dataset.clozeText = span.text;
      el.textContent = span.text;

      if (pluginRef.settings.fixedWidth) el.classList.add('fixed-width');
      const fc = failColorClass(rec.failCount || 0);
      if (fc) el.classList.add(fc);

      if (!pluginRef.revealState.has(span.id)) {
        pluginRef.setRevealState(span.id, !pluginRef.shouldHideSpan(span), false);
      }

      const st = pluginRef.getRevealState(span.id);
      el.classList.add(st.revealed ? 'is-revealed' : 'is-hidden');

      el.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        pluginRef.handleClozeClick(el, span);
      };

      pluginRef.registerClozeElement(span.id, el, span, 'live', null);
      return el;
    }

    eq(other) {
      return other instanceof ClozeWidget && other.span.id === this.span.id;
    }

    ignoreEvent() {
      return false;
    }
  }

  function buildDecorations(view) {
    if (plugin.currentMode === 'normal') return Decoration.none;

    const filePath = plugin.getCurrentFilePath();
    if (!filePath) return Decoration.none;

    const docText = view.state.doc.toString();
    if (!plugin.checkTagFilter(docText, filePath)) return Decoration.none;

    const spans = plugin.parser.parse(docText, filePath);
    plugin.currentSpans = spans;
    plugin.updateStableSpans(filePath, spans);

    const builder = new RangeSetBuilder();
    const docLen = view.state.doc.length;
    const from = Math.max(0, view.viewport.from - 25000);
    const to = Math.min(docLen, view.viewport.to + 25000);

    for (const span of spans) {
      if (span.from < from || span.to > to) continue;
      builder.add(span.from, span.to, Decoration.replace({
        widget: new ClozeWidget(span, plugin),
        inclusive: false
      }));
    }

    return builder.finish();
  }

  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.modeVersion = plugin.modeVersion || 0;
      this.decorations = buildDecorations(view);
    }

    update(update) {
      const cur = plugin.modeVersion || 0;
      const modeChanged = cur !== this.modeVersion;
      if (modeChanged) this.modeVersion = cur;

      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || modeChanged) {
        this.decorations = buildDecorations(update.view);
        setTimeout(() => {
          plugin.tableProcessor?.refreshActiveEditor();
          plugin.refreshPanelsOnly();
          if (plugin.currentMode === 'learn' && plugin.settings.enableDivider) {
            plugin.dividerLine.onScroll();
          }
        }, 0);
      }
    }
  }, { decorations: v => v.decorations });
}

/* ========================= Setting Tab ========================= */

class ClozePlusSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  toggle(containerEl, name, desc, key, onChange = null) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle(t => t
        .setValue(this.plugin.settings[key])
        .onChange(async (v) => {
          this.plugin.settings[key] = v;
          await this.plugin.saveSettingsOnly();
          if (onChange) await onChange(v);
          else this.plugin.refreshAllViews();
        }));
  }

  color(containerEl, name, key) {
    new Setting(containerEl)
      .setName(name)
      .addColorPicker(cp => cp
        .setValue(this.plugin.settings[key])
        .onChange(async (v) => {
          this.plugin.settings[key] = v;
          await this.plugin.saveSettingsOnly();
          this.plugin.applyDynamicStyles();
          this.plugin.refreshAllViews();
        }));
  }

  desc(lines) {
    const frag = document.createDocumentFragment();

    for (let i = 0; i < lines.length; i++) {
      if (i) frag.appendChild(document.createElement('br'));
      frag.appendChild(document.createTextNode(lines[i]));
    }

    return frag;
  }

  async saveDataStorageSettings(message = '') {
    if (this.plugin.dataManager) {
      await this.plugin.dataManager.save();
    } else {
      await this.plugin.saveSettingsOnly();
    }

    if (message) {
      new Notice(message);
    }
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Cloze Plus 设置' });

    containerEl.createEl('h3', { text: 'Cloze 来源' });
    this.toggle(containerEl, '花括号文字', '启用 {{...}}', 'enableCurly');
    this.toggle(containerEl, '高亮文字', '启用 ==...==', 'enableHighlight');
    this.toggle(containerEl, '粗体文字', '启用 **...**', 'enableBold');
    this.toggle(containerEl, '下划线文字', '启用 <u>...</u>', 'enableUnderline');
    this.toggle(containerEl, '斜体文字', '启用 *...* / _..._', 'enableItalic');
    this.toggle(containerEl, '括号文字', '启用 [...]', 'enableBracket');

    containerEl.createEl('h3', { text: '显示设置' });

    new Setting(containerEl)
      .setName('作用标签')
      .setDesc(this.desc([
        '这是插件是否处理当前笔记的过滤条件。',
        '例如填 #cloze 后，只有正文含 #cloze，或 frontmatter tags 里有 cloze 的笔记才会生效。',
        '留空 = 所有笔记都生效。'
      ]))
      .addText(t => {
        t.setPlaceholder('#cloze')
          .setValue(this.plugin.settings.tagFilter)
          .onChange(async (v) => {
            this.plugin.settings.tagFilter = v.trim();
            await this.plugin.saveSettingsOnly();
            this.plugin.refreshAllViews();
          });
      });

    this.toggle(containerEl, '学习模式默认隐藏', '', 'defaultHide');
    this.toggle(containerEl, '固定填空宽度', '', 'fixedWidth');
    this.toggle(containerEl, '启用表格兼容模式', '', 'enableTableCompat');

    containerEl.createEl('h3', { text: '数据设置' });

    new Setting(containerEl)
      .setName('数据存储方式')
      .setDesc(this.desc([
        '单一 data：所有笔记的复习数据保存在一个文件里。',
        '每文件独立 json：每篇笔记一个 json，方便单独查看和同步。'
      ]))
      .addDropdown(d => {
        d.addOption('single', '单一 data')
          .addOption('per-file', '每文件独立 json')
          .setValue(this.plugin.settings.storageMode || 'single')
          .onChange(async (v) => {
            this.plugin.settings.storageMode = v;

            await this.saveDataStorageSettings(
              v === 'single'
                ? '已切换为单一 data，并已写入当前数据位置'
                : '已切换为每文件独立 json，并已写入当前数据位置'
            );

            this.plugin.refreshAllViews();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName('数据保存位置')
      .setDesc(this.desc([
        '插件私有目录：沿用旧版保存方式，数据保存在插件数据中。',
        '库内文件夹：数据保存到当前 vault 里的普通文件夹，方便同步、备份，也可以和导出目录放一起。'
      ]))
      .addDropdown(d => {
        d.addOption('plugin', '插件私有目录')
          .addOption('vault', '库内文件夹')
          .setValue(this.plugin.settings.dataLocation || 'plugin')
          .onChange(async (v) => {
            this.plugin.settings.dataLocation = v;

            await this.saveDataStorageSettings(
              v === 'vault'
                ? '已切换为库内文件夹保存，并已写入新位置'
                : '已切换为插件私有目录保存，并已写入新位置'
            );

            this.plugin.refreshAllViews();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName('使用导出目录作为数据目录')
      .setDesc(this.desc([
        '仅在“数据保存位置 = 库内文件夹”时生效。',
        '开启后，数据会保存到“导出目录”下。',
        '单一 data：导出目录/cloze-data.json',
        '每文件独立 json：导出目录/cloze-data/*.json'
      ]))
      .addToggle(t => {
        t.setValue(!!this.plugin.settings.dataUseExportDir)
          .onChange(async (v) => {
            this.plugin.settings.dataUseExportDir = v;

            await this.saveDataStorageSettings(
              v
                ? '已改为使用导出目录保存数据'
                : '已改为使用单独的数据目录保存数据'
            );

            this.plugin.refreshAllViews();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName('库内数据目录')
      .setDesc(this.desc([
        '仅在“数据保存位置 = 库内文件夹”且未开启“使用导出目录作为数据目录”时使用。',
        '路径相对于 vault 根目录，例如：ClozePlus-Data'
      ]))
      .addText(t => {
        t.setPlaceholder('ClozePlus-Data')
          .setValue(this.plugin.settings.dataVaultDir || 'ClozePlus-Data')
          .onChange(async (v) => {
            this.plugin.settings.dataVaultDir = v.trim() || 'ClozePlus-Data';
            await this.saveDataStorageSettings();
          });

        if (this.plugin.settings.dataUseExportDir) {
          t.setDisabled(true);
        }
      });

    new Setting(containerEl)
      .setName('当前数据位置')
      .setDesc(
        this.plugin.dataManager?.getStorageDescription?.()
        || '当前数据位置暂不可用'
      );

    new Setting(containerEl)
      .setName('颜色样式')
      .addDropdown(d => {
        d.addOption('underline', '下划线')
          .addOption('highlight', '高亮')
          .addOption('both', '下划线 + 高亮')
          .setValue(this.plugin.settings.colorStyle)
          .onChange(async (v) => {
            this.plugin.settings.colorStyle = v;
            await this.plugin.saveSettingsOnly();
            this.plugin.applyDynamicStyles();
            this.plugin.refreshAllViews();
          });
      });

    new Setting(containerEl)
      .setName('下划线宽度')
      .setDesc('px')
      .addSlider(s => {
        s.setLimits(1, 6, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.underlineWidth)
          .onChange(async (v) => {
            this.plugin.settings.underlineWidth = v;
            await this.plugin.saveSettingsOnly();
            this.plugin.applyDynamicStyles();
          });
      });

    this.color(containerEl, '隐藏状态基础色', 'hiddenBaseColor');
    this.color(containerEl, '显示状态基础色', 'shownBaseColor');
    this.color(containerEl, '第一次不会颜色', 'fail1Color');
    this.color(containerEl, '第二次不会颜色', 'fail2Color');
    this.color(containerEl, '第三次不会颜色', 'fail3Color');
    this.color(containerEl, '第四次及以上不会颜色', 'fail4Color');

    containerEl.createEl('h3', { text: '学习线' });
    this.toggle(containerEl, '固定横线', '', 'enableDivider');
    new Setting(containerEl)
      .setName('横线位置 (%)')
      .addSlider(s => {
        s.setLimits(10, 90, 5)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.dividerPosition)
          .onChange(async (v) => {
            this.plugin.settings.dividerPosition = v;
            await this.plugin.saveSettingsOnly();
            this.plugin.dividerLine.updatePosition();
          });
      });

    containerEl.createEl('h3', { text: '导出设置' });

    new Setting(containerEl)
      .setName('导出格式')
      .setDesc('Anki / Spaced Repetition / 原始 markdown')
      .addDropdown(d => {
        d.addOption('anki-tsv', 'Anki TSV')
          .addOption('sr-inline', 'SR inline（Front:: Back）')
          .addOption('sr-multiline', 'SR multiline（Front ? Back）')
          .addOption('raw-markdown', '原始 markdown')
          .setValue(this.plugin.settings.exportProfile)
          .onChange(async (v) => {
            this.plugin.settings.exportProfile = v;
            await this.plugin.saveSettingsOnly();
          });
      });

    new Setting(containerEl)
      .setName('导出文本模式')
      .setDesc('content 占位符使用哪种内容')
      .addDropdown(d => {
        d.addOption('anki-cloze', 'Anki Cloze：{{c1::...}}')
          .addOption('original-markdown', '原始 markdown')
          .addOption('plain-text', '纯文本')
          .setValue(this.plugin.settings.exportTextMode)
          .onChange(async (v) => {
            this.plugin.settings.exportTextMode = v;
            await this.plugin.saveSettingsOnly();
          });
      });

    new Setting(containerEl)
      .setName('导出分隔符')
      .setDesc('支持 \\n')
      .addTextArea(t => {
        t.setValue(this.plugin.settings.exportSeparator || '\\n\\n\\n\\n')
          .onChange(async (v) => {
            this.plugin.settings.exportSeparator = v;
            await this.plugin.saveSettingsOnly();
          });
        t.inputEl.rows = 2;
        t.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('导出目录')
      .setDesc(this.desc([
        '相对于 vault 根目录。',
        '如果“数据设置”里开启了“使用导出目录作为数据目录”，数据也会保存到这个目录下。'
      ]))
      .addText(t => {
        t.setPlaceholder('ClozePlus-Exports')
          .setValue(this.plugin.settings.exportDir || 'ClozePlus-Exports')
          .onChange(async (v) => {
            this.plugin.settings.exportDir = v.trim() || 'ClozePlus-Exports';

            if (
              this.plugin.settings.dataLocation === 'vault' &&
              this.plugin.settings.dataUseExportDir &&
              this.plugin.dataManager
            ) {
              await this.plugin.dataManager.save();
            } else {
              await this.plugin.saveSettingsOnly();
            }
          });
      });

    new Setting(containerEl)
      .setName('正面模板')
      .setDesc(this.desc([
        '占位符必须使用双大括号，例如 {{content}}，不是 {content}。',
        '可用：{{content}} {{anki}} {{raw}} {{plain}} {{source}} {{title}} {{tags}}',
        '{{content}} = 按“导出文本模式”生成的内容。',
        '{{anki}} = 强制使用 Anki Cloze 格式。',
        '常用示例 1：{{content}}',
        '常用示例 2：{{title}} 之后空一行，再写 {{content}}'
      ]))
      .addTextArea(t => {
        t.setValue(this.plugin.settings.exportFrontTemplate || '{{content}}')
          .onChange(async (v) => {
            this.plugin.settings.exportFrontTemplate = v;
            await this.plugin.saveSettingsOnly();
          });
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('背面模板')
      .setDesc(this.desc([
        '占位符必须使用双大括号，例如 {{source}}，不是 {source}。',
        '可用：{{content}} {{anki}} {{raw}} {{plain}} {{source}} {{title}} {{tags}}',
        '{{source}} = 来源文件和行号。',
        '{{tags}} = 导出标签。',
        '常用示例 1：{{source}}',
        '常用示例 2：来源：{{source}}；标签：{{tags}}'
      ]))
      .addTextArea(t => {
        t.setValue(this.plugin.settings.exportBackTemplate || '{{source}}')
          .onChange(async (v) => {
            this.plugin.settings.exportBackTemplate = v;
            await this.plugin.saveSettingsOnly();
          });
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('导出标签')
      .setDesc(this.desc([
        '导出到 Anki / SR 时附加到卡片上的标签。',
        '它和“作用标签”不是一回事。',
        '多个标签用空格分隔，例如：clozeplus 法考 安全生产。',
        '模板中可用 {{tags}} 引用这里的内容。'
      ]))
      .addText(t => {
        t.setValue(this.plugin.settings.exportTags || 'clozeplus')
          .onChange(async (v) => {
            this.plugin.settings.exportTags = v;
            await this.plugin.saveSettingsOnly();
          });
      });

    this.toggle(containerEl, '按标题分组导出', '避免跨标题章节混合导出', 'exportGroupByHeading');
    this.toggle(containerEl, '标题转标签', '将标题路径转换为标签', 'exportHeadingAsTag');

    new Setting(containerEl)
      .setName('导出当前文件全部卡片')
      .addButton(b => b.setButtonText('导出').onClick(() => this.plugin.exportCardsFromSpans(null, 'all')));

    containerEl.createEl('h3', { text: '调试' });
    this.toggle(containerEl, '开启调试日志', '', 'debug');
    new Setting(containerEl).setName('复制调试日志').addButton(b => b.setButtonText('复制').onClick(() => this.plugin.logger.copy()));
    new Setting(containerEl).setName('清空调试日志').addButton(b => b.setButtonText('清空').onClick(() => this.plugin.logger.clear()));
  }
}

/* ========================= Plugin ========================= */

class ClozePlusPlugin extends Plugin {
  constructor() {
    super(...arguments);
    this.currentMode = 'normal';
    this.modeVersion = 0;
    this.currentSpans = [];
    this.fullFileSpansByPath = {};
    this.clozeElements = new Map();
    this.revealState = new Map();
    this.readingDomIndex = new Map();
    this.lockedPanelSpansByMode = { review: null, fsrs: null };
    this.jumpSeq = 0;
    this.jumpRunning = false;
    this.jumpToken = 0;
    this.layoutReady = false;
    this._jumpFlashStates = new WeakMap();
    this._jumpFlashActiveEl = null;
  }

  async onload() {
    await this.loadSettings();

    this.logger = new DebugLogger(this);
    this.fsrs = new FSRS(this, this.settings.requestedRetention);
    this.dataManager = new DataManager(this);
    await this.dataManager.load();

    this.parser = new ClozeParser(this);
    this.popupManager = new PopupManager(this);
    this.dividerLine = new DividerLine(this);
    this.reviewPanel = new ListPanel(this, 'review');
    this.fsrsPanel = new ListPanel(this, 'fsrs');
    this.readingProcessor = new ReadingViewProcessor(this);
    this.tableProcessor = new LivePreviewTableWidgetProcessor(this);

    this.addSettingTab(new ClozePlusSettingTab(this.app, this));

    this.registerMarkdownPostProcessor(() => {
      if (!this.layoutReady || this.currentMode === 'normal') return;
      this.readingProcessor.schedule();
    });

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      if (this.layoutReady) this.onLeafChange();
    }));

    this.registerEvent(this.app.workspace.on('editor-change', () => {
      if (!this.layoutReady) return;
      this.refreshCurrentSpans();
      this.tableProcessor.schedule();
    }));

    this.addCommand({ id: 'enter-learn-mode', name: '进入学习模式', callback: () => this.enterMode('learn') });
    this.addCommand({ id: 'enter-review-mode', name: '进入复习模式', callback: () => this.enterMode('review') });
    this.addCommand({ id: 'enter-fsrs-mode', name: '进入记忆曲线复习模式', callback: () => this.enterMode('fsrs') });
    this.addCommand({ id: 'exit-mode', name: '退出当前模式', callback: () => this.exitMode() });
    this.addCommand({ id: 'export-current-file-cards', name: '导出当前文件全部卡片', callback: () => this.exportCardsFromSpans(null, 'all') });
    this.addCommand({ id: 'copy-debug-log', name: '复制 ClozePlus 调试日志', callback: () => this.logger.copy() });

    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      this.applyDynamicStyles();

      this.statusBar = this.addStatusBarItem();
      this.statusBar.addClass('cloze-status-bar');
      this.statusBar.addEventListener('click', () => this.showModeMenu());
      this.updateStatusBar();

      if (cmState?.Compartment) {
        this.clozeCompartment = new cmState.Compartment();
        const ext = buildCM6Extension(this);
        if (ext) this.registerEditorExtension(this.clozeCompartment.of(ext));
      }

      this.readingProcessor.start();
      this.tableProcessor.start();
      this.refreshCurrentSpans();
      this.logger.log('plugin loaded', { file: this.getCurrentFilePath() });
    });
  }

  onunload() {
    this.exitMode(true);
    this.popupManager?.close();
    this.readingProcessor?.stop();
    this.tableProcessor?.stop();
    this.dynamicStyleEl?.remove();
  }

  async loadSettings() {
    const raw = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
  }

  async saveSettingsOnly() {
    const raw = (await this.loadData()) || {};
    raw.settings = this.settings;

    const storageMode = this.settings.storageMode || 'single';
    const dataLocation = this.settings.dataLocation || 'plugin';

    if (
      dataLocation === 'plugin' &&
      storageMode === 'single'
    ) {
      raw.reviewData = this.dataManager ? this.dataManager.reviewData : (raw.reviewData || {});
      raw.cardMap = this.dataManager ? this.dataManager.cardMap : (raw.cardMap || {});
    } else {
      delete raw.reviewData;
      delete raw.cardMap;
    }

    await this.saveData(raw);
  }

  applyDynamicStyles() {
    if (!document?.head) return;

    if (!this.dynamicStyleEl) {
      this.dynamicStyleEl = document.createElement('style');
      document.head.appendChild(this.dynamicStyleEl);
    }

    const s = this.settings;
    const underline = `${s.underlineWidth || 2}px solid`;
    const useUnderline = s.colorStyle === 'underline' || s.colorStyle === 'both';
    const useHighlight = s.colorStyle === 'highlight' || s.colorStyle === 'both';
    const hiddenAlpha = clamp(s.hiddenHighlightAlpha ?? 22, 0, 100);
    const shownAlpha = clamp(s.shownHighlightAlpha ?? 16, 0, 100);

    this.dynamicStyleEl.textContent = `
      :root{
        ${cssVarName('hidden-base')}:${s.hiddenBaseColor};
        ${cssVarName('shown-base')}:${s.shownBaseColor};
        ${cssVarName('fail1')}:${s.fail1Color};
        ${cssVarName('fail2')}:${s.fail2Color};
        ${cssVarName('fail3')}:${s.fail3Color};
        ${cssVarName('fail4')}:${s.fail4Color};
        ${cssVarName('panel-gap')}:${s.panelItemGap || 2}px;
      }
      .cloze-plus-mode .cloze-hint,.markdown-reading-view .cloze-hint,.markdown-preview-view .cloze-hint{
        border-bottom:${useUnderline ? underline + ' var(' + cssVarName('hidden-base') + ')' : 'none'};
        background:${useHighlight ? `color-mix(in srgb, var(${cssVarName('hidden-base')}) ${hiddenAlpha}%, transparent)` : 'transparent'};
      }
      .cloze-plus-mode .cloze-hint.is-hidden,.markdown-reading-view .cloze-hint.is-hidden,.markdown-preview-view .cloze-hint.is-hidden{
        color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important;
      }
      .cloze-plus-mode .cloze-hint.is-revealed,.markdown-reading-view .cloze-hint.is-revealed,.markdown-preview-view .cloze-hint.is-revealed{
        color:var(--text-normal) !important;-webkit-text-fill-color:currentColor !important;
        background:${useHighlight ? `color-mix(in srgb, var(${cssVarName('shown-base')}) ${shownAlpha}%, transparent)` : 'transparent'};
      }
      .cloze-plus-mode .cloze-hint.fail-1,.markdown-reading-view .cloze-hint.fail-1,.markdown-preview-view .cloze-hint.fail-1{${useUnderline ? `border-bottom-color:var(${cssVarName('fail1')});` : ''}${useHighlight ? `background:color-mix(in srgb, var(${cssVarName('fail1')}) ${hiddenAlpha}%, transparent);` : ''}}
      .cloze-plus-mode .cloze-hint.fail-2,.markdown-reading-view .cloze-hint.fail-2,.markdown-preview-view .cloze-hint.fail-2{${useUnderline ? `border-bottom-color:var(${cssVarName('fail2')});` : ''}${useHighlight ? `background:color-mix(in srgb, var(${cssVarName('fail2')}) ${hiddenAlpha}%, transparent);` : ''}}
      .cloze-plus-mode .cloze-hint.fail-3,.markdown-reading-view .cloze-hint.fail-3,.markdown-preview-view .cloze-hint.fail-3{${useUnderline ? `border-bottom-color:var(${cssVarName('fail3')});` : ''}${useHighlight ? `background:color-mix(in srgb, var(${cssVarName('fail3')}) ${hiddenAlpha}%, transparent);` : ''}}
      .cloze-plus-mode .cloze-hint.fail-4,.markdown-reading-view .cloze-hint.fail-4,.markdown-preview-view .cloze-hint.fail-4{${useUnderline ? `border-bottom-color:var(${cssVarName('fail4')});` : ''}${useHighlight ? `background:color-mix(in srgb, var(${cssVarName('fail4')}) ${hiddenAlpha}%, transparent);` : ''}}
    `;
  }

  getCurrentFilePath() {
    return getCurrentFilePath(this.app);
  }

  getActiveLeaf() {
    return this.app.workspace.activeLeaf || null;
  }

  setModeClass() {
    document.body.classList.remove('cloze-plus-mode');
    if (this.currentMode !== 'normal') document.body.classList.add('cloze-plus-mode');
  }

  setRevealState(id, revealed, manual = false) {
    this.revealState.set(id, { revealed: !!revealed, manual: !!manual });
  }

  getRevealState(id) {
    return this.revealState.get(id) || { revealed: false, manual: false };
  }

  resetRevealStates() {
    this.revealState.clear();
  }

  clearDomIndexes() {
    this.readingDomIndex.clear();
  }

  registerReadingDomIndex(id, hintEl, wrapEl, originalEl) {
    this.readingDomIndex.set(id, { hintEl, wrapEl, originalEl });
  }

  registerClozeElement(id, el, span, kind = 'live', originalEl = null) {
    this.clozeElements.set(id, { el, span, kind, originalEl });
  }

  shouldHideSpan(span) {
    const rec = this.dataManager.getRecord(span.filePath, span.id);
    if (this.currentMode === 'learn') return this.settings.defaultHide !== false;
    if (this.currentMode === 'review') return (rec.failCount || 0) > 0;
    if (this.currentMode === 'fsrs') return rec.inFsrs === true;
    return false;
  }

  applyRevealToElement(entry, revealed) {
    const el = entry.el;
    if (!el) return;

    el.classList.toggle('is-hidden', !revealed);
    el.classList.toggle('is-revealed', revealed);

    if (entry.originalEl) entry.originalEl.style.display = revealed ? '' : 'none';

    const group = el.closest('.cloze-table-overlay');
    if (group) {
      group.classList.toggle('is-hidden', !revealed);
      group.classList.toggle('is-revealed', revealed);
    }
  }

  consumeUiEvent(evt) {
    if (!evt) return;
    try { evt.preventDefault(); } catch (e) {}
    try { evt.stopPropagation(); } catch (e) {}
    try { evt.stopImmediatePropagation?.(); } catch (e) {}
  }

  isUiActionTarget(target) {
    const el = target instanceof HTMLElement ? target : null;
    if (!el) return false;

    return !!el.closest([
      '[data-cp-stop-jump="1"]',
      '.cp-action-btn',
      '.cloze-popup',
      '.cloze-fsrs-popup',
      '.cloze-panel-footer',
      '.cloze-panel-close',
      'button',
      'a',
      'input',
      'select',
      'textarea',
      'label'
    ].join(','));
  }

  bindQuietActionButton(btn, handler = null) {
    if (!(btn instanceof HTMLElement)) return btn;

    btn.dataset.cpStopJump = '1';
    btn.classList.add('cp-action-btn');

    if (btn.tagName === 'BUTTON' && !btn.getAttribute('type')) {
      btn.setAttribute('type', 'button');
    }

    const quiet = (evt) => {
      try { evt.stopPropagation(); } catch (e) {}
      try { evt.stopImmediatePropagation?.(); } catch (e) {}
    };

    btn.addEventListener('pointerdown', quiet, true);
    btn.addEventListener('mousedown', quiet, true);
    btn.addEventListener('mouseup', quiet, true);
    btn.addEventListener('auxclick', quiet, true);

    btn.addEventListener('contextmenu', (evt) => {
      this.consumeUiEvent(evt);
    }, true);

    btn.addEventListener('click', async (evt) => {
      this.consumeUiEvent(evt);
      if (handler) await handler(evt);
    }, true);

    return btn;
  }

  getSpanById(id) {
    const entry = this.clozeElements?.get?.(id);
    if (entry?.span) return entry.span;

    const all = [];
    const seen = new Set();

    for (const s of [
      ...(this.getStableSpans?.() || []),
      ...(this.getPanelSpans?.() || []),
      ...(this.currentSpans || [])
    ]) {
      if (!s || seen.has(s.id)) continue;
      seen.add(s.id);
      all.push(s);
    }

    return all.find(s => s.id === id) || null;
  }

  syncClozeVisual(id) {
    const span = this.getSpanById(id);
    const fp = span?.filePath || this.getCurrentFilePath();
    if (!fp) return;

    const rec = this.dataManager.getRecord(fp, id);
    const safeId = this.escapeAttrValue ? this.escapeAttrValue(id) : String(id);

    const els = new Set();

    try {
      document.querySelectorAll(`[data-cloze-id="${safeId}"]`).forEach(el => {
        if (el instanceof HTMLElement) els.add(el);
      });
    } catch (e) {}

    const entry = this.clozeElements?.get?.(id);
    if (entry?.el instanceof HTMLElement) els.add(entry.el);

    for (const el of els) {
      this.updateClozeVisualElement(el, span, rec);
    }

    const idx = this.readingDomIndex?.get?.(id);
    if (idx?.hintEl instanceof HTMLElement) {
      this.updateClozeVisualElement(idx.hintEl, span, rec);
    }
  }

  updateClozeVisualElement(el, span, rec) {
    if (!(el instanceof HTMLElement)) return;

    el.classList.remove(
      'fail-1', 'fail-2', 'fail-3', 'fail-4',
      'r-high', 'r-mid', 'r-low', 'r-vlow'
    );

    const fc = failColorClass(rec?.failCount || 0);
    if (fc) el.classList.add(fc);

    if (span && !this.revealState.has(span.id)) {
      this.setRevealState(span.id, !this.shouldHideSpan(span), false);
    }

    if (span) {
      const st = this.getRevealState(span.id);
      const isHint = el.classList.contains('cloze-hint')
        || el.classList.contains('cloze-table-overlay-text')
        || el.classList.contains('cloze-reading-hint');

      if (isHint) {
        el.classList.toggle('is-hidden', !st.revealed);
        el.classList.toggle('is-revealed', st.revealed);
      }

      const idx = this.readingDomIndex?.get?.(span.id);
      if (idx?.originalEl instanceof HTMLElement) {
        idx.originalEl.style.display = st.revealed ? '' : 'none';
      }

      const group = el.closest?.('.cloze-table-overlay');
      if (group) {
        group.classList.toggle('is-hidden', !st.revealed);
        group.classList.toggle('is-revealed', st.revealed);
      }
    }
  }

  async deletePanelRecord(id) {
    const fp = this.getCurrentFilePath();
    if (!fp) return;

    await this.dataManager.deleteRecord(fp, id);
    this.revealState.delete(id);
    this.syncClozeVisual(id);
    this.refreshPanelsOnly();
    new Notice('已删除该条目记录');
  }

  updateStableSpans(filePath, spans) {
    this.fullFileSpansByPath[filePath] = spans;
    this.logger.log('stable spans updated', {
      filePath,
      count: spans.length,
      table: spans.filter(s => s.inTable).length
    });
  }

  getLiveStableSpans(filePath = null) {
    const fp = filePath || this.getCurrentFilePath();
    return fp ? (this.fullFileSpansByPath[fp] || []) : [];
  }

  getStableSpans() {
    return this.getLiveStableSpans() || this.currentSpans || [];
  }

  buildLocator(span) {
    return {
      id: span.id,
      from: span.from,
      line: span.line,
      tableCol: span.tableCol,
      inTable: !!span.inTable,
      headingPath: span.headingPath || [],
      contextBefore: span.contextBefore || '',
      text: span.text,
      contextAfter: span.contextAfter || '',
      tableCellMarkdown: span.tableCellMarkdown || '',
      tableCellPlain: span.tableCellPlain || '',
      rowPlain: span.rowPlain || '',
      tableOccurrence: span.tableOccurrence || 1
    };
  }

  snapshotPanelSpans(mode) {
    if (!this.settings.lockPanelListInMode) return;
    if (mode === 'review' || mode === 'fsrs') {
      this.lockedPanelSpansByMode[mode] = [...this.getStableSpans()];
    }
  }

  clearPanelSnapshot(mode = null) {
    if (!mode) {
      this.lockedPanelSpansByMode = { review: null, fsrs: null };
      return;
    }
    this.lockedPanelSpansByMode[mode] = null;
  }

  getPanelSpans() {
    const m = this.currentMode;
    if (this.settings.lockPanelListInMode && (m === 'review' || m === 'fsrs')) {
      const locked = this.lockedPanelSpansByMode[m];
      if (locked?.length) return locked;
    }
    return this.getStableSpans();
  }

  async getCurrentFileText() {
    const fp = this.getCurrentFilePath();
    if (!fp) return '';

    const view = getActiveMarkdownView(this.app);
    if (view?.editor) {
      try { return view.editor.getValue() || ''; } catch (e) {}
    }

    const file = getCurrentFile(this.app);
    if (!file) return '';

    try {
      return await this.app.vault.cachedRead(file);
    } catch (e) {
      return '';
    }
  }

  refreshCurrentSpans() {
    const fp = this.getCurrentFilePath();
    if (!fp) {
      this.currentSpans = [];
      return;
    }

    const view = getActiveMarkdownView(this.app);
    if (!view?.editor) {
      this.currentSpans = this.fullFileSpansByPath[fp] || [];
      return;
    }

    let text = '';
    try { text = view.editor.getValue(); } catch (e) {}

    if (!text) {
      this.currentSpans = [];
      return;
    }

    const spans = this.parser.parse(text, fp);
    this.currentSpans = spans;
    this.updateStableSpans(fp, spans);
  }

  checkTagFilter(docText, filePath) {
    const tag = this.settings.tagFilter;
    if (!tag) return true;
    if (docText && docText.includes(tag)) return true;
    if (!filePath) return false;

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) return false;

    const cache = this.app.metadataCache.getFileCache(file);
    if (cache?.tags?.some(t => t.tag === tag || t.tag === tag.replace('#', ''))) return true;

    if (cache?.frontmatter?.tags) {
      const tags = ensureArray(cache.frontmatter.tags);
      if (tags.some(t => '#' + t === tag || t === tag.replace('#', ''))) return true;
    }

    return false;
  }

  teardownModeUi() {
    this.dividerLine?.hide();
    this.reviewPanel?.hide();
    this.fsrsPanel?.hide();
    this.popupManager?.close();
    this.clearPanelSnapshot();
  }

  enterMode(mode) {
    if (!this.layoutReady) return;

    this.teardownModeUi();
    this.currentMode = mode;
    this.modeVersion++;
    this.refreshCurrentSpans();
    this.clozeElements.clear();
    this.clearDomIndexes();
    this.resetRevealStates();
    this.setModeClass();

    if (mode === 'learn') {
      if (this.settings.enableDivider) this.dividerLine.show();
      new Notice('📖 已进入学习模式');
    } else if (mode === 'review') {
      this.snapshotPanelSpans('review');
      this.reviewPanel.show();
      new Notice('🔄 已进入复习模式');
    } else if (mode === 'fsrs') {
      this.snapshotPanelSpans('fsrs');
      this.fsrsPanel.show();
      new Notice('🧠 已进入记忆曲线复习模式');
    }

    this.logger.log('enter mode', { mode });
    this.refreshAllViews();
    setTimeout(() => this.refreshEditorExtension(), 0);
    this.updateStatusBar();
  }

  exitMode(silent = false) {
    this.currentMode = 'normal';
    this.modeVersion++;
    this.jumpRunning = false;
    this.jumpToken++;
    this.teardownModeUi();
    this.clozeElements.clear();
    this.clearDomIndexes();
    this.resetRevealStates();
    this.setModeClass();
    this.readingProcessor?.unwrapAll();
    this.tableProcessor?.removeAllOverlays();
    this.refreshAllViews();
    setTimeout(() => this.refreshEditorExtension(), 0);

    if (!silent) new Notice('✅ 已返回正常视图');
    this.logger.log('exit mode');
    this.updateStatusBar();
  }

  refreshEditorExtension() {
    if (!this.clozeCompartment || !cmState || !this.layoutReady) return;

    const ext = buildCM6Extension(this);
    if (!ext) return;

    this.app.workspace.iterateAllLeaves(leaf => {
      const cm = leaf?.view?.editor?.cm;
      if (!cm) return;
      try {
        cm.dispatch({ effects: this.clozeCompartment.reconfigure(ext) });
      } catch (e) {}
    });
  }

  refreshAllViews() {
    if (!this.layoutReady) return;

    this.clozeElements.clear();
    this.clearDomIndexes();

    this.app.workspace.iterateAllLeaves(leaf => {
      try { leaf.view?.editor?.cm?.requestMeasure?.(); } catch (e) {}
      try { leaf.view?.previewMode?.rerender?.(true); } catch (e) {}
    });

    setTimeout(() => {
      this.readingProcessor.forceRefreshSeries();
      this.tableProcessor.forceRefreshSeries();
      this.refreshPanelsOnly();
      if (this.currentMode === 'learn' && this.settings.enableDivider) {
        this.dividerLine.onScroll();
      }
    }, 100);
  }

  refreshPanelsOnly() {
    if (this.currentMode === 'review') this.reviewPanel?.refresh();
    if (this.currentMode === 'fsrs') this.fsrsPanel?.refresh();
  }

  onLeafChange() {
    this.clozeElements.clear();
    this.clearDomIndexes();
    this.refreshCurrentSpans();

    if (this.currentMode === 'review') this.snapshotPanelSpans('review');
    if (this.currentMode === 'fsrs') this.snapshotPanelSpans('fsrs');

    setTimeout(() => {
      if (this.currentMode === 'learn' && this.settings.enableDivider) {
        this.dividerLine.show();
      }
      this.refreshAllViews();
    }, 100);
  }

  handleClozeClick(el, span) {
    const mode = this.currentMode;

    if (mode === 'review' || mode === 'fsrs') {
      if (el.classList.contains('is-hidden')) {
        el.classList.remove('is-hidden');
        el.classList.add('is-revealed');
        this.setRevealState(span.id, true, true);
      }

      if (mode === 'review') this.popupManager.showCloze(el, span);
      else this.popupManager.showFsrs(el, span);

      return this.refreshPanelsOnly();
    }

    if (mode === 'learn') {
      const reveal = el.classList.contains('is-hidden');
      this.setRevealState(span.id, reveal, reveal);
      this.applyRevealToElement({ el, originalEl: null, span }, reveal);
      if (reveal) this.popupManager.showCloze(el, span);
      else this.popupManager.close();
      this.refreshPanelsOnly();
    }
  }

  handleReadingLikeClick(hintEl, originalEl, span) {
    const mode = this.currentMode;

    if (mode === 'review' || mode === 'fsrs') {
      if (hintEl.classList.contains('is-hidden')) {
        this.setRevealState(span.id, true, true);
        this.applyRevealToElement({ el: hintEl, originalEl, span }, true);
      }

      if (mode === 'review') this.popupManager.showCloze(hintEl, span);
      else this.popupManager.showFsrs(hintEl, span);

      this.refreshPanelsOnly();
      this.tableProcessor?.refreshActiveEditor();
      return;
    }

    if (mode === 'learn') {
      const reveal = hintEl.classList.contains('is-hidden');
      this.setRevealState(span.id, reveal, reveal);
      this.applyRevealToElement({ el: hintEl, originalEl, span }, reveal);
      if (reveal) this.popupManager.showCloze(hintEl, span);
      else this.popupManager.close();

      this.refreshPanelsOnly();
      this.tableProcessor?.refreshActiveEditor();
    }
  }

  /* ===== 阅读视图跳转增强 / H-3 ===== */

  escapeAttrValue(v) {
    const s = String(v ?? '');
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(s);
      }
    } catch (e) {}
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  isElementDisplayable(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (!document.body.contains(el)) return false;

    try {
      const s = getComputedStyle(el);
      if (s.display === 'none') return false;
      if (s.visibility === 'hidden') return false;
      if (Number(s.opacity) === 0) return false;
    } catch (e) {
      return false;
    }

    return true;
  }

  isVisibleElement(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (!this.isElementDisplayable(el)) return false;
    const r = safeRect(el);
    if (!r || r.width <= 0 || r.height <= 0) return false;
    return true;
  }

  hasAnyLineAttr(el) {
    if (!(el instanceof HTMLElement)) return false;
    return [
      'data-line',
      'data-source-line',
      'data-line-start',
      'data-start-line',
      'data-sourcepos'
    ].some(name => el.hasAttribute(name));
  }

  simplifySearchText(s) {
    let t = normalizeText(String(s ?? '')).replace(/\s+/g, '');
    try {
      t = t.replace(/[^\p{L}\p{N}]/gu, '');
    } catch (e) {
      t = t.replace(/[^A-Za-z0-9\u4E00-\u9FFF]/g, '');
    }
    return t;
  }

  isWeakJumpText(s) {
    return this.simplifySearchText(s).length < 2;
  }

  stripMarkdownForHint(s) {
    let t = String(s ?? '');
    t = t.replace(/\r/g, '');
    t = t.replace(/!\[[^\]]*\]\([^)]+\)/g, ' ');
    t = t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
    t = t.replace(/\[\[([^\]]+)\]\]/g, '$1');
    t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    t = t.replace(/`{1,3}([^`]+)`{1,3}/g, '$1');
    t = t.replace(/==([^=]+)==/g, '$1');
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
    t = t.replace(/__([^_]+)__/g, '$1');
    t = t.replace(/\*([^*]+)\*/g, '$1');
    t = t.replace(/_([^_]+)_/g, '$1');
    t = t.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '');
    return normalizeText(t);
  }

  isAnswerLikeJump(locator) {
    const before = normalizeText(locator?.contextBefore || '');
    const text = normalizeText(locator?.text || '');
    const after = normalizeText(locator?.contextAfter || '');

    if (/答案|参考答案|正确答案/.test(before)) return true;
    if (/答案|参考答案|正确答案/.test(after)) return true;
    if (/^[A-E]$/.test(text)) return true;
    if (/^[A-E]{2,5}$/.test(text)) return true;

    return false;
  }

  buildSearchNeedle(raw, side = 'full') {
    const norm0 = normalizeText(String(raw ?? '').trim());
    if (!norm0) return { raw: '', norm: '', simple: '' };

    let norm = norm0;
    if (side === 'before') norm = norm0.slice(-40);
    if (side === 'after') norm = norm0.slice(0, 40);

    return {
      raw: raw ?? '',
      norm,
      simple: this.simplifySearchText(norm)
    };
  }

  buildStrongContextNeedle(raw, side = 'after') {
    const needle = this.buildSearchNeedle(raw, side);
    if (!needle.norm) return { raw: '', norm: '', simple: '' };

    const simple = needle.simple || '';
    let cjk = 0;
    let alnum = 0;

    for (const ch of simple) {
      if (/[\u4E00-\u9FFF]/.test(ch)) cjk++;
      else if (/[A-Za-z0-9]/.test(ch)) alnum++;
      else if (ch) alnum++;
    }

    const strongEnough = simple.length >= 4 || cjk >= 2 || alnum >= 3;
    if (!strongEnough) {
      return { raw: needle.raw, norm: '', simple: '' };
    }

    return needle;
  }

  textContainsNeedle(hayNorm, haySimple, needleNorm, needleSimple) {
    if (needleNorm && hayNorm.includes(needleNorm)) return true;
    if (needleSimple && needleSimple.length >= 2 && haySimple.includes(needleSimple)) return true;
    return false;
  }

  rankWeakTargetHint(h) {
    if (!h) return -Infinity;

    let score = 0;
    const role = h.role || '';
    const distance = Number.isFinite(h.distance) ? h.distance : 999999;
    const source = String(h.source || '');

    if (role === 'self') score += 1000;
    else if (role === 'next') score += 700;
    else if (role === 'prev') score += 660;
    else score += 500;

    score -= distance * 40;

    if (source.startsWith('locator')) score += 80;
    else if (source.startsWith('file')) score += 40;
    else if (source.startsWith('span')) score += 10;

    return score;
  }

  getReadingRootFromLeaf(leaf) {
    const c = leaf?.containerEl || leaf?.view?.containerEl || null;
    if (!c) return null;

    const candidates = [
      c.querySelector('.markdown-reading-view .markdown-preview-view'),
      c.querySelector('.markdown-preview-view'),
      c.querySelector('.markdown-reading-view')
    ].filter(el => this.isVisibleElement(el));

    return candidates[0] || null;
  }

  getReadingLeavesForCurrentFile() {
    const fp = this.getCurrentFilePath?.() || null;
    const activeLeaf = this.getActiveLeaf?.() || null;

    const leaves = (this.app.workspace.getLeavesOfType?.('markdown') || []).filter(leaf => {
      const path = leaf?.view?.file?.path || null;
      if (fp && path && path !== fp) return false;
      return !!this.getReadingRootFromLeaf(leaf);
    });

    leaves.sort((a, b) => {
      const aScore = (a === activeLeaf ? 100 : 0) + ((fp && a?.view?.file?.path === fp) ? 20 : 0);
      const bScore = (b === activeLeaf ? 100 : 0) + ((fp && b?.view?.file?.path === fp) ? 20 : 0);

      if (aScore !== bScore) return bScore - aScore;

      const ra = safeRect(a?.containerEl);
      const rb = safeRect(b?.containerEl);
      const aa = ra ? ra.width * ra.height : 0;
      const ab = rb ? rb.width * rb.height : 0;
      return ab - aa;
    });

    return leaves;
  }

  getAllVisibleReadingRoots() {
    return this.getReadingLeavesForCurrentFile()
      .map(leaf => this.getReadingRootFromLeaf(leaf))
      .filter(Boolean);
  }

  activeLeafHasVisibleReadingRoot() {
    const leaf = this.getActiveLeaf?.() || null;
    if (!leaf) return false;

    const fp = this.getCurrentFilePath?.() || null;
    const path = leaf?.view?.file?.path || null;
    if (fp && path && path !== fp) return false;

    return !!this.getReadingRootFromLeaf(leaf);
  }

  getActiveReadingRoot() {
    const activeLeaf = this.getActiveLeaf?.() || null;
    const fp = this.getCurrentFilePath?.() || null;
    const activePath = activeLeaf?.view?.file?.path || null;

    if (activeLeaf && (!fp || !activePath || activePath === fp)) {
      const root = this.getReadingRootFromLeaf(activeLeaf);
      if (root) return root;
    }

    return this.getAllVisibleReadingRoots()[0] || null;
  }

  findVisibleClozeElInRoot(id, root) {
    if (!root) return null;

    const safeId = this.escapeAttrValue(id);
    const els = Array.from(root.querySelectorAll(`[data-cloze-id="${safeId}"]`))
      .filter(el => this.isVisibleElement(el));

    if (!els.length) return null;

    els.sort((a, b) => {
      const ra = safeRect(a);
      const rb = safeRect(b);
      const aa = ra ? ra.width * ra.height : 0;
      const ab = rb ? rb.width * rb.height : 0;
      return ab - aa;
    });

    return els[0] || null;
  }

  findVisibleClozeEl(id) {
    const cached = this.clozeElements?.get?.(id)?.el || null;
    if (cached && this.isVisibleElement(cached)) return cached;

    const activeRoot = this.getActiveReadingRoot();
    const inActiveRoot = this.findVisibleClozeElInRoot(id, activeRoot);
    if (inActiveRoot) return inActiveRoot;

    const activeLeafRoot = this.getActiveLeaf?.()?.containerEl || null;
    if (activeLeafRoot) {
      const safeId = this.escapeAttrValue(id);
      const inLeaf = Array.from(activeLeafRoot.querySelectorAll(`[data-cloze-id="${safeId}"]`))
        .find(el => this.isVisibleElement(el));
      if (inLeaf) return inLeaf;
    }

    for (const root of this.getAllVisibleReadingRoots()) {
      if (root === activeRoot) continue;
      const found = this.findVisibleClozeElInRoot(id, root);
      if (found) return found;
    }

    const safeId = this.escapeAttrValue(id);
    return Array.from(document.querySelectorAll(`[data-cloze-id="${safeId}"]`))
      .find(el => this.isVisibleElement(el)) || null;
  }

  resolveSpanForJump(id, locator) {
    const stable = this.getStableSpans?.() || [];
    const panel = this.getPanelSpans?.() || [];
    const all = [];
    const seen = new Set();

    for (const s of [...stable, ...panel]) {
      if (!s) continue;
      const key = s.id || `${s.from}:${s.line}:${s.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(s);
    }

    let span = all.find(s => s.id === id);
    if (span) return span;

    if (!locator) return null;

    const nText = normalizeText(locator.text || '');
    const nBefore = normalizeText(locator.contextBefore || '');
    const nAfter = normalizeText(locator.contextAfter || '');

    span =
      all.find(s => typeof locator.from === 'number' && s.from === locator.from) ||
      all.find(s => typeof locator.line === 'number' && s.line === locator.line && normalizeText(s.text || '') === nText) ||
      all.find(s => typeof locator.line === 'number' && Math.abs((s.line ?? -999999) - locator.line) <= 1 && normalizeText(s.text || '') === nText) ||
      all.find(s => normalizeText(s.text || '') === nText && normalizeText(s.contextBefore || '') === nBefore && normalizeText(s.contextAfter || '') === nAfter) ||
      all.find(s => normalizeText(s.text || '') === nText && normalizeText(s.contextBefore || '') === nBefore) ||
      all.find(s => normalizeText(s.text || '') === nText);

    return span || null;
  }

  getAllJumpSpans() {
    const stable = this.getStableSpans?.() || [];
    const panel = this.getPanelSpans?.() || [];
    const all = [];
    const seen = new Set();

    for (const s of [...stable, ...panel]) {
      if (!s) continue;
      const key = s.id || `${s.from}:${s.line}:${s.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(s);
    }

    all.sort((a, b) => {
      const af = Number.isFinite(a?.from) ? a.from : Number.MAX_SAFE_INTEGER;
      const bf = Number.isFinite(b?.from) ? b.from : Number.MAX_SAFE_INTEGER;
      if (af !== bf) return af - bf;

      const al = Number.isFinite(a?.line) ? a.line : Number.MAX_SAFE_INTEGER;
      const bl = Number.isFinite(b?.line) ? b.line : Number.MAX_SAFE_INTEGER;
      return al - bl;
    });

    return all;
  }

  getWeakTargetSpanNeighborHints(id, locator) {
    const all = this.getAllJumpSpans();
    if (!all.length) return [];

    const resolved = this.resolveSpanForJump(id, locator) || null;
    let idx = -1;

    if (resolved?.id) {
      idx = all.findIndex(s => s?.id === resolved.id);
    }

    if (idx < 0 && resolved) {
      idx = all.findIndex(s =>
        (typeof resolved.from === 'number' && s?.from === resolved.from) ||
        (
          typeof resolved.line === 'number' &&
          s?.line === resolved.line &&
          normalizeText(s?.text || '') === normalizeText(resolved.text || '')
        )
      );
    }

    if (idx < 0 && id) idx = all.findIndex(s => s?.id === id);
    if (idx < 0) return [];

    const hints = [];
    const seen = new Set();

    const add = (span, role, distance) => {
      if (!span) return;

      const text = normalizeText(span.text || '');
      if (!text) return;
      if (this.isWeakJumpText(text)) return;

      const needle = this.buildStrongContextNeedle(text, 'full');
      if (!(needle.norm || needle.simple)) return;

      const key = needle.simple || needle.norm;
      if (seen.has(key)) return;
      seen.add(key);

      hints.push({
        text,
        role,
        distance,
        line: Number.isFinite(span.line) ? span.line : null,
        from: Number.isFinite(span.from) ? span.from : null,
        source: 'span'
      });
    };

    for (let step = 1; step <= 6 && hints.length < 6; step++) {
      add(all[idx + step], 'next', step);
      add(all[idx - step], 'prev', step);
    }

    hints.sort((a, b) => this.rankWeakTargetHint(b) - this.rankWeakTargetHint(a));
    return hints;
  }

  buildWeakSelfHintText(locator, lines = null, centerLine = null) {
    const asStrong = (raw) => {
      const clean = this.stripMarkdownForHint(raw);
      if (!clean) return '';
      const needle = this.buildStrongContextNeedle(clean, 'full');
      return (needle.norm || needle.simple) ? clean : '';
    };

    const before = this.stripMarkdownForHint(locator?.contextBefore || '');
    const text = this.stripMarkdownForHint(locator?.text || '');
    const after = this.stripMarkdownForHint(locator?.contextAfter || '');

    const combined = normalizeText([before, text, after].filter(Boolean).join(' '));
    const strongCombined = asStrong(combined);
    if (strongCombined) return strongCombined;

    if (Array.isArray(lines) && Number.isFinite(centerLine)) {
      const cur = this.stripMarkdownForHint(lines[centerLine] || '');
      const prev = this.stripMarkdownForHint(lines[centerLine - 1] || '');
      const next = this.stripMarkdownForHint(lines[centerLine + 1] || '');

      const curStrong = asStrong(cur);
      if (curStrong) return curStrong;

      if (/答案|解析|结论|口诀/.test(prev) && text) {
        const mergedPrev = asStrong(`${prev} ${text}`);
        if (mergedPrev) return mergedPrev;
      }

      if (/答案|解析|结论|口诀/.test(cur) && text) {
        const mergedCur = asStrong(`${cur} ${text}`);
        if (mergedCur) return mergedCur;
      }

      if (text && next && !this.isWeakJumpText(next)) {
        const mergedNext = asStrong(`${before} ${text} ${next}`);
        if (mergedNext) return mergedNext;
      }

      const prevStrong = asStrong(prev);
      if (prevStrong) return prevStrong;
    }

    return '';
  }

  async getWeakTargetFileHints(locator, lineInfo) {
    const file = this.getActiveLeaf?.()?.view?.file || this.app.workspace.getActiveFile?.() || null;
    if (!file) return [];

    let txt = '';
    try {
      if (typeof this.app.vault.cachedRead === 'function') txt = await this.app.vault.cachedRead(file);
      else if (typeof this.app.vault.read === 'function') txt = await this.app.vault.read(file);
    } catch (e) {
      return [];
    }

    if (typeof txt !== 'string' || !txt) return [];

    const lines = txt.split(/\r\n|\r|\n/);
    if (!lines.length) return [];

    let center =
      Number.isFinite(lineInfo?.lineFromFrom) ? lineInfo.lineFromFrom :
      Number.isFinite(lineInfo?.lineFromLocator) ? lineInfo.lineFromLocator :
      null;

    if (!Number.isFinite(center)) return [];
    center = Math.max(0, Math.min(lines.length - 1, center));

    const out = [];
    const seen = new Set();

    const pushHint = (rawText, role, distance, extra = {}) => {
      const text = this.stripMarkdownForHint(rawText);
      if (!text) return false;

      const needle = this.buildStrongContextNeedle(text, 'full');
      if (!(needle.norm || needle.simple)) return false;

      const key = needle.simple || needle.norm;
      if (seen.has(key)) return false;
      seen.add(key);

      out.push({
        text,
        role,
        distance,
        line: Number.isFinite(extra.line) ? extra.line : null,
        from: null,
        source: extra.source || 'file'
      });

      return true;
    };

    const selfText = this.buildWeakSelfHintText(locator, lines, center);
    if (selfText) {
      pushHint(selfText, 'self', 0, { line: center, source: 'locator-self' });
    }

    pushHint(lines[center], 'self', 0, { line: center, source: 'file:center' });

    let nextCount = 0;
    for (let step = 1; step <= 6 && nextCount < 3; step++) {
      const idx = center + step;
      if (idx >= lines.length) break;
      const ok = pushHint(lines[idx], 'next', step, { line: idx, source: 'file:next' });
      if (ok) nextCount++;
    }

    let prevCount = 0;
    for (let step = 1; step <= 8 && prevCount < 3; step++) {
      const idx = center - step;
      if (idx < 0) break;
      const ok = pushHint(lines[idx], 'prev', step, { line: idx, source: 'file:prev' });
      if (ok) prevCount++;
    }

    out.sort((a, b) => this.rankWeakTargetHint(b) - this.rankWeakTargetHint(a));
    return out.slice(0, 6);
  }

  mergeWeakTargetHints(...lists) {
    const map = new Map();

    const normalizeHint = (h) => {
      if (!h) return null;

      const text = this.stripMarkdownForHint(h.text || '');
      if (!text) return null;

      const needle = this.buildStrongContextNeedle(text, 'full');
      if (!(needle.norm || needle.simple)) return null;

      return {
        text,
        role: h.role || 'next',
        distance: Number.isFinite(h.distance) ? h.distance : 999999,
        line: Number.isFinite(h.line) ? h.line : null,
        from: Number.isFinite(h.from) ? h.from : null,
        source: h.source || 'unknown'
      };
    };

    for (const list of lists) {
      for (const item of Array.isArray(list) ? list : []) {
        const h = normalizeHint(item);
        if (!h) continue;

        const keyNeedle = this.buildStrongContextNeedle(h.text, 'full');
        const key = keyNeedle.simple || keyNeedle.norm;
        if (!key) continue;

        const old = map.get(key);
        if (!old || this.rankWeakTargetHint(h) > this.rankWeakTargetHint(old)) {
          map.set(key, h);
        }
      }
    }

    return Array.from(map.values())
      .sort((a, b) => this.rankWeakTargetHint(b) - this.rankWeakTargetHint(a))
      .slice(0, 6);
  }

  getScrollParent(el) {
    let cur = el instanceof HTMLElement ? el : el?.parentElement || null;

    while (cur && cur !== document.body) {
      try {
        const s = getComputedStyle(cur);
        const oy = s.overflowY;
        const canScroll = cur.scrollHeight > cur.clientHeight + 4;

        if (
          canScroll &&
          (
            oy === 'auto' ||
            oy === 'scroll' ||
            oy === 'overlay' ||
            cur.classList.contains('markdown-preview-view') ||
            cur.classList.contains('view-content')
          )
        ) {
          return cur;
        }
      } catch (e) {}

      cur = cur.parentElement;
    }

    return (
      this.getActiveLeaf?.()?.containerEl?.querySelector('.markdown-preview-view') ||
      this.getActiveLeaf?.()?.containerEl?.querySelector('.view-content') ||
      null
    );
  }

  getReadingScroller(root) {
    const leaf = this.getActiveLeaf?.() || null;

    const candidates = [
      root,
      root?.closest?.('.markdown-preview-view'),
      root?.closest?.('.markdown-reading-view'),
      root?.closest?.('.view-content'),
      leaf?.containerEl?.querySelector('.markdown-preview-view'),
      leaf?.containerEl?.querySelector('.view-content')
    ].filter(el => el instanceof HTMLElement);

    const uniq = Array.from(new Set(candidates));

    const scrollables = uniq.filter(el => {
      try {
        return el.scrollHeight > el.clientHeight + 4;
      } catch (e) {
        return false;
      }
    });

    if (!scrollables.length) return this.getScrollParent(root);

    scrollables.sort((a, b) => {
      const score = (el) => {
        let s = 0;
        if (el === root) s += 120;
        if (el.classList.contains('markdown-preview-view')) s += 100;
        if (el.classList.contains('markdown-reading-view')) s += 70;
        if (el.classList.contains('view-content')) s += 50;
        try {
          s += Math.min(80, (el.scrollHeight - el.clientHeight) / 200);
        } catch (e) {}
        return s;
      };
      return score(b) - score(a);
    });

    return scrollables[0] || this.getScrollParent(root);
  }

  scrollTargetIntoView(el) {
    if (!el) return;

    try {
      el.scrollIntoView({
        behavior: 'auto',
        block: 'center',
        inline: 'nearest'
      });
    } catch (e) {}

    const scroller = this.getScrollParent(el);

    if (scroller instanceof HTMLElement) {
      try {
        const tr = el.getBoundingClientRect();
        const sr = scroller.getBoundingClientRect();
        const delta = tr.top - sr.top - (sr.height / 2) + (tr.height / 2);

        if (Number.isFinite(delta) && Math.abs(delta) > 2) {
          const targetTop = Math.max(0, scroller.scrollTop + delta);
          scroller.scrollTop = targetTop;

          try {
            scroller.scrollTo({ top: targetTop, behavior: 'auto' });
          } catch (e) {}
        }
      } catch (e) {}
    }
  }

  hardScrollToElement(el, root = null) {
    if (!el) return false;

    try {
      el.scrollIntoView({
        behavior: 'auto',
        block: 'center',
        inline: 'nearest'
      });
    } catch (e) {}

    const scroller = (root ? this.getReadingScroller(root) : null) || this.getScrollParent(el);
    if (!(scroller instanceof HTMLElement)) return false;

    try {
      const tr = el.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      const delta = tr.top - sr.top - sr.height / 2 + tr.height / 2;

      if (Number.isFinite(delta)) {
        const targetTop = Math.max(0, scroller.scrollTop + delta);
        scroller.scrollTop = targetTop;
        try {
          scroller.scrollTo({ top: targetTop, behavior: 'auto' });
        } catch (e) {}
      }
    } catch (e) {}

    return true;
  }

  scrollElementTo(scroller, top) {
    if (!(scroller instanceof HTMLElement)) {
      return {
        ok: false,
        beforeTop: null,
        targetTop: null,
        afterTop: null,
        maxTop: null
      };
    }

    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const beforeTop = scroller.scrollTop;
    const targetTop = Math.max(0, Math.min(maxTop, Math.round(Number(top) || 0)));

    try {
      scroller.scrollTop = targetTop;
      scroller.scrollTo({ top: targetTop, behavior: 'auto' });
    } catch (e) {
      try { scroller.scrollTop = targetTop; } catch (e2) {}
    }

    return {
      ok: true,
      beforeTop,
      targetTop,
      afterTop: scroller.scrollTop,
      maxTop
    };
  }

  async settleReadingAfterScroll(root, scroller) {
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    } catch (e) {
      await sleep(30);
    }

    try { this.readingProcessor?.forceRefreshSeries?.(); } catch (e) {}
    await sleep(80);
    try { this.readingProcessor?.forceRefreshSeries?.(); } catch (e) {}

    return {
      rootClass: root?.className || null,
      scrollerClass: scroller?.className || null,
      scrollerTop: scroller instanceof HTMLElement ? scroller.scrollTop : null
    };
  }

  getElementLineHint(el, boundary = null) {
    const toNum = (v) => {
      if (v == null) return null;
      const m = String(v).match(/^\s*(\d+)/);
      if (!m) return null;
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    };

    let cur = el;
    let depth = 0;

    while (cur && cur instanceof HTMLElement && depth < 14) {
      const values = [
        cur.getAttribute('data-line'),
        cur.getAttribute('data-source-line'),
        cur.getAttribute('data-line-start'),
        cur.getAttribute('data-start-line'),
        cur.getAttribute('data-sourcepos'),
        cur.dataset?.line,
        cur.dataset?.sourceLine,
        cur.dataset?.lineStart,
        cur.dataset?.startLine,
        cur.dataset?.sourcepos
      ];

      for (const v of values) {
        const n = toNum(v);
        if (n != null) return n;
      }

      if (boundary && cur === boundary) break;
      cur = cur.parentElement;
      depth++;
    }

    return null;
  }

  getReadingCandidateElements(root) {
    if (!root) return [];

    const selector = [
      '[data-cloze-id]',
      '[data-line]',
      '[data-source-line]',
      '[data-line-start]',
      '[data-start-line]',
      '[data-sourcepos]',
      '.markdown-preview-section',
      '.markdown-preview-section > div',
      '.el-p',
      '.el-li',
      '.el-blockquote',
      '.el-table',
      '.el-h1',
      '.el-h2',
      '.el-h3',
      '.el-h4',
      '.el-h5',
      '.el-h6',
      'p',
      'li',
      'blockquote',
      'td',
      'th',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      '.callout'
    ].join(',');

    return Array.from(new Set(Array.from(root.querySelectorAll(selector))))
      .filter(el => {
        if (!(el instanceof HTMLElement)) return false;
        if (!root.contains(el)) return false;
        if (!this.isElementDisplayable(el)) return false;

        const hasLine = this.hasAnyLineAttr(el);
        const text = normalizeText(el.textContent || '');
        const r = safeRect(el);

        if (hasLine) return true;
        if (text) return true;
        if (r && r.width > 0 && r.height > 0) return true;
        return false;
      });
  }

  isInScrollerViewport(el, scroller, margin = 0) {
    if (!(el instanceof HTMLElement)) return false;

    const r = safeRect(el);
    if (!r || r.width <= 0 || r.height <= 0) return false;

    let sr = null;
    if (scroller instanceof HTMLElement) sr = scroller.getBoundingClientRect();
    else sr = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };

    return (
      r.bottom >= sr.top - margin &&
      r.top <= sr.bottom + margin &&
      r.right >= sr.left - margin &&
      r.left <= sr.right + margin
    );
  }

  getViewportLineStats(root, scroller, margin = 300) {
    const elements = this.getReadingCandidateElements(root);
    const allLines = [];
    const viewLines = [];

    for (const el of elements) {
      const line = this.getElementLineHint(el, root);
      if (!Number.isFinite(line)) continue;

      allLines.push(line);
      if (this.isInScrollerViewport(el, scroller, margin)) {
        viewLines.push(line);
      }
    }

    const summarize = (arr) => {
      const nums = arr.filter(n => Number.isFinite(n));
      if (!nums.length) {
        return { count: 0, min: null, max: null, head: [], tail: [] };
      }
      const uniq = Array.from(new Set(nums)).sort((a, b) => a - b);
      return {
        count: nums.length,
        min: Math.min(...nums),
        max: Math.max(...nums),
        head: uniq.slice(0, 6),
        tail: uniq.slice(-6)
      };
    };

    const all = summarize(allLines);
    const view = summarize(viewLines);

    return {
      scrollerTop: scroller instanceof HTMLElement ? scroller.scrollTop : null,
      scrollerHeight: scroller instanceof HTMLElement ? scroller.clientHeight : null,
      scrollHeight: scroller instanceof HTMLElement ? scroller.scrollHeight : null,
      allHintCount: all.count,
      allMin: all.min,
      allMax: all.max,
      allHead: all.head,
      allTail: all.tail,
      viewportHintCount: view.count,
      min: view.min,
      max: view.max,
      viewportHead: view.head,
      viewportTail: view.tail
    };
  }

  findNearestLineElement(root, resolvedLine, scroller = null, margin = 1200) {
    if (!root || !Number.isFinite(resolvedLine)) return null;

    const elements = this.getReadingCandidateElements(root);
    let best = null;
    let bestDist = Infinity;

    for (const el of elements) {
      const line = this.getElementLineHint(el, root);
      if (!Number.isFinite(line)) continue;
      if (scroller instanceof HTMLElement && !this.isInScrollerViewport(el, scroller, margin)) continue;

      const dist = Math.min(
        Math.abs(line - resolvedLine),
        Math.abs(line - (resolvedLine + 1))
      );

      if (dist < bestDist) {
        bestDist = dist;
        best = {
          el,
          lineHint: line,
          lineDist: dist,
          text: normalizeText(el.textContent || '').slice(0, 120)
        };
      }
    }

    return best;
  }

  async getReadingFileLineInfo(locator) {
    let lineFromLocator = typeof locator?.line === 'number' ? Math.max(0, locator.line) : null;
    let lineFromFrom = null;
    let totalLines = null;

    try {
      const file = this.getActiveLeaf?.()?.view?.file || this.app.workspace.getActiveFile?.() || null;
      if (file) {
        let txt = '';
        if (typeof this.app.vault.cachedRead === 'function') txt = await this.app.vault.cachedRead(file);
        else if (typeof this.app.vault.read === 'function') txt = await this.app.vault.read(file);

        if (typeof txt === 'string') {
          totalLines = txt.split(/\r\n|\r|\n/).length;
          if (typeof locator?.from === 'number') {
            const from = Math.max(0, locator.from);
            lineFromFrom = txt.slice(0, from).split(/\r\n|\r|\n/).length - 1;
            if (Number.isFinite(lineFromFrom)) lineFromFrom = Math.max(0, lineFromFrom);
          }
        }
      }
    } catch (e) {}

    return {
      lineFromLocator: Number.isFinite(lineFromLocator) ? lineFromLocator : null,
      lineFromFrom: Number.isFinite(lineFromFrom) ? lineFromFrom : null,
      totalLines: Number.isFinite(totalLines) ? Math.max(0, totalLines) : null
    };
  }

  getJumpLineCandidates(lineInfo) {
    const out = [];
    const seen = new Set();

    const add = (line, source) => {
      if (!Number.isFinite(line)) return;
      const n = Math.max(0, Math.round(line));
      const key = String(n);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ line: n, source });
    };

    add(lineInfo?.lineFromLocator, 'locator.line');
    add(lineInfo?.lineFromFrom, 'locator.from');

    return out;
  }

  expandJumpLineCandidates(candidates, offsets = [0]) {
    const out = [];
    const seen = new Set();

    const add = (line, source) => {
      if (!Number.isFinite(line)) return;
      const n = Math.max(0, Math.round(line));
      const key = `${n}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ line: n, source });
    };

    for (const item of Array.isArray(candidates) ? candidates : []) {
      for (const off of offsets) {
        const suffix = off === 0 ? '' : off > 0 ? `+${off}` : `${off}`;
        add((item.line ?? 0) + off, `${item.source}${suffix}`);
      }
    }

    return out;
  }

  findBestReadingCandidate(root, locator, preferredLine, options = {}) {
    if (!root) return null;

    const scroller = options.scroller || this.getReadingScroller(root);
    const viewportOnly = !!options.viewportOnly;
    const margin = Number.isFinite(options.margin) ? options.margin : 1200;

    const weakTarget = this.isWeakJumpText(locator?.text || '');
    const answerLike = options.answerLike ?? this.isAnswerLikeJump(locator);

    const targetNeedle = weakTarget
      ? { raw: locator?.text || '', norm: '', simple: '' }
      : this.buildSearchNeedle(locator?.text || '', 'full');

    const beforeNeedle = this.buildStrongContextNeedle(locator?.contextBefore || '', 'before');
    const afterNeedle = this.buildStrongContextNeedle(locator?.contextAfter || '', 'after');

    const headingPath = Array.isArray(locator?.headingPath) ? locator.headingPath : [];
    const headingNeedle = headingPath.length
      ? this.buildStrongContextNeedle(headingPath[headingPath.length - 1], 'full')
      : { norm: '', simple: '' };

    const hintEntries = (Array.isArray(options.neighborHints) ? options.neighborHints : [])
      .map(h => {
        const text = this.stripMarkdownForHint(h?.text || '');
        const needle = this.buildStrongContextNeedle(text, 'full');
        if (!(needle.norm || needle.simple)) return null;
        return { ...h, text, needle };
      })
      .filter(Boolean);

    const elements = this.getReadingCandidateElements(root)
      .filter(el => !viewportOnly || this.isInScrollerViewport(el, scroller, margin));

    let best = null;
    let bestScore = -Infinity;

    const isHeadingEl = (el) => (
      el instanceof HTMLElement &&
      el.matches('h1,h2,h3,h4,h5,h6,.el-h1,.el-h2,.el-h3,.el-h4,.el-h5,.el-h6')
    );

    for (const el of elements) {
      const textRaw = normalizeText(el.textContent || '');
      const textNorm = textRaw;
      const textSimple = this.simplifySearchText(textRaw);
      const lineHint = this.getElementLineHint(el, root);

      const hasTargetExact = !weakTarget && !!targetNeedle.norm && textNorm.includes(targetNeedle.norm);
      const hasTargetLoose = !weakTarget && !hasTargetExact && !!targetNeedle.simple && targetNeedle.simple.length >= 2 && textSimple.includes(targetNeedle.simple);
      const hasTarget = hasTargetExact || hasTargetLoose;

      const hasBefore = this.textContainsNeedle(textNorm, textSimple, beforeNeedle.norm, beforeNeedle.simple);
      const hasAfter = this.textContainsNeedle(textNorm, textSimple, afterNeedle.norm, afterNeedle.simple);
      const hasHeading = this.textContainsNeedle(textNorm, textSimple, headingNeedle.norm, headingNeedle.simple);

      const matchedHints = [];
      for (const h of hintEntries) {
        const hit = this.textContainsNeedle(textNorm, textSimple, h.needle.norm, h.needle.simple);
        if (!hit) continue;
        matchedHints.push(h);
      }

      matchedHints.sort((a, b) => this.rankWeakTargetHint(b) - this.rankWeakTargetHint(a));
      const matchedHint = matchedHints[0] || null;
      const hintCount = matchedHints.length;

      const lineDist =
        Number.isFinite(preferredLine) && Number.isFinite(lineHint)
          ? Math.min(Math.abs(lineHint - preferredLine), Math.abs(lineHint - (preferredLine + 1)))
          : Infinity;

      if (!hasTarget && !(hasBefore && hasAfter) && !matchedHint && !Number.isFinite(lineDist)) {
        continue;
      }

      let score = 0;
      const source = [];

      if (hasTargetExact) {
        score += 560;
        source.push('text');
      } else if (hasTargetLoose) {
        score += 500;
        source.push('text-simple');
      }

      if (hasBefore) {
        score += 220;
        source.push('before');
      }

      if (hasAfter) {
        score += 220;
        source.push('after');
      }

      if (hasBefore && hasAfter) {
        score += 200;
        source.push('before+after');
      }

      if (matchedHint) {
        let hintScore = 0;

        if (matchedHint.role === 'self') hintScore = 360;
        else if (matchedHint.role === 'next') hintScore = Math.max(160, 300 - (matchedHint.distance || 0) * 42);
        else if (matchedHint.role === 'prev') hintScore = Math.max(150, 290 - (matchedHint.distance || 0) * 40);
        else hintScore = Math.max(140, 270 - (matchedHint.distance || 0) * 38);

        if (String(matchedHint.source || '').startsWith('locator')) hintScore += 50;
        else if (String(matchedHint.source || '').startsWith('file')) hintScore += 20;

        score += hintScore;
        source.push(`hint:${matchedHint.role}:${matchedHint.distance}:${matchedHint.source}`);
      }

      if (hintCount >= 2) {
        score += 60 + (hintCount - 2) * 18;
        source.push(`hint-count:${hintCount}`);
      }

      if (hasHeading) {
        score += 25;
        source.push('heading');
      }

      if (Number.isFinite(lineDist)) {
        const lineScore = weakTarget
          ? Math.max(-120, 120 - lineDist * 8)
          : Math.max(-260, 260 - lineDist * 10);

        score += lineScore;
        source.push(`line:${lineHint}`);
      }

      if (weakTarget && hasBefore) score += 90;
      if (weakTarget && matchedHint && hasBefore) score += 180;
      if (weakTarget && matchedHint?.role === 'self') score += 120;
      if (weakTarget && answerLike && matchedHint?.role === 'next') score += 18;
      if (weakTarget && hintCount >= 2) score += 40;
      if (weakTarget && matchedHint && textNorm.length <= 320) score += 35;
      if (locator?.inTable && el.matches('td,th,.el-table')) score += 45;
      if (el.matches('p,li,blockquote,td,th,.el-p,.el-li,.el-blockquote')) score += 30;
      if (el.matches('.markdown-preview-section')) score -= 180;
      if (isHeadingEl(el) && !hasTarget && !matchedHint) score -= lineDist <= 3 ? 20 : 160;
      if (hasTarget && textNorm.length <= 220) score += 35;

      score -= Math.min(110, textNorm.length * 0.025);

      if (score > bestScore) {
        bestScore = score;
        best = {
          el,
          score,
          source: source.join('+') || 'unknown',
          lineHint,
          lineDist,
          text: textNorm.slice(0, 160),
          hasTarget,
          hasTargetExact,
          hasTargetLoose,
          hasBefore,
          hasAfter,
          weakTarget,
          answerLike,
          hintCount,
          hint: matchedHint ? {
            role: matchedHint.role,
            distance: matchedHint.distance,
            source: matchedHint.source,
            text: normalizeText(matchedHint.text || '').slice(0, 100)
          } : null
        };
      }
    }

    if (!best) return null;

    const weakAcceptable =
      !!best.hint && (
        best.hint.role === 'self' ||
        (best.hasBefore && best.hintCount >= 1) ||
        best.hintCount >= 2 ||
        best.score >= (best.answerLike ? 420 : 360)
      );

    const acceptable =
      (!weakTarget && best.hasTarget) ||
      (best.hasBefore && best.hasAfter) ||
      (weakTarget && weakAcceptable) ||
      (!weakTarget && best.lineDist <= 30) ||
      (!weakTarget && Number.isFinite(best.lineDist) && best.score >= 220);

    return acceptable ? best : null;
  }

  async applyObsidianLineJump(line) {
    if (!Number.isFinite(line)) return false;

    const leaf = this.getActiveLeaf?.() || null;
    const file = leaf?.view?.file || this.app.workspace.getActiveFile?.() || null;
    const used = [];

    try {
      leaf?.setEphemeralState?.({ line });
      used.push('leaf.setEphemeralState');
    } catch (e) {}

    try {
      leaf?.view?.setEphemeralState?.({ line });
      used.push('view.setEphemeralState');
    } catch (e) {}

    try {
      if (leaf?.openFile && file) {
        await leaf.openFile(file, { active: true, eState: { line } });
        used.push('leaf.openFile:eState.line');
      }
    } catch (e) {
      console.log('[ClozePlus jump H obsidian-line error]', {
        line,
        message: e?.message || String(e)
      });
    }

    console.log('[ClozePlus jump H obsidian-line]', {
      line,
      used,
      file: file?.path || null
    });

    return used.length > 0;
  }

  async jumpEditorAndRetryDom(id, locator) {
    const view = getActiveMarkdownView(this.app);
    const editor = this.app.workspace.activeEditor?.editor || view?.editor;
    if (!editor || !locator) return false;

    const readingVisible = this.activeLeafHasVisibleReadingRoot();
    const posList = [];
    const used = new Set();

    const addPos = (pos) => {
      if (!pos) return;
      const line = Math.max(0, Number(pos.line || 0));
      const ch = Math.max(0, Number(pos.ch || 0));
      const key = `${line}:${ch}`;
      if (used.has(key)) return;
      used.add(key);
      posList.push({ line, ch });
    };

    if (typeof locator.from === 'number') {
      try { addPos(editor.offsetToPos(locator.from)); } catch (e) {}
    }

    if (typeof locator.line === 'number') {
      let line = Math.max(0, locator.line);
      try {
        if (typeof editor.lineCount === 'function') {
          line = Math.min(line, Math.max(0, editor.lineCount() - 1));
        }
      } catch (e) {}
      addPos({ line, ch: 0 });
    }

    if (!posList.length) return false;

    let moved = false;

    for (const pos of posList) {
      try { editor.focus?.(); } catch (e) {}

      try {
        editor.setCursor(pos);
        editor.scrollIntoView({ from: pos, to: pos }, true);
        moved = true;
      } catch (e) {
        continue;
      }

      for (const d of [80, 160, 320, 520]) {
        await sleep(d);

        try { view?.editor?.cm?.requestMeasure?.(); } catch (e) {}
        try { this.tableProcessor?.refreshActiveEditor?.(); } catch (e) {}
        try { this.readingProcessor?.forceRefreshSeries?.(); } catch (e) {}

        const el = this.findVisibleClozeEl(id) || this.tableProcessor?.findElementById?.(id) || null;
        if (el && this.isVisibleElement(el)) {
          this.flash(el);
          return true;
        }
      }
    }

    return !readingVisible && moved;
  }

  async jumpReadingAndRetryDom(id, locator) {
    let root = this.getActiveReadingRoot();

    let rootsCount = null;
    try {
      rootsCount = this.getAllVisibleReadingRoots?.().length ?? null;
    } catch (e) {}

    const initialScroller = root ? this.getReadingScroller(root) : null;
    const initialTop = initialScroller instanceof HTMLElement ? initialScroller.scrollTop : null;

    console.log('[ClozePlus jump H root]', {
      id,
      currentFile: this.getCurrentFilePath?.() || null,
      activeLeafFile: this.getActiveLeaf?.()?.view?.file?.path || null,
      roots: rootsCount,
      line: locator?.line,
      from: locator?.from,
      text: locator?.text,
      contextBefore: locator?.contextBefore,
      contextAfter: locator?.contextAfter,
      rootClass: root?.className || null,
      scrollerClass: initialScroller?.className || null,
      scrollerTop: initialTop,
      scrollerHeight: initialScroller instanceof HTMLElement ? initialScroller.clientHeight : null,
      scrollHeight: initialScroller instanceof HTMLElement ? initialScroller.scrollHeight : null
    });

    if (!root) return false;

    const getRoot = () => {
      const r = this.getActiveReadingRoot();
      if (r) root = r;
      return root;
    };

    const getScroller = () => {
      const r = getRoot();
      return this.getReadingScroller(r);
    };

    const tryDirect = () => {
      const r = getRoot();
      const el = this.findVisibleClozeElInRoot(id, r) || this.findVisibleClozeEl?.(id) || null;

      if (el && this.isVisibleElement(el)) {
        this.flash(el);
        console.log('[ClozePlus jump H direct]', { id });
        return true;
      }
      return false;
    };

    if (tryDirect()) return true;

    const lineInfo = await this.getReadingFileLineInfo(locator);
    const rawLineCandidates = this.getJumpLineCandidates(lineInfo);
    const weakTarget = this.isWeakJumpText(locator?.text || '');
    const answerLike = this.isAnswerLikeJump(locator);

    const lineCandidates = weakTarget
      ? this.expandJumpLineCandidates(rawLineCandidates, answerLike ? [0, 1, -1, 2, -2] : [0, 1, -1])
      : rawLineCandidates;

    const fileHints = weakTarget ? await this.getWeakTargetFileHints(locator, lineInfo) : [];
    let spanHints = [];

    if (weakTarget && !answerLike) {
      spanHints = this.getWeakTargetSpanNeighborHints(id, locator);
    } else if (weakTarget && answerLike && !fileHints.length) {
      spanHints = this.getWeakTargetSpanNeighborHints(id, locator);
    }

    const neighborHints = weakTarget ? this.mergeWeakTargetHints(fileHints, spanHints) : [];

    console.log('[ClozePlus jump H line-candidates]', {
      locatorLine: lineInfo.lineFromLocator,
      fromLine: lineInfo.lineFromFrom,
      totalLines: lineInfo.totalLines,
      rawCandidates: rawLineCandidates,
      candidates: lineCandidates,
      weakTarget,
      answerLike,
      neighborHints: neighborHints.map(h => ({
        role: h.role,
        distance: h.distance,
        line: h.line,
        source: h.source,
        text: normalizeText(h.text || '').slice(0, 80)
      }))
    });

    const logCandidate = (label, cand, preferredLine, extra = {}) => {
      const r = getRoot();
      const s = getScroller();
      const stats = this.getViewportLineStats(r, s, 500);

      console.log(`[ClozePlus jump H ${label}]`, cand ? {
        found: true,
        source: cand.source,
        score: cand.score,
        line: preferredLine,
        lineHint: cand.lineHint,
        lineDist: cand.lineDist,
        hasTarget: cand.hasTarget,
        hasBefore: cand.hasBefore,
        hasAfter: cand.hasAfter,
        weakTarget: cand.weakTarget,
        answerLike: cand.answerLike,
        hintCount: cand.hintCount,
        hint: cand.hint || null,
        text: cand.text,
        stats,
        ...extra
      } : {
        found: false,
        line: preferredLine,
        stats,
        ...extra
      });
    };

    const useCandidate = async (cand, label) => {
      if (!cand?.el) return false;

      const r = getRoot();
      const s = getScroller();

      console.log('[ClozePlus jump H use-candidate]', {
        label,
        source: cand.source,
        score: cand.score,
        lineHint: cand.lineHint,
        lineDist: cand.lineDist,
        hasTarget: cand.hasTarget,
        hasBefore: cand.hasBefore,
        hasAfter: cand.hasAfter,
        weakTarget: cand.weakTarget,
        answerLike: cand.answerLike,
        hintCount: cand.hintCount,
        hint: cand.hint || null,
        text: cand.text
      });

      this.hardScrollToElement(cand.el, r);
      await this.settleReadingAfterScroll(r, s);
      this.hardScrollToElement(cand.el, r);
      await this.settleReadingAfterScroll(r, s);

      for (const d of [80, 160, 320, 520]) {
        await sleep(d);
        try { this.readingProcessor?.forceRefreshSeries?.(); } catch (e) {}
        if (tryDirect()) return true;
      }

      const weakAcceptable =
        !!cand.hint && (
          cand.hint.role === 'self' ||
          (cand.hasBefore && cand.hintCount >= 1) ||
          cand.hintCount >= 2 ||
          cand.score >= (cand.answerLike ? 420 : 360)
        );

      if (
        (!cand.weakTarget && cand.hasTarget) ||
        (cand.hasBefore && cand.hasAfter) ||
        (!cand.weakTarget && cand.lineDist <= 20) ||
        (cand.weakTarget && weakAcceptable)
      ) {
        this.flash(cand.el);
        return true;
      }

      return false;
    };

    let anyMeaningfulMove = false;

    const checkAt = async (label, top, preferredLine, extra = {}) => {
      const r = getRoot();
      const s = getScroller();

      const result = this.scrollElementTo(s, top);
      if (Math.abs((result.afterTop ?? 0) - (result.beforeTop ?? 0)) > 40) {
        anyMeaningfulMove = true;
      }

      await this.settleReadingAfterScroll(r, s);

      if (tryDirect()) return true;

      const nearest = this.findNearestLineElement(getRoot(), preferredLine, getScroller(), 1800);

      console.log('[ClozePlus jump H scroll-check]', {
        id,
        label,
        preferredLine,
        ...result,
        nearest: nearest ? {
          lineHint: nearest.lineHint,
          lineDist: nearest.lineDist,
          text: nearest.text
        } : null,
        stats: this.getViewportLineStats(getRoot(), getScroller(), 500),
        ...extra
      });

      const localCand = this.findBestReadingCandidate(getRoot(), locator, preferredLine, {
        scroller: getScroller(),
        viewportOnly: true,
        margin: answerLike ? 1400 : weakTarget ? 1600 : 2200,
        neighborHints,
        answerLike
      });

      logCandidate(`candidate-${label}`, localCand, preferredLine, extra);

      if (localCand?.el) {
        return await useCandidate(localCand, label);
      }

      if (!weakTarget && nearest?.el && nearest.lineDist <= 4) {
        this.hardScrollToElement(nearest.el, getRoot());
        await this.settleReadingAfterScroll(getRoot(), getScroller());

        if (tryDirect()) return true;

        this.flash(nearest.el);
        return true;
      }

      return false;
    };

    const preferredInitialLine = lineCandidates[0]?.line ?? null;
    let cand = null;

    if (weakTarget && lineCandidates.length) {
      logCandidate('candidate-before', null, preferredInitialLine, {
        skippedGlobal: true,
        reason: answerLike ? 'weak-answer-like' : 'weak-target'
      });
    } else {
      cand = this.findBestReadingCandidate(root, locator, preferredInitialLine, {
        scroller: getScroller(),
        viewportOnly: false,
        margin: 1200,
        neighborHints,
        answerLike
      });

      logCandidate('candidate-before', cand, preferredInitialLine);

      const noLineCandidates = !lineCandidates.length;
      const canTrustEarlyCandidate = !!cand?.el && (
        !weakTarget ||
        (cand.hasBefore && cand.hasAfter) ||
        (!!cand.hint && cand.hint.role === 'self') ||
        (!!cand.hint && cand.hintCount >= 2) ||
        noLineCandidates
      );

      if (cand?.el && canTrustEarlyCandidate) {
        const ok = await useCandidate(cand, 'before');
        if (ok) return true;
      }

      if (cand?.el && !canTrustEarlyCandidate) {
        console.log('[ClozePlus jump H weak-target-skip-direct-candidate]', {
          id,
          text: locator?.text,
          preferredInitialLine,
          candidateText: cand.text,
          hint: cand.hint || null
        });
      }
    }

    for (const item of lineCandidates) {
      const preferredLine = item.line;
      const source = item.source;

      const usedInternal = await this.applyObsidianLineJump(preferredLine);
      await sleep(120);

      root = this.getActiveReadingRoot() || root;
      await this.settleReadingAfterScroll(root, getScroller());

      if (tryDirect()) return true;

      cand = this.findBestReadingCandidate(root, locator, preferredLine, {
        scroller: getScroller(),
        viewportOnly: true,
        margin: answerLike ? 1400 : weakTarget ? 1600 : 2200,
        neighborHints,
        answerLike
      });

      logCandidate('candidate-after-obsidian-line', cand, preferredLine, { source, usedInternal });

      if (cand?.el) {
        const ok = await useCandidate(cand, `after-obsidian-line:${source}`);
        if (ok) return true;
      }

      const scrollerAfterInternal = getScroller();

      if (scrollerAfterInternal instanceof HTMLElement) {
        const centerTop = scrollerAfterInternal.scrollTop;
        const offsets = answerLike
          ? [0, -240, 240, -520, 520, -860, 860]
          : weakTarget
            ? [0, -320, 320, -700, 700]
            : [0, -2400, 2400, -1400, 1400, -800, 800, -400, 400];

        for (let i = 0; i < offsets.length; i++) {
          const top = centerTop + offsets[i];
          const ok = await checkAt(
            `scan-${source}-${i + 1}`,
            top,
            preferredLine,
            {
              phase: answerLike ? 'answer-local-scan' : weakTarget ? 'weak-local-scan' : 'scan',
              source,
              offset: offsets[i]
            }
          );
          if (ok) return true;
        }
      }

      if (weakTarget) {
        console.log('[ClozePlus jump H weak-target-stop-scan]', { id, preferredLine, source });
        continue;
      }

      const s2 = getScroller();
      if (s2 instanceof HTMLElement && Number.isFinite(lineInfo.totalLines) && lineInfo.totalLines > 1) {
        const maxTop = Math.max(0, s2.scrollHeight - s2.clientHeight);
        const ratio = Math.max(0, Math.min(1, preferredLine / Math.max(1, lineInfo.totalLines - 1)));
        const approxTop = Math.round(maxTop * ratio);

        const okApprox = await checkAt(
          `approx-${source}`,
          approxTop,
          preferredLine,
          { phase: 'approx', source, ratio, totalLines: lineInfo.totalLines }
        );
        if (okApprox) return true;

        const aroundApprox = [-2400, 2400, -1400, 1400, -800, 800, -400, 400];
        for (let i = 0; i < aroundApprox.length; i++) {
          const ok = await checkAt(
            `approx-scan-${source}-${i + 1}`,
            approxTop + aroundApprox[i],
            preferredLine,
            {
              phase: 'approx-scan',
              source,
              ratio,
              totalLines: lineInfo.totalLines,
              offset: aroundApprox[i]
            }
          );
          if (ok) return true;
        }
      }
    }

    const finalScroller = getScroller();

    if (finalScroller instanceof HTMLElement && initialTop != null && Math.abs(finalScroller.scrollTop - initialTop) > 120) {
      console.log('[ClozePlus jump H moved-not-exact]', {
        id,
        initialTop,
        finalTop: finalScroller.scrollTop,
        anyMeaningfulMove,
        weakTarget,
        answerLike
      });

      if (!weakTarget) return true;
    }

    if (weakTarget) {
      console.log('[ClozePlus jump H weak-target-unresolved]', {
        id,
        lineInfo,
        answerLike,
        neighborHints: neighborHints.map(h => ({
          role: h.role,
          distance: h.distance,
          line: h.line,
          source: h.source,
          text: normalizeText(h.text || '').slice(0, 80)
        })),
        anyMeaningfulMove
      });
    }

    console.log('[ClozePlus jump H failed]', { id, lineInfo, anyMeaningfulMove });
    return false;
  }

  async jumpToCloze(id, locator = null) {
    const seq = ++this.jumpSeq;
    const token = ++this.jumpToken;
    this.jumpRunning = true;

    try {
      console.log('[ClozePlus jump H start]', { seq, id, locator });

      this.refreshCurrentSpans();

      const span = this.resolveSpanForJump(id, locator);
      if (!span && !locator) {
        new Notice('未找到该条目的定位信息');
        return false;
      }

      locator = locator || this.buildLocator(span);

      const direct = this.findVisibleClozeEl(id);
      if (direct && document.body.contains(direct)) {
        this.flash(direct);
        console.log('[ClozePlus jump H direct-start]', { seq, id });
        return true;
      }

      if (this.activeLeafHasVisibleReadingRoot()) {
        const readingOk = await this.jumpReadingAndRetryDom(id, locator);
        if (readingOk) {
          console.log('[ClozePlus jump H reading-first ok]', { seq, id });
          return true;
        }
      }

      const editorOk = await this.jumpEditorAndRetryDom(id, locator);
      if (editorOk) {
        console.log('[ClozePlus jump H editor ok]', { seq, id });
        return true;
      }

      const readingFallback = await this.jumpReadingAndRetryDom(id, locator);
      if (readingFallback) {
        console.log('[ClozePlus jump H reading-fallback ok]', { seq, id });
        return true;
      }

      new Notice('未能定位目标');
      console.log('[ClozePlus jump H failed]', { seq, id, locator });
      return false;
    } finally {
      if (token === this.jumpToken) this.jumpRunning = false;
    }
  }

  clearFlash(el) {
    if (!el) return;

    if (!this._jumpFlashStates) {
      this._jumpFlashStates = new WeakMap();
    }

    const state = this._jumpFlashStates.get(el);

    try { if (state?.softTimer) clearTimeout(state.softTimer); } catch (e) {}
    try { if (state?.clearTimer) clearTimeout(state.clearTimer); } catch (e) {}

    try {
      el.classList.remove('is-jumping');
      const prev = state?.prev || null;

      el.style.transition = prev?.transition ?? '';
      el.style.outline = prev?.outline ?? '';
      el.style.outlineOffset = prev?.outlineOffset ?? '';
      el.style.boxShadow = prev?.boxShadow ?? '';
      el.style.backgroundColor = prev?.backgroundColor ?? '';
      el.style.borderRadius = prev?.borderRadius ?? '';
    } catch (e) {}

    try { delete el.dataset.cpJumpFlashToken; } catch (e) {}

    this._jumpFlashStates.delete(el);
    if (this._jumpFlashActiveEl === el) this._jumpFlashActiveEl = null;
  }

  flash(el) {
    if (!el) return;

    try { this.scrollTargetIntoView(el); } catch (e) {}

    if (!this._jumpFlashStates) {
      this._jumpFlashStates = new WeakMap();
    }

    try {
      if (this._jumpFlashActiveEl && this._jumpFlashActiveEl !== el) {
        this.clearFlash(this._jumpFlashActiveEl);
      }
    } catch (e) {}

    try {
      const existing = this._jumpFlashStates.get(el);

      const prev = existing?.prev || {
        transition: el.style.transition,
        outline: el.style.outline,
        outlineOffset: el.style.outlineOffset,
        boxShadow: el.style.boxShadow,
        backgroundColor: el.style.backgroundColor,
        borderRadius: el.style.borderRadius
      };

      try { if (existing?.softTimer) clearTimeout(existing.softTimer); } catch (e) {}
      try { if (existing?.clearTimer) clearTimeout(existing.clearTimer); } catch (e) {}

      const token = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const applyStrong = () => {
        el.classList.add('is-jumping');
        el.style.transition = 'outline 180ms ease, box-shadow 260ms ease, background-color 260ms ease';
        el.style.outline = '2px solid rgba(255, 86, 86, 0.95)';
        el.style.outlineOffset = '2px';
        if (!el.style.borderRadius) el.style.borderRadius = prev.borderRadius || '4px';

        el.style.backgroundColor = 'rgba(255, 235, 59, 0.24)';
        el.style.boxShadow = [
          'inset 0 0 0 9999px rgba(255, 235, 59, 0.20)',
          '0 0 0 3px rgba(255, 86, 86, 0.30)',
          '0 0 0 10px rgba(255, 86, 86, 0.14)',
          '0 0 18px rgba(255, 86, 86, 0.18)'
        ].join(', ');
      };

      const applySoft = () => {
        el.style.backgroundColor = 'rgba(255, 235, 59, 0.12)';
        el.style.boxShadow = [
          'inset 0 0 0 9999px rgba(255, 235, 59, 0.10)',
          '0 0 0 2px rgba(255, 86, 86, 0.18)',
          '0 0 0 8px rgba(255, 86, 86, 0.08)',
          '0 0 12px rgba(255, 86, 86, 0.10)'
        ].join(', ');
      };

      const state = { prev, token, softTimer: 0, clearTimer: 0 };
      this._jumpFlashStates.set(el, state);
      this._jumpFlashActiveEl = el;

      try { el.dataset.cpJumpFlashToken = token; } catch (e) {}

      applyStrong();

      state.softTimer = window.setTimeout(() => {
        const cur = this._jumpFlashStates.get(el);
        if (!cur || cur.token !== token) return;

        if (!document.body.contains(el)) {
          this._jumpFlashStates.delete(el);
          if (this._jumpFlashActiveEl === el) this._jumpFlashActiveEl = null;
          return;
        }

        applySoft();
      }, 180);

      state.clearTimer = window.setTimeout(() => {
        const cur = this._jumpFlashStates.get(el);
        if (!cur || cur.token !== token) return;
        this.clearFlash(el);
      }, 1300);
    } catch (e) {}
  }

  /* ===== 导出 ===== */

  buildBlocks(text) {
    const lines = String(text || '').split('\n');
    const lineOffsets = [];
    let off = 0;

    for (let i = 0; i < lines.length; i++) {
      lineOffsets[i] = off;
      off += lines[i].length + 1;
    }

    const blocks = [];
    let cur = [];
    let startLine = 0;
    let mode = '';

    const flush = () => {
      if (!cur.length) return;
      const endLine = startLine + cur.length - 1;
      blocks.push({
        startLine,
        endLine,
        startOffset: lineOffsets[startLine] || 0,
        endOffset: (lineOffsets[endLine] || 0) + lines[endLine].length,
        text: cur.join('\n'),
        isTable: mode === 'table',
        hasCloze: false,
        headingKey: ''
      });
      cur = [];
      mode = '';
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const blank = !line.trim();
      const table = isMarkdownTableLine(line);
      const heading = /^\s*#{1,6}\s+/.test(line);
      const want = table ? 'table' : heading ? 'heading' : 'para';

      if (blank) {
        flush();
        continue;
      }

      if (!cur.length) {
        cur = [line];
        startLine = i;
        mode = want;
        continue;
      }

      if (mode === 'table' && table) {
        cur.push(line);
        continue;
      }

      if (mode === 'para' && !table && !heading) {
        cur.push(line);
        continue;
      }

      flush();
      cur = [line];
      startLine = i;
      mode = want;
    }

    flush();
    return blocks;
  }

  makeAnkiClozeSnippet(fullText, range, spans) {
    let snippet = fullText.slice(range.startOffset, range.endOffset);

    const rel = spans.map((s, i) => ({
      ...s,
      relFrom: s.from - range.startOffset,
      relTo: s.to - range.startOffset,
      cidx: i + 1
    }))
      .filter(s => s.relFrom >= 0 && s.relTo <= snippet.length)
      .sort((a, b) => b.relFrom - a.relFrom);

    for (const s of rel) {
      snippet = snippet.slice(0, s.relFrom) + `{{c${s.cidx}::${s.text}}}` + snippet.slice(s.relTo);
    }

    return snippet;
  }

  getCardTitle(cardSpans) {
    const first = cardSpans[0];
    if (!first) return '';
    return (first.headingPath || []).join(' / ');
  }

  buildCardTags(title) {
    const base = normalizeText(this.settings.exportTags || '');
    const tags = base ? base.split(/\s+/).filter(Boolean) : [];
    if (this.settings.exportHeadingAsTag && title) {
      title.split('/').map(x => titleToTag(x)).filter(Boolean).forEach(t => tags.push(t));
    }
    return [...new Set(tags)].join(' ');
  }

  getContentByMode(card) {
    const mode = this.settings.exportTextMode;
    if (mode === 'original-markdown') return card.raw;
    if (mode === 'plain-text') return card.plain;
    return card.anki;
  }

  async writeExportFiles(baseName, outputs) {
    const adapter = this.app.vault.adapter;
    const exportDir = String(this.settings.exportDir || 'ClozePlus-Exports').trim() || 'ClozePlus-Exports';
    await ensureFolder(adapter, exportDir);

    for (const out of outputs) {
      await adapter.write(joinPath(exportDir, `${baseName}.${out.ext}`), out.content);
    }
  }

  buildExportRanges(blocks, spans, selectedSet) {
    const lineToBlock = [];
    blocks.forEach((b, i) => {
      for (let l = b.startLine; l <= b.endLine; l++) lineToBlock[l] = i;
    });

    spans.forEach(s => {
      const bi = lineToBlock[s.line];
      if (bi != null) {
        blocks[bi].hasCloze = true;
        if (!blocks[bi].headingKey) blocks[bi].headingKey = (s.headingPath || []).join(' / ');
      }
    });

    const selectedBlockSet = new Set();
    spans.forEach(s => {
      if (!selectedSet || selectedSet.has(s.id)) {
        const bi = lineToBlock[s.line];
        if (bi != null) selectedBlockSet.add(bi);
      }
    });

    const sortedBlocks = [...selectedBlockSet].sort((a, b) => a - b);
    const ranges = [];

    const sameHeading = (a, b) => {
      if (!this.settings.exportGroupByHeading) return true;
      const ka = blocks[a]?.headingKey || '';
      const kb = blocks[b]?.headingKey || '';
      return ka === kb;
    };

    for (const idx of sortedBlocks) {
      let clusterStart = idx;
      let clusterEnd = idx;

      while (clusterStart > 0 && blocks[clusterStart - 1].hasCloze && sameHeading(clusterStart - 1, clusterStart)) clusterStart--;
      while (clusterEnd < blocks.length - 1 && blocks[clusterEnd + 1].hasCloze && sameHeading(clusterEnd, clusterEnd + 1)) clusterEnd++;

      let start = Math.max(0, clusterStart - 1);
      let end = Math.min(blocks.length - 1, clusterEnd + 1);

      if (this.settings.exportGroupByHeading) {
        while (start < clusterStart && !sameHeading(start, clusterStart)) start++;
        while (end > clusterEnd && !sameHeading(end, clusterEnd)) end--;
      }

      const last = ranges[ranges.length - 1];
      if (last && start <= last.end + 1 && (!this.settings.exportGroupByHeading || sameHeading(start, last.end))) {
        last.end = Math.max(last.end, end);
      } else {
        ranges.push({ start, end });
      }
    }

    return { ranges, lineToBlock };
  }

  async exportCardsFromSpans(spanIds = null, label = 'export') {
    const filePath = this.getCurrentFilePath();
    if (!filePath) return new Notice('没有活动文件');

    const fullText = await this.getCurrentFileText();
    if (!fullText) return new Notice('文件为空，无法导出');

    const spans = this.parser.parse(fullText, filePath);
    if (!spans.length) return new Notice('当前文件没有 cloze');

    const blocks = this.buildBlocks(fullText);
    if (!blocks.length) return new Notice('没有可导出的段落');

    const selectedSet = spanIds ? new Set(spanIds) : null;
    const { ranges } = this.buildExportRanges(blocks, spans, selectedSet);
    if (!ranges.length) return new Notice('当前筛选没有可导出项');

    const cards = ranges.map((r, idx) => {
      const range = {
        startBlock: r.start,
        endBlock: r.end,
        startLine: blocks[r.start].startLine,
        endLine: blocks[r.end].endLine,
        startOffset: blocks[r.start].startOffset,
        endOffset: blocks[r.end].endOffset
      };

      const cardSpans = spans.filter(s => s.line >= range.startLine && s.line <= range.endLine);
      const raw = blocks.slice(r.start, r.end + 1).map(b => b.text).join('\n\n');
      const plain = stripMarkdownMarks(raw);
      const anki = this.makeAnkiClozeSnippet(fullText, range, cardSpans);
      const source = `${filePath} [${range.startLine + 1}-${range.endLine + 1}]`;
      const title = this.getCardTitle(cardSpans);
      const tags = this.buildCardTags(title);

      return {
        index: idx + 1,
        raw,
        plain,
        anki,
        source,
        title,
        tags,
        clozeTexts: cardSpans.map(s => s.text)
      };
    });

    const separator = decodeEscaped(this.settings.exportSeparator || '\\n\\n\\n\\n');

    const rendered = cards.map(card => {
      const data = {
        content: this.getContentByMode(card),
        anki: card.anki,
        raw: card.raw,
        plain: card.plain,
        source: card.source,
        title: card.title,
        tags: card.tags
      };

      return {
        front: renderTemplate(this.settings.exportFrontTemplate || '{{content}}', data),
        back: renderTemplate(this.settings.exportBackTemplate || '{{source}}', data),
        tags: card.tags,
        raw: card.raw,
        source: card.source
      };
    });

    const outputs = [];
    let primaryText = '';

    if (this.settings.exportProfile === 'anki-tsv') {
      primaryText = rendered.map(x => `${tsvQuote(x.front)}\t${tsvQuote(x.back)}\t${tsvQuote(x.tags)}`).join('\n');
      outputs.push({ ext: 'anki.tsv', content: primaryText });
      outputs.push({
        ext: 'preview.md',
        content: cards.map((c, i) =>
          `## Card ${i + 1}\n\n**Source:** ${c.source}\n\n**Title:** ${c.title || '(none)'}\n\n**Tags:** ${c.tags}\n\n\`\`\`md\n${c.raw}\n\`\`\`\n`
        ).join('\n')
      });
    } else if (this.settings.exportProfile === 'sr-inline') {
      primaryText = rendered.map(x => `${x.front}:: ${x.back}`).join(separator);
      outputs.push({ ext: 'sr-inline.md', content: primaryText });
    } else if (this.settings.exportProfile === 'sr-multiline') {
      primaryText = rendered.map(x => `${x.front}\n?\n${x.back}`).join(separator);
      outputs.push({ ext: 'sr-multiline.md', content: primaryText });
    } else {
      primaryText = rendered.map((x, i) => `## Card ${i + 1}\n\n${x.front}\n\n---\n\n${x.back}`).join(separator);
      outputs.push({ ext: 'md', content: primaryText });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${stamp}-${label}-${sanitizePathReadable(filePath.split('/').pop() || 'export')}`;
    await this.writeExportFiles(base, outputs);

    try { await navigator.clipboard.writeText(primaryText); } catch (e) {}

    new Notice(`已导出 ${cards.length} 张卡片，并复制主输出到剪贴板`);
    this.logger.log('export cards', {
      cards: cards.length,
      filePath,
      label,
      profile: this.settings.exportProfile
    });
  }

  /* ===== 评分 ===== */

  async handleClozeAction(span, action, el) {
    const fp = this.getCurrentFilePath();
    if (!fp) return;

    const rec = await this.dataManager.recordAction(
      fp,
      span.id,
      span.text,
      action,
      this.buildLocator(span)
    );

    if (el instanceof HTMLElement) {
      el.classList.remove('fail-1', 'fail-2', 'fail-3', 'fail-4');
      const fc = failColorClass(rec.failCount || 0);
      if (fc) el.classList.add(fc);
    }

    if (action === '➕') {
      new Notice('✅ 已加入记忆曲线复习');
    }

    this.syncClozeVisual(span.id);
    this.refreshPanelsOnly();

    if (this.currentMode === 'learn' && this.settings.enableDivider) {
      try { this.dividerLine?.onScroll?.(); } catch (e) {}
    }
  }

  async handleFsrsRating(span, rating, el) {
    const fp = this.getCurrentFilePath();
    if (!fp) return;

    const rec = await this.dataManager.rateFsrs(
      fp,
      span.id,
      rating,
      this.fsrs,
      this.buildLocator(span)
    );

    const days = rec.fsrs.due - todayDays();

    if (el instanceof HTMLElement) {
      el.classList.remove('r-high', 'r-mid', 'r-low', 'r-vlow');
      el.classList.add(rColorClass(this.fsrs.currentR(rec.fsrs, todayDays())));
    }

    new Notice(days <= 0 ? '📅 今天再次复习' : `📅 ${days} 天后复习`);

    this.syncClozeVisual(span.id);
    this.refreshPanelsOnly();
  }

  async removeFromFsrs(span, el) {
    const fp = this.getCurrentFilePath();
    if (!fp) return;

    await this.dataManager.removeFromFsrs(
      fp,
      span.id,
      this.buildLocator(span)
    );

    if (el instanceof HTMLElement) {
      el.classList.remove('r-high', 'r-mid', 'r-low', 'r-vlow');
      const rec = this.dataManager.getRecord(fp, span.id);
      const fc = failColorClass(rec.failCount || 0);
      if (fc) el.classList.add(fc);
    }

    new Notice('➖ 已移出记忆曲线，转入复习');

    this.syncClozeVisual(span.id);
    this.refreshPanelsOnly();
  }

  updateStatusBar() {
    if (!this.statusBar) return;

    const labels = {
      normal: '📝 Cloze',
      learn: '📖 学习中',
      review: '🔄 复习中',
      fsrs: '🧠 记忆曲线'
    };

    this.statusBar.textContent = labels[this.currentMode] || '📝 Cloze';
  }

  showModeMenu() {
    if (!this.statusBar) return;

    const menu = new Menu();
    menu.addItem(i => i.setTitle('📖 进入学习模式').onClick(() => this.enterMode('learn')));
    menu.addItem(i => i.setTitle('🔄 进入复习模式').onClick(() => this.enterMode('review')));
    menu.addItem(i => i.setTitle('🧠 进入记忆曲线复习模式').onClick(() => this.enterMode('fsrs')));
    menu.addSeparator();
    menu.addItem(i => i.setTitle('导出当前文件全部卡片').onClick(() => this.exportCardsFromSpans(null, 'all')));
    menu.addItem(i => i.setTitle('复制调试日志').onClick(() => this.logger.copy()));
    menu.addItem(i => i.setTitle('✅ 退出当前模式').onClick(() => this.exitMode()));

    const rect = this.statusBar.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.top });
  }
}

module.exports = ClozePlusPlugin;