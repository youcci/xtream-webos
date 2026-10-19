'use strict';
var assert=require('assert'),Watchdog=require('../runtime/lib/playback-watchdog');
var tests=[];
function test(name,run){tests.push({name:name,run:run});}
function fixture(){
  var f={time:100000,calls:[],foreground:'com.webos.app.livetv',running:true,selected:{returnValue:true,channelId:'owned',isLocked:false},channel:{returnValue:true,channelId:'owned',channelChange:'unlocked'}};
  f.manager={player:{},byNative:{owned:{}}};
  f.call=function(uri,payload){
    f.calls.push({method:uri.split('/').pop(),payload:payload});
    if(/getForegroundAppInfo$/.test(uri))return Promise.resolve({appId:f.foreground});
    if(/bind$/.test(uri))return Promise.resolve({returnValue:true,binded:true,broadcastId:'main'});
    if(/getCurrentChannel$/.test(uri))return Promise.resolve({returnValue:true,channel:f.selected});
    if(/running$/.test(uri))return Promise.resolve({running:f.running?[{id:'com.webos.app.livedmost'}]:[]});
    if(/getChannel$/.test(uri)){if(!f.running)throw new Error('absent player would never respond');return Promise.resolve(f.channel);}
    if(/launch$/.test(uri)&&payload.id==='com.webos.app.livedmost')f.running=true;
    if(/setDmostUrl$/.test(uri))f.manager.playerReadyAt=++f.time;
    return Promise.resolve({returnValue:true});
  };
  f.watch=new Watchdog(f.manager,{now:function(){return f.time;},sleep:function(){return Promise.resolve();},call:function(uri,payload){return f.call(uri,payload);}});
  f.time+=31000;return f;
}
test('missing player for an owned, unlocked LiveTV channel is reloaded once',async function(){
  var f=fixture();assert.strictEqual(await f.watch.tick(),true);
  assert.strictEqual(f.calls.filter(function(c){return c.method==='setDmostUrl';}).length,1);
  assert.strictEqual(f.watch.state.reloads,1);
  var count=f.calls.length;assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.calls.length,count);
  f.time+=60000;assert.strictEqual(await f.watch.tick(),true);
});
test('healthy heartbeats and startup grace avoid native requests',async function(){
  var f=fixture();f.manager.player={updatedAt:f.time-2000,active:true};
  assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.calls.length,0);
  f.manager.player={};f.time-=30000;assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.calls.length,0);
});
test('other foreground apps are never interrupted',async function(){
  for(var app of ['netflix','com.webos.app.hdmi1','com.webos.app.home']){
    var f=fixture();f.foreground=app;assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.calls.length,1);
  }
});
test('other inputs, unknown channels and locked/stopped states never reload',async function(){
  var channels=[{channelId:'_'},{channelId:'foreign'},{channelId:'owned',returnValue:false}];
  ['locked','blocked','stop','deactivate'].forEach(function(state){channels.push({channelId:'owned',channelChange:state});});
  for(var channel of channels){var f=fixture();f.channel=channel;assert.strictEqual(await f.watch.tick(),false);assert(!f.calls.some(function(c){return /^(launch|setDmostUrl)$/.test(c.method);}));}
});
test('a heartbeat received during native inspection cancels recovery',async function(){
  var f=fixture(),call=f.call;
  f.call=function(uri,payload){if(/getChannel$/.test(uri))f.manager.player={updatedAt:f.time,active:true};return call(uri,payload);};
  assert.strictEqual(await f.watch.tick(),false);assert(!f.calls.some(function(c){return c.method==='setDmostUrl';}));
});
test('native failures are sanitized and retries are limited',async function(){
  var f=fixture();f.call=function(){return Promise.reject(new Error('sensitive native error details'));};
  assert.strictEqual(await f.watch.tick(),false);
  assert.strictEqual(f.watch.state.lastError,'Native player recovery unavailable at foreground');assert.strictEqual(f.watch.busy,false);
  var checks=f.watch.state.checks;assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.watch.state.checks,checks);
});
test('overlapping native probes cannot reload twice',async function(){
  var f=fixture(),release,call=f.call;
  f.call=function(uri,payload){if(/getForegroundAppInfo$/.test(uri)&&!release)return new Promise(function(resolve){release=resolve;});return call(uri,payload);};
  var pending=f.watch.tick();await Promise.resolve();await Promise.resolve();
  assert.strictEqual(await f.watch.tick(),false);release({appId:f.foreground});
  assert.strictEqual(await pending,true);assert.strictEqual(f.watch.state.reloads,1);
});
test('missing app is started before WAM queries and the selected channel is replayed',async function(){
  var f=fixture();f.running=false;assert.strictEqual(await f.watch.tick(),true);
  assert(!f.calls.some(function(c){return c.method==='getChannel';}));
  var changes=f.calls.filter(function(c){return /^(launch|setDmostUrl|changeChannel)$/.test(c.method);});
  assert.strictEqual(changes[0].payload.id,'com.webos.app.livedmost');assert.strictEqual(changes[1].method,'setDmostUrl');
  assert.strictEqual(changes[2].method,'changeChannel');assert.strictEqual(changes[2].payload.channelId,'owned');assert.strictEqual(changes[2].payload.broadcastId,'main');assert.strictEqual(changes[2].payload.update,true);assert.strictEqual(f.watch.state.starts,1);assert.strictEqual(f.watch.state.replays,1);
});
test('RF, foreign and locked selection prevents a missing-app launch',async function(){
  for(var selected of [{channelId:'RF',isLocked:false},{channelId:'foreign',isLocked:false},{channelId:'owned',isLocked:true},{channelId:'owned'},{returnValue:false}]){
    var f=fixture();f.running=false;f.selected=selected;assert.strictEqual(await f.watch.tick(),false);assert(!f.calls.some(function(c){return /^(launch|setDmostUrl)$/.test(c.method);}));
  }
});
test('fresh inactive telemetry gets transition grace then repairs an uninitialized player',async function(){
  var f=fixture();f.manager.player={updatedAt:f.time,active:false};f.channel={channelId:'_',channelChange:'unlocked'};
  assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.calls.length,0);
  f.time+=20000;f.manager.player.updatedAt=f.time;assert.strictEqual(await f.watch.tick(),true);assert.strictEqual(f.watch.state.replays,1);
});
test('switching to RF during startup prevents channel replay',async function(){
  var f=fixture(),call=f.call;f.running=false;
  f.call=function(uri,payload){if(/setDmostUrl$/.test(uri))f.selected={channelId:'RF',isLocked:false};return call(uri,payload);};
  assert.strictEqual(await f.watch.tick(),true);assert.strictEqual(f.watch.state.replays,0);
});
test('a changed selection before repair cancels all mutations',async function(){
  var f=fixture(),call=f.call,reads=0;f.running=false;
  f.call=function(uri,payload){if(/getCurrentChannel$/.test(uri)&&++reads===2)f.selected={channelId:'foreign',isLocked:false};return call(uri,payload);};
  assert.strictEqual(await f.watch.tick(),false);assert(!f.calls.some(function(c){return /^(launch|setDmostUrl)$/.test(c.method);}));
});
test('player launch readiness has a finite deadline',async function(){
  var f=fixture(),call=f.call;f.running=false;
  f.call=function(uri,payload){if(/launch$/.test(uri)){f.calls.push({method:'launch',payload:payload});return Promise.resolve({returnValue:true});}return call(uri,payload);};
  assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.watch.state.lastError,'Native player recovery unavailable at waiting-player');
  assert.strictEqual(f.calls.filter(function(c){return c.method==='setDmostUrl';}).length,0);
});
test('invalid app inventory never causes a speculative launch',async function(){
  var f=fixture(),call=f.call;f.call=function(uri,payload){return /running$/.test(uri)?Promise.resolve({returnValue:true}):call(uri,payload);};
  assert.strictEqual(await f.watch.tick(),false);assert(!f.calls.some(function(c){return /^(launch|setDmostUrl)$/.test(c.method);}));
});
test('a loaded app must acknowledge page readiness before any native retune',async function(){
  var f=fixture(),call=f.call;f.running=false;
  f.call=function(uri,payload){if(/setDmostUrl$/.test(uri)){f.calls.push({method:'setDmostUrl',payload:payload});return Promise.resolve({returnValue:true});}return call(uri,payload);};
  assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.watch.state.lastError,'Native player recovery unavailable at waiting-page');
  assert.strictEqual(f.calls.filter(function(c){return c.method==='changeChannel';}).length,0);
});
(async function(){for(var t of tests){await t.run();console.log('ok - '+t.name);}console.log(tests.length+' playback recovery tests passed');}()).catch(function(e){console.error(e);process.exitCode=1;});
