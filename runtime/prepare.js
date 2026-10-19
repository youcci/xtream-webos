'use strict';
// Generate overlays from the owner's firmware. No LG QML is shipped in this repo.
var fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
var QML='/usr/palm/applications/com.webos.app.livemenu/qml';
var CHANNEL_DB='/mnt/lg/cmn_data/iepg/db/channel.sql';
var GUIDE_DB='/tmp/epg/PBS_EPG_DB.db';
var RELATIVES=['main.qml','Pages/Page1/Components/SettingPopupFeed.qml','Controllers/ChannelInterfaces/Interfaces.qml'];
var COUNTRY='systemProperties.country === "KOR" || systemProperties.country === "USA"';
var GENRES=' || systemProperties.channelGenreList.some(function(g) { var code = Number(g.channelGenreCode); return code >= 100 && code <= 997; })';
var REFRESH=[
'',
'    // Refresh a cached native Guide on every launch, including removals.',
'    function refreshXtreamView() {',
'        root.needToUpdateChannelList = true;',
'        xtreamResumeRefresh.restart();',
'    }',
'',
'    Connections {',
'        target: systemProperties',
'        onIsAppRunningChanged: {',
'            if (systemProperties.isAppRunning) {',
'                xtreamResumeRefresh.restart();',
'            } else {',
'                root.needToUpdateChannelList = true;',
'            }',
'        }',
'    }',
'',
'    Timer {',
'        id: xtreamResumeRefresh',
'        interval: 150',
'        onTriggered: {',
'            if (!systemProperties.isAppRunning || !root.services) return;',
'            root.services["getGenreMapTable"]({"type":2,"genreType":1}, function(response) {',
'                if (response.returnValue && response.genreItemList) {',
'                    systemProperties.channelGenreList = response.genreItemList;',
'                    var selectedGenre = systemProperties.channelGenreCode;',
'                    if (!response.genreItemList.some(function(g) { return Number(g.channelGenreCode) === selectedGenre; })) {',
'                        systemProperties.tunerGenreCode = 0;',
'                        systemProperties.stbGenreCode = 0;',
'                    }',
'                }',
'                if (systemProperties.isAppRunning) {',
'                    root.callChannelList(root.isChannelListPageReady ? "notify" : "init");',
'                } else {',
'                    root.needToUpdateChannelList = true;',
'                }',
'            });',
'        }',
'    }',
''
].join('\n');
function once(source,needle,replacement,label){
  if(source.split(needle).length!==2)throw new Error('Unsupported firmware: expected one '+label+' anchor.');
  return source.replace(needle,replacement);
}
function patchSources(sources){
  var out={};RELATIVES.forEach(function(f){if(typeof sources[f]!=='string')throw new Error('Missing QML: '+f);out[f]=sources[f];});
  var feed=RELATIVES[1],interfaces=RELATIVES[2];
  out[feed]=once(out[feed],COUNTRY,COUNTRY+GENRES,'genre-country');
  out[interfaces]=once(out[interfaces],'if ('+COUNTRY+') {','if ('+COUNTRY+GENRES+') {','genre-model');
  out[interfaces]=once(out[interfaces],'    signal channelListChanged()','    signal channelListChanged()\n'+REFRESH,'channel refresh signal');
  var ready='        console.log("[ChannelInterfaces] onIsChannelListPageReadyChanged: " + isChannelListPageReady);';
  out[interfaces]=once(out[interfaces],ready,ready+'\n        if (isChannelListPageReady && systemProperties.isAppRunning) xtreamResumeRefresh.restart();','channel readiness');
  var register='        lifeCycleController.registerApp();';
  out['main.qml']=once(out['main.qml'],register,'        if (interfaces.channels) interfaces.channels.refreshXtreamView();\n'+register,'app launch');
  return out;
}
function mkdir(dir){if(fs.existsSync(dir))return;mkdir(path.dirname(dir));fs.mkdirSync(dir,448);}
function columns(db,table,sqlite){if(!fs.existsSync(db))throw new Error('Required native database is missing: '+db);return cp.execFileSync(sqlite||'/usr/bin/sqlite3',['-batch',db,'PRAGMA table_info('+table+');'],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(function(line){return line.split('|')[1];});}
function expectedGuide(schema){var out={};schema.replace(/CREATE TABLE IF NOT EXISTS (\w+) \(([^;]+)\);/g,function(_,table,body){out[table]=body.split(', PRIMARY KEY')[0].split(',').map(function(c){return c.trim().split(/\s+/)[0];});return _;});return out;}
function inspect(options){
  options=options||{};
  var base=options.base||__dirname,template=options.template||JSON.parse(fs.readFileSync(path.join(base,'native-template.json'),'utf8'));
  var schema=options.guideSchema||fs.readFileSync(path.join(base,'guide-schema.sql'),'utf8');
  var db=options.channelDb||CHANNEL_DB,guide=options.guideDb||GUIDE_DB,root=options.qmlRoot||QML;
  var expected=Object.keys(template),actual=columns(db,'ip',options.sqlite);
  if(actual.length!==expected.length||expected.some(function(c){return actual.indexOf(c)<0;}))throw new Error('Unsupported native ip schema; no writes were performed.');
  var genres=columns(db,'pbs_genre_base',options.sqlite);
  ['genre_code','genre_type','version','genre_name','use_flag','reserved_1','genreFavoritePoint'].forEach(function(c){if(genres.indexOf(c)<0)throw new Error('Unsupported native genre schema.');});
  var collisions=cp.execFileSync(options.sqlite||'/usr/bin/sqlite3',['-batch',db,"SELECT count(*) FROM pbs_genre_base WHERE genre_type='S' AND CAST(genre_code AS INTEGER) BETWEEN 100 AND 997 AND COALESCE(reserved_1,'')!='XTREAM';"],{encoding:'utf8'}).trim();
  if(Number(collisions))throw new Error('Native genre codes 100–997 are already in use by another provider.');
  var guideColumns=expectedGuide(schema);
  if(fs.existsSync(guide))Object.keys(guideColumns).forEach(function(t){var got=columns(guide,t,options.sqlite);if(got.length&&JSON.stringify(got)!==JSON.stringify(guideColumns[t]))throw new Error('Unsupported native Guide schema: '+t);});
  var sources={},alreadyPatched=false;
  RELATIVES.forEach(function(f){var original=path.join(base,'originals',f);sources[f]=fs.readFileSync(fs.existsSync(original)?original:path.join(root,f),'utf8');if(sources[f].indexOf('refreshXtreamView')>=0)alreadyPatched=true;});
  if(!alreadyPatched)patchSources(sources);
  return {compatible:true,channelColumns:actual.length,guideSchemaChecked:fs.existsSync(guide),qml:alreadyPatched?'existing-xtream-overlay':'anchors-match',sources:sources};
}
function generate(base){
  var result=inspect({base:base});
  if(result.qml!=='anchors-match')throw new Error('Existing manual overlays detected. Back up and follow docs/MIGRATION.md.');
  var patches=patchSources(result.sources);
  RELATIVES.forEach(function(f){var original=path.join(base,'originals',f),patched=path.join(base,'patches',f);mkdir(path.dirname(original));mkdir(path.dirname(patched));if(!fs.existsSync(original))fs.writeFileSync(original,result.sources[f],{mode:384});fs.writeFileSync(patched,patches[f],{mode:384});});
  fs.writeFileSync(path.join(base,'firmware-profile.json'),JSON.stringify({channelColumns:result.channelColumns,guideBinarySha256:crypto.createHash('sha256').update(fs.readFileSync('/usr/bin/com.webos.app.livemenu')).digest('hex')},null,2),{mode:384});
}
exports.patchSources=patchSources;exports.inspect=inspect;exports.expectedGuide=expectedGuide;exports.relatives=RELATIVES;
if(require.main===module){
  try{
    if(process.argv[2]==='--check-schema'){
      var c=columns(CHANNEL_DB,'ip'),t=Object.keys(require('./native-template.json'));
      if(c.length!==t.length||t.some(function(k){return c.indexOf(k)<0;}))throw new Error('Native schema changed. Disable hooks and review compatibility before starting.');
      var profile=JSON.parse(fs.readFileSync(path.join(__dirname,'firmware-profile.json'),'utf8'));
      var hash=crypto.createHash('sha256').update(fs.readFileSync('/usr/bin/com.webos.app.livemenu')).digest('hex');
      if(hash!==profile.guideBinarySha256)throw new Error('Guide firmware changed. Recheck QML compatibility before starting.');
    }else{generate(__dirname);console.log('Generated private on-device QML overlays.');}
  }catch(e){console.error(e.message);process.exitCode=1;}
}
