'use strict';
// Synthetic schemas and short anchor snippets: no firmware or TV backups.
var assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
var catalog=require('../runtime/lib/catalog'),db=require('../runtime/lib/native-db'),prepare=require('../runtime/prepare');
var template=require('../runtime/native-template.json'),schema=fs.readFileSync(path.join(__dirname,'../runtime/guide-schema.sql'),'utf8');
var tmp=fs.mkdtempSync(path.join(os.tmpdir(),'xtream-native-test-')),tests=0;
function query(sql){return cp.execFileSync('/usr/bin/sqlite3',['-batch','-bail',path.join(tmp,'channels')],{input:sql,encoding:'utf8'}).trim();}
function test(name,fn){fn();tests++;console.log('ok - '+name);}
function remove(dir){fs.readdirSync(dir).forEach(function(f){var p=path.join(dir,f);if(fs.statSync(p).isDirectory())remove(p);else fs.unlinkSync(p);});fs.rmdirSync(dir);}
var cats=[{category_id:'1',category_name:"News & O'Clock"},{category_id:'2',category_name:'Sports'}];
function stream(id,category){return {stream_id:id,category_id:category||'1',name:'Test '+id,epg_channel_id:'example'};}
var library;
try{
test('catalogue rejects empty or drastically truncated provider replies',function(){
  assert.throws(function(){catalog.build([],[]);});
  library=catalog.build(cats,[stream(1),stream(2),stream(3,'2'),{stream_id:9,name:'#### HEADER ####'},stream(1)]);
  assert.strictEqual(library.channels.length,3);assert.strictEqual(library.headersSkipped,1);
  assert.throws(function(){catalog.build(cats,[stream(1)],library);},/less than half/);
});
test('numbers remain stable across provider ordering, removals and returns',function(){
  var a=catalog.build(cats,[stream(3,'2'),stream(1),stream(2)],library);
  assert.strictEqual(a.channels[0].number,1003);
  var b=catalog.build(cats,[stream(1),stream(3,'2')],a);
  var c=catalog.build(cats,[stream(4),stream(2),stream(1),stream(3,'2')],b);
  assert.strictEqual(c.channels[1].number,1002);assert.strictEqual(c.channels[0].number,1004);
  assert.strictEqual(c.channels[0].nativeId,'11_3_1004_65535_0_0_0');
});
test('category filtering imports only selected rows, including an empty selection',function(){
  var Manager=require('../runtime/lib/manager'),filter=Manager.prototype.filter;
  assert.strictEqual(filter(library,['2']).channels.length,1);
  assert.strictEqual(filter(library,[]).channels.length,0);
});
test('boot loads only the selected catalogue and defers the full library until needed',function(){
  var Manager=require('../runtime/lib/manager'),base=path.join(tmp,'lazy-manager');fs.mkdirSync(base);
  var selected={channels:[{id:'kept',nativeId:'owned'}],categories:[]};
  fs.writeFileSync(path.join(base,'catalog.private.json'),JSON.stringify(selected));
  fs.writeFileSync(path.join(base,'library.private.json'),JSON.stringify({channels:[],categories:[{id:'old'}]}));
  var manager=new Manager(base),full={channels:[{id:'kept'},{id:'unselected'}],categories:[{id:'all'}]};
  fs.writeFileSync(path.join(base,'library.private.json'),JSON.stringify(full));
  assert.strictEqual(manager.catalog.channels.length,1);assert.strictEqual(manager.selection().categories[0].id,'all');
  fs.writeFileSync(path.join(base,'library.private.json'),'invalid later content');
  assert.strictEqual(manager.library.channels.length,2);
  var updated={channels:[],categories:[]};manager.library=updated;assert.strictEqual(manager.library,updated);
});
test('an existing management token does not request unused startup randomness',function(){
  var Manager=require('../runtime/lib/manager'),crypto=require('crypto'),random=crypto.randomBytes,base=path.join(tmp,'saved-token');fs.mkdirSync(base);
  fs.writeFileSync(path.join(base,'settings.private.json'),JSON.stringify({token:'synthetic-existing-token'}));
  crypto.randomBytes=function(){throw new Error('Unexpected entropy request');};
  try{assert.strictEqual(new Manager(base).settings.token,'synthetic-existing-token');}finally{crypto.randomBytes=random;}
});
test('existing-account playback construction does not load unused TLS or crypto modules',function(){
  var base=path.join(tmp,'http-only-boot');fs.mkdirSync(base);fs.writeFileSync(path.join(base,'settings.private.json'),JSON.stringify({token:'synthetic-existing-token'}));
  var code="var Module=require('module'),load=Module._load;Module._load=function(name){if(name==='https'||name==='crypto')throw new Error('Unused boot module '+name);return load.apply(this,arguments);};var Manager=require('./runtime/lib/manager');require('./runtime/lib/proxy')(new Manager(process.argv[1]));";
  cp.execFileSync(process.execPath,['-e',code,base],{cwd:path.join(__dirname,'..')});
});
test('initial metadata refresh waits for decoded video or a bounded fallback and runs once',function(){
  var Manager=require('../runtime/lib/manager'),oldSet=global.setTimeout,oldClear=global.clearTimeout,timer,cleared=0,syncs=0;
  global.setTimeout=function(callback,ms){assert.strictEqual(ms,30000);timer=callback;return {unref:function(){}};};global.clearTimeout=function(){cleared++;};
  function fixture(){var m=Object.create(Manager.prototype);Object.assign(m,{settings:{account:{},syncHours:6},history:{},sync:{running:false},guide:{running:false},catalog:{channels:[]},player:{},startSync:function(){syncs++;}});return m;}
  try{
    var m=fixture();m.queueInitialRefresh();assert.strictEqual(syncs,0);m.beginInitialRefresh();timer();assert.strictEqual(syncs,1);
    m=fixture();m.queueInitialRefresh();timer();assert.strictEqual(syncs,2);
    m=fixture();m.player={active:true,readyState:2,width:1280,height:720};m.queueInitialRefresh();assert.strictEqual(syncs,3);
    m=fixture();m.sync.running=true;m.queueInitialRefresh();timer();assert.strictEqual(syncs,3);assert(cleared>=4);
  }finally{global.setTimeout=oldSet;global.clearTimeout=oldClear;}
});
query('CREATE TABLE ip('+Object.keys(template).map(function(k){return k+(typeof template[k]==='number'?' NUMERIC':' TEXT');}).join(',')+'); CREATE TABLE pbs_genre_base(genre_code TEXT,genre_type TEXT,version TEXT,genre_name TEXT,use_flag TEXT,reserved_1 TEXT,genreFavoritePoint NUMERIC,PRIMARY KEY(genre_code,genre_type));');
test('native imports quote names and preserve favourites, locks, groups and unrelated rows',function(){
  query(db.script(library));
  query("UPDATE ip SET locked_flag=1,favoriteIdxA=4,chan_gr_list='[0,2]' WHERE chan_code='xtream_1'; INSERT INTO ip(dvc_chan_id,chan_code) VALUES('native','stock');");
  library.channels[0].name="O'Clock 世界";
  query(db.script(library));
  assert.strictEqual(query("SELECT chan_std_name||'|'||locked_flag||'|'||favoriteIdxA||'|'||chan_gr_list FROM ip WHERE chan_code='xtream_1';"),"O'Clock 世界|1|4|[0,2]");
  assert.strictEqual(query("SELECT count(*) FROM ip WHERE chan_code='stock';"),'1');
  query(db.script({channels:[],categories:[]}));
  assert.strictEqual(query('SELECT count(*) FROM ip;'),'1');assert.strictEqual(query('SELECT count(*) FROM pbs_genre_base;'),'0');
});
test('large native SQL import is streamed without an argv-size limit',function(){
  var channels=[];for(var i=1;i<=21001;i++)channels.push(stream(i));
  var large=catalog.build(cats,channels);query(db.script(large));
  assert.strictEqual(query("SELECT count(*) FROM ip WHERE substr(chan_code,1,7)='xtream_';"),'21001');
});
var sources={};sources['main.qml']='    function launched() {\n        lifeCycleController.registerApp();\n    }';
sources[prepare.relatives[1]]='visible: systemProperties.country === "KOR" || systemProperties.country === "USA"';
sources[prepare.relatives[2]]='    signal channelListChanged()\nif (systemProperties.country === "KOR" || systemProperties.country === "USA") {\n}\n        console.log("[ChannelInterfaces] onIsChannelListPageReadyChanged: " + isChannelListPageReady);';
test('QML patches dirty the cache before registration and refresh without waiting for page readiness',function(){
  var patched=prepare.patchSources(sources),main=patched['main.qml'],interfaces=patched[prepare.relatives[2]];
  assert(main.indexOf('refreshXtreamView();')<main.indexOf('registerApp();'));
  assert(interfaces.indexOf('root.needToUpdateChannelList = true;')<interfaces.indexOf('xtreamResumeRefresh.restart();'));
  assert(interfaces.indexOf('root.isChannelListPageReady ? "notify" : "init"')>=0);
  assert.throws(function(){prepare.patchSources(patched);},/anchor/);
  var bad=Object.assign({},sources);bad['main.qml']+='\n        lifeCycleController.registerApp();';
  assert.throws(function(){prepare.patchSources(bad);},/anchor/);
});
test('doctor validates synthetic channel, genre and Guide schemas without writing',function(){
  prepare.relatives.forEach(function(f){var target=path.join(tmp,f),parent=path.dirname(target);fs.mkdirSync(parent,{recursive:true});fs.writeFileSync(target,sources[f]);});
  var guide=path.join(tmp,'guide');cp.execFileSync('/usr/bin/sqlite3',[guide],{input:schema});
  var options={base:tmp,template:template,guideSchema:schema,channelDb:path.join(tmp,'channels'),guideDb:guide,qmlRoot:tmp};
  assert.strictEqual(prepare.inspect(options).qml,'anchors-match');
  query("INSERT INTO pbs_genre_base(genre_code,genre_type,reserved_1) VALUES('998','S','native');");
  assert.strictEqual(prepare.inspect(options).compatible,true);
  query("INSERT INTO pbs_genre_base(genre_code,genre_type,reserved_1) VALUES('150','S','other');");
  assert.throws(function(){prepare.inspect(options);},/already in use/);
  query("DELETE FROM pbs_genre_base WHERE reserved_1='other'; ALTER TABLE ip ADD COLUMN unexpected TEXT;");
  assert.throws(function(){prepare.inspect(options);},/Unsupported native ip schema/);
  assert(!fs.existsSync(path.join(tmp,'patches')));
});
console.log(tests+' native tests passed');
}finally{remove(tmp);}
