/* Shared Fishingbot browser i18n.
 * The selected language is the single source of truth for the shell and every local page.
 * Static keyed copy uses data-i18n; rendered copy uses catalog keys or the exact-phrase tables.
 * Original English text is retained on each node so changing languages never translates a
 * translation, including content inserted by a renderer after the language was selected.
 */
(function (global) {
  'use strict';

  const supported = ['en', 'es', 'de', 'fr', 'zh'];
  const cache = new Map();
  let language = 'en';
  let resources = {};
  let fallback = {};
  let phrases = {};
  let activePhrases = {};
  let reverseExact = new Map();
  let reversePatterns = [];
  let forwardPatterns = [];
  let loadSerial = 0;

  async function read(code) {
    if (cache.has(code)) return cache.get(code);
    const response = await fetch('/i18n/' + code + '.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('Language resource unavailable: ' + code);
    const data = await response.json();
    cache.set(code, data);
    return data;
  }

  async function readPhrases(code) {
    if (code === 'en') return {};
    const key = 'phrases:' + code;
    if (cache.has(key)) return cache.get(key);
    const response = await fetch('/i18n/phrases-' + code + '.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('Phrase table unavailable: ' + code);
    const data = await response.json();
    cache.set(key, data);
    return data;
  }

  function normal(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function templateRegex(template) {
    const parts = String(template).split(/(\{[^{}]+\})/g);
    let source = '^';
    let count = 0;
    for (const part of parts) {
      if (/^\{[^{}]+\}$/.test(part)) {
        source += '([\\s\\S]*?)';
        count += 1;
      } else source += escapeRegExp(part);
    }
    source += '$';
    return count ? { regex: new RegExp(source), count } : null;
  }

  function replaceTemplate(template, captures) {
    let index = 0;
    return String(template).replace(/\{[^{}]+\}/g, () => String(captures[index++] ?? ''));
  }

  function addReverse(reverse, value, source) {
    const key = normal(value);
    if (!key || key === normal(source)) return;
    if (reverse.has(key) && reverse.get(key) !== source) reverse.set(key, null);
    else if (!reverse.has(key)) reverse.set(key, source);
  }

  function buildIndexes() {
    const map = {};
    const reverse = new Map();
    const backPatterns = [];
    const nextPatterns = [];
    const englishValues = new Set(Object.values(fallback).filter(v => typeof v === 'string').map(normal));

    // The keyed dictionaries cover core UI labels and longer status messages. Turn them into
    // phrase entries too, so renderers which output the English label directly still translate.
    for (const [key, english] of Object.entries(fallback)) {
      if (typeof english !== 'string') continue;
      const localized = typeof resources[key] === 'string' ? resources[key] : english;
      if (english && localized && english !== localized) map[normal(english)] = localized;
      if (localized) addReverse(reverse, localized, english);
      const back = templateRegex(localized);
      if (back) backPatterns.push({ ...back, translated: localized, source: english });
      const forward = templateRegex(english);
      if (forward && localized !== english) nextPatterns.push({ ...forward, source: english, translated: localized });
    }

    // Phrase files add context-specific sentences used by dynamic pages and toasts.
    for (const [english, localized] of Object.entries(phrases)) {
      if (typeof english !== 'string' || typeof localized !== 'string') continue;
      if (!Object.prototype.hasOwnProperty.call(map, normal(english))) map[normal(english)] = localized;
      addReverse(reverse, localized, english);
      const back = templateRegex(localized);
      if (back) backPatterns.push({ ...back, translated: localized, source: english });
      const forward = templateRegex(english);
      if (forward && localized !== english) nextPatterns.push({ ...forward, source: english, translated: localized });
    }

    // Exact canonical English text must win over reverse mappings which happen to be common words.
    for (const english of englishValues) reverse.delete(english);
    activePhrases = map;
    reverseExact = reverse;
    reversePatterns = backPatterns;
    forwardPatterns = nextPatterns;
  }

  function canonicalize(text) {
    const value = normal(text);
    if (!value) return value;
    if (Object.values(fallback).some(entry => typeof entry === 'string' && normal(entry) === value)) return value;
    const exact = reverseExact.get(value);
    if (typeof exact === 'string') return exact;
    for (const entry of reversePatterns) {
      const match = entry.regex.exec(value);
      if (match) return replaceTemplate(entry.source, match.slice(1));
    }
    return String(text);
  }

  function translateString(text) {
    const raw = String(text);
    const value = normal(raw);
    if (!value || language === 'en') return raw;
    if (Object.prototype.hasOwnProperty.call(activePhrases, value)) return activePhrases[value];
    for (const entry of forwardPatterns) {
      const match = entry.regex.exec(value);
      if (match) return replaceTemplate(entry.translated, match.slice(1));
    }
    return raw;
  }

  function t(key, vars) {
    const template = (resources && resources[key]) || (fallback && fallback[key]) || key;
    if (!vars) return template;
    return String(template).replace(/\{([^{}]+)\}/g, (all, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all);
  }

  function splitWhitespace(text) {
    const match = String(text).match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { before: match ? match[1] : '', core: match ? match[2] : String(text), after: match ? match[3] : '' };
  }

  function applyExplicit(root) {
    if (!root || root.nodeType !== 1) return;
    const keyed = [];
    if (root.matches && root.matches('[data-i18n]')) keyed.push(root);
    if (root.querySelectorAll) keyed.push(...root.querySelectorAll('[data-i18n]'));
    for (const el of keyed) {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    }
    const placeholders = [];
    if (root.matches && root.matches('[data-i18n-placeholder]')) placeholders.push(root);
    if (root.querySelectorAll) placeholders.push(...root.querySelectorAll('[data-i18n-placeholder]'));
    for (const el of placeholders) {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) el.setAttribute('placeholder', t(key));
    }
  }

  function translateElement(el) {
    if (!el || !el.getAttribute) return;
    for (const attr of ['placeholder', 'title', 'aria-label', 'aria-description', 'alt', 'data-tip', 'data-tooltip', 'data-description', 'data-hint']) {
      if (!el.hasAttribute(attr)) continue;
      el.__fbI18nAttributes = el.__fbI18nAttributes || {};
      if (!Object.prototype.hasOwnProperty.call(el.__fbI18nAttributes, attr)) {
        const raw = el.getAttribute(attr);
        const space = splitWhitespace(raw);
        el.__fbI18nAttributes[attr] = space.before + canonicalize(space.core) + space.after;
      }
      const source = el.__fbI18nAttributes[attr];
      const space = splitWhitespace(source);
      const translated = translateString(space.core);
      const next = space.before + translated + space.after;
      if (el.getAttribute(attr) !== next) el.setAttribute(attr, next);
    }
  }

  function translateText(node) {
    if (!node || !node.nodeValue || !node.nodeValue.trim()) return;
    if (node.parentElement && /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|TEXTAREA)$/i.test(node.parentElement.tagName)) return;
    if (node.__fbI18nSource === undefined) {
      const space = splitWhitespace(node.nodeValue);
      node.__fbI18nSource = space.before + canonicalize(space.core) + space.after;
    }
    const space = splitWhitespace(node.__fbI18nSource);
    const next = space.before + translateString(space.core) + space.after;
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateText(root); return; }
    if (root.nodeType === 1) translateElement(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 3) translateText(node);
      else translateElement(node);
    }
  }

  async function loadLanguage(code) {
    const serial = ++loadSerial;
    const wanted = supported.includes(String(code || '').toLowerCase()) ? String(code).toLowerCase() : 'en';
    let en = {};
    try { en = await read('en'); } catch (_) { /* untranslated keys remain readable */ }
    let nextResources = en;
    if (wanted !== 'en') {
      try { nextResources = await read(wanted); } catch (_) { nextResources = en; }
    }
    let nextPhrases = {};
    try { nextPhrases = await readPhrases(wanted); } catch (_) { nextPhrases = {}; }
    if (serial !== loadSerial) return language;

    fallback = en;
    resources = nextResources;
    phrases = nextPhrases;
    language = wanted === 'en' || nextResources === en ? (wanted === 'en' ? 'en' : 'en') : wanted;
    buildIndexes();
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
    applyExplicit(document.documentElement);
    translateTree(document.documentElement);
    try { localStorage.setItem('fishingbot.language', language); } catch (_) { }
    if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
      global.chrome.webview.postMessage(language);
    }
    global.dispatchEvent(new CustomEvent('fishingbot:language-changed', { detail: { language } }));
    return language;
  }

  // All renderers (including the Control Centre's innerHTML templates) flow through this observer.
  // Text/attribute source is kept once, so a render or language switch can't translate the translation.
  if (typeof MutationObserver !== 'undefined') {
    const descriptiveAttributes = ['placeholder', 'title', 'aria-label', 'aria-description', 'alt', 'data-tip', 'data-tooltip', 'data-description', 'data-hint'];
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') {
          const el = record.target;
          const attr = record.attributeName;
          const source = el.__fbI18nAttributes && el.__fbI18nAttributes[attr];
          if (source !== undefined) {
            const space = splitWhitespace(source);
            const expected = space.before + translateString(space.core) + space.after;
            // Detect a newly rendered description/title and adopt it as the source phrase.
            if (el.getAttribute(attr) !== expected) delete el.__fbI18nAttributes[attr];
          }
          translateElement(el);
          continue;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) applyExplicit(node);
          translateTree(node);
        }
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: descriptiveAttributes,
    });
  }

  global.FishingbotI18n = {
    t,
    loadLanguage,
    setLanguage: loadLanguage,
    getLanguage: () => language,
    supported: supported.slice(),
    translate: translateTree,
  };
  const initial = (() => { try { return localStorage.getItem('fishingbot.language') || 'en'; } catch (_) { return 'en'; } })();
  loadLanguage(initial);
})(window);
