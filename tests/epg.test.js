'use strict';

/* Offline tests: no credentials, provider traffic, or TV access. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var child = require('child_process');
var stream = require('stream');
var zlib = require('zlib');
var http = require('http');
var EventEmitter = require('events').EventEmitter;
var epg = require('../runtime/lib/epg');
var schemaPath = path.join(__dirname, '..', 'runtime/guide-schema.sql');
var schema = fs.readFileSync(schemaPath, 'utf8');
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function parse(xml, size) {
  var programmes = [], parser = epg.createXmltvParser({ onProgramme: function (p) { programmes.push(p); } });
  var bytes = Buffer.from(xml, 'utf8');
  for (var i = 0; i < bytes.length; i += size || bytes.length) parser.write(bytes.slice(i, i + (size || bytes.length)));
  var stats = parser.end(); return { programmes: programmes, stats: stats };
}
function source(xml, chunkSize) {
  var bytes = Buffer.isBuffer(xml) ? xml : Buffer.from(xml, 'utf8'), offset = 0;
  return new stream.Readable({ read: function () {
    if (offset === bytes.length) return this.push(null);
    var end = Math.min(offset + (chunkSize || 37), bytes.length);
    this.push(bytes.slice(offset, end)); offset = end;
  } });
}
function query(db, sql) {
  var result = child.spawnSync('/usr/bin/sqlite3', ['-batch', db], { input: sql, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, 'sqlite test setup/query failed');
  return result.stdout.trim();
}
function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'xtream-epg-test-')); }
function clean(location) {
  fs.readdirSync(location).forEach(function (name) {
    var file = path.join(location, name);
    if (fs.statSync(file).isDirectory()) clean(file); else fs.unlinkSync(file);
  });
  fs.rmdirSync(location);
}
function options(workDir) {
  return { dbPath: path.join(workDir, 'guide.db'), schemaPath: schemaPath, workDir: workDir,
    now: epg.parseXmltvTime('20261025003000 +0000'),
    catalog: [
      { id: 1, code: 'xtream_one', epgId: 'example', genreCode: '100' },
      { id: 2, code: 'xtream_two', epgId: 'example', genreCode: '100' },
      { id: 3, code: 'native_unowned', epgId: 'example' }
    ] };
}
function programme(channel, start, stop, title) {
  return '<programme channel="' + channel + '" start="' + start + '" stop="' + stop + '"><title>' + (title || 'News') + '</title><desc>Guide &amp; description</desc></programme>';
}
var valid = '<?xml version="1.0" encoding="UTF-8"?><tv>' +
  programme('example', '20261025023000 +0200', '20261025023000 +0100', 'Nouvelles 世界 📺') + '</tv>';

test('explicit timezone offsets distinguish both occurrences of a DST hour', function () {
  var a = epg.parseXmltvTime('20261025023000 +0200'), b = epg.parseXmltvTime('20261025023000 +0100');
  assert.strictEqual(b - a, 3600);
  assert.strictEqual(epg.utc(a), '2026,10,25,00,30,00');
  assert.strictEqual(epg.parseXmltvTime('20261024233000 -0100'), a);
  assert.strictEqual(epg.parseXmltvTime('20261025003000Z'), a);
  assert.strictEqual(epg.parseXmltvTime('20261025003000'), a);
  assert.strictEqual(epg.parseXmltvTime('20260230003000 +0000'), null);
  assert.strictEqual(epg.parseXmltvTime('20261025243000 +0000'), null);
  assert.strictEqual(epg.parseXmltvTime('20261025003000 Europe/Berlin'), null);
});
test('one-byte chunks preserve UTF-8, CDATA, attributes, and numeric entities', function () {
  var xml = '<!DOCTYPE tv SYSTEM "xmltv.dtd"><tv><channel id="x&amp;y"><display-name>世界</display-name></channel>' +
    '<programme stop="20261025033000 +0100" channel="x&amp;y" start="20261025023000 +0200"><title><![CDATA[世界 📺 & News]]></title>' +
    '<desc>Rock &amp; Roll &#x1F4FA; &#233; &lt;live&gt;</desc><title lang="fr">Ignored translation</title></programme></tv>';
  var result = parse(xml, 1);
  assert.strictEqual(result.programmes[0].channel, 'x&y');
  assert.strictEqual(result.programmes[0].title, '世界 📺 & News');
  assert.strictEqual(result.programmes[0].description, 'Rock & Roll 📺 é <live>');
  assert.strictEqual(result.stats.programmes, 1);
});
test('parser rejects malformed XML, HTML login pages, and entity expansion', function () {
  ['<tv><programme channel="x" start="x" stop="y"><title>bad</programme></tv>',
    '<html><body>Login</body></html>', '<tv></tv><tv></tv>',
    '<tv><channel id="x">bad &unknown;</channel></tv>', '<tv><!-- bad -- comment --></tv>',
    '<!DOCTYPE tv [<!ENTITY secret SYSTEM "file:///etc/passwd">]><tv></tv>',
    '<tv><channel id="x" id="duplicate"/></tv>', '<tv><channel id="x">a]]>b</channel></tv>'
  ].forEach(function (xml) { assert.throws(function () { parse(xml, 2); }, /EPG_XML/); });
});
test('programme block and decompressed byte limits are enforced', function () {
  assert.throws(function () { parse('<tv>' + programme('x', '20261025003000Z', '20261025013000Z', 'a'.repeat(65536)) + '</tv>', 19); }, /EPG_LIMIT/);
  var p = epg.createXmltvParser({ maxBytes: 10 });
  assert.throws(function () { p.write(Buffer.from('<tv>       </tv>')); }, /EPG_LIMIT/);
});
test('parser callback applies backpressure without losing the next programme', function () {
  var rows = [], p = epg.createXmltvParser({ onProgramme: function (row) { rows.push(row); return false; } });
  assert.strictEqual(p.write(Buffer.from('<tv>' + programme('one', '20261025003000Z', '20261025013000Z') + programme('two', '20261025003000Z', '20261025013000Z') + '</tv>')), false);
  assert.strictEqual(rows.length, 1); assert.strictEqual(p.resume(), false); assert.strictEqual(rows.length, 2);
  assert.strictEqual(p.resume(), true); assert.strictEqual(p.end().programmes, 2);
});
test('staged import maps one EPG ID to multiple channels and preserves native data', async function () {
  var workDir = dir(), o = options(workDir);
  try {
    query(o.dbPath, schema + "INSERT INTO PBS_BROADCAST_PROGRAM(contents_id,seq_no,use_flag) VALUES('native_p','0','0'),('xtream_orphan','0','0'),('xtream_old','0','0');" +
      "INSERT INTO PBS_BROADCAST_SCHEDULE(schd_id,contents_id,seq_no,chan_code,startTimeLong,endTimeLong,use_flag) VALUES('native_s','native_p','0','native_unowned',1,2,'0'),('xtream_old','xtream_old','0','xtream_removed',1,2,'0');");
    var result = await epg._test.importStream(o, source(valid, 1));
    assert.strictEqual(result.programmes, 2); assert.strictEqual(result.channels, 2); assert.strictEqual(result.source, 'xmltv');
    assert.strictEqual(query(o.dbPath, 'SELECT chan_code FROM PBS_BROADCAST_SCHEDULE ORDER BY chan_code;'), 'native_unowned\nxtream_one\nxtream_two');
    assert.strictEqual(query(o.dbPath, "SELECT COUNT(*) FROM PBS_BROADCAST_PROGRAM WHERE contents_id IN ('xtream_old','xtream_orphan');"), '0');
    assert.strictEqual(query(o.dbPath, "SELECT start_time||'|'||end_time||'|'||schd_pgm_ttl FROM PBS_BROADCAST_SCHEDULE WHERE chan_code='xtream_one';"), '2026,10,25,00,30,00|2026,10,25,01,30,00|Nouvelles 世界 📺');
    assert.strictEqual(query(o.dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='IDX_XTREAM_CHANNEL_START';"), '1');
    assert.strictEqual(query(o.dbPath, "SELECT COUNT(*) FROM PBS_BROADCAST_PROGRAM WHERE contents_id='native_p';"), '1');
    assert.strictEqual(query(o.dbPath, "SELECT COUNT(*) FROM PBS_BROADCAST_PROGRAM WHERE substr(contents_id,1,7)='xtream_';"), '1', 'quality variants share one programme record');
    assert.strictEqual(query(o.dbPath, "SELECT COUNT(DISTINCT contents_id) FROM PBS_BROADCAST_SCHEDULE WHERE substr(chan_code,1,7)='xtream_';"), '1');
    assert.strictEqual(query(o.dbPath, "SELECT COUNT(*) FROM PBS_BROADCAST_SCHEDULE s JOIN PBS_BROADCAST_PROGRAM p ON p.contents_id=s.contents_id AND p.seq_no=s.seq_no WHERE substr(s.chan_code,1,7)='xtream_' AND p.summary='Guide & description';"), '2', 'both native schedules join to the shared summary');
  } finally { clean(workDir); }
});
test('empty, unmapped, malformed, login, and failed streams never clobber the last guide', async function () {
  var workDir = dir(), o = options(workDir);
  try {
    await epg._test.importStream(o, source(valid));
    var before = query(o.dbPath, 'SELECT * FROM PBS_BROADCAST_SCHEDULE ORDER BY schd_id;');
    var failures = ['<tv></tv>', '<html>secret password in login page</html>', valid.slice(0, -3),
      '<tv>' + programme('not-mapped', '20261025003000Z', '20261025013000Z') + '</tv>',
      '<tv>' + programme('example', '20261024003000Z', '20261024013000Z') + '</tv>'];
    for (var i = 0; i < failures.length; i++) {
      try { await epg._test.importStream(o, source(failures[i])); assert.fail('expected failure'); }
      catch (e) { assert(/^EPG_/.test(e.message)); assert(e.lastSuccess); assert(!/secret|password/.test(e.message)); }
      assert.strictEqual(query(o.dbPath, 'SELECT * FROM PBS_BROADCAST_SCHEDULE ORDER BY schd_id;'), before);
    }
    var broken = new stream.Readable({ read: function () { this.destroy(new Error('secret provider URL')); } });
    try { await epg._test.importStream(o, broken); assert.fail('expected failure'); }
    catch (e) { assert.strictEqual(e.message, 'EPG_XML'); }
    assert.strictEqual(query(o.dbPath, 'SELECT * FROM PBS_BROADCAST_SCHEDULE ORDER BY schd_id;'), before);
  } finally { clean(workDir); }
});
test('sqlite failure and cancellation preserve a previously successful import', async function () {
  var workDir = dir(), o = options(workDir);
  try {
    await epg._test.importStream(o, source(valid));
    var before = query(o.dbPath, 'SELECT * FROM PBS_BROADCAST_SCHEDULE;');
    o.sqlitePath = '/no-such-sqlite';
    try { await epg._test.importStream(o, source(valid)); assert.fail('expected failure'); }
    catch (e) { assert.strictEqual(e.code, 'EPG_SQLITE'); }
    assert.strictEqual(query(o.dbPath, 'SELECT * FROM PBS_BROADCAST_SCHEDULE;'), before);
    delete o.sqlitePath;
    query(o.dbPath, "CREATE TRIGGER deny_merge BEFORE INSERT ON PBS_BROADCAST_SCHEDULE BEGIN SELECT RAISE(ABORT,'test blocked'); END;");
    try { await epg._test.importStream(o, source(valid)); assert.fail('expected merge failure'); }
    catch (e) { assert.strictEqual(e.code, 'EPG_SQLITE'); }
    assert.strictEqual(query(o.dbPath, 'SELECT * FROM PBS_BROADCAST_SCHEDULE;'), before, 'failed merge must roll back its preceding deletion');
    query(o.dbPath, 'DROP TRIGGER deny_merge;');
    o.signal = { aborted: false };
    o.onProgress = function (p) { if (p.phase === 'download') o.signal.aborted = true; };
    try { await epg._test.importStream(o, source(valid)); assert.fail('expected failure'); }
    catch (e) { assert.strictEqual(e.code, 'EPG_CANCELLED'); }
    assert.strictEqual(query(o.dbPath, 'SELECT * FROM PBS_BROADCAST_SCHEDULE;'), before);
  } finally { clean(workDir); }
});
test('full-feed failure requests short EPG for only the current stream', async function () {
  var workDir = dir(), o = options(workDir), original = http.get, requests = [];
  o.account = { url: 'http://offline.invalid', username: 'dummy-user', password: 'dummy-password' };
  o.currentStreamId = 1;
  http.get = function (requestOptions, callback) {
    requests.push(requestOptions.path);
    var req = new EventEmitter();
    req.destroy = function () {};
    req.setTimeout = function () { return req; };
    process.nextTick(function () {
      var xmlRequest = requestOptions.pathname === '/xmltv.php';
      var body = xmlRequest ? '<html>Login</html>' : JSON.stringify({ epg_listings: [{
        start_timestamp: String(o.now), stop_timestamp: String(o.now + 3600),
        title: Buffer.from('Current show 世界').toString('base64'), description: Buffer.from('Current description').toString('base64')
      }] });
      var res = source(zlib.gzipSync(Buffer.from(body)), 11);
      res.statusCode = 200; res.headers = { 'content-encoding': 'gzip' }; callback(res);
    });
    return req;
  };
  try {
    var result = await epg.refresh(o);
    assert.strictEqual(result.source, 'short'); assert.strictEqual(result.channels, 1); assert.strictEqual(result.programmes, 1);
    assert.strictEqual(requests.length, 2);
    assert(/\/xmltv\.php\?/.test(requests[0]));
    assert(/action=get_short_epg&stream_id=1&limit=48/.test(requests[1]));
    assert.strictEqual(query(o.dbPath, 'SELECT chan_code FROM PBS_BROADCAST_SCHEDULE;'), 'xtream_one');
    assert.strictEqual(query(o.dbPath, 'SELECT schd_pgm_ttl FROM PBS_BROADCAST_SCHEDULE;'), 'Current show 世界');
    assert(!fs.readFileSync(path.join(workDir, 'epg-last-success.json'), 'utf8').match(/dummy|password/));
  } finally { http.get = original; clean(workDir); }
});
test('gzip-decoded XML and large mapped catalogs use streaming writes', async function () {
  var workDir = dir(), o = options(workDir);
  try {
    o.catalog = [];
    for (var i = 0; i < 21000; i++) o.catalog.push({ id: i, code: 'xtream_' + i, epgId: 'example' });
    var decoded = source(zlib.gzipSync(Buffer.from(valid)), 17).pipe(zlib.createGunzip());
    var result = await epg._test.importStream(o, decoded);
    assert.strictEqual(result.programmes, 21000); assert.strictEqual(result.channels, 21000);
    assert.strictEqual(query(o.dbPath, 'SELECT COUNT(*) FROM PBS_BROADCAST_SCHEDULE;'), '21000');
    assert.strictEqual(query(o.dbPath, 'SELECT COUNT(*) FROM PBS_BROADCAST_PROGRAM;'), '1');
    assert.deepStrictEqual(fs.readdirSync(workDir).filter(function (name) { return /^epg-\d/.test(name); }), []);
  } finally { clean(workDir); }
});

(async function () {
  for (var i = 0; i < tests.length; i++) {
    await tests[i].fn(); process.stdout.write('ok - ' + tests[i].name + '\n');
  }
  process.stdout.write(tests.length + ' EPG tests passed\n');
})().catch(function (e) { process.stderr.write((e.stack || String(e)) + '\n'); process.exitCode = 1; });
