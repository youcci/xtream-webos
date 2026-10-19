(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = { view: 'overview', history: [], token: '', status: null, settings: null,
    settingsDirty: false, categories: [], categoriesLoaded: false, channelsLoaded: false,
    category: '', categoryName: 'All channels', query: '', offset: 0, limit: 40, total: 0,
    items: [], requestNumber: 0, channelBusy: false, action: '', testing: false, saving: false,
    polling: false, passwordSet: false, lastSync: null, lastJobError: '', noticeKind: '',
    searchTimer: null, connectionFailed: false, selectionCategories: [], selectedIds: Object.create(null),
    savedIds: Object.create(null), selectionLoaded: false, selectionLoading: false, selectionApplying: false,
    selectionDirty: false, selectionQuery: '', selectionImported: 0, selectionRefreshPending: false };
  var launchParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  state.token = launchParams.get('token') || '';
  var launchView = launchParams.get('view') || 'overview';

  function text(id, value) { var element = $(id); if (element && element.textContent !== String(value)) element.textContent = String(value); }
  function hidden(id, value) { $(id).hidden = !!value; }
  function trim(value) { return String(value || '').replace(/^\s+|\s+$/g, ''); }
  function friendly(value) {
    if (value && typeof value === 'object') value = value.message || value.code || '';
    var message = String(value || 'The request could not be completed.');
    var known = { invalid_credentials: 'The account details were not accepted. Check the username and password.',
      account_expired: 'This account has expired. Check with your provider.', unauthorized: 'This access link has expired. Reopen Channel room on your TV.',
      forbidden: 'This access link has expired. Reopen Channel room on your TV.', busy: 'An update is already running. Please wait for it to finish.',
      not_configured: 'Connect an account first.', network_error: 'The server could not be reached. Check the address and your connection.' };
    if (known[message]) return known[message];
    // Upstream exceptions can contain a URL. The UI never displays those URLs.
    return message.replace(/https?:\/\/[^\s<>"']+/gi, '[server]').replace(/\b(password|token)=([^\s&]+)/gi, '$1=[hidden]').replace(/_/g, ' ').slice(0, 240);
  }
  function error(message) { var result = new Error(message); result.friendly = true; return result; }
  function api(path, method, body) {
    if (!state.token) return Promise.reject(error('The access link is missing. Reopen Channel room from your TV.'));
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timeout = setTimeout(function () { if (!settled) { settled = true; reject(error('The TV is taking longer than expected. Please try again.')); } }, 30000);
      var options = { method: method || 'GET', cache: 'no-store', credentials: 'same-origin', headers: { 'X-Xtream-Token': state.token } };
      if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
      fetch(path, options).then(function (response) {
        return response.text().then(function (raw) {
          var data = {};
          try { if (raw) data = JSON.parse(raw); } catch (_) { if (response.ok) throw error('The TV returned an unreadable response. Please try again.'); }
          if (!response.ok) {
            if (response.status === 401 || response.status === 403) throw error('This access link has expired. Reopen Channel room on your TV.');
            throw error(friendly(data.error || data.message || ('Request failed (' + response.status + '). Please try again.')));
          }
          if (data.ok === false) throw error(friendly(data.error || data.message || 'The request could not be completed. Please try again.'));
          return data;
        });
      }).then(function (data) { if (!settled) { settled = true; clearTimeout(timeout); resolve(data); } }, function (problem) {
        if (!settled) { settled = true; clearTimeout(timeout); reject(problem && problem.friendly ? problem : error('The TV could not be reached. Check your connection and try again.')); }
      });
    });
  }
  function notice(message, isError, kind) {
    state.noticeKind = kind || 'action';
    text('notice', message); $('notice').className = 'notice' + (isError ? ' error' : ''); hidden('notice', false);
  }
  function accountMessage(message, isError) {
    text('account-message', message); $('account-message').className = 'account-message' + (isError ? ' error' : ''); hidden('account-message', false);
  }
  function selectionMessage(message, isError) {
    text('selection-message', message); $('selection-message').className = 'selection-message' + (isError ? ' error' : ''); hidden('selection-message', false);
  }
  function number(value) { var n = Number(value); return isFinite(n) ? n : 0; }
  function count(value) { return Math.max(0, number(value)).toLocaleString(); }
  function date(value) {
    if (!value) return null;
    if (/^\d+(?:\.\d+)?$/.test(String(value))) { value = Number(value); if (value < 100000000000) value *= 1000; }
    var result = new Date(value); return isNaN(result.getTime()) ? null : result;
  }
  function timeLabel(value, includeDay) {
    var d = date(value); if (!d) return 'Not yet';
    var today = new Date(); var day = d.toDateString() === today.toDateString() ? 'Today' : d.toLocaleDateString();
    var time = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return includeDay ? day + ', ' + time : time;
  }
  function working() { return !!(state.status && ((state.status.sync && state.status.sync.running) || (state.status.guide && state.status.guide.running))); }
  function configured() { return !!(state.status && state.status.configured); }
  function updateButtons() {
    var busy = working() || !!state.action || state.saving || state.testing || state.selectionApplying || state.selectionRefreshPending;
    $('sync-channels').disabled = busy || !configured();
    $('refresh-guide').disabled = busy || !configured();
    $('save-account').disabled = busy;
    $('test-account').disabled = busy;
    text('save-account-label', state.saving ? 'Saving your account…' : 'Save & sync');
    text('test-account', state.testing ? 'Testing connection…' : 'Test account');
    var watches = $('channel-list').querySelectorAll('button');
    for (var i = 0; i < watches.length; i++) watches[i].disabled = state.channelBusy || busy;
    $('previous-page').disabled = state.channelBusy || state.offset <= 0;
    $('next-page').disabled = state.channelBusy || state.offset + state.items.length >= state.total;
    var selectionBusy = busy || state.selectionLoading || state.selectionApplying || !state.selectionLoaded;
    $('selection-select-all').disabled = selectionBusy;
    $('selection-clear').disabled = selectionBusy;
    $('selection-apply').disabled = selectionBusy || !configured();
    $('selection-open-guide').disabled = busy || !configured() || !state.status.counts || !state.status.counts.channels;
    text('selection-apply-label', state.selectionApplying ? 'Applying selection…' : 'Apply selection');
    var selections = $('selection-list').querySelectorAll('button');
    for (var j = 0; j < selections.length; j++) selections[j].disabled = selectionBusy;
  }
  function progressValue(value) {
    if (value && typeof value === 'object') return value.total ? Math.round(100 * number(value.done || value.current) / number(value.total)) : 0;
    return Math.max(0, Math.min(100, Math.round(number(value))));
  }
  function updateStatus(data) {
    var oldSync = state.lastSync;
    var hadStatus = state.status !== null;
    var wasWorking = working();
    state.status = data || {};
    var sync = data.sync || {}, guide = data.guide || {}, counts = data.counts || {};
    state.lastSync = sync.lastSuccess || null;
    text('count-channels', count(counts.channels)); text('count-categories', count(counts.categories)); text('count-programmes', count(guide.programmes));
    text('connection-label', 'Connected to your TV'); $('connection-dot').className = 'connection-dot online';
    if (state.connectionFailed && state.noticeKind === 'connection') hidden('notice', true);
    state.connectionFailed = false;
    if (data.configured) {
      $('hero-title').innerHTML = 'Your channels.<br>Right at home.';
      text('hero-description', data.player && data.player.name ? 'Now on Live TV: ' + data.player.name + '. Open the Guide to see what’s on next.' : 'Everything you love to watch, together in LG’s channel list and TV Guide.');
      hidden('setup-account', true); text('library-label', working() ? 'LOOKING AFTER YOUR LIBRARY' : 'YOUR LINE-UP, TOGETHER');
      text('library-detail', counts.channels ? 'Your selected channels are available in the original Live TV.' : 'Choose your categories to bring channels into Live TV.');
      text('next-sync', data.nextSync ? 'Next channel update · ' + timeLabel(data.nextSync, true) : 'Automatic updates enabled');
    } else {
      $('hero-title').innerHTML = 'Bring your<br>channels home.';
      text('hero-description', 'Connect your account. Find your favourites in LG’s familiar channel list and TV Guide.');
      hidden('setup-account', false); text('library-label', 'LET’S GET STARTED'); text('library-detail', 'Your account keeps everything together.'); text('next-sync', 'Automatic updates after setup');
    }
    text('last-sync', sync.lastSuccess ? 'Last updated · ' + timeLabel(sync.lastSuccess, true) : 'No update yet');
    text('last-guide', guide.lastSuccess ? 'Last refreshed · ' + timeLabel(guide.lastSuccess, true) : 'No guide update yet');
    hidden('sync-error', !sync.error); if (sync.error) text('sync-error', friendly(sync.error));
    hidden('guide-error', !guide.error); if (guide.error) text('guide-error', friendly(guide.error));
    var activeJob = sync.running ? sync : guide.running ? guide : null;
    hidden('job-banner', !activeJob);
    if (activeJob) {
      text('job-title', sync.running ? 'Updating your channels' : 'Refreshing the TV Guide');
      var phases = { download: 'Downloading programme data…', stage: 'Preparing programme listings…', commit: 'Adding listings to LG’s Guide…', fallback: 'Updating the current channel’s listings…' };
      text('job-phase', phases[activeJob.phase] || (activeJob.phase ? friendly(activeJob.phase) : 'Keeping everything in place'));
      var progress = progressValue(activeJob.progress); text('job-percent', activeJob.progress === undefined ? '' : progress + '%');
      $('job-progress').style.width = (activeJob.progress === undefined ? 15 : Math.max(1, progress)) + '%';
      $('job-progress').parentNode.setAttribute('aria-valuenow', progress);
    }
    var jobError = sync.error || guide.error || '';
    if (jobError && String(jobError) !== state.lastJobError) notice(friendly(jobError), true, 'job');
    if (!activeJob && !jobError && counts.channels && (!hadStatus || wasWorking)) {
      notice((wasWorking ? 'Update complete. ' : 'Your lineup is ready. ') + count(counts.channels) + ' channels in ' + count(counts.categories) + ' categories are available in LG Live TV and Guide.', false, 'complete');
    }
    state.lastJobError = String(jobError);
    if (hadStatus && state.lastSync && oldSync !== state.lastSync) {
      state.categoriesLoaded = false; state.channelsLoaded = false;
      if (state.view === 'channels') { loadCategories(); loadChannels(); }
      if (!state.selectionDirty && !state.selectionRefreshPending && !state.selectionApplying) {
        state.selectionLoaded = false; if (state.view === 'categories') loadSelection();
      }
    }
    updateButtons();
    if (state.selectionRefreshPending && !state.selectionApplying && !working()) refreshSelectedCatalog();
  }
  function pollStatus() {
    if (state.polling) return Promise.resolve(false);
    state.polling = true;
    return api('/api/status').then(function (data) { updateStatus(data); return true; }, function (problem) {
      text('connection-label', 'Connection needs attention'); $('connection-dot').className = 'connection-dot error';
      if (!state.connectionFailed) notice(problem.message, true, 'connection'); state.connectionFailed = true; return false;
    }).then(function (ok) { state.polling = false; return ok; });
  }
  function focus(element) {
    if (!element || element.disabled) return;
    element.focus();
    try { element.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) { element.scrollIntoView(false); }
  }
  function showView(name, targetFocus, fromBack) {
    if (['overview', 'channels', 'categories', 'account'].indexOf(name) < 0) return;
    if (name !== state.view && !fromBack) { state.history.push(state.view); if (state.history.length > 10) state.history.shift(); }
    state.view = name;
    var names = ['overview', 'channels', 'categories', 'account'];
    for (var i = 0; i < names.length; i++) {
      var selected = names[i] === name;
      hidden('view-' + names[i], !selected);
      $('nav-' + names[i]).className = 'nav-button' + (selected ? ' selected' : '');
      if (selected) $('nav-' + names[i]).setAttribute('aria-current', 'page'); else $('nav-' + names[i]).removeAttribute('aria-current');
    }
    text('view-title', { overview: 'At a glance', channels: 'Your channel library', categories: 'Choose your Live TV lineup', account: 'Account & updates' }[name]);
    $('main-content').scrollTop = 0;
    if (name === 'channels') { if (!state.categoriesLoaded) loadCategories(); if (!state.channelsLoaded) loadChannels(); }
    if (name === 'categories' && !state.selectionLoaded && !state.selectionLoading) loadSelection();
    if (targetFocus) focus($(targetFocus));
  }
  function make(tag, className, content) { var element = document.createElement(tag); if (className) element.className = className; if (content !== undefined) element.textContent = content; return element; }
  function icon(name) {
    var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    var shape = document.createElementNS(ns, name === 'empty' ? 'circle' : 'path');
    if (name === 'empty') { shape.setAttribute('cx', '12'); shape.setAttribute('cy', '12'); shape.setAttribute('r', '8'); shape.setAttribute('stroke-dasharray', '2 4'); }
    else shape.setAttribute('d', name === 'play' ? 'M7 4 21 12 7 20Z' : name === 'check' ? 'm5 12 4 4 10-10' : 'M20 11a8 8 0 1 0-2.3 6M20 4v7h-7');
    svg.appendChild(shape); return svg;
  }
  function selectionIds() {
    var ids = [];
    for (var i = 0; i < state.selectionCategories.length; i++) { var id = String(state.selectionCategories[i].id); if (state.selectedIds[id]) ids.push(id); }
    return ids;
  }
  function updateSelectionSummary() {
    var selected = 0, channels = 0, dirty = false;
    for (var i = 0; i < state.selectionCategories.length; i++) {
      var item = state.selectionCategories[i], id = String(item.id);
      if (state.selectedIds[id]) { selected++; channels += Math.max(0, number(item.count)); }
      if (!!state.selectedIds[id] !== !!state.savedIds[id]) dirty = true;
    }
    state.selectionDirty = dirty;
    text('selection-channel-count', count(channels));
    text('selection-category-count', count(selected) + ' of ' + count(state.selectionCategories.length) + ' categories selected');
    text('selection-saved-state', dirty ? 'Changes take effect when you apply. Your current lineup stays in place until then.' : 'Your saved selection. ' + count(state.selectionImported) + ' channels currently in Live TV.');
    hidden('selection-zero-note', !state.selectionLoaded || selected !== 0);
  }
  function renderSelection() {
    var fragment = document.createDocumentFragment(), shown = 0, query = state.selectionQuery.toLocaleLowerCase();
    var active = document.activeElement, restore = active && active.getAttribute('data-select-category');
    for (var i = 0; i < state.selectionCategories.length; i++) {
      var item = state.selectionCategories[i], id = String(item.id), name = String(item.name || 'Unnamed category');
      if (query && name.toLocaleLowerCase().indexOf(query) < 0) continue;
      var button = make('button', 'selection-category'); button.type = 'button'; button.setAttribute('data-select-category', id); button.setAttribute('role', 'checkbox'); button.setAttribute('aria-checked', String(!!state.selectedIds[id]));
      var box = make('span', 'selection-checkbox'); box.setAttribute('aria-hidden', 'true'); box.appendChild(icon('check')); button.appendChild(box);
      button.appendChild(make('span', 'selection-category-copy', name)); button.appendChild(make('span', 'selection-category-total', count(item.count))); fragment.appendChild(button); shown++;
    }
    $('selection-list').textContent = ''; $('selection-list').appendChild(fragment);
    text('selection-visible-count', query ? count(shown) + ' matching categories' : count(shown) + ' available categories');
    hidden('selection-empty', shown > 0);
    text('selection-empty', query ? 'No categories match. Try another country, language or name.' : 'No categories are available yet. Sync your account from Overview, then try loading again.');
    if (restore !== null && restore !== undefined) {
      var buttons = $('selection-list').querySelectorAll('button'), found = false;
      for (var j = 0; j < buttons.length; j++) if (buttons[j].getAttribute('data-select-category') === restore) { focus(buttons[j]); found = true; break; }
      if (!found) focus($('selection-search-button'));
    }
    updateSelectionSummary(); updateButtons();
  }
  function loadSelection() {
    if (state.selectionLoading) return;
    state.selectionLoading = true; updateButtons(); hidden('selection-retry', true); hidden('selection-message', true);
    return api('/api/category-selection').then(function (data) {
      state.selectionCategories = data.categories || []; state.selectionImported = number(data.importedChannels);
      state.selectedIds = Object.create(null); state.savedIds = Object.create(null);
      var selected = Array.isArray(data.selectedIds) ? data.selectedIds : state.selectionCategories.map(function (item) { return item.id; });
      for (var i = 0; i < selected.length; i++) { var id = String(selected[i]); state.selectedIds[id] = true; state.savedIds[id] = true; }
      state.selectionLoaded = true; state.selectionLoading = false; renderSelection();
      hidden('selection-retry', state.selectionCategories.length > 0);
    }, function (problem) {
      state.selectionLoading = false; hidden('selection-retry', false); text('selection-empty', 'Your categories could not be loaded. Please try again.');
      selectionMessage(problem.message, true); updateButtons();
    });
  }
  function toggleSelection(button) {
    if (!state.selectionLoaded || state.selectionApplying || working()) return;
    var id = button.getAttribute('data-select-category'); state.selectedIds[id] = !state.selectedIds[id];
    button.setAttribute('aria-checked', String(!!state.selectedIds[id])); hidden('selection-message', true); updateSelectionSummary();
  }
  function setAllSelections(selected) {
    if (!state.selectionLoaded || state.selectionApplying || working()) return;
    state.selectedIds = Object.create(null);
    if (selected) for (var i = 0; i < state.selectionCategories.length; i++) state.selectedIds[String(state.selectionCategories[i].id)] = true;
    var buttons = $('selection-list').querySelectorAll('button');
    for (var j = 0; j < buttons.length; j++) buttons[j].setAttribute('aria-checked', String(!!state.selectedIds[buttons[j].getAttribute('data-select-category')]));
    hidden('selection-message', true); updateSelectionSummary();
  }
  function refreshSelectedCatalog() {
    state.selectionRefreshPending = false;
    state.category = ''; state.categoryName = 'All channels'; state.offset = 0;
    state.categoriesLoaded = false; state.channelsLoaded = false;
    loadCategories(); loadChannels();
    var problem = state.status && state.status.sync && state.status.sync.error;
    var guideProblem = state.status && state.status.guide && state.status.guide.error;
    selectionMessage(problem ? 'Your selection was saved, but Live TV could not be updated. ' + friendly(problem) : 'Your selection is now applied. ' + count(state.status.counts.channels) + ' channels in ' + count(state.status.counts.categories) + ' categories are ready in LG Live TV. ' + (guideProblem ? 'The Guide refresh failed; existing listings were retained.' : 'The Guide is ready too. Choose Open TV Guide to watch.'), !!(problem || guideProblem));
    if (!problem) { state.selectionImported = state.status && state.status.counts ? number(state.status.counts.channels) : state.selectionImported; updateSelectionSummary(); }
  }
  function applySelection() {
    if (!state.selectionLoaded || state.selectionApplying || working() || state.action || state.saving || state.testing) return;
    var ids = selectionIds(); state.selectionApplying = true; updateButtons(); hidden('selection-message', true);
    api('/api/category-selection', 'POST', { ids: ids }).then(function () {
      state.savedIds = Object.create(null); for (var i = 0; i < ids.length; i++) state.savedIds[ids[i]] = true;
      state.selectionRefreshPending = true; state.categoriesLoaded = false; state.channelsLoaded = false;
      updateSelectionSummary(); selectionMessage('Your selection was saved. Applying it to Live TV and Guide…', false);
      return pollStatus();
    }).then(function (statusOk) {
      state.selectionApplying = false; updateButtons(); if (statusOk && state.selectionRefreshPending && !working()) refreshSelectedCatalog();
    }, function (problem) { state.selectionApplying = false; updateButtons(); selectionMessage(problem.message, true); });
  }
  function categoryButton(item, all) {
    var button = make('button', 'category-button' + (String(item.id) === state.category ? ' active' : ''));
    button.type = 'button'; button.setAttribute('data-category', item.id); button.setAttribute('aria-pressed', String(String(item.id) === state.category));
    if (all) button.id = 'category-all';
    button.appendChild(make('span', '', item.name)); button.appendChild(make('span', 'category-count', count(item.count)));
    return button;
  }
  function loadCategories() {
    return api('/api/categories').then(function (data) {
      state.categories = data.categories || []; state.categoriesLoaded = true;
      var active = document.activeElement; var restore = active && active.getAttribute('data-category');
      var fragment = document.createDocumentFragment(); var total = state.status && state.status.counts ? state.status.counts.channels : 0;
      fragment.appendChild(categoryButton({ id: '', name: 'All channels', count: total }, true));
      for (var i = 0; i < state.categories.length; i++) fragment.appendChild(categoryButton(state.categories[i], false));
      $('category-list').textContent = ''; $('category-list').appendChild(fragment);
      if (restore !== null && restore !== undefined) {
        var buttons = $('category-list').querySelectorAll('button');
        for (var j = 0; j < buttons.length; j++) if (buttons[j].getAttribute('data-category') === restore) { focus(buttons[j]); break; }
      }
    }, function (problem) { notice('Categories could not be loaded. ' + problem.message, true); });
  }
  function channelState(title, description, symbol) {
    hidden('channel-state', false); text('channel-list', '');
    $('channel-state').querySelector('h4').textContent = title;
    $('channel-state').querySelector('p').textContent = description;
    var symbolElement = $('channel-state').querySelector('.empty-symbol'); symbolElement.textContent = ''; symbolElement.appendChild(icon(symbol || 'empty'));
  }
  function renderChannels() {
    var active = document.activeElement; var restore = active && active.getAttribute('data-stream');
    text('channel-total', count(state.total) + (state.total === 1 ? ' channel' : ' channels'));
    text('category-title', state.categoryName);
    text('page-range', state.total ? (state.offset + 1) + '–' + Math.min(state.offset + state.items.length, state.total) + ' of ' + count(state.total) : 'No channels');
    text('page-label', 'Page ' + (Math.floor(state.offset / state.limit) + 1) + ' of ' + Math.max(1, Math.ceil(state.total / state.limit)));
    if (!state.items.length) {
      channelState(state.query ? 'Nothing by that name.' : configured() ? 'No channels here yet.' : 'Your next watch starts here.',
        state.query ? 'Try a different name or choose another category.' : configured() ? 'Update your channel library from Overview to get started.' : 'Connect your account, then sync your channel library.', 'empty');
    } else {
      hidden('channel-state', true); var fragment = document.createDocumentFragment();
      for (var i = 0; i < state.items.length; i++) {
        var item = state.items[i]; var row = make('div', 'channel-row');
        row.appendChild(make('span', 'channel-number', item.number === undefined || item.number === null ? '—' : item.number));
        var copy = make('div', 'channel-copy'); copy.appendChild(make('div', 'channel-name', item.name || 'Unnamed channel'));
        copy.appendChild(make('div', 'channel-category', item.categoryName || 'Live TV')); row.appendChild(copy);
        var watch = make('button', 'watch-button'); watch.type = 'button'; watch.setAttribute('data-stream', item.id); watch.setAttribute('aria-label', 'Watch ' + (item.name || 'channel'));
        watch.appendChild(icon('play')); watch.appendChild(document.createTextNode('Watch')); row.appendChild(watch); fragment.appendChild(row);
      }
      $('channel-list').textContent = ''; $('channel-list').appendChild(fragment); $('channel-list').scrollTop = 0;
      if (restore !== null && restore !== undefined) {
        var buttons = $('channel-list').querySelectorAll('button'); var found = false;
        for (var j = 0; j < buttons.length; j++) if (buttons[j].getAttribute('data-stream') === restore) { focus(buttons[j]); found = true; break; }
        if (!found) focus($('category-all'));
      }
    }
    updateButtons();
  }
  function loadChannels() {
    var request = ++state.requestNumber; state.channelBusy = true; updateButtons();
    var path = '/api/channels?offset=' + state.offset + '&limit=' + state.limit;
    if (state.category) path += '&category=' + encodeURIComponent(state.category);
    if (state.query) path += '&q=' + encodeURIComponent(state.query);
    text('page-range', 'Loading…'); if (!state.items.length) channelState('Loading your channels', 'Making room for your next watch.');
    return api(path).then(function (data) {
      if (request !== state.requestNumber) return;
      state.items = data.items || []; state.total = number(data.total); state.offset = number(data.offset); state.limit = number(data.limit) || 40;
      state.channelBusy = false; state.channelsLoaded = true; renderChannels();
    }, function (problem) {
      if (request !== state.requestNumber) return;
      state.channelBusy = false; state.items = []; state.total = 0;
      channelState('The library couldn’t be loaded.', problem.message, 'refresh'); text('page-range', 'Connection needs attention'); updateButtons();
    });
  }
  function selectCategory(button) {
    state.category = button.getAttribute('data-category'); state.categoryName = button.querySelector('span').textContent; state.offset = 0;
    var buttons = $('category-list').querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) { var active = buttons[i] === button; buttons[i].className = 'category-button' + (active ? ' active' : ''); buttons[i].setAttribute('aria-pressed', String(active)); }
    loadChannels();
  }
  function runAction(path, action, message) {
    if (state.action || working()) { notice('An update is already running. Please wait for it to finish.', false); return; }
    state.action = action; updateButtons();
    api(path, 'POST', {}).then(function () { notice(message, false); return pollStatus(); }, function (problem) { notice(problem.message, true); }).then(function () { state.action = ''; updateButtons(); });
  }
  function openGuide() {
    $('open-guide').disabled = true;
    api('/api/open-guide', 'POST', {}).then(function () { notice('Opening LG’s TV Guide.', false); }, function (problem) { notice(problem.message, true); }).then(function () { $('open-guide').disabled = false; });
  }
  function accountPayload() {
    var url = trim($('server-url').value).replace(/\/+$/, ''); var username = trim($('username').value); var password = $('password').value;
    if (!/^https?:\/\/[^\s/]+/i.test(url)) { focus($('server-url')); throw error('Enter a server address beginning with http:// or https://.'); }
    if (!username) { focus($('username')); throw error('Enter your account username.'); }
    if (!password && !state.passwordSet) { focus($('password')); throw error('Enter your account password.'); }
    var account = { url: url, username: username }; if (password) account.password = password;
    return account;
  }
  function schedulePayload() {
    var hours = Number($('sync-hours').value), minutes = Number($('epg-minutes').value);
    if (!isFinite(hours) || hours % 1 || hours < 1 || hours > 168) { focus($('sync-hours')); throw error('Choose a channel update interval from 1 to 168 hours.'); }
    if (!isFinite(minutes) || minutes % 1 || minutes < 5 || minutes > 1440) { focus($('epg-minutes')); throw error('Choose a guide refresh interval from 5 to 1,440 minutes.'); }
    return { syncHours: hours, epgMinutes: minutes };
  }
  function saveAccount(event) {
    event.preventDefault(); if (working() || state.saving || state.testing) return;
    var account, payload; try { account = accountPayload(); payload = schedulePayload(); payload.account = account; } catch (problem) { accountMessage(problem.message, true); return; }
    var accountSaved = false;
    state.saving = true; updateButtons(); hidden('account-message', true);
    api('/api/settings', 'PUT', payload).then(function () {
      accountSaved = true;
      state.passwordSet = true; state.settingsDirty = false; $('password').value = ''; $('password').type = 'password'; text('show-password', 'Show'); $('show-password').setAttribute('aria-pressed', 'false');
      text('password-note', 'A password is saved. Leave this blank to keep it.'); $('password').placeholder = 'Saved password — leave blank to keep'; text('account-state', 'CONNECTED');
      accountMessage('Account saved. Starting your channel update…', false);
      return api('/api/sync', 'POST', {}).then(function () { accountMessage('Account saved. Your channels are updating. You can follow progress in Overview.', false); return pollStatus(); });
    }, function (problem) { throw problem; }).then(function () { state.saving = false; updateButtons(); }, function (problem) {
      state.saving = false; updateButtons(); accountMessage((accountSaved ? 'Account saved, but the channel update could not start. ' : '') + problem.message, true); pollStatus();
    });
  }
  function testAccount() {
    if (working() || state.testing || state.saving) return;
    var account; try { account = accountPayload(); } catch (problem) { accountMessage(problem.message, true); return; }
    state.testing = true; updateButtons(); hidden('account-message', true);
    api('/api/test-account', 'POST', { account: account }).then(function (data) {
      if (data.ok === false) { accountMessage(friendly(data.error || 'The account details were not accepted. Check them and try again.'), true); return; }
      var details = ['Connection successful'];
      if (data.status) details.push(friendly(data.status));
      if (data.maxConnections !== undefined && data.maxConnections !== null) details.push(data.maxConnections + (Number(data.maxConnections) === 1 ? ' connection' : ' connections'));
      var expiry = date(data.expires); if (expiry) details.push('Expires ' + expiry.toLocaleDateString());
      accountMessage(details.join(' · ') + '.', false);
    }, function (problem) { accountMessage(problem.message, true); }).then(function () { state.testing = false; updateButtons(); });
  }
  function loadSettings() {
    return api('/api/settings').then(function (data) {
      state.settings = data; state.passwordSet = !!(data.account && data.account.passwordSet);
      if (!state.settingsDirty) {
        $('server-url').value = data.account && data.account.url || ''; $('username').value = data.account && data.account.username || '';
        $('sync-hours').value = data.syncHours || 6; $('epg-minutes').value = data.epgMinutes || 60;
      }
      // Existing passwords are never returned to, or populated in, this field.
      text('account-state', state.passwordSet ? 'CONNECTED' : 'NOT CONNECTED');
      text('password-note', state.passwordSet ? 'A password is saved. Leave this blank to keep it.' : 'Your password is stored on this TV and never shown here.');
      $('password').placeholder = state.passwordSet ? 'Saved password — leave blank to keep' : 'Your account password';
    }, function (problem) { accountMessage('Account settings could not be loaded. ' + problem.message, true); });
  }

  // Live-geometry spatial navigation. Widget-local candidates win; crossing a
  // widget boundary uses the actual visible rectangles, never hard-coded rows.
  function visible(element) {
    if (!element || element.disabled || element.tabIndex < 0 || !element.getClientRects().length) return false;
    var rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && window.getComputedStyle(element).visibility !== 'hidden';
  }
  function scope(element) { while (element && element !== document.body) { if (element.hasAttribute && element.hasAttribute('data-nav-scope')) return element; element = element.parentNode; } return document.body; }
  function editing(element) { var tag = element && element.tagName; return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!(element && element.isContentEditable); }
  function candidates(root) { var items = root.querySelectorAll('button,a[href],input,select,textarea,[tabindex]'); var result = []; for (var i = 0; i < items.length; i++) if (visible(items[i])) result.push(items[i]); return result; }
  function nearest(active, direction, items) {
    var a = active.getBoundingClientRect(), ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2;
    var best = null, score = Infinity;
    for (var i = 0; i < items.length; i++) {
      var item = items[i]; if (item === active) continue;
      var b = item.getBoundingClientRect(), bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2;
      var horizontal = direction === 'left' || direction === 'right';
      var forward = direction === 'left' ? ax - bx : direction === 'right' ? bx - ax : direction === 'up' ? ay - by : by - ay;
      if (forward <= 3) continue;
      var lateral = horizontal ? Math.abs(by - ay) : Math.abs(bx - ax);
      var overlap = horizontal ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) : Math.min(a.right, b.right) - Math.max(a.left, b.left);
      var edgeDistance = horizontal ? (direction === 'right' ? b.left - a.right : a.left - b.right) : (direction === 'down' ? b.top - a.bottom : a.top - b.bottom);
      var value = Math.max(0, edgeDistance) + lateral * (overlap > 0 ? 0.25 : 2.5) + (overlap > 0 ? 0 : 90);
      if (value < score) { score = value; best = item; }
    }
    return best;
  }
  function goBack(event) {
    var active = document.activeElement;
    if (editing(active)) { event.preventDefault(); active.blur(); focus($(state.view === 'channels' ? 'search-button' : state.view === 'categories' ? 'selection-search-button' : 'test-account')); return; }
    if (state.view !== 'overview') { event.preventDefault(); var previous = state.history.pop() || 'overview'; showView(previous, 'nav-' + previous, true); return; }
    var platform = window.webOSSystem || window.PalmSystem;
    if (window.webOS && typeof window.webOS.platformBack === 'function') { event.preventDefault(); window.webOS.platformBack(); }
    else if (platform && typeof platform.platformBack === 'function') { event.preventDefault(); platform.platformBack(); }
    else if (typeof window.close === 'function') { event.preventDefault(); window.close(); }
  }
  document.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.isComposing) return;
    var key = event.keyCode || event.which;
    if (key === 461 || key === 27) { goBack(event); return; }
    if (key === 13 && document.activeElement && document.activeElement.tagName === 'BUTTON') {
      event.preventDefault(); if (!event.repeat && !document.activeElement.disabled) document.activeElement.click(); return;
    }
    var direction = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' }[key];
    if (!direction || event.altKey || event.ctrlKey || event.metaKey || editing(document.activeElement)) return;
    var active = document.activeElement;
    if (!active || active === document.body || !visible(active)) { event.preventDefault(); focus($('nav-' + state.view)); return; }
    var next = nearest(active, direction, candidates(scope(active))) || nearest(active, direction, candidates(document.body));
    event.preventDefault(); if (next) focus(next);
  });
  document.addEventListener('click', function (event) {
    var element = event.target;
    while (element && element !== document.body && element.tagName !== 'BUTTON') element = element.parentNode;
    if (!element || element.tagName !== 'BUTTON' || element.disabled) return;
    if (element.hasAttribute('data-view')) { showView(element.getAttribute('data-view')); return; }
    if (element.hasAttribute('data-select-category')) { toggleSelection(element); return; }
    if (element.hasAttribute('data-category')) { selectCategory(element); return; }
    if (element.hasAttribute('data-stream')) {
      if (state.action || working()) return;
      state.action = 'tune'; updateButtons();
      api('/api/tune', 'POST', { id: element.getAttribute('data-stream') }).then(function () { notice('Opening your channel in Live TV.', false); }, function (problem) { notice(problem.message, true); }).then(function () { state.action = ''; updateButtons(); pollStatus(); });
    }
  });
  $('browse-channels').addEventListener('click', function () { showView('channels', 'category-all'); });
  $('setup-account').addEventListener('click', function () { showView('account', 'server-url'); });
  $('open-guide').addEventListener('click', openGuide);
  $('sync-channels').addEventListener('click', function () { runAction('/api/sync', 'sync', 'Your channel update has started.'); });
  $('refresh-guide').addEventListener('click', function () { runAction('/api/refresh-guide', 'guide', 'Your guide refresh has started.'); });
  $('previous-page').addEventListener('click', function () { state.offset = Math.max(0, state.offset - state.limit); loadChannels(); });
  $('next-page').addEventListener('click', function () { state.offset += state.limit; loadChannels(); });
  $('search-form').addEventListener('submit', function (event) { event.preventDefault(); clearTimeout(state.searchTimer); state.query = trim($('channel-search').value); state.offset = 0; loadChannels(); });
  $('channel-search').addEventListener('input', function () { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(function () { state.query = trim($('channel-search').value); state.offset = 0; loadChannels(); }, 500); });
  $('account-form').addEventListener('input', function () { state.settingsDirty = true; });
  $('account-form').addEventListener('submit', saveAccount);
  $('test-account').addEventListener('click', testAccount);
  $('show-password').addEventListener('click', function () { var showing = $('password').type === 'text'; $('password').type = showing ? 'password' : 'text'; text('show-password', showing ? 'Show' : 'Hide'); $('show-password').setAttribute('aria-pressed', String(!showing)); });
  $('selection-search-form').addEventListener('submit', function (event) { event.preventDefault(); state.selectionQuery = trim($('selection-search').value); if (state.selectionLoaded) renderSelection(); });
  $('selection-search').addEventListener('input', function () { state.selectionQuery = trim($('selection-search').value); if (state.selectionLoaded) renderSelection(); });
  $('selection-select-all').addEventListener('click', function () { setAllSelections(true); });
  $('selection-clear').addEventListener('click', function () { setAllSelections(false); });
  $('selection-apply').addEventListener('click', applySelection);
  $('selection-open-guide').addEventListener('click', openGuide);
  $('selection-retry').addEventListener('click', loadSelection);
  function clock() { var now = new Date(); text('clock', ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2)); $('clock').dateTime = now.toISOString(); }
  clock(); setInterval(clock, 30000); pollStatus(); loadSettings(); setInterval(pollStatus, 5000);
  showView(launchView);
  setTimeout(function () { focus($('nav-' + state.view)); }, 50);
}());
