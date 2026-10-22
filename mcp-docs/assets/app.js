/* ══════════════════════════════════════════════════════════════
   MCP 网关 · 技术文档站交互脚本
   零依赖 · 纯 DOM · 可直接 file:// 打开
   职责：目录生成 / 全文搜索 / 明暗主题 / 滚动高亮 / 代码复制
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var THEME_KEY = 'mgw_docs_theme';
  var contentEl = $('#content');
  var tocEl = $('#toc');

  /* ══════════════════════════════════════════════════════════
     1. 主题：明 / 暗
     ══════════════════════════════════════════════════════════ */
  var Theme = (function () {
    function systemPref() {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    }

    function apply(mode) {
      document.documentElement.setAttribute('data-theme', mode);
      var btn = $('#themeToggle');
      if (btn) {
        btn.innerHTML = mode === 'dark' ? ICON.sun : ICON.moon;
        btn.setAttribute('title', mode === 'dark' ? '切换到亮色主题' : '切换到暗色主题');
        btn.setAttribute('aria-label', btn.getAttribute('title'));
      }
      var meta = $('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', mode === 'dark' ? '#08080a' : '#f2f2f4');
    }

    function current() {
      return document.documentElement.getAttribute('data-theme') || 'dark';
    }

    function init() {
      var saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* 隐私模式 */ }
      apply(saved === 'light' || saved === 'dark' ? saved : systemPref());

      var btn = $('#themeToggle');
      if (btn) {
        btn.addEventListener('click', function () {
          var next = current() === 'dark' ? 'light' : 'dark';
          apply(next);
          try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* noop */ }
        });
      }

      // 跟随系统（仅当用户未手动选择过）
      if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: light)');
        var onChange = function () {
          var s = null;
          try { s = localStorage.getItem(THEME_KEY); } catch (e) { /* noop */ }
          if (!s) apply(systemPref());
        };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
      }
    }

    return { init: init, apply: apply, current: current };
  })();

  /* ══════════════════════════════════════════════════════════
     2. 图标（内联 SVG，避免外部请求）
     ══════════════════════════════════════════════════════════ */
  var ICON = {
    sun:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
      '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.2M12 19.4v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.4 12h2.2M19.4 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/></svg>',
    moon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/></svg>',
    search:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
      '<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.7 15.7L21 21"/></svg>',
    menu:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
      '<path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    close:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
      '<path d="M6 6l12 12M18 6L6 18"/></svg>',
    up:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>',
    copy:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5.5 15H4.8A1.8 1.8 0 0 1 3 13.2V4.8A1.8 1.8 0 0 1 4.8 3h8.4A1.8 1.8 0 0 1 15 4.8v.7"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4.5 12.5l5 5 10-11"/></svg>',
  };

  /* ══════════════════════════════════════════════════════════
     3. 文档模型：扫描 DOM 建立章节 / 小节索引
     ══════════════════════════════════════════════════════════ */
  var DOC = { chapters: [], sections: [] };

  /** 从标题文本生成稳定 slug（保留中文，去掉标点） */
  function slug(text) {
    return String(text)
      .trim()
      .toLowerCase()
      .replace(/[`~!@#$%^&*()+=\[\]{}\\|;:'",.<>/?！，。、；：？「」『』【】（）]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60);
  }

  /** 提取节点直到下一个同级标题之间的纯文本 */
  function collectText(startEl, stopTags) {
    var buf = [];
    var el = startEl.nextElementSibling;
    while (el) {
      var tag = el.tagName;
      if (stopTags.indexOf(tag) !== -1) break;
      buf.push(el.textContent || '');
      el = el.nextElementSibling;
    }
    return buf.join('\n').replace(/\s+/g, ' ').trim();
  }

  function buildModel() {
    var chapters = $$('.chapter', contentEl);
    var usedIds = {};

    chapters.forEach(function (sec, i) {
      var h2 = $('h2', sec);
      if (!h2) return;

      var cid = sec.id || slug(h2.textContent);
      if (usedIds[cid]) cid = cid + '-' + i;
      usedIds[cid] = true;
      sec.id = cid;
      if (!h2.id) h2.id = cid;
      sec.setAttribute('data-idx', String(i + 1).padStart(2, '0'));

      var lede = $('.chapter-lede', sec);
      var idxEl = $('.chapter-idx', sec);
      if (idxEl) idxEl.textContent = String(i + 1).padStart(2, '0');

      var entry = {
        id: cid,
        num: String(i + 1).padStart(2, '0'),
        title: h2.textContent.trim(),
        lede: lede ? lede.textContent.trim() : '',
        el: sec,
        subs: [],
      };

      // 小节：h3
      var h3s = $$('h3', sec);
      h3s.forEach(function (h3, j) {
        var sid = h3.id;
        if (!sid) {
          sid = cid + '--' + slug(h3.textContent) || cid + '--s' + j;
          if (usedIds[sid]) sid = sid + '-' + j;
          h3.id = sid;
        }
        usedIds[sid] = true;

        var sub = {
          id: sid,
          chapterId: cid,
          chapterTitle: entry.title,
          chapterNum: entry.num,
          title: h3.textContent.trim(),
          text: collectText(h3, ['H3', 'H2']),
          el: h3,
        };
        entry.subs.push(sub);
        DOC.sections.push(sub);
      });

      // 章节级正文 = lede + 章节头之后到第一个 h3 之前的内容（避免与小节重复）
      var firstH3 = h3s[0];
      var head = $('.chapter-head', sec);
      var headText = '';
      if (firstH3) {
        var probe = (head || lede || h2).nextElementSibling;
        while (probe && probe !== firstH3) {
          headText += ' ' + (probe.textContent || '');
          probe = probe.nextElementSibling;
        }
      } else {
        headText = head ? (head.textContent || '') : collectText(lede || h2, ['H2']);
      }
      entry.text = (entry.lede + ' ' + headText).replace(/\s+/g, ' ').trim();

      DOC.chapters.push(entry);
    });
  }

  /* ══════════════════════════════════════════════════════════
     4. 侧栏目录
     ══════════════════════════════════════════════════════════ */
  function buildToc() {
    var frag = document.createDocumentFragment();

    DOC.chapters.forEach(function (ch) {
      var group = document.createElement('div');
      group.className = 'toc-group';
      group.setAttribute('data-chapter', ch.id);

      var btn = document.createElement('button');
      btn.className = 'toc-chapter';
      btn.type = 'button';
      btn.setAttribute('data-target', ch.id);
      btn.innerHTML =
        '<span class="toc-num">' + ch.num + '</span><span class="toc-label"></span>';
      $('.toc-label', btn).textContent = ch.title;

      btn.addEventListener('click', function () {
        goTo(ch.id);
        closeSidebarOnMobile();
      });
      group.appendChild(btn);

      if (ch.subs.length) {
        var subs = document.createElement('div');
        subs.className = 'toc-subs';
        ch.subs.forEach(function (s) {
          var a = document.createElement('button');
          a.className = 'toc-sub';
          a.type = 'button';
          a.setAttribute('data-target', s.id);
          a.textContent = s.title;
          a.addEventListener('click', function (e) {
            e.stopPropagation();
            goTo(s.id);
            closeSidebarOnMobile();
          });
          subs.appendChild(a);
        });
        group.appendChild(subs);
      }

      frag.appendChild(group);
    });

    tocEl.appendChild(frag);

    var empty = document.createElement('div');
    empty.className = 'toc-empty';
    empty.textContent = '没有匹配的章节';
    empty.hidden = true;
    tocEl.appendChild(empty);
  }

  function goTo(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // 更新 hash（不触发跳转）
    if (history.replaceState) history.replaceState(null, '', '#' + id);
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  /* ══════════════════════════════════════════════════════════
     5. 滚动高亮（scroll-spy）
     ══════════════════════════════════════════════════════════ */
  var Spy = (function () {
    var ticking = false;

    function update() {
      ticking = false;
      // 用视口坐标而非 offsetTop：.content 是滚动容器，但 offsetParent 是 .shell
      var origin = contentEl.getBoundingClientRect().top + 96;
      var activeChapter = null;
      var activeSub = null;

      for (var i = 0; i < DOC.chapters.length; i++) {
        var ch = DOC.chapters[i];
        if (ch.el.getBoundingClientRect().top <= origin) activeChapter = ch;
      }
      if (!activeChapter && DOC.chapters.length) activeChapter = DOC.chapters[0];

      if (activeChapter) {
        for (var j = 0; j < activeChapter.subs.length; j++) {
          if (activeChapter.subs[j].el.getBoundingClientRect().top <= origin) activeSub = activeChapter.subs[j];
        }
      }

      $$('.toc-chapter', tocEl).forEach(function (b) {
        b.classList.toggle('is-active', !!activeChapter && b.getAttribute('data-target') === activeChapter.id);
      });
      $$('.toc-group', tocEl).forEach(function (g) {
        g.classList.toggle('is-open', !!activeChapter && g.getAttribute('data-chapter') === activeChapter.id);
      });
      $$('.toc-sub', tocEl).forEach(function (b) {
        b.classList.toggle('is-active', !!activeSub && b.getAttribute('data-target') === activeSub.id);
      });

      // 保持当前章节在侧栏可见
      var activeBtn = $('.toc-chapter.is-active', tocEl);
      if (activeBtn) {
        var r = activeBtn.getBoundingClientRect();
        var pr = tocEl.getBoundingClientRect();
        if (r.top < pr.top + 20 || r.bottom > pr.bottom - 20) {
          activeBtn.scrollIntoView({ block: 'nearest' });
        }
      }

      // 进度条 + 返回顶部
      var max = contentEl.scrollHeight - contentEl.clientHeight;
      var pct = max > 0 ? (contentEl.scrollTop / max) * 100 : 0;
      var prog = $('#progress');
      if (prog) prog.style.width = pct.toFixed(2) + '%';
      var tt = $('#toTop');
      if (tt) tt.classList.toggle('is-show', contentEl.scrollTop > 480);
    }

    function init() {
      contentEl.addEventListener('scroll', function () {
        if (!ticking) {
          ticking = true;
          window.requestAnimationFrame(update);
        }
      }, { passive: true });
      window.addEventListener('resize', update);
      update();
    }

    return { init: init, update: update };
  })();

  /* ══════════════════════════════════════════════════════════
     6. 全文搜索
        索引：章节标题 + 章节导语/头部正文 + 每个 h3 小节正文
        评分：标题命中权重最高，其次关键词，最后正文
     ══════════════════════════════════════════════════════════ */
  var Search = (function () {
    var modal = $('#searchModal');
    var input = $('#searchInput');
    var results = $('#searchResults');
    var countEl = $('#searchCount');
    var items = [];
    var sel = -1;
    var lastQuery = '';

    function norm(s) { return String(s || '').toLowerCase(); }

    function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function escHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function highlight(text, terms) {
      if (!terms.length) return escHtml(text);
      var re = new RegExp('(' + terms.map(escRe).join('|') + ')', 'gi');
      return escHtml(text).replace(re, '<mark>$1</mark>');
    }

    function snippet(text, terms, radius) {
      radius = radius || 62;
      var lower = norm(text);
      var pos = -1;
      for (var i = 0; i < terms.length; i++) {
        var p = lower.indexOf(terms[i]);
        if (p !== -1 && (pos === -1 || p < pos)) pos = p;
      }
      if (pos === -1) return text.slice(0, radius * 2);
      var start = Math.max(0, pos - radius);
      var end = Math.min(text.length, pos + radius);
      return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    }

    /** 分词：英文按空格/标点切，中文整体保留 + 二元切分兜底 */
    function tokenize(q) {
      var raw = norm(q).split(/[\s,;，；、|]+/).filter(Boolean);
      var out = [];
      raw.forEach(function (t) {
        if (out.indexOf(t) === -1) out.push(t);
      });
      return out;
    }

    function score(entry, terms) {
      var s = 0;
      var title = norm(entry.title);
      var kw = norm(entry.keywords || '');
      var body = norm(entry.text || '');
      var crumb = norm(entry.chapterTitle || '');

      terms.forEach(function (t) {
        var hit = false;
        if (title === t) { s += 240; hit = true; }
        else if (title.indexOf(t) === 0) { s += 160; hit = true; }
        else if (title.indexOf(t) !== -1) { s += 110; hit = true; }

        if (kw.indexOf(t) !== -1) { s += 70; hit = true; }
        if (crumb.indexOf(t) !== -1) { s += 26; hit = true; }

        var c = 0, idx = body.indexOf(t);
        while (idx !== -1 && c < 12) { c++; idx = body.indexOf(t, idx + t.length); }
        if (c > 0) { s += Math.min(c, 8) * 7; hit = true; }

        if (!hit) s -= 500; // 必须所有词都命中
      });

      // 章节级条目略微优先（信息密度高）
      if (entry.kind === 'chapter') s += 12;
      return s;
    }

    function buildEntries() {
      var list = [];
      DOC.chapters.forEach(function (ch) {
        list.push({
          kind: 'chapter',
          id: ch.id,
          num: ch.num,
          title: ch.title,
          chapterTitle: '',
          text: ch.text + ' ' + ch.subs.map(function (s) { return s.title; }).join(' '),
          keywords: ch.el.getAttribute('data-keywords') || '',
        });
        ch.subs.forEach(function (s) {
          list.push({
            kind: 'section',
            id: s.id,
            num: s.chapterNum,
            title: s.title,
            chapterTitle: s.chapterTitle,
            text: s.text,
            keywords: s.el.getAttribute('data-keywords') || '',
          });
        });
      });
      return list;
    }

    var ENTRIES = [];

    function run(q) {
      q = String(q || '').trim();
      if (q === lastQuery && results.childElementCount) return;
      lastQuery = q;
      items = [];
      sel = -1;
      results.innerHTML = '';

      if (!q) {
        renderEmpty('输入关键词开始检索', '覆盖 ' + ENTRIES.length + ' 个章节与小节 · 支持中英文、代码符号、API 路径');
        if (countEl) countEl.textContent = ENTRIES.length + ' 条索引';
        return;
      }

      var terms = tokenize(q);
      if (!terms.length) return;

      var hits = [];
      ENTRIES.forEach(function (e) {
        var s = score(e, terms);
        if (s > 0) hits.push({ e: e, s: s });
      });
      hits.sort(function (a, b) { return b.s - a.s; });
      hits = hits.slice(0, 40);

      if (!hits.length) {
        renderEmpty('没有找到 “' + q + '”', '试试更短的关键词，如「熔断」「RBAC」「审计」「限流」「备份」');
        if (countEl) countEl.textContent = '0 条结果';
        return;
      }

      var lastGroup = null;
      hits.forEach(function (h) {
        var groupName = h.e.kind === 'chapter' ? '章节' : '小节';
        if (groupName !== lastGroup) {
          var g = document.createElement('div');
          g.className = 'sr-group';
          g.textContent = groupName;
          results.appendChild(g);
          lastGroup = groupName;
        }

        var btn = document.createElement('button');
        btn.className = 'sr-item';
        btn.type = 'button';
        btn.setAttribute('data-id', h.e.id);

        var crumb = h.e.kind === 'chapter'
          ? '<span class="sr-num">' + h.e.num + '</span><span>章节</span>'
          : '<span class="sr-num">' + h.e.num + '</span><span>' + escHtml(h.e.chapterTitle) + '</span><span>›</span><span>小节</span>';

        var body = h.e.text || h.e.lede || '';
        btn.innerHTML =
          '<span class="sr-crumb">' + crumb + '</span>' +
          '<span class="sr-title">' + highlight(h.e.title, terms) + '</span>' +
          (body ? '<span class="sr-snip">' + highlight(snippet(body, terms), terms) + '</span>' : '');

        btn.addEventListener('click', function () {
          close();
          goTo(h.e.id);
        });
        btn.addEventListener('mouseenter', function () { select(items.indexOf(btn)); });

        results.appendChild(btn);
        items.push(btn);
      });

      if (countEl) countEl.textContent = hits.length + ' 条结果';
      select(0);
    }

    function renderEmpty(title, hint) {
      results.innerHTML =
        '<div class="sr-empty"><strong>' + escHtml(title) + '</strong>' + escHtml(hint) + '</div>';
      items = [];
      sel = -1;
    }

    function select(i) {
      if (!items.length) return;
      if (i < 0) i = 0;
      if (i >= items.length) i = items.length - 1;
      items.forEach(function (b, k) { b.classList.toggle('is-sel', k === i); });
      sel = i;
      var el = items[i];
      var r = el.getBoundingClientRect();
      var pr = results.getBoundingClientRect();
      if (r.top < pr.top) results.scrollTop -= (pr.top - r.top) + 8;
      else if (r.bottom > pr.bottom) results.scrollTop += (r.bottom - pr.bottom) + 8;
    }

    function open() {
      modal.hidden = false;
      document.body.style.overflow = 'hidden';
      input.value = '';
      lastQuery = '';
      run('');
      setTimeout(function () { input.focus(); }, 30);
    }

    function close() {
      modal.hidden = true;
      document.body.style.overflow = '';
      input.value = '';
      lastQuery = '';
    }

    function init() {
      ENTRIES = buildEntries();
      var total = $('#searchTotal');
      if (total) total.textContent = ENTRIES.length;

      $('#searchTrigger').addEventListener('click', open);
      $('.search-mask', modal).addEventListener('click', close);
      $('#searchClose').addEventListener('click', close);

      input.addEventListener('input', function () { run(input.value); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); select(sel + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); select(sel - 1); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          var btn = items[sel] || items[0];
          if (btn) { close(); goTo(btn.getAttribute('data-id')); }
        } else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });

      document.addEventListener('keydown', function (e) {
        var isK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
        var isSlash = e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
        if (isK || isSlash) {
          e.preventDefault();
          if (modal.hidden) open(); else input.focus();
        } else if (e.key === 'Escape' && !modal.hidden) {
          close();
        }
      });

      if (countEl) countEl.textContent = ENTRIES.length + ' 条索引';
    }

    return { init: init, open: open, close: close };
  })();

  /* ══════════════════════════════════════════════════════════
     7. 代码块：语言标签 + 复制按钮
     ══════════════════════════════════════════════════════════ */
  function enhanceCode() {
    $$('pre', contentEl).forEach(function (pre) {
      // 内容里已手写了 .code-wrap 容器；裸 pre 则自动包一层
      var wrap = pre.parentElement.classList.contains('code-wrap')
        ? pre.parentElement
        : (function () {
            var w = document.createElement('div');
            w.className = 'code-wrap';
            pre.parentNode.insertBefore(w, pre);
            w.appendChild(pre);
            return w;
          })();
      if (wrap.childElementCount > 1) return;   // 已增强过

      var lang = pre.getAttribute('data-lang');
      if (lang) {
        var tag = document.createElement('span');
        tag.className = 'code-lang';
        tag.textContent = lang;
        wrap.appendChild(tag);
      }

      var btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.type = 'button';
      btn.title = '复制代码';
      btn.setAttribute('aria-label', '复制代码');
      btn.innerHTML = ICON.copy;
      btn.addEventListener('click', function () {
        var text = pre.textContent || '';
        var done = function () {
          btn.innerHTML = ICON.check;
          btn.classList.add('is-done');
          setTimeout(function () {
            btn.innerHTML = ICON.copy;
            btn.classList.remove('is-done');
          }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
        } else {
          fallback(text, done);
        }
      });
      wrap.appendChild(btn);
    });
  }

  function fallback(text, cb) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); cb(); } catch (e) { /* noop */ }
    document.body.removeChild(ta);
  }

  /* ══════════════════════════════════════════════════════════
     8. 侧栏抽屉（移动端）
     ══════════════════════════════════════════════════════════ */
  function initSidebar() {
    var sb = $('#sidebar');
    var mask = $('#sideMask');
    var toggle = $('#navToggle');
    toggle.innerHTML = ICON.menu;

    toggle.addEventListener('click', function () {
      var open = sb.classList.toggle('is-open');
      mask.classList.toggle('is-open', open);
      toggle.innerHTML = open ? ICON.close : ICON.menu;
    });
    mask.addEventListener('click', function () {
      sb.classList.remove('is-open');
      mask.classList.remove('is-open');
      toggle.innerHTML = ICON.menu;
    });
  }

  function closeSidebarOnMobile() {
    if (window.innerWidth > 900) return;
    var sb = $('#sidebar');
    sb.classList.remove('is-open');
    $('#sideMask').classList.remove('is-open');
    $('#navToggle').innerHTML = ICON.menu;
  }

  /* ══════════════════════════════════════════════════════════
     9. 目录过滤
     ══════════════════════════════════════════════════════════ */
  function initTocFilter() {
    var inp = $('#tocFilter');
    var empty = $('.toc-empty', tocEl);

    inp.addEventListener('input', function () {
      var q = inp.value.trim().toLowerCase();
      var visible = 0;

      $$('.toc-group', tocEl).forEach(function (g) {
        var chap = $('.toc-chapter', g);
        var label = $('.toc-label', chap).textContent.toLowerCase();
        var subs = $$('.toc-sub', g);
        var subHit = 0;

        subs.forEach(function (s) {
          var ok = !q || s.textContent.toLowerCase().indexOf(q) !== -1 || label.indexOf(q) !== -1;
          s.hidden = !ok;
          if (ok && q) subHit++;
        });

        var groupOk = !q || label.indexOf(q) !== -1 || subHit > 0;
        g.hidden = !groupOk;
        if (groupOk) visible++;
        // 过滤时自动展开全部命中组
        g.classList.toggle('is-open', !!q && groupOk);
      });

      if (empty) empty.hidden = visible !== 0;
    });
  }

  /* ══════════════════════════════════════════════════════════
     10. 其它交互
     ══════════════════════════════════════════════════════════ */
  function initMisc() {
    $('#toTop').innerHTML = ICON.up;
    $('#toTop').addEventListener('click', function () {
      contentEl.scrollTo({ top: 0, behavior: 'smooth' });
    });

    $('#searchIcon').innerHTML = ICON.search;
    var smi = $('#searchModalIcon');
    if (smi) smi.innerHTML = ICON.search;
    var sc = $('#searchClose');
    if (sc) sc.innerHTML = ICON.close;
    var bt2 = $('#buildTime2');
    if (bt2 && window.DOCS_META && window.DOCS_META.builtAt) bt2.textContent = window.DOCS_META.builtAt;

    // 正文内的锚点链接（#id）走平滑滚动
    contentEl.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (!a) return;
      var id = a.getAttribute('href').slice(1);
      if (!id || !document.getElementById(id)) return;
      e.preventDefault();
      goTo(id);
    });

    // 顶部品牌回首页
    var brand = $('.brand');
    if (brand) {
      brand.addEventListener('click', function (e) {
        e.preventDefault();
        contentEl.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    // 渲染统计
    var st = $('#statChapters');
    if (st) st.textContent = DOC.chapters.length;
    var st2 = $('#statSections');
    if (st2) st2.textContent = DOC.sections.length;
    var st3 = $('#statWords');
    if (st3) {
      var n = (contentEl.textContent || '').replace(/\s+/g, '').length;
      st3.textContent = n > 10000 ? (n / 10000).toFixed(1) + 'w' : n;
    }
  }

  /* ══════════════════════════════════════════════════════════
     11. 联系作者弹窗（二维码）
     ══════════════════════════════════════════════════════════ */
  var Contact = (function () {
    var modal = null;
    var img = null;
    var loaded = false;
    var lastFocus = null;

    /** 二维码走外链，首次打开弹窗时才拉，避免白耗流量 */
    function loadQr() {
      if (loaded || !img) return;
      loaded = true;
      var url = img.getAttribute('data-src') || '';
      if (!url) return;
      img.addEventListener('error', function () { fallback(url); });
      img.setAttribute('src', url);
      // 命中缓存的失败图可能不再触发 error，这里补一道检查
      if (img.complete && img.naturalWidth === 0) fallback(url);
    }

    /** 图拉不到时降级为可点的直链，不让弹窗变成一块空白 */
    function fallback(url) {
      var frame = $('#qrFrame');
      if (!frame || frame.getAttribute('data-fb') === '1') return;
      frame.setAttribute('data-fb', '1');
      frame.innerHTML =
        '<div class="qr-fallback">' +
        '<span>二维码图片暂时无法加载，可点下方链接查看：</span>' +
        '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>' +
        '</div>';
    }

    function open() {
      if (!modal) return;
      lastFocus = document.activeElement;
      modal.hidden = false;
      loadQr();
      var btn = $('#contactClose');
      if (btn) setTimeout(function () { btn.focus(); }, 30);
    }

    function close() {
      if (!modal || modal.hidden) return;
      modal.hidden = true;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    /** 弹窗内可聚焦元素不多，Tab 循环锁在内部 */
    function trapTab(e) {
      var f = $$('a[href], button:not([disabled])', modal);
      if (!f.length) return;
      var first = f[0];
      var last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function init() {
      modal = $('#contactModal');
      img = $('#qrImg');
      if (!modal) return;

      var fab = $('#contactFab');
      if (fab) fab.addEventListener('click', open);
      var cl = $('#contactClose');
      if (cl) cl.addEventListener('click', close);
      var mask = $('.modal-mask', modal);
      if (mask) mask.addEventListener('click', close);

      document.addEventListener('keydown', function (e) {
        if (modal.hidden) return;
        if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); close(); }
        else if (e.key === 'Tab') { trapTab(e); }
      });
    }

    return { init: init, open: open, close: close };
  })();

  /* ══════════════════════════════════════════════════════════
     12. 启动
     ══════════════════════════════════════════════════════════ */
  function boot() {
    Theme.init();
    buildModel();
    buildToc();
    enhanceCode();
    initSidebar();
    initTocFilter();
    Search.init();
    Spy.init();
    initMisc();
    Contact.init();

    // 首屏定位到 hash
    var h = (location.hash || '').replace('#', '');
    if (h && document.getElementById(h)) {
      setTimeout(function () { goTo(h); }, 60);
    }
    window.addEventListener('hashchange', function () {
      var id = (location.hash || '').replace('#', '');
      if (id && document.getElementById(id)) goTo(id);
    });

    // 构建时间
    var bt = $('#buildTime');
    if (bt && window.DOCS_META && window.DOCS_META.builtAt) bt.textContent = window.DOCS_META.builtAt;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
