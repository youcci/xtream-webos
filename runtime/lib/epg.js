'use strict';

/* Node 8.12, builtins only. Credentials are used only to construct requests and
 * are never included in progress, persisted metadata, or error messages. */
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var url = require('url');
var zlib = require('zlib');
var crypto = require('crypto');
var child = require('child_process');
var stream = require('stream');
var StringDecoder = require('string_decoder').StringDecoder;

var MAX_FEED = 512 * 1024 * 1024;
var MAX_PROGRAMME = 64 * 1024;
var MAX_ROWS = 2000000;
var active = Object.create(null);
var codes = ['EPG_CONFIG', 'EPG_BUSY', 'EPG_DOWNLOAD', 'EPG_XML', 'EPG_EMPTY',
  'EPG_LIMIT', 'EPG_CANCELLED', 'EPG_SQLITE', 'EPG_IO', 'EPG_REFRESH'];

function failure(code) { var e = new Error(code); e.code = code; return e; }
function safeError(e, fallback) {
  return failure(e && codes.indexOf(e.code) !== -1 ? e.code : fallback || 'EPG_REFRESH');
}
function cancelled(options) { if (options.signal && options.signal.aborted) throw failure('EPG_CANCELLED'); }
function observeAbort(signal, listener) {
  if (!signal) return function () {};
  if (signal.addEventListener) {
    signal.addEventListener('abort', listener);
    return function () { signal.removeEventListener('abort', listener); };
  }
  if (signal.on) {
    signal.on('abort', listener);
    return function () { signal.removeListener('abort', listener); };
  }
  return function () {};
}
function progress(options, data) {
  if (typeof options.onProgress === 'function') {
    try { options.onProgress(data); } catch (_) {} // Observers cannot interrupt an import.
  }
}
function quote(value) { return value == null ? 'NULL' : "'" + String(value).replace(/'/g, "''") + "'"; }
function utc(seconds) {
  var d = new Date(seconds * 1000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(),
    d.getUTCMinutes(), d.getUTCSeconds()].map(function (n, i) {
    return i ? ('0' + n).slice(-2) : String(n);
  }).join(',');
}
function parseXmltvTime(value) {
  var m = /^\s*(\d{4})(\d{2})(\d{2})(?:(\d{2})(?:(\d{2})(\d{2})?)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?\s*$/.exec(String(value || ''));
  if (!m) return null;
  var y = +m[1], mo = +m[2], day = +m[3], h = +(m[4] || 0), min = +(m[5] || 0), sec = +(m[6] || 0);
  var d = new Date(0);
  d.setUTCFullYear(y, mo - 1, day); d.setUTCHours(h, min, sec, 0);
  if (y < 1900 || mo < 1 || mo > 12 || day < 1 || h > 23 || min > 59 || sec > 59 ||
      d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== day) return null;
  var offset = 0;
  if (m[7] && /^[+-]/.test(m[7])) {
    var tz = m[7].replace(':', ''), th = +tz.slice(1, 3), tm = +tz.slice(3, 5);
    if (th > 23 || tm > 59) return null;
    offset = (th * 60 + tm) * 60 * (tz[0] === '+' ? 1 : -1);
  }
  return Math.floor(d.getTime() / 1000) - offset;
}
function validChar(n) {
  return n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) ||
    (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);
}
function xmlText(value, literal) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw failure('EPG_XML');
  if (literal) return value;
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(value)) throw failure('EPG_XML');
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, function (_, name) {
    if (name[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name];
    var n = name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!validChar(n)) throw failure('EPG_XML');
    if (n <= 0xffff) return String.fromCharCode(n);
    n -= 0x10000; return String.fromCharCode(0xd800 + (n >> 10), 0xdc00 + (n & 1023));
  });
}
function attributes(source) {
  var result = Object.create(null), rest = source;
  while (rest.length) {
    if (/^\s*$/.test(rest)) break;
    var m = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(rest);
    if (!m || Object.prototype.hasOwnProperty.call(result, m[1]) || /</.test(m[3])) throw failure('EPG_XML');
    result[m[1]] = xmlText(m[3], false); rest = rest.slice(m[0].length);
  }
  return result;
}

/* Small streaming XML lexer, not an HTML/regex scraper. It validates nesting and
 * the single <tv> root; no DTD or external entity is ever loaded or expanded.
 * A DOCTYPE naming an external DTD is tolerated, but internal subsets/ENTITY
 * declarations are rejected. onProgramme can return false to apply backpressure. */
function createXmltvParser(options) {
  options = options || {};
  var decoder = new StringDecoder('utf8'), buffer = '', stack = [], programme = null;
  var opened = false, closed = false, ended = false, paused = false, bytes = 0, seen = 0;
  var maxBytes = options.maxBytes || MAX_FEED, blockLimit = options.maxProgrammeBytes || MAX_PROGRAMME;
  function count(raw) {
    if (programme) {
      programme.bytes += Buffer.byteLength(raw, 'utf8');
      if (programme.bytes > blockLimit) throw failure('EPG_LIMIT');
    }
  }
  function text(raw, cdata) {
    count(raw);
    var decoded = xmlText(raw, cdata);
    if (!stack.length && /\S/.test(decoded.replace(/^\ufeff/, ''))) throw failure('EPG_XML');
    if (programme && stack.length && stack[stack.length - 1].field) {
      programme[stack[stack.length - 1].field] += decoded;
    }
  }
  function token(raw) {
    count(raw);
    if (raw.slice(0, 4) === '<!--') {
      if (/--/.test(raw.slice(4, -3))) throw failure('EPG_XML');
      return;
    }
    if (raw.slice(0, 9) === '<![CDATA[') {
      if (!stack.length) throw failure('EPG_XML');
      // The wrapper has already been counted.
      var data = xmlText(raw.slice(9, -3), true);
      if (programme && stack[stack.length - 1].field) programme[stack[stack.length - 1].field] += data;
      return;
    }
    if (raw.slice(0, 2) === '<?') {
      if (!/^<\?[A-Za-z_][\w:.-]*(?:\s[\s\S]*)?\?>$/.test(raw)) throw failure('EPG_XML');
      return;
    }
    if (raw.slice(0, 2) === '<!') {
      if (opened || !/^<!DOCTYPE\s+tv(?:\s+(?:SYSTEM\s+(?:"[^"<>]*"|'[^'<>]*')|PUBLIC\s+(?:"[^"<>]*"|'[^'<>]*')\s+(?:"[^"<>]*"|'[^'<>]*')))?\s*>$/.test(raw)) throw failure('EPG_XML');
      return;
    }
    var close = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(raw);
    if (close) {
      if (!stack.length || stack[stack.length - 1].name !== close[1]) throw failure('EPG_XML');
      stack.pop();
      if (close[1] === 'programme') {
        if (!programme || stack.length !== 1) throw failure('EPG_XML');
        var complete = programme; programme = null; seen++;
        complete.title = complete.title.trim(); complete.description = complete.description.trim();
        if (options.onProgramme && options.onProgramme(complete) === false) paused = true;
      }
      if (!stack.length) closed = true;
      return;
    }
    var start = /^<([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(raw);
    if (!start || closed) throw failure('EPG_XML');
    var attrs = attributes(start[2]), name = start[1], selfClosing = !!start[3];
    if (!stack.length) {
      if (opened || name !== 'tv' || selfClosing) throw failure('EPG_XML');
      opened = true;
    }
    var field = stack.length ? stack[stack.length - 1].field : null;
    if (name === 'programme') {
      if (stack.length !== 1 || !attrs.channel || !attrs.start || !attrs.stop || selfClosing) throw failure('EPG_XML');
      programme = { channel: attrs.channel, start: attrs.start, stop: attrs.stop,
        title: '', description: '', category: '', bytes: Buffer.byteLength(raw, 'utf8'), fields: Object.create(null) };
    } else if (programme && stack.length === 2) {
      field = name === 'title' ? 'title' : name === 'desc' ? 'description' : name === 'category' ? 'category' : null;
      if (field) {
        if (programme.fields[field]) field = null;
        else programme.fields[field] = true;
      }
    }
    if (!selfClosing) stack.push({ name: name, field: field });
  }
  function process(final) {
    paused = false;
    while (buffer.length && !paused) {
      if (buffer[0] !== '<') {
        var next = buffer.indexOf('<'), size = next;
        if (next === -1) {
          size = buffer.length;
          if (!final) {
            var amp = buffer.lastIndexOf('&');
            if (amp !== -1 && buffer.indexOf(';', amp) === -1) size = amp;
            // Keep two characters so a split illegal ]]> is detected.
            if (/\]{1,2}$/.test(buffer.slice(0, size))) size -= /\]\]$/.test(buffer.slice(0, size)) ? 2 : 1;
          }
        }
        if (size) {
          var rawText = buffer.slice(0, size);
          if (rawText.indexOf(']]>') !== -1) throw failure('EPG_XML');
          text(rawText, false); buffer = buffer.slice(size);
        }
        if (next === -1 || !size) break;
        continue;
      }
      var end = -1;
      if (buffer.slice(0, 4) === '<!--') {
        end = buffer.indexOf('-->', 4); if (end !== -1) end += 3;
      } else if (buffer.slice(0, 9) === '<![CDATA[') {
        end = buffer.indexOf(']]>', 9); if (end !== -1) end += 3;
      } else if (buffer.slice(0, 2) === '<?') {
        end = buffer.indexOf('?>', 2); if (end !== -1) end += 2;
      } else {
        var quoted = '';
        for (var i = 1; i < buffer.length; i++) {
          var c = buffer[i];
          if (quoted) { if (c === quoted) quoted = ''; }
          else if (c === '"' || c === "'") quoted = c;
          else if (c === '>') { end = i + 1; break; }
        }
      }
      if (end === -1) {
        if (buffer.length > blockLimit || final) throw failure(final ? 'EPG_XML' : 'EPG_LIMIT');
        break;
      }
      if (end > blockLimit) throw failure('EPG_LIMIT');
      var raw = buffer.slice(0, end); buffer = buffer.slice(end); token(raw);
    }
    if (buffer.length > blockLimit && !paused) throw failure('EPG_LIMIT');
    return !paused;
  }
  return {
    write: function (chunk) {
      if (ended || paused) throw failure('EPG_XML');
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), 'utf8');
      if (bytes > maxBytes) throw failure('EPG_LIMIT');
      buffer += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
      return process(false);
    },
    resume: function () { return process(false); },
    end: function () {
      if (paused || ended) throw failure('EPG_XML');
      ended = true; buffer += decoder.end(); process(true);
      if (buffer.length || stack.length || !opened || !closed) throw failure('EPG_XML');
      return { programmes: seen, bytes: bytes };
    },
    stats: function () { return { programmes: seen, bytes: bytes }; }
  };
}

function mkdir(dir) {
  return new Promise(function (resolve, reject) {
    fs.mkdir(dir, 448, function (e) { if (e && e.code !== 'EEXIST') reject(failure('EPG_IO')); else resolve(); });
  });
}
function readFile(file) {
  return new Promise(function (resolve, reject) {
    fs.readFile(file, 'utf8', function (e, data) { if (e) reject(failure('EPG_IO')); else resolve(data); });
  });
}
function remove(file) { return new Promise(function (resolve) { fs.unlink(file, function () { resolve(); }); }); }
function lastSuccess(options) {
  try {
    var value = JSON.parse(fs.readFileSync(path.join(options.workDir, 'epg-last-success.json'), 'utf8'));
    return typeof value.lastSuccess === 'string' ? value.lastSuccess : null;
  } catch (_) { return null; }
}
function saveSuccess(options, result) {
  var target = path.join(options.workDir, 'epg-last-success.json'), temp = target + '.' + process.pid + '.tmp';
  return new Promise(function (resolve) {
    fs.writeFile(temp, JSON.stringify(result), { mode: 384 }, function (e) {
      if (e) return resolve();
      fs.rename(temp, target, function () { resolve(); });
    });
  });
}
function mapping(catalog, currentId) {
  var byId = Object.create(null), selected = [], used = Object.create(null);
  (catalog || []).forEach(function (channel) {
    if (!channel || typeof channel.code !== 'string' || channel.code.indexOf('xtream_') !== 0 || /[\x00-\x1f]/.test(channel.code) || used[channel.code]) return;
    if (currentId != null && String(channel.id) !== String(currentId)) return;
    used[channel.code] = true; selected.push(channel);
    var id = String(channel.epgId || '').trim();
    if (id) (byId[id] || (byId[id] = [])).push(channel);
  });
  return { byId: byId, selected: selected };
}
function windowFor(options) {
  var now = options.now == null ? Math.floor(Date.now() / 1000) : Math.floor(Number(options.now));
  var hours = options.windowHours == null ? 36 : Number(options.windowHours);
  if (!isFinite(now) || !isFinite(hours) || hours <= 0 || hours > 168) throw failure('EPG_CONFIG');
  return { from: now - 7200, to: now + Math.floor(hours * 3600) };
}
function sqlRows(p, channel, writeProgramme) {
  var id = 'xtream_' + crypto.createHash('sha1').update(channel.code + '\x00' + p.start + '\x00' + p.end).digest('hex');
  return (writeProgramme ? 'INSERT OR REPLACE INTO PBS_BROADCAST_PROGRAM(contents_id,seq_no,summary,org_genre_code,com_genre_code,use_flag) VALUES(' +
    [p.contentsId, '0', p.description || '', channel.genreCode || '', channel.genreCode || '', '0'].map(quote).join(',') + ');\n' : '') +
    'INSERT OR REPLACE INTO PBS_BROADCAST_SCHEDULE(schd_id,contents_id,seq_no,chan_code,start_time,end_time,schd_pgm_ttl,startTimeLong,endTimeLong,use_flag) VALUES(' +
    [id, p.contentsId, '0', channel.code, utc(p.start), utc(p.end), p.title, p.start, p.end, '0'].map(quote).join(',') + ');\n';
}
function SqlWriter(file, schema, options, window) {
  this.output = fs.createWriteStream(file, { mode: 384 });
  this.error = null; this.closed = false; this.blocked = false; this.pending = null; this.rows = 0;
  this.writtenProgrammes = new Set();
  this.channels = Object.create(null); this.options = options; this.window = window;
  var self = this;
  this.output.on('error', function () { self.error = failure('EPG_IO'); });
  this.output.on('close', function () { self.closed = true; });
  this.output.write('.bail on\n.timeout 5000\nPRAGMA journal_mode=OFF;\nPRAGMA synchronous=OFF;\nPRAGMA temp_store=FILE;\nPRAGMA cache_size=-4096;\n' + schema + '\nBEGIN;\n');
}
SqlWriter.prototype.flush = function () {
  if (this.error) throw this.error;
  cancelled(this.options);
  while (this.pending && !this.blocked) {
    var pending = this.pending, channel = pending.channels[pending.index++];
    if (++this.rows > MAX_ROWS) throw failure('EPG_LIMIT');
    var first = !this.writtenProgrammes.has(pending.programme.contentsId);
    var sql = sqlRows(pending.programme, channel, first);
    if (first) this.writtenProgrammes.add(pending.programme.contentsId);
    this.channels[channel.code] = true;
    if (this.rows % 1000 === 0) sql += 'COMMIT;\nBEGIN;\n';
    if (pending.index === pending.channels.length) this.pending = null;
    this.blocked = !this.output.write(sql);
  }
  return !this.blocked;
};
SqlWriter.prototype.add = function (programme, channels) {
  if (!channels || !channels.length) return true;
  var start = typeof programme.start === 'number' ? programme.start : parseXmltvTime(programme.start);
  var end = typeof programme.end === 'number' ? programme.end : parseXmltvTime(programme.stop);
  if (start == null || end == null || end <= start || start >= this.window.to || end <= this.window.from || !programme.title.trim()) return true;
  var title = programme.title.trim(), description = programme.description || '';
  var identity = String(programme.channel || channels[0].epgId || 'stream:' + channels[0].id);
  var contentsId = 'xtream_p_' + crypto.createHash('sha1').update(identity + '\x00' + start + '\x00' + end + '\x00' + title + '\x00' + description).digest('hex');
  this.pending = { index: 0, channels: channels, programme: {
    start: start, end: end, title: title, description: description, contentsId: contentsId
  } };
  return this.flush();
};
SqlWriter.prototype.ready = function () {
  var self = this;
  if (this.error) return Promise.reject(this.error);
  if (!this.blocked) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    var off = observeAbort(self.options.signal, function () { done(failure('EPG_CANCELLED')); });
    function done(e) {
      self.output.removeListener('drain', drain); self.output.removeListener('error', error); off();
      if (e) reject(e); else { self.blocked = false; resolve(); }
    }
    function drain() { done(); }
    function error() { done(failure('EPG_IO')); }
    self.output.once('drain', drain); self.output.once('error', error);
    if (self.options.signal && self.options.signal.aborted) done(failure('EPG_CANCELLED'));
  });
};
SqlWriter.prototype.finish = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    if (self.error) return reject(self.error);
    self.output.once('error', function () { reject(failure('EPG_IO')); });
    self.output.end('COMMIT;\nPRAGMA quick_check;\nSELECT COUNT(*),COUNT(DISTINCT chan_code) FROM PBS_BROADCAST_SCHEDULE;\n', function () {
      if (self.error) reject(self.error); else resolve();
    });
  });
};
SqlWriter.prototype.close = function () {
  var self = this;
  if (self.closed) return Promise.resolve();
  return new Promise(function (resolve) {
    self.output.once('close', resolve);
    self.output.destroy();
  });
};

function sqlite(options, db, input, isFile) {
  return new Promise(function (resolve, reject) {
    cancelled(options);
    var proc, reader, output = '', settled = false, timedOut = false;
    try { proc = child.spawn(options.sqlitePath || '/usr/bin/sqlite3', ['-batch', db], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (_) { return reject(failure('EPG_SQLITE')); }
    var timeout = setTimeout(function () { timedOut = true; proc.kill('SIGKILL'); }, options.sqliteTimeoutMs || 120000);
    var off = observeAbort(options.signal, function () { proc.kill('SIGKILL'); });
    function done(e) {
      if (settled) return; settled = true; clearTimeout(timeout); off();
      if (reader) reader.destroy();
      if (e) reject(e); else resolve(output);
    }
    proc.stdout.on('data', function (data) { if (output.length < 4096) output += data.toString('utf8').slice(0, 4096 - output.length); });
    // Drain diagnostics, but never surface paths or SQL containing provider text.
    proc.stderr.on('data', function () {});
    proc.on('error', function () { done(failure('EPG_SQLITE')); });
    proc.on('close', function (code) {
      if (code === 0 && !timedOut) return done();
      done(failure(options.signal && options.signal.aborted ? 'EPG_CANCELLED' : 'EPG_SQLITE'));
    });
    proc.stdin.on('error', function () {}); // Early sqlite exit is handled by close.
    if (isFile) {
      reader = fs.createReadStream(input); reader.on('error', function () { proc.kill('SIGKILL'); done(failure('EPG_IO')); }); reader.pipe(proc.stdin);
    } else proc.stdin.end(input);
  });
}
function openSource(location, options, maxBytes, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    cancelled(options);
    var parsed = url.parse(location);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || redirects > 4) return reject(failure('EPG_DOWNLOAD'));
    var request, response, decoded, finished = false, total = 0;
    var off = function () {}, timer;
    function cleanup() { clearTimeout(timer); off(); }
    function fail(e) {
      if (finished) return; finished = true; cleanup();
      if (request) request.destroy(); if (response) response.destroy(); if (decoded && decoded !== response) decoded.destroy();
      reject(safeError(e, 'EPG_DOWNLOAD'));
    }
    try {
      request = (parsed.protocol === 'https:' ? https : http).get(Object.assign({}, parsed, { headers: {
        'User-Agent': 'VLC/3.0.21', 'Accept': 'application/xml,text/xml,application/json', 'Accept-Encoding': 'gzip'
      } }), function (res) {
        response = res;
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          var target = url.resolve(location, res.headers.location); res.resume(); finished = true; cleanup();
          return resolve(openSource(target, options, maxBytes, redirects + 1));
        }
        if (res.statusCode !== 200) return fail(failure('EPG_DOWNLOAD'));
        var encoding = String(res.headers['content-encoding'] || '').toLowerCase().trim();
        if (encoding && encoding !== 'identity' && encoding !== 'gzip' && encoding !== 'x-gzip') return fail(failure('EPG_DOWNLOAD'));
        decoded = encoding === 'gzip' || encoding === 'x-gzip' ? res.pipe(zlib.createGunzip()) : res;
        var limiter = new stream.Transform({ transform: function (chunk, _, cb) {
          total += chunk.length;
          if (total > maxBytes) cb(failure('EPG_LIMIT'));
          else { try { cancelled(options); cb(null, chunk); } catch (e) { cb(e); } }
        } });
        function destroySource(e) {
          cleanup(); request.destroy(); response.destroy();
          if (decoded !== response) decoded.destroy();
          limiter.destroy(e);
        }
        off(); off = observeAbort(options.signal, function () { destroySource(failure('EPG_CANCELLED')); });
        res.on('aborted', function () { destroySource(failure('EPG_DOWNLOAD')); });
        res.on('error', function () { destroySource(failure('EPG_DOWNLOAD')); });
        decoded.on('error', function () { destroySource(failure('EPG_DOWNLOAD')); });
        limiter.on('error', function () { cleanup(); request.destroy(); });
        limiter.on('end', cleanup);
        finished = true;
        decoded.pipe(limiter);
        resolve({ readable: limiter, close: function () { destroySource(); } });
      });
    } catch (_) { return fail(failure('EPG_DOWNLOAD')); }
    request.on('error', function () { fail(failure('EPG_DOWNLOAD')); });
    request.setTimeout(options.requestTimeoutMs || 30000, function () {
      if (finished && decoded) decoded.destroy(failure('EPG_DOWNLOAD')); else fail(failure('EPG_DOWNLOAD'));
    });
    off = observeAbort(options.signal, function () { fail(failure('EPG_CANCELLED')); });
    timer = setTimeout(function () {
      if (finished && decoded) decoded.destroy(failure('EPG_DOWNLOAD')); else fail(failure('EPG_DOWNLOAD'));
    }, options.downloadTimeoutMs || 300000);
  });
}
function location(account, endpoint, query) {
  if (!account || typeof account.url !== 'string' || typeof account.username !== 'string' || typeof account.password !== 'string') throw failure('EPG_CONFIG');
  var base = account.url.replace(/\/+$/, ''), parsed = url.parse(base);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.search || parsed.hash) throw failure('EPG_CONFIG');
  return base + '/' + endpoint + '?username=' + encodeURIComponent(account.username) + '&password=' + encodeURIComponent(account.password) + (query || '');
}
function consumeXml(readable, writer, map, options) {
  return new Promise(function (resolve, reject) {
    var ended = false, lastReport = 0, parser = createXmltvParser({
      onProgramme: function (programme) { return writer.add(programme, map.byId[programme.channel]); }
    });
    async function resumeParser() {
      do { await writer.ready(); writer.flush(); } while (writer.blocked);
      while (!parser.resume()) {
        do { await writer.ready(); writer.flush(); } while (writer.blocked);
      }
    }
    var sink = new stream.Writable({ write: function (chunk, _, cb) {
      (async function () {
        cancelled(options);
        if (!parser.write(chunk)) await resumeParser();
        if (Date.now() - lastReport > 1000) {
          lastReport = Date.now(); progress(options, { phase: 'download', source: 'xmltv', bytes: parser.stats().bytes, programmes: writer.rows });
        }
      })().then(function () { cb(); }, function (e) { cb(safeError(e, 'EPG_XML')); });
    } });
    function done(e) {
      if (ended) return; ended = true;
      readable.unpipe(sink); readable.destroy();
      if (e) { sink.destroy(); reject(safeError(e, 'EPG_XML')); } else resolve();
    }
    readable.on('error', done); sink.on('error', done);
    sink.on('finish', function () {
      try { var stats = parser.end(); if (!stats.programmes || !writer.rows) throw failure('EPG_EMPTY'); done(); }
      catch (e) { done(e); }
    });
    readable.pipe(sink);
  });
}
async function merge(options, stage, schema, window, statistics, source) {
  cancelled(options);
  progress(options, { phase: 'commit', source: source, programmes: statistics.programmes, channels: statistics.channels });
  var prefix = "substr(chan_code,1,7)='xtream_'";
  var sql = '.bail on\n.timeout 5000\nPRAGMA temp_store=FILE;\nPRAGMA cache_size=-4096;\nATTACH DATABASE ' + quote(stage) + ' AS epg_in;\nBEGIN IMMEDIATE;\n' + schema + '\n' +
    'CREATE INDEX IF NOT EXISTS IDX_XTREAM_CHANNEL_START ON PBS_BROADCAST_SCHEDULE(chan_code,startTimeLong);\n' +
    'CREATE INDEX IF NOT EXISTS IDX_XTREAM_CONTENTS ON PBS_BROADCAST_SCHEDULE(contents_id,seq_no);\n' +
    'DELETE FROM PBS_BROADCAST_SCHEDULE WHERE ' + prefix + ' AND (endTimeLong<=' + window.from + ' OR (chan_code IN (SELECT DISTINCT chan_code FROM epg_in.PBS_BROADCAST_SCHEDULE) AND startTimeLong<' + window.to + ' AND endTimeLong>' + window.from + '));\n' +
    'INSERT OR REPLACE INTO PBS_BROADCAST_PROGRAM SELECT * FROM epg_in.PBS_BROADCAST_PROGRAM;\n' +
    'INSERT OR REPLACE INTO PBS_BROADCAST_SCHEDULE SELECT * FROM epg_in.PBS_BROADCAST_SCHEDULE;\n' +
    "DELETE FROM PBS_BROADCAST_PROGRAM WHERE substr(contents_id,1,7)='xtream_' AND NOT EXISTS (SELECT 1 FROM PBS_BROADCAST_SCHEDULE s WHERE s.contents_id=PBS_BROADCAST_PROGRAM.contents_id AND s.seq_no=PBS_BROADCAST_PROGRAM.seq_no);\nCOMMIT;\n";
  await sqlite(options, options.dbPath, sql, false);
  var result = { programmes: statistics.programmes, channels: statistics.channels, source: source, lastSuccess: new Date().toISOString() };
  await saveSuccess(options, result);
  progress(options, Object.assign({ phase: 'complete' }, result));
  return result;
}
async function staged(options, source, populate) {
  cancelled(options);
  var window = windowFor(options);
  await mkdir(options.workDir);
  var schema = await readFile(options.schemaPath);
  var base = path.join(options.workDir, 'epg-' + process.pid + '-' + crypto.randomBytes(8).toString('hex'));
  var sqlFile = base + '.sql', stage = base + '.db', writer;
  try {
    writer = new SqlWriter(sqlFile, schema, options, window);
    await populate(writer);
    cancelled(options);
    if (!writer.rows) throw failure('EPG_EMPTY');
    await writer.finish();
    progress(options, { phase: 'stage', source: source, programmes: writer.rows });
    var output = await sqlite(options, stage, sqlFile, true);
    var lines = output.trim().split(/\r?\n/), match = /^(\d+)\|(\d+)$/.exec(lines[lines.length - 1]);
    if (!match || lines.indexOf('ok') === -1 || +match[1] < 1 || +match[2] < 1) throw failure('EPG_SQLITE');
    return await merge(options, stage, schema, window, { programmes: +match[1], channels: +match[2] }, source);
  } finally {
    if (writer) await writer.close();
    await Promise.all([remove(sqlFile), remove(stage), remove(stage + '-journal'), remove(stage + '-wal'), remove(stage + '-shm')]);
  }
}
async function xmltv(options, supplied) {
  var map = mapping(options.catalog);
  if (!Object.keys(map.byId).length) throw failure('EPG_EMPTY');
  var opened;
  try {
    return await staged(options, 'xmltv', async function (writer) {
      opened = supplied ? { readable: supplied, close: function () { supplied.destroy(); } } :
        await openSource(location(options.account, 'xmltv.php'), options, MAX_FEED);
      await consumeXml(opened.readable, writer, map, options);
    });
  } finally { if (opened) opened.close(); }
}
function providerText(value) {
  var text = String(value || ''), compact = text.replace(/\s/g, '');
  if (compact && compact.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    var decoded = Buffer.from(compact, 'base64').toString('utf8');
    if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(decoded)) return decoded;
  }
  return text;
}
async function shortEpg(options) {
  if (options.currentStreamId == null) throw failure('EPG_EMPTY');
  var map = mapping(options.catalog, options.currentStreamId);
  if (!map.selected.length) throw failure('EPG_EMPTY');
  var opened;
  try {
    opened = await openSource(location(options.account, 'player_api.php', '&action=get_short_epg&stream_id=' + encodeURIComponent(options.currentStreamId) + '&limit=48'), options, 2 * 1024 * 1024);
    var json = await new Promise(function (resolve, reject) {
      var chunks = [];
      opened.readable.on('data', function (chunk) { chunks.push(chunk); });
      opened.readable.on('error', function (e) { reject(safeError(e, 'EPG_DOWNLOAD')); });
      opened.readable.on('end', function () {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(failure('EPG_XML')); }
      });
    });
    if (!json || !Array.isArray(json.epg_listings) || !json.epg_listings.length) throw failure('EPG_EMPTY');
    return await staged(options, 'short', async function (writer) {
      for (var i = 0; i < json.epg_listings.length; i++) {
        cancelled(options);
        var p = json.epg_listings[i], start = Number(p.start_timestamp), end = Number(p.stop_timestamp || p.end_timestamp);
        if (!isFinite(start) || !isFinite(end) || start < 100000000 || Math.floor(start) !== start || Math.floor(end) !== end) continue;
        if (!writer.add({ start: start, end: end, title: providerText(p.title), description: providerText(p.description) }, map.selected)) {
          do { await writer.ready(); writer.flush(); } while (writer.blocked);
        }
      }
    });
  } finally { if (opened) opened.close(); }
}
async function locked(options, operation) {
  options = options || {};
  if (!options.dbPath || !options.schemaPath || !options.workDir || !Array.isArray(options.catalog)) throw failure('EPG_CONFIG');
  var key = path.resolve(options.dbPath);
  if (active[key]) throw failure('EPG_BUSY');
  active[key] = true;
  try { return await operation(options); }
  catch (e) { var safe = safeError(e); safe.lastSuccess = lastSuccess(options); throw safe; }
  finally { delete active[key]; }
}
function refresh(options) {
  return locked(options, async function (o) {
    try { return await xmltv(o); }
    catch (e) {
      var error = safeError(e);
      if (error.code === 'EPG_CANCELLED' || o.currentStreamId == null) throw error;
      progress(o, { phase: 'fallback', source: 'short', error: error.code });
      return shortEpg(o);
    }
  });
}
function refreshCurrent(options) { return locked(options, shortEpg); }

module.exports = {
  refresh: refresh,
  refreshCurrent: refreshCurrent,
  parseXmltvTime: parseXmltvTime,
  createXmltvParser: createXmltvParser,
  utc: utc,
  // Offline validation uses the exact staging/merge path without reading an account.
  _test: { importStream: function (options, readable) { return locked(options, function (o) { return xmltv(o, readable); }); },
    decodeEntities: function (text) { return xmlText(text, false); }, providerText: providerText }
};
