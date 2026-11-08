// Desktop language. The page keeps its English text in the markup; this module swaps the text
// of every element under a root for the chosen language, using the dictionary in i18n/desktop.json
// (keyed by the English text). Text with no translation stays English. The original English is kept,
// so switching back works. Dynamic text in scripts uses t(), which fills {name} placeholders.
(() => {
  'use strict';

  const ATTRIBUTES = ['placeholder', 'title', 'aria-label'];
  let dictionary = {};
  let language = 'en';

  function translation(text) {
    if (language === 'en' || !dictionary[language]) return null;
    const hit = dictionary[language][text];
    return typeof hit === 'string' ? hit : null;
  }

  // Translates one string, filling {name} placeholders from vars.
  function t(text, vars) {
    let out = translation(text) || text;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) out = out.split(`{${name}}`).join(String(value));
    }
    return out;
  }

  // Swaps the text of static markup under root for the current language.
  // options.fresh = true marks markup that is still English (the page at start, or a template just
  // added). Text the scripts create with t() is not marked, so it is never translated twice.
  function apply(root, options) {
    if (!root) return;
    const fresh = !!(options && options.fresh);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    for (const node of nodes) {
      if (node.parentElement && /^(SCRIPT|STYLE)$/.test(node.parentElement.tagName)) continue;
      if (node.fbSource === undefined && !fresh) continue;
      const source = node.fbSource !== undefined ? node.fbSource : node.nodeValue;
      const trimmed = source.trim();
      if (!trimmed) continue;
      node.fbSource = source;
      const tr = translation(trimmed);
      node.nodeValue = tr ? source.replace(trimmed, tr) : source;
    }
    const elements = root.querySelectorAll ? [root, ...root.querySelectorAll('*')] : [];
    for (const el of elements) {
      for (const name of ATTRIBUTES) {
        if (!el.hasAttribute(name)) continue;
        el.fbAttributes = el.fbAttributes || {};
        if (el.fbAttributes[name] === undefined) {
          if (!fresh) continue;
          el.fbAttributes[name] = el.getAttribute(name);
        }
        const source = el.fbAttributes[name];
        const tr = translation(source);
        el.setAttribute(name, tr || source);
      }
    }
  }

  function setLanguage(code) {
    language = dictionary[code] ? code : 'en';
    document.documentElement.lang = language;
  }

  // Loads the dictionary from the main process and applies the saved language.
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

  window.FishingbotI18n = Object.freeze({ load, setLanguage, apply, t, get language() { return language; } });
})();
