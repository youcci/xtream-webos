'use strict';
var assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),Resume=require('../runtime/lib/startup-resume');
var tests=[];
function test(name,run){tests.push({name:name,run:run});}
function fallback(){return {channelId:'1_0_1_0_0_0_0',channelName:'',channelModeName:'Terrestrial',isSkipped:true,isLocked:false};}
function fixture(options){
  options=options||{};
  var f={time:100000,uptime:80,calls:[],foreground:'com.webos.app.livetv',channel:fallback(),claimed:false};
  f.manager={base:'/unused',history:{lastChannelId:'owned'},byNative:{owned:{nativeId:'owned'}},nativeReady:true,playerReadyAt:f.time,sync:{running:false},player:{}};
  if(options.manager)options.manager(f.manager);
  f.call=function(uri,payload){
    f.calls.push({method:uri.split('/').pop(),payload:payload});
    if(/getForegroundAppInfo$/.test(uri))return Promise.resolve({returnValue:true,appId:f.foreground});
    if(/bind$/.test(uri))return Promise.resolve({returnValue:true,binded:true,broadcastId:'observer'});
    if(/getCurrentChannel$/.test(uri))return Promise.resolve({returnValue:true,channel:f.channel});
    return Promise.resolve({returnValue:true});
  };
  f.resume=new Resume(f.manager,{boot:function(){return {uptime:options.late?500:f.uptime};},claim:function(){if(options.claimed)return false;f.claimed=true;return true;},now:function(){return f.time;},call:function(uri,payload){return f.call(uri,payload);}});
  f.advance=function(ms){f.time+=ms;f.uptime+=ms/1000;};
  f.advance(1000);return f;
}
async function select(f){await f.resume.tick();f.advance(2000);return f.resume.tick();}
function launches(f){return f.calls.filter(function(c){return c.method==='launch';});}
test('stable boot fallback resumes the saved imported channel exactly once',async function(){
  var f=fixture();assert.strictEqual(await select(f),true);
  assert.deepStrictEqual(launches(f)[0].payload,{id:'com.webos.app.livetv',params:{id:'channelChange',channelId:'owned'}});
  assert.strictEqual(f.resume.state.status,'awaiting-playback');
  for(var i=0;i<3;i++){f.advance(5000);await f.resume.tick();}assert.strictEqual(launches(f).length,1);
  f.manager.player={channelId:'owned',updatedAt:f.time,active:true,readyState:4,width:1280,height:720};
  assert.strictEqual(await f.resume.tick(),true);assert.strictEqual(f.resume.state.status,'resumed');assert(f.resume.state.resumedAt);
});
test('native map readiness and pending writes delay inspection',async function(){
  var f=fixture();f.manager.nativeReady=false;await f.resume.tick();assert.strictEqual(f.calls.length,0);
  f.manager.nativeReady=true;f.manager.sync.running=true;await f.resume.tick();assert.strictEqual(f.calls.length,0);
  f.manager.sync.running=false;assert.strictEqual(await select(f),true);
});
test('an individually verified startup row permits resume before full maintenance',async function(){
  var f=fixture();f.manager.nativeReady=false;f.manager.startupTargetReady='different';await f.resume.tick();assert.strictEqual(f.calls.length,0);
  f.manager.startupTargetReady='owned';assert.strictEqual(await select(f),true);assert.strictEqual(launches(f).length,1);
});
test('early verified selection can start the ordinary native IP path while its page initializes',async function(){
  var f=fixture();f.manager.nativeReady=false;f.manager.startupTargetReady='owned';f.manager.playerReadyAt=0;
  assert.strictEqual(await select(f),true);assert.strictEqual(launches(f).length,1);assert.strictEqual(f.resume.state.timings.playerReady,null);
});
test('ready native services resume after two stable seconds without the old startup sleep',async function(){
  var f=fixture();await f.resume.tick();f.advance(1000);await f.resume.tick();assert.strictEqual(launches(f).length,0);
  f.advance(1000);assert.strictEqual(await f.resume.tick(),true);assert.strictEqual(launches(f).length,1);
  assert.strictEqual(f.resume.state.timings.nativeReady,81);assert.strictEqual(f.resume.state.timings.channelSelected,83);
});
test('page readiness unlocks the fast path while an absent page has a bounded fallback',async function(){
  var f=fixture();f.manager.playerReadyAt=0;await f.resume.tick();assert.strictEqual(f.calls.length,0);
  f.manager.playerReadyAt=f.time;assert.strictEqual(await select(f),true);assert(f.resume.state.timings.playerReady);
  f=fixture();f.manager.playerReadyAt=0;f.advance(9000);assert.strictEqual(await select(f),true);assert.strictEqual(f.resume.state.timings.playerReady,null);
});
test('a service restart in the same boot and a late install never select',async function(){
  for(var options of [{claimed:true},{late:true}]){var f=fixture(options);await select(f);assert.strictEqual(f.calls.length,0);assert.strictEqual(f.resume.state.status,'skipped');}
});
test('missing history and removed-category channels cannot be resumed',async function(){
  for(var id of [undefined,'removed']){var f=fixture({manager:function(m){m.history.lastChannelId=id;}});await select(f);assert.strictEqual(f.calls.length,0);assert.strictEqual(f.resume.state.reason,'no-imported-history');}
});
test('other foreground apps cancel this boot instead of waiting to interrupt them later',async function(){
  for(var app of ['netflix','com.webos.app.hdmi1']){
    var f=fixture();f.foreground=app;await f.resume.tick();f.foreground='com.webos.app.livetv';await select(f);assert.strictEqual(launches(f).length,0);assert.strictEqual(f.resume.state.reason,'another-app');
  }
});
test('transient boot Home waits without mutations, then requires stable Live TV fallback',async function(){
  var f=fixture();f.foreground='com.webos.app.home';
  await f.resume.tick();assert.strictEqual(f.resume.done,false);assert.strictEqual(f.resume.state.lastStage,'waiting-live-tv');
  assert.strictEqual(f.resume.state.lastForeground,'home');assert.strictEqual(f.calls.length,1);
  f.advance(2000);await f.resume.tick();assert.strictEqual(launches(f).length,0);
  f.foreground='com.webos.app.livetv';await f.resume.tick();assert.strictEqual(launches(f).length,0);
  f.advance(2000);assert.strictEqual(await f.resume.tick(),true);assert.strictEqual(launches(f).length,1);
  assert.strictEqual(f.resume.state.lastForeground,'live-tv');
});
test('Home allowance expires at ninety seconds and cannot retune a later return to TV',async function(){
  var f=fixture();f.foreground='com.webos.app.home';await f.resume.tick();f.uptime=90;
  await f.resume.tick();assert.strictEqual(f.resume.state.reason,'another-app');
  f.foreground='com.webos.app.livetv';await select(f);assert.strictEqual(launches(f).length,0);
});
test('Home after an observed TV or a different app cancels the pending resume',async function(){
  var f=fixture();await f.resume.tick();f.foreground='com.webos.app.home';await f.resume.tick();
  assert.strictEqual(f.resume.state.reason,'another-app');assert.strictEqual(launches(f).length,0);
  f=fixture();f.foreground='com.webos.app.home';await f.resume.tick();f.foreground='netflix';await f.resume.tick();
  assert.strictEqual(f.resume.state.reason,'another-app');assert.strictEqual(f.resume.state.lastForeground,'other');
  f.foreground='com.webos.app.livetv';await select(f);assert.strictEqual(launches(f).length,0);
});
test('configured RF, imported, locked, incomplete and unknown selections are preserved',async function(){
  var channels=[{channelId:'owned',isLocked:false},{channelId:'RF',isLocked:false},{channelId:'foreign',isLocked:false}];
  ['channelName','channelModeName','isSkipped','isLocked'].forEach(function(key){var c=fallback();delete c[key];channels.push(c);});
  var locked=fallback();locked.isLocked=true;channels.push(locked);
  var named=fallback();named.channelName='An actual antenna channel';channels.push(named);
  for(var channel of channels){var f=fixture();f.channel=channel;await select(f);assert.strictEqual(launches(f).length,0);assert.strictEqual(f.resume.state.reason,'another-channel');}
});
test('user input between fallback observations cancels the pending resume',async function(){
  var f=fixture();await f.resume.tick();f.advance(5000);f.channel={channelId:'other-owned',isLocked:false};await f.resume.tick();assert.strictEqual(launches(f).length,0);
  f=fixture();await f.resume.tick();f.advance(5000);f.foreground='netflix';await f.resume.tick();assert.strictEqual(launches(f).length,0);
});
test('history or catalogue changes during native reads prevent selection',async function(){
  for(var change of [function(m){delete m.byNative.owned;},function(m){m.history.lastChannelId='newly-watched';}]){
    var f=fixture(),call=f.call;await f.resume.tick();f.advance(5000);
    f.call=function(uri,payload){if(/getCurrentChannel$/.test(uri))change(f.manager);return call(uri,payload);};
    await f.resume.tick();assert.strictEqual(launches(f).length,0);
  }
});
test('native boot errors are sanitized and require a fresh stable observation',async function(){
  var f=fixture(),call=f.call;f.call=function(){return Promise.reject(new Error('private native data'));};
  assert.strictEqual(await f.resume.tick(),false);assert.strictEqual(f.resume.state.lastError,'Startup resume unavailable at foreground');
  var count=f.calls.length;f.call=call;f.advance(1000);await f.resume.tick();assert.strictEqual(f.calls.length,count);
  f.advance(4000);await f.resume.tick();assert.strictEqual(launches(f).length,0);f.advance(2000);assert.strictEqual(await f.resume.tick(),true);
});
test('a timed-out launch is never sent again even if its acknowledgement was lost',async function(){
  var f=fixture(),call=f.call;f.call=function(uri,payload){var reply=call(uri,payload);return /launch$/.test(uri)?Promise.reject(new Error('lost response')):reply;};
  assert.strictEqual(await select(f),false);f.advance(5000);await f.resume.tick();assert.strictEqual(launches(f).length,1);assert.strictEqual(f.resume.state.status,'awaiting-playback');
});
test('a launch acknowledgement or stale/undecoded telemetry is not playback success',async function(){
  var f=fixture();await select(f);
  for(var p of [{active:false},{width:0},{updatedAt:f.time-20000},{channelId:'other'}]){
    f.manager.player=Object.assign({channelId:'owned',active:true,readyState:4,width:1280,height:720,updatedAt:f.time},p);await f.resume.tick();assert.strictEqual(f.resume.state.status,'awaiting-playback');
  }
  f.uptime=300;await f.resume.tick();assert.strictEqual(f.resume.state.status,'failed');assert.strictEqual(launches(f).length,1);
});
test('the boot deadline also applies after slow native reads',async function(){
  var f=fixture(),call=f.call;await f.resume.tick();f.advance(5000);
  f.call=function(uri,payload){if(/getCurrentChannel$/.test(uri))f.uptime=300;return call(uri,payload);};
  await f.resume.tick();assert.strictEqual(launches(f).length,0);assert.strictEqual(f.resume.state.reason,'boot-window-ended');
});
test('overlapping probes cannot issue two launches',async function(){
  var f=fixture(),call=f.call,release;await f.resume.tick();f.advance(5000);
  f.call=function(uri,payload){return /getForegroundAppInfo$/.test(uri)?new Promise(function(resolve){release=resolve;}):call(uri,payload);};
  var pending=f.resume.tick();await Promise.resolve();await Promise.resolve();assert.strictEqual(await f.resume.tick(),false);
  release({appId:'com.webos.app.livetv'});await pending;assert.strictEqual(launches(f).length,1);
});
test('exclusive runtime marker survives process restarts and resets with boot tmpfs',async function(){
  var folder=fs.mkdtempSync(path.join(os.tmpdir(),'xtream-resume-'));
  var directory=path.join(folder,'boot-runtime'),marker=path.join(directory,'startup-resume.claim');
  try{
    assert.strictEqual(Resume.claim(directory),true);assert.strictEqual(Resume.claim(directory),false);
    assert.strictEqual(fs.statSync(marker).mode&511,384);assert.strictEqual(fs.statSync(directory).mode&511,448);
    fs.unlinkSync(marker);fs.rmdirSync(directory); // The runtime filesystem is fresh on reboot.
    assert.strictEqual(Resume.claim(directory),true);
  }finally{if(fs.existsSync(marker))fs.unlinkSync(marker);if(fs.existsSync(directory))fs.rmdirSync(directory);fs.rmdirSync(folder);}
});
(async function(){for(var t of tests){await t.run();console.log('ok - '+t.name);}console.log(tests.length+' startup resume tests passed');}()).catch(function(e){console.error(e);process.exitCode=1;});
