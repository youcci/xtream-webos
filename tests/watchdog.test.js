'use strict';
var assert=require('assert'),Watchdog=require('../runtime/lib/playback-watchdog');
var tests=[];
function test(name,run){tests.push({name:name,run:run});}
function fixture(){
  var f={time:100000,calls:[],foreground:'com.webos.app.livetv',channel:{returnValue:true,channelId:'owned',channelChange:'unlocked'}};
  f.manager={player:{},byNative:{owned:{}}};
  f.call=function(uri,payload){
    f.calls.push({method:uri.split('/').pop(),payload:payload});
    if(/getForegroundAppInfo$/.test(uri))return Promise.resolve({appId:f.foreground});
    if(/getChannel$/.test(uri))return Promise.resolve(f.channel);
    return Promise.resolve({returnValue:true});
  };
  f.watch=new Watchdog(f.manager,{now:function(){return f.time;},call:function(uri,payload){return f.call(uri,payload);}});
  f.time+=31000;return f;
}
test('missing player for an owned, unlocked LiveTV channel is reloaded once',async function(){
  var f=fixture();assert.strictEqual(await f.watch.tick(),true);
  assert.deepStrictEqual(f.calls.map(function(c){return c.method;}),['getForegroundAppInfo','getChannel','setDmostUrl']);
  assert.strictEqual(f.calls[1].payload.subscribe,false);assert.strictEqual(f.watch.state.reloads,1);
  assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.calls.length,3);
  f.time+=60000;assert.strictEqual(await f.watch.tick(),true);
});
test('healthy heartbeats and startup grace avoid native requests',async function(){
  var f=fixture();f.manager.player.updatedAt=f.time-2000;
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
  for(var channel of channels){var f=fixture();f.channel=channel;assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.calls.length,2);}
});
test('a heartbeat received during native inspection cancels recovery',async function(){
  var f=fixture(),call=f.call;
  f.call=function(uri,payload){if(/getChannel$/.test(uri))f.manager.player.updatedAt=f.time;return call(uri,payload);};
  assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.calls.length,2);
});
test('native failures are sanitized and retries are limited',async function(){
  var f=fixture();f.call=function(){return Promise.reject(new Error('sensitive native error details'));};
  assert.strictEqual(await f.watch.tick(),false);
  assert.strictEqual(f.watch.state.lastError,'Native player recovery unavailable');assert.strictEqual(f.watch.busy,false);
  var checks=f.watch.state.checks;assert.strictEqual(await f.watch.tick(),false);assert.strictEqual(f.watch.state.checks,checks);
});
test('overlapping native probes cannot reload twice',async function(){
  var f=fixture(),release,call=f.call;
  f.call=function(uri,payload){if(/getForegroundAppInfo$/.test(uri))return new Promise(function(resolve){release=resolve;});return call(uri,payload);};
  var pending=f.watch.tick();await Promise.resolve();
  assert.strictEqual(await f.watch.tick(),false);release({appId:f.foreground});
  assert.strictEqual(await pending,true);assert.strictEqual(f.watch.state.reloads,1);
});
(async function(){for(var t of tests){await t.run();console.log('ok - '+t.name);}console.log(tests.length+' playback recovery tests passed');}()).catch(function(e){console.error(e);process.exitCode=1;});
