// A shared folder's public page: reads /s/<id> from the address, asks the Tabfold server for the
// folder, and shows its name, its pages and what people can do with them. Everything shown comes
// from someone else's tabs, so it is only ever set as text, and only http(s) links are made.
(function () {
  'use strict';

  var config = window.TABFOLD_CONFIG || {};
  var COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  var ID = /^[A-Za-z0-9]{10}$/;
  var SVG = 'http://www.w3.org/2000/svg';
  var EXTERNAL = ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'];

  var $ = function (id) {
    return document.getElementById(id);
  };

  var share = null;

  /** The folder's id: /s/<id>, or ?id=<id> (for trying the page out). */
  function shareId() {
    var match = /\/s\/([^/?#]+)\/?$/.exec(window.location.pathname);
    var id = match ? match[1] : new URLSearchParams(window.location.search).get('id') || '';
    return ID.test(id) ? id : null;
  }

  function show(which) {
    ['loading', 'share', 'gone', 'error'].forEach(function (id) {
      $(id).hidden = id !== which;
    });
  }

  function setStatus(text) {
    $('status').textContent = text;
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /** An http(s) address, or null for anything else. */
  function safeUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      var url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch (error) {
      return null;
    }
  }

  function hostOf(url) {
    return new URL(url).hostname.replace(/^www\./, '');
  }

  /** "today", "yesterday", "3 days ago", "on 2 October". */
  function updated(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var then = new Date(ms);
    var now = new Date();
    var day = function (d) {
      return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    };
    var days = Math.round((day(now) - day(then)) / 86400000);
    if (days <= 0) return 'updated today';
    if (days === 1) return 'updated yesterday';
    if (days < 7) return 'updated ' + days + ' days ago';
    var options = { day: 'numeric', month: 'long' };
    if (then.getFullYear() !== now.getFullYear()) options.year = 'numeric';
    return 'updated on ' + then.toLocaleDateString(undefined, options);
  }

  /** A site's letter, in a colour that stays the same for the site. */
  function tile(host) {
    var span = document.createElement('span');
    var hash = 0;
    for (var i = 0; i < host.length; i++) hash = (hash * 31 + host.charCodeAt(i)) >>> 0;
    span.className = 'tile cg-' + COLORS[hash % COLORS.length];
    span.setAttribute('aria-hidden', 'true');
    var letter = (host.match(/[a-z0-9]/i) || ['?'])[0];
    span.textContent = letter.toUpperCase();
    return span;
  }

  function icon(paths, size) {
    var svg = document.createElementNS(SVG, 'svg');
    var attrs = {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.75',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    };
    Object.keys(attrs).forEach(function (name) {
      svg.setAttribute(name, String(attrs[name]));
    });
    paths.forEach(function (d) {
      var path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  /** A folder's note: one line, at most 140 characters (the server already sends it so). */
  function readNote(value) {
    if (typeof value !== 'string') return '';
    return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, 140).join('').trim();
  }

  /** The server's answer, checked: a name, a known colour, pages with http(s) addresses, and the note. */
  function readShare(json) {
    if (!json || typeof json !== 'object' || typeof json.name !== 'string' || !Array.isArray(json.tabs)) return null;
    var tabs = [];
    json.tabs.forEach(function (tab) {
      var url = tab && safeUrl(tab.url);
      if (!url) return;
      var host = hostOf(url);
      var title = typeof tab.title === 'string' && tab.title.trim() ? tab.title.trim() : host || url;
      tabs.push({ url: url, host: host, title: title });
    });
    return {
      name: json.name.trim() || 'A shared folder',
      color: COLORS.indexOf(json.color) >= 0 ? json.color : 'grey',
      tabs: tabs,
      updatedAt: json.updatedAt,
      note: readNote(json.note),
    };
  }

  function render() {
    document.title = share.name + ' · Tabfold';
    $('name').textContent = share.name;
    // Under the name, only when the folder has one. Text only, like everything else here.
    $('note').textContent = share.note;
    $('note').hidden = !share.note;
    $('folder-icon').className = 'folder-icon cg-' + share.color;
    var count = share.tabs.length;
    $('meta').textContent = [plural(count, 'page', 'pages'), updated(share.updatedAt)].filter(Boolean).join(' · ');
    $('open-all').textContent = count === 1 ? 'Open the page' : 'Open all ' + count;
    $('actions').hidden = count === 0;
    $('empty').hidden = count > 0;

    var list = $('list');
    list.textContent = '';
    share.tabs.forEach(function (tab) {
      var item = document.createElement('li');
      var link = document.createElement('a');
      link.className = 'row';
      link.href = tab.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = tab.url;
      var text = document.createElement('span');
      text.className = 'text';
      var title = document.createElement('span');
      title.className = 'page-title';
      title.textContent = tab.title;
      var host = document.createElement('span');
      host.className = 'host';
      host.textContent = tab.host;
      text.appendChild(title);
      text.appendChild(host);
      var external = icon(EXTERNAL, 14);
      external.setAttribute('class', 'external');
      link.appendChild(tile(tab.host));
      link.appendChild(text);
      link.appendChild(external);
      item.appendChild(link);
      list.appendChild(item);
    });
    show('share');
  }

  function fail(title, text) {
    $('error-title').textContent = title;
    $('error-text').textContent = text;
    show('error');
  }

  function load() {
    var id = shareId();
    if (!id) {
      show('gone');
      return;
    }
    var api = String(config.API_URL || '').replace(/\/+$/, '');
    if (!api) {
      fail('This page isn’t set up yet', 'The site’s config.js has no API_URL.');
      return;
    }
    show('loading');
    fetch(api + '/public/shares/' + id, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
      .then(function (response) {
        if (response.status === 404) return show('gone');
        if (response.status === 429) return fail('Too many visits just now', 'Try again in a minute.');
        if (!response.ok) return fail('Couldn’t load this folder', 'Tabfold’s server is having trouble. Try again in a minute.');
        return response.json().then(function (json) {
          share = readShare(json);
          if (share) render();
          else fail('Couldn’t load this folder', 'Tabfold’s server sent something unexpected. Try again in a minute.');
        });
      })
      .catch(function () {
        fail('Couldn’t load this folder', 'Check your connection and try again.');
      });
  }

  /**
   * Opens every page in a new tab. Browsers let a click open one tab and usually block the rest,
   * so this opens the first and says how to get the others.
   */
  function openAll() {
    var opened = 0;
    var blocked = 0;
    share.tabs.forEach(function (tab) {
      var opener = window.open(tab.url, '_blank');
      if (!opener) {
        blocked += 1;
        return;
      }
      try {
        opener.opener = null;
      } catch (error) {
        // Another site's window: nothing to do.
      }
      opened += 1;
    });
    if (blocked === 0) setStatus(opened === 1 ? 'Opened the page.' : 'Opened ' + opened + ' pages.');
    else if (opened > 0) {
      setStatus(
        'Your browser opened the first page and blocked the other ' +
          plural(blocked, 'one', 'pages') +
          '. To open them all at once, allow pop-ups for this site and try again, or open them one by one below.',
      );
    } else setStatus('Your browser blocked the new tabs. Allow pop-ups for this site and try again, or open the pages one by one below.');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return copyBySelecting(text);
      });
    }
    return copyBySelecting(text);
  }

  function copyBySelecting(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'offscreen';
    document.body.appendChild(area);
    area.select();
    var done = false;
    try {
      done = document.execCommand('copy');
    } catch (error) {
      done = false;
    }
    document.body.removeChild(area);
    return done ? Promise.resolve() : Promise.reject(new Error('copy'));
  }

  function copyLinks() {
    var links = share.tabs.map(function (tab) {
      return tab.url;
    });
    copyText(links.join('\n')).then(
      function () {
        setStatus(links.length === 1 ? 'Copied the link.' : 'Copied ' + links.length + ' links.');
      },
      function () {
        setStatus('Couldn’t copy the links. Open the pages below and copy them from there.');
      },
    );
  }

  function storeUrl() {
    return safeUrl(config.STORE_URL) || 'https://chromewebstore.google.com/';
  }

  /** Tabfold isn't there (or is too old to answer): its store page, in a new tab. */
  function openStore() {
    if (!window.open(storeUrl(), '_blank', 'noopener')) setStatus('Get Tabfold from the Chrome Web Store first, then save this folder.');
  }

  /**
   * "Save to my Tabfold": asks Tabfold to add this folder, when it is installed and lets this site
   * talk to it; otherwise the link goes to the Chrome Web Store.
   */
  function save(event) {
    var runtime = window.chrome && window.chrome.runtime;
    var extension = String(config.EXTENSION_ID || '');
    if (!/^[a-p]{32}$/.test(extension) || !runtime || typeof runtime.sendMessage !== 'function') return;
    event.preventDefault();
    var id = shareId();
    try {
      runtime.sendMessage(extension, { type: 'tabfold-save-share', id: id }, function (response) {
        if (runtime.lastError || !response) {
          openStore();
          return;
        }
        if (response.ok) setStatus('Saved to your Tabfold.');
        else setStatus(typeof response.message === 'string' && response.message ? response.message : 'Tabfold couldn’t save this folder. Try again.');
      });
    } catch (error) {
      openStore();
    }
  }

  function start() {
    var links = document.querySelectorAll('[data-store-link]');
    for (var i = 0; i < links.length; i++) {
      links[i].href = storeUrl();
      links[i].target = '_blank';
      links[i].rel = 'noopener noreferrer';
    }
    $('open-all').addEventListener('click', openAll);
    $('copy').addEventListener('click', copyLinks);
    $('save').addEventListener('click', save);
    $('retry').addEventListener('click', load);
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
