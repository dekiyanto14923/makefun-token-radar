// Token Radar dashboard — radar-2 model, no framework, no network.
// Reads window.RADAR (written by main.ts from the sealed snapshot) and renders
// the ranked board, a detail view for every protocol, the live-token view and
// the model's own method. State lives in the URL hash, so a view can be linked:
//   #/detail/<slug>   one protocol's detail view
//   #/filter/<category>  the board filtered to one category
//   #/live            the live-token view
//   #/method          how the implied value is computed
(function () {
  'use strict';
  var DATA = window.RADAR;
  var state = { q: '', category: 'all', chain: 'all', minTvl: 0, sort: 'implied', dir: -1, tab: 'pre-token', selected: null };

  function $(id) { return document.getElementById(id); }

  /** Escape text for HTML. */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Compact dollars: $2.75B, $45.6M, $789K, $512. */
  function fmtUsd(n) {
    if (n == null || !isFinite(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return '$' + Math.round(n);
  }

  /** A per-cent change with its sign, or an em dash when unknown. */
  function fmtPct(n) {
    if (n == null || !isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  /** An age in days as years and days, or an em dash when unknown. */
  function fmtAge(days) {
    if (days == null) return '—';
    if (days < 365) return days + 'd';
    var y = Math.floor(days / 365);
    var d = days % 365;
    return y + 'y ' + d + 'd';
  }

  /** A multiple with two decimals. */
  function fmtMult(n) { return (n == null || !isFinite(n)) ? '—' : n.toFixed(2) + '×'; }

  /** Append children, flattening nested arrays (a child may itself be a list). */
  function appendKids(node, kids) {
    if (kids == null) return;
    if (!Array.isArray(kids)) kids = [kids];
    kids.forEach(function (c) {
      if (c == null) return;
      if (Array.isArray(c)) appendKids(node, c);
      else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
  }

  /** A small DOM builder: el('div', {class:'x', onclick: fn}, [children]). */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null) return;
        if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      });
    }
    appendKids(node, children);
    return node;
  }

  /** Read the view out of location.hash. */
  function readHash() {
    var hash = window.location.hash.replace(/^#\/?/, '');
    if (!hash) return;
    var parts = hash.split('/');
    if (parts[0] === 'detail' && parts[1]) { state.selected = decodeURIComponent(parts[1]); state.tab = 'pre-token'; }
    else if (parts[0] === 'filter' && parts[1]) { state.category = decodeURIComponent(parts[1]); state.tab = 'pre-token'; state.selected = null; }
    else if (parts[0] === 'live') { state.tab = 'live'; state.selected = null; }
    else if (parts[0] === 'method') { state.tab = 'method'; state.selected = null; }
  }

  /** Write the view back into location.hash. */
  function writeHash() {
    var hash = '';
    if (state.selected) hash = '#/detail/' + encodeURIComponent(state.selected);
    else if (state.category !== 'all') hash = '#/filter/' + encodeURIComponent(state.category);
    else if (state.tab === 'live') hash = '#/live';
    else if (state.tab === 'method') hash = '#/method';
    if (hash) window.history.replaceState(null, '', hash);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  /** The board's rows after the search, category, chain and TVL filters. */
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) === -1) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  /** Sort a list by the current sort key and direction, ties broken by slug. */
  function sortedRows(list) {
    var key = state.sort;
    var dir = state.dir;
    function val(r) {
      if (key === 'implied') return r.implied_value_usd;
      if (key === 'tvl') return r.tvl_usd;
      if (key === 'growth') return r.change_7d == null ? -9999 : r.change_7d;
      if (key === 'age') return r.age_days == null ? -1 : r.age_days;
      if (key === 'multiple') return r.category_multiple;
      if (key === 'name') return r.name.toLowerCase();
      return r.rank;
    }
    return list.slice().sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  /** The live-token rows after the search and category filters. */
  function filteredLive() {
    var q = state.q.trim().toLowerCase();
    return DATA.live.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) === -1) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  /** The distinct categories on the board, sorted. */
  function categories() {
    return Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
  }

  /** The distinct chains on the board, sorted by how many rows name them. */
  function chains() {
    var counts = {};
    DATA.rows.forEach(function (r) { r.chains.forEach(function (c) { counts[c] = (counts[c] || 0) + 1; }); });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
  }

  /* ------------------------------------------------------------ the page top */

  function header() {
    return el('header', { class: 'top' }, [
      el('div', { class: 'brand' }, [
        el('span', { class: 'mark', 'aria-hidden': 'true' }),
        el('div', null, [
          el('h1', { text: 'Token Radar' }),
          el('div', { class: 'brand-name', text: 'Pre-token protocols, ranked by implied value · model ' + DATA.model_version }),
        ]),
      ]),
      el('div', { class: 'top-meta' }, [
        el('span', null, ['Snapshot ', el('b', { text: DATA.as_of })]),
        el('span', null, ['Watchlist floor ', el('b', { class: 'num', text: fmtUsd(DATA.floor_usd) })]),
        el('span', null, [el('b', { text: String(DATA.board_size) }), ' rows']),
      ]),
    ]);
  }

  function lede() {
    var top = DATA.rows[0];
    return el('section', { class: 'lede' }, [
      el('p', null, [
        'Every protocol below still records no token, and none of them is a wrapped, staked or bridged product of a token that already trades. ',
        el('b', { text: 'Implied value' }),
        ' is what a token would be worth if the protocol launched one at the multiple its own category trades at: TVL times the category multiple, times growth, times maturity. ',
        top ? ['The board opens with ', el('b', { text: top.name }), ' at ', el('b', { class: 'num', text: fmtUsd(top.implied_value_usd) }), '.'] : '',
      ]),
      el('div', { class: 'facts' }, [
        el('div', { class: 'fact' }, [el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' of ' + DATA.watchlist_size })]),
        el('div', { class: 'fact' }, [el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })]),
        el('div', { class: 'fact' }, [el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) })]),
        el('div', { class: 'fact' }, [el('span', { text: 'Global multiple' }), el('b', { text: fmtMult(DATA.global_multiple) })]),
      ]),
    ]);
  }

  /* ------------------------------------------------------------ controls */

  function controls() {
    var cats = categories();
    var chs = chains();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, slug, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; render(); });
    var catSel = el('select', { id: 'cat', 'aria-label': 'Category' },
      [el('option', { value: 'all', text: 'All categories' })].concat(cats.map(function (c) {
        return el('option', { value: c, text: c + ' (' + DATA.rows.filter(function (r) { return (r.category || 'Other') === c; }).length + ')', selected: c === state.category ? 'selected' : null });
      })));
    catSel.addEventListener('change', function () { state.category = catSel.value; state.selected = null; writeHash(); render(); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Chain' },
      [el('option', { value: 'all', text: 'All chains' })].concat(chs.map(function (c) {
        return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null });
      })));
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; render(); });
    var tvlSel = el('select', { id: 'mintvl', 'aria-label': 'Minimum TVL' }, [
      el('option', { value: '0', text: 'Any TVL', selected: state.minTvl === 0 ? 'selected' : null }),
      el('option', { value: '100000000', text: 'TVL $100M+', selected: state.minTvl === 100000000 ? 'selected' : null }),
      el('option', { value: '50000000', text: 'TVL $50M+', selected: state.minTvl === 50000000 ? 'selected' : null }),
      el('option', { value: '10000000', text: 'TVL $10M+', selected: state.minTvl === 10000000 ? 'selected' : null }),
    ]);
    tvlSel.addEventListener('change', function () { state.minTvl = Number(tvlSel.value); render(); });
    function tabBtn(tab, label) {
      return el('button', { type: 'button', 'aria-pressed': state.tab === tab ? 'true' : 'false', text: label, onclick: function () { state.tab = tab; state.selected = null; writeHash(); render(); } });
    }
    var wrap = el('div', { class: 'controls' }, [
      el('div', { class: 'field' }, [el('label', { for: 'q', text: 'Search' }), search]),
      el('div', { class: 'field' }, [el('label', { for: 'cat', text: 'Category' }), catSel]),
      el('div', { class: 'field' }, [el('label', { for: 'chain', text: 'Chain' }), chainSel]),
      el('div', { class: 'field' }, [el('label', { for: 'mintvl', text: 'Minimum TVL' }), tvlSel]),
      el('div', { class: 'field' }, [el('span', { class: 'sub', text: 'View' }), el('div', { class: 'tabs' }, [tabBtn('pre-token', 'Pre-token'), tabBtn('live', 'Live token'), tabBtn('method', 'Method')])]),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? filteredRows().length + ' of ' + DATA.rows.length + ' rows shown' : state.tab === 'live' ? DATA.live.length + ' live-token protocols' : 'How the value is computed' }),
    ]);
    if (state.category !== 'all' && state.tab === 'pre-token') {
      wrap.appendChild(el('div', { class: 'filter-note' }, [
        'Filtered to category ',
        el('b', { text: state.category }),
        ' — ' + filteredRows().length + ' rows.',
        el('button', { type: 'button', text: 'Clear filter', onclick: function () { state.category = 'all'; writeHash(); render(); } }),
      ]));
    }
    return wrap;
  }

  /* ------------------------------------------------------------ the board */

  function sortHeader(key, label, numeric) {
    var active = state.sort === key;
    return el('th', { class: numeric ? 'num' : null }, el('button', { type: 'button', onclick: function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'name' ? 1 : -1; }
      render();
    } }, [label, active ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ▼' : ' ▲' }) : null]));
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' }, [
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; writeHash(); render(); } }),
      ]));
    }
    var head = el('tr', null, [
      sortHeader('rank', '#'),
      sortHeader('name', 'Protocol'),
      sortHeader('category', 'Category'),
      sortHeader('tvl', 'TVL', true),
      sortHeader('growth', '7d', true),
      sortHeader('age', 'Age', true),
      sortHeader('multiple', 'Multiple', true),
      sortHeader('implied', 'Implied value', true),
    ]);
    var body = el('tbody', null, list.map(function (r) {
      var growth = r.change_7d == null ? el('span', { class: 'num', text: '—' }) : el('span', { class: 'num ' + (r.change_7d >= 0 ? 'up' : 'down'), text: fmtPct(r.change_7d) });
      var tr = el('tr', { class: state.selected === r.slug ? 'selected' : null, onclick: function () { selectRow(r.slug); } }, [
        el('td', null, el('span', { class: 'rank-badge', text: String(r.rank) })),
        el('td', { class: 'name' }, [el('b', { text: r.name }), el('span', { text: r.slug })]),
        el('td', null, el('span', { class: 'tag', text: r.category || 'Other' })),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num' }, growth),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtMult(r.category_multiple) }),
        el('td', { class: 'num' }, el('b', { text: fmtUsd(r.implied_value_usd) })),
      ]);
      return tr;
    }));
    return el('div', { class: 'panel' }, el('table', null, [el('thead', null, head), body]));
  }

  /** Open one protocol's detail view and put it in the hash. */
  function selectRow(slug) {
    state.selected = slug;
    writeHash();
    render();
    var d = $('detail');
    if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ------------------------------------------------------------ the detail view */

  function detailView() {
    if (!state.selected) return null;
    var r = null;
    DATA.rows.forEach(function (row) { if (row.slug === state.selected) r = row; });
    if (!r) return null;
    var growth = r.change_7d == null ? 'no seven-day figure reported' : fmtPct(r.change_7d) + ' over seven days';
    var formula = 'TVL ' + fmtUsd(r.tvl_usd) + ' × multiple ' + fmtMult(r.category_multiple) +
      ' × growth ' + r.growth_multiplier.toFixed(2) + ' × maturity ' + r.maturity_multiplier.toFixed(2) +
      ' = ' + fmtUsd(r.implied_value_usd);
    var steps = el('ol', { class: 'steps' }, r.farm_steps.map(function (s) {
      var costAt = s.lastIndexOf(' Cost: ');
      var main = costAt > 0 ? s.slice(0, costAt) : s;
      var cost = costAt > 0 ? s.slice(costAt + 1) : '';
      return el('li', null, [el('div', null, [el('div', { text: main }), el('div', { class: 'cost', text: cost })])]);
    }));
    return el('section', { class: 'detail', id: 'detail', 'aria-label': 'Protocol detail' }, [
      el('div', { class: 'detail-head' }, [
        el('h2', null, ['#', String(r.rank), ' · ', r.name]),
        el('button', { class: 'close', type: 'button', text: 'Close', onclick: function () { state.selected = null; writeHash(); render(); } }),
      ]),
      el('p', { class: 'muted' }, [
        (r.category || 'Other') + ' · ' + r.chains.join(', ') + ' · tracked since ' + (r.listed_at || 'unknown date') +
        ' · ' + growth + '.',
      ]),
      el('div', { class: 'detail-grid' }, [
        el('div', { class: 'cell' }, [el('span', { text: 'TVL' }), el('b', { text: fmtUsd(r.tvl_usd) })]),
        el('div', { class: 'cell' }, [el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(r.implied_value_usd) })]),
        el('div', { class: 'cell' }, [el('span', { text: 'Category multiple' }), el('b', { text: fmtMult(r.category_multiple) + ' (' + r.comparables + ' live)' })]),
        el('div', { class: 'cell' }, [el('span', { text: 'Age with no token' }), el('b', { text: fmtAge(r.age_days) })]),
        el('div', { class: 'cell' }, [el('span', { text: 'Token status' }), el('b', { text: 'Pre-token' })]),
        el('div', { class: 'cell' }, [el('span', { text: 'Chains' }), el('b', { text: String(r.chains.length) })]),
      ]),
      el('h3', { text: 'How the value is computed' }),
      el('div', { class: 'formula' }, [
        el('b', { text: formula }),
        el('div', { class: 'muted', text: 'The multiple is the median mcap/TVL of the ' + r.comparables + ' live-token ' + (r.category || 'uncategorized') + ' protocols in this snapshot' + (r.comparables < 3 ? '; fewer than three comparables, so the global median applies' : '') + '.' }),
      ]),
      el('h3', { text: 'Farm plan', style: 'margin-top:16px' }),
      steps,
    ]);
  }

  /* ------------------------------------------------------------ live tokens and method */

  function liveTable() {
    var list = filteredLive();
    var head = el('tr', null, [
      el('th', { text: 'Protocol' }),
      el('th', { text: 'Category' }),
      el('th', { class: 'num', text: 'TVL' }),
      el('th', { class: 'num', text: 'Market cap' }),
      el('th', { class: 'num', text: 'mcap / TVL' }),
      el('th', { class: 'num', text: '7d' }),
    ]);
    var body = el('tbody', null, list.map(function (r) {
      var ratio = r.mcap_usd != null && r.tvl_usd > 0 ? (r.mcap_usd / r.tvl_usd).toFixed(2) + '×' : '—';
      var growth = r.change_7d == null ? el('span', { class: 'num', text: '—' }) : el('span', { class: 'num ' + (r.change_7d >= 0 ? 'up' : 'down'), text: fmtPct(r.change_7d) });
      return el('tr', { style: 'cursor:default' }, [
        el('td', { class: 'name' }, [el('b', { text: r.name }), el('span', { text: r.slug })]),
        el('td', null, el('span', { class: 'tag', text: r.category || 'Other' })),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num' }, el('b', { text: fmtUsd(r.mcap_usd) })),
        el('td', { class: 'num', text: ratio }),
        el('td', { class: 'num' }, growth),
      ]);
    }));
    return el('div', null, [
      el('p', { class: 'muted' }, 'These protocols already trade, so the board shows the market\u2019s own value for them, not a model\u2019s. Their mcap/TVL ratios are what set the category multiples above.'),
      el('div', { class: 'panel' }, el('table', null, [el('thead', null, head), body])),
    ]);
  }

  function methodSection() {
    var rows = DATA.multiples.map(function (m) {
      return el('tr', null, [
        el('td', { text: m.category }),
        el('td', { class: 'num', text: fmtMult(m.multiple) }),
        el('td', { class: 'num', text: String(m.comparables) }),
      ]);
    });
    return el('div', { class: 'method' }, [
      el('h2', { text: 'How the implied value is computed' }),
      el('p', { class: 'muted' }, [
        'implied = TVL × category multiple × growth × maturity. ',
        'The multiple is the median mcap/TVL of the live-token protocols in the same category, in this snapshot alone; a category with fewer than three live protocols takes the global median of ' + fmtMult(DATA.global_multiple) + '. ',
        'Growth is 1 + clamp(seven-day change, −60%, +120%) ÷ 100 × 0.5. Maturity is 0.6 + min(age, 1095 days) ÷ 1095 × 0.4; a protocol with no listing date counts as 365 days old. Multiples are clamped to [0.05×, 1.50×]. No name is ever special-cased: the same function scores every row.',
      ]),
      el('div', { class: 'panel' }, el('table', null, [
        el('thead', null, el('tr', null, [el('th', { text: 'Category' }), el('th', { class: 'num', text: 'Multiple' }), el('th', { class: 'num', text: 'Live comparables' })])),
        el('tbody', null, rows),
      ])),
      el('div', { class: 'note' }, [
        el('b', { text: 'What is set aside. ' }),
        'Of the snapshot\u2019s ' + (DATA.board_size + DATA.set_aside + DATA.live_size) + ' protocols, ' + DATA.set_aside + ' are neither ranked nor shown as live: exchanges, bridges, wrapped and staked products of tokens that already trade, and versioned pools. They are not launches waiting to happen, so the board does not rank them.',
      ]),
    ]);
  }

  function footer() {
    return el('footer', null, [
      'Snapshot: ' + DATA.source + ' · ' + DATA.as_of + '. ',
      'Model ' + DATA.model_version + '. ',
      'Implied values are the entry\u2019s own claim from the snapshot\u2019s figures; they do not predict whether or when a token is issued.',
    ]);
  }

  /* ------------------------------------------------------------ render */

  function render() {
    var main = $('board');
    main.setAttribute('aria-busy', 'false');
    main.innerHTML = '';
    main.appendChild(header());
    main.appendChild(lede());
    main.appendChild(controls());
    if (state.tab === 'live') main.appendChild(liveTable());
    else if (state.tab === 'method') main.appendChild(methodSection());
    else {
      var detail = detailView();
      if (detail) main.appendChild(detail);
      main.appendChild(boardTable());
    }
    main.appendChild(footer());
  }

  readHash();
  window.addEventListener('hashchange', function () { readHash(); render(); });
  render();
})();
