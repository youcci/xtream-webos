'use strict';
var assert=require('assert'),fs=require('fs'),Manager=require('../runtime/lib/manager'),u=require('../runtime/lib/util');
var tests=[];
function test(name,run){tests.push({name:name,run:run});}
function fixture(){
  var m=Object.create(Manager.prototype);
  Object.assign(m,{history:{lastChannelId:'owned'},byNative:{owned:{nativeId:'owned',code:'xtream_1'}},activeAccount:{},player:{}});
  return m;
}
function row(){return {channelId:'owned',chanCode:'xtream_1',IPChannelCode:'xtream_1',channelMode:'IP',playerService:'com.webos.service.dmost',locked:false,skipped:false,Invisible:false};}
test('one-row readiness requires an exact owned, visible and unlocked IP descriptor',async function(){
  var oldCall=u.luna,oldExists=fs.existsSync,reply;
  fs.existsSync=function(file){return file==='/run/xtream-native/early-start'?true:oldExists(file);};
  u.luna=function(uri,payload){assert.strictEqual(uri,'luna://com.webos.service.iepg/getChannelInfo');assert.deepStrictEqual(payload,{dataType:0,channelId:'owned'});return Promise.resolve(reply);};
  try{
    reply={returnValue:true,channelListCount:1,channelList:[row()]};var m=fixture();assert.strictEqual(await m.checkStartupTarget(),true);assert.strictEqual(m.startupTargetReady,'owned');
    var invalid=[{returnValue:false},{returnValue:true,channelListCount:0,channelList:[]},{returnValue:true,channelListCount:1,channelList:[row(),row()]}];
    for(var changes of [{channelId:'foreign'},{chanCode:'foreign'},{IPChannelCode:'foreign'},{channelMode:'Terrestrial'},{playerService:'other'},{locked:true},{skipped:true},{Invisible:true}])invalid.push({returnValue:true,channelListCount:1,channelList:[Object.assign(row(),changes)]});
    for(var key of ['channelId','chanCode','IPChannelCode','channelMode','playerService','locked','skipped','Invisible']){var r=row();delete r[key];invalid.push({returnValue:true,channelListCount:1,channelList:[r]});}
    for(reply of invalid){m=fixture();assert.strictEqual(await m.checkStartupTarget(),false);assert.strictEqual(m.startupTargetReady,undefined);}
    u.luna=function(){return Promise.reject(new Error('private details'));};assert.strictEqual(await fixture().checkStartupTarget(),false);
  }finally{u.luna=oldCall;fs.existsSync=oldExists;}
});
test('ordinary starts, removed channels and missing accounts never use the early gate',async function(){
  var oldCall=u.luna,oldExists=fs.existsSync,early=false,calls=0;
  fs.existsSync=function(file){return file==='/run/xtream-native/early-start'?early:oldExists(file);};u.luna=function(){calls++;return Promise.resolve({});};
  try{
    assert.strictEqual(await fixture().checkStartupTarget(),false);early=true;
    var m=fixture();delete m.byNative.owned;assert.strictEqual(await m.checkStartupTarget(),false);
    m=fixture();delete m.byNative.owned.code;assert.strictEqual(await m.checkStartupTarget(),false);
    m=fixture();m.activeAccount=null;assert.strictEqual(await m.checkStartupTarget(),false);assert.strictEqual(calls,0);
  }finally{u.luna=oldCall;fs.existsSync=oldExists;}
});
test('maintenance deferral ends on playback or its deadline and excludes competing writes',async function(){
  var oldSet=global.setTimeout,oldClear=global.clearTimeout,timer,cleared=0;
  global.setTimeout=function(callback,ms){assert.strictEqual(ms,30000);timer=callback;return {unref:function(){}};};global.clearTimeout=function(){cleared++;};
  try{
    var m=fixture(),resolved=false,p=m.waitStartupPlayback().then(function(){resolved=true;});await Promise.resolve();assert.strictEqual(resolved,false);assert.strictEqual(m.startupMaintenancePending,true);
    m.sync={running:false};m.guide={running:false};assert.throws(function(){m.select([]);},/Wait/);assert.throws(function(){m.startSync();},/startup/);assert.throws(function(){m.startGuide();},/startup/);
    await assert.rejects(m.save({}),/Wait/);m.releaseNativeStartup();await p;m.releaseNativeStartup();assert.strictEqual(resolved,true);
    m=fixture();p=m.waitStartupPlayback();timer();await p;
    m=fixture();m.player={active:true,readyState:2,width:1280,height:720};await m.waitStartupPlayback();assert(cleared>=3);
  }finally{global.setTimeout=oldSet;global.clearTimeout=oldClear;}
});
(async function(){for(var t of tests){await t.run();console.log('ok - '+t.name);}console.log(tests.length+' early native readiness tests passed');}()).catch(function(e){console.error(e);process.exitCode=1;});
