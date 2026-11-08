/* Fishingbot lightweight browser i18n. No external dependencies.
 * Two layers: data-i18n keys for the shell (header, navigation, labels) and a phrase table for the
 * text the renderers write (i18n/phrases-<code>.json, keyed by the exact English text). Rendered text
 * and placeholder/title/aria-label attributes are translated as they are added to the page. */
(function (global) {
  'use strict';
  const supported = ['en', 'es', 'de', 'fr', 'zh'];
  const cache = new Map();
  let language = 'en';
  let resources = {};
  let phrases = {};
  const fallback = {};

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

  function t(key) {
    return (resources && resources[key]) || (fallback && fallback[key]) || key;
  }

  function normal(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function translateText(node) {
    const value = node.nodeValue;
    if (!value || !value.trim()) return;
    const match = value.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const translated = phrases[normal(match[2])];
    if (translated) node.nodeValue = match[1] + translated + match[3];
  }

  function translateElement(el) {
    ['placeholder', 'title', 'aria-label'].forEach(attr => {
      if (!el.hasAttribute(attr)) return;
      const translated = phrases[normal(el.getAttribute(attr))];
      if (translated) el.setAttribute(attr, translated);
    });
  }

  function translateTree(root) {
    if (!root || !Object.keys(phrases).length) return;
    if (root.nodeType === 3) { translateText(root); return; }
    if (root.nodeType === 1) translateElement(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 3) translateText(node);
      else translateElement(node);
    }
  }

  async function loadLanguage(code) {
    const wanted = supported.includes(String(code || '').toLowerCase()) ? String(code).toLowerCase() : 'en';
    try { Object.assign(fallback, await read('en')); } catch (_) { /* keys remain readable */ }
    try {
      resources = wanted === 'en' ? fallback : await read(wanted);
      language = wanted;
    } catch (_) {
      resources = fallback;
      language = 'en';
    }
    try { phrases = await readPhrases(language); } catch (_) { phrases = {}; }
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    translateTree(document.documentElement);
    // The desktop window (WebView2 host) follows the same language.
    if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) global.chrome.webview.postMessage(language);
    try { localStorage.setItem('fishingbot.language', language); } catch (_) { }
    global.dispatchEvent(new CustomEvent('fishingbot:language-changed', { detail: { language } }));
    return language;
  }

  // Pages re-render their sections with innerHTML. Translate each new piece as it arrives.
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(records => {
      if (!Object.keys(phrases).length) return;
      for (const record of records) {
        for (const node of record.addedNodes) translateTree(node);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  global.FishingbotI18n = { t, loadLanguage, getLanguage: () => language, supported: supported.slice(), translate: translateTree };
  const initial = (() => { try { return localStorage.getItem('fishingbot.language') || 'en'; } catch (_) { return 'en'; } })();
  loadLanguage(initial);
})(window);
