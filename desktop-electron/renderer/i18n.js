// Desktop i18n. Each text/attribute node stores its canonical English source, so language changes
// are reversible and dynamically rendered dialogs, settings, menus and notifications are translated.
(() => {
  'use strict';

  const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'aria-description', 'alt'];
  let dictionary = {};
  let language = 'en';
  let reverseExact = new Map();
  let reversePatterns = [];
  let forwardPatterns = [];
  let canonicalEnglish = new Set();
  const canonicalCache = new Map();

  const normal = (value) => String(value).replace(/\s+/g, ' ').trim();
  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function templateRegex(template) {
    const parts = String(template).split(/(\{[^{}]+\})/g);
    let source = '^';
    let count = 0;
    for (const part of parts) {
      if (/^\{[^{}]+\}$/.test(part)) { source += '([\\s\\S]*?)'; count += 1; }
      else source += escapeRegExp(part);
    }
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

  function rebuildIndexes() {
    const reverse = new Map();
    const backs = [];
    const forwards = [];
    const english = new Set();
    for (const dict of Object.values(dictionary)) {
      if (!dict || typeof dict !== 'object') continue;
      for (const source of Object.keys(dict)) english.add(normal(source));
    }
    canonicalEnglish = english;
    canonicalCache.clear();
    for (const [code, dict] of Object.entries(dictionary)) {
      if (!dict || typeof dict !== 'object') continue;
      for (const [source, translated] of Object.entries(dict)) {
        if (typeof source !== 'string' || typeof translated !== 'string') continue;
        addReverse(reverse, translated, source);
        const back = templateRegex(translated);
        if (back) backs.push({ ...back, translated, source });
        if (code === language && translated !== source) {
          const forward = templateRegex(source);
          if (forward) forwards.push({ ...forward, source, translated });
        }
      }
    }
    for (const english of canonicalEnglish) reverse.delete(english);
    reverseExact = reverse;
    reversePatterns = backs;
    forwardPatterns = forwards;
  }

  function canonicalize(value) {
    const text = normal(value);
    if (!text) return text;
    if (canonicalEnglish.has(text)) return text;
    if (canonicalCache.has(text)) return canonicalCache.get(text);
    const exact = reverseExact.get(text);
    if (typeof exact === 'string') { canonicalCache.set(text, exact); return exact; }
    for (const entry of reversePatterns) {
      const match = entry.regex.exec(text);
      if (match) { const result = replaceTemplate(entry.source, match.slice(1)); canonicalCache.set(text, result); return result; }
    }
    canonicalCache.set(text, text);
    return text;
  }

  function translation(text) {
    const raw = String(text);
    const source = normal(raw);
    if (language === 'en' || !dictionary[language]) return raw;
    const hit = dictionary[language][source];
    if (typeof hit === 'string') return hit;
    for (const entry of forwardPatterns) {
      const match = entry.regex.exec(source);
      if (match) return replaceTemplate(entry.translated, match.slice(1));
    }
    return raw;
  }

  // Translate one string, filling {name} placeholders from vars.
  function t(text, vars) {
    let out = translation(text);
    if (vars) {
      for (const [name, value] of Object.entries(vars)) out = out.split(`{${name}}`).join(String(value));
    }
    return out;
  }

  function splitWhitespace(text) {
    const match = String(text).match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { before: match ? match[1] : '', core: match ? match[2] : String(text), after: match ? match[3] : '' };
  }

  function apply(root, options) {
    if (!root) return;
    const fresh = !!(options && options.fresh);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    if (root.nodeType === 3) nodes.unshift(root);
    for (const node of nodes) {
      if (!node.nodeValue || (node.parentElement && /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|TEXTAREA)$/i.test(node.parentElement.tagName))) continue;
      if (node.__fbI18nSource === undefined || fresh) {
        const space = splitWhitespace(node.nodeValue);
        node.__fbI18nSource = space.before + canonicalize(space.core) + space.after;
      }
      const space = splitWhitespace(node.__fbI18nSource);
      const next = space.before + translation(space.core) + space.after;
      if (node.nodeValue !== next) node.nodeValue = next;
    }

    const elements = root.querySelectorAll ? [root, ...root.querySelectorAll('*')] : [];
    for (const el of elements) {
      for (const name of ATTRIBUTES) {
        if (!el.hasAttribute(name)) continue;
        el.__fbI18nAttributes = el.__fbI18nAttributes || {};
        if (!Object.prototype.hasOwnProperty.call(el.__fbI18nAttributes, name) || fresh) {
          const space = splitWhitespace(el.getAttribute(name));
          el.__fbI18nAttributes[name] = space.before + canonicalize(space.core) + space.after;
        }
        const space = splitWhitespace(el.__fbI18nAttributes[name]);
        const next = space.before + translation(space.core) + space.after;
        if (el.getAttribute(name) !== next) el.setAttribute(name, next);
      }
    }
  }

  function setLanguage(code) {
    language = dictionary[code] ? code : 'en';
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
    rebuildIndexes();
  }

  async function load(api, savedLanguage) {
    try {
      const result = await api.strings();
      dictionary = (result && result.dictionary) || {};
    } catch {
      dictionary = {};
    }
    setLanguage(savedLanguage);
    apply(document.body, { fresh: true });
  }

  // Desktop shell apps generate new DOM frequently (toasts, settings status, menus, log rows). Translate
  // it as it arrives instead of relying on each renderer to remember to call apply().
  if (typeof MutationObserver !== 'undefined') {
    // Batch DOM updates into one animation frame. Applying each MutationRecord synchronously
    // caused repeated full subtree walks when settings pages rendered many controls at once.
    const pending = new Set();
    let applyFrame = 0;
    const flush = () => {
      applyFrame = 0;
      const roots = [...pending];
      pending.clear();
      // Drop descendants when an ancestor is already queued to avoid translating the same subtree twice.
      const topLevel = roots.filter(node => !roots.some(other => other !== node && other.nodeType === 1 && other.contains && other.contains(node)));
      for (const node of topLevel) apply(node);
    };
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 || node.nodeType === 3) pending.add(node);
        }
      }
      if (pending.size && !applyFrame) applyFrame = requestAnimationFrame(flush);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  window.FishingbotI18n = Object.freeze({ load, setLanguage, apply, t, get language() { return language; } });
})();
