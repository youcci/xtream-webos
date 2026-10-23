'use strict';
var assert=require('assert'),configure=require('../runtime/lib/boot-player'),waitForNative=require('../runtime/lib/util').waitForNative;
var tests=[];
function test(name,run){tests.push({name:name,run:run});}
function fixture(){
  var f={time:0,calls:[],running:false};
  f.options={now:function(){return f.time;},sleep:function(ms){f.time+=ms;return Promise.resolve();},call:function(uri,payload){return f.call(uri,payload);}};
  f.call=function(uri,payload){
    var method=uri.split('/').pop();f.calls.push(method);
    return Promise.resolve(method==='running'?{returnValue:true,running:f.running?[{id:'com.webos.app.livedmost'}]:[]}:{returnValue:true});
  };
  return f;
}
test('early bootstrap waits for the actual hidden player before setting its URL',async function(){
  var f=fixture(),call=f.call;
  f.call=function(uri,payload){if(f.time>=1500)f.running=true;return call(uri,payload);};
  assert.strictEqual(await configure(f.options),true);assert.strictEqual(f.time,1500);assert.strictEqual(f.calls.filter(function(m){return m==='setDmostUrl';}).length,1);
  assert(!f.calls.some(function(m){return /launch|changeChannel/.test(m);}));
});
test('a missing player reaches the deadline without calling its unresponsive WAM method',async function(){
  var f=fixture();assert.strictEqual(await configure(f.options),false);assert.strictEqual(f.time,30000);assert(!f.calls.includes('setDmostUrl'));
});
test('invalid or unavailable app inventories cannot cause a speculative player mutation',async function(){
  for(var reply of [{returnValue:false},{returnValue:true}]){
    var f=fixture();f.call=function(){return Promise.resolve(reply);};assert.strictEqual(await configure(f.options),false);assert.strictEqual(f.time,30000);
  }
});
test('transient native failure can recover without relaunching or changing the input',async function(){
  var f=fixture(),call=f.call;f.running=true;var failed=false;
  f.call=function(uri,payload){if(!failed){failed=true;return Promise.reject(new Error('private native details'));}return call(uri,payload);};
  assert.strictEqual(await configure(f.options),true);assert.strictEqual(f.time,500);assert.deepStrictEqual(f.calls,['running','setDmostUrl']);
});
test('a rejected URL load is retried while startup is still in the bounded window',async function(){
  var f=fixture(),call=f.call,loads=0;f.running=true;
  f.call=function(uri,payload){var r=call(uri,payload);if(/setDmostUrl$/.test(uri)&&++loads===1)return Promise.resolve({returnValue:false});return r;};
  assert.strictEqual(await configure(f.options),true);assert.strictEqual(loads,2);
});
test('a slow inventory response cannot initiate a new mutation after the deadline',async function(){
  var f=fixture(),call=f.call;f.running=true;
  f.call=function(uri,payload){f.time=30000;return call(uri,payload);};
  assert.strictEqual(await configure(f.options),false);assert(!f.calls.includes('setDmostUrl'));
});
function earlyFixture(){
  var f=fixture(),call=f.call;f.options.earlyLaunch=true;
  f.options.claimEarlyPlayer=function(){return true;};
  f.foreground='com.webos.app.livetv';f.channel={channelId:'1_0_1_0_0_0_0',channelName:'',channelModeName:'Terrestrial',isSkipped:true,isLocked:false};
  f.call=function(uri,payload){
    var method=uri.split('/').pop();
    if(['getForegroundAppInfo','bind','getCurrentChannel','launch'].indexOf(method)>=0){
      f.calls.push(method);
      if(method==='getForegroundAppInfo')return Promise.resolve({returnValue:true,appId:f.foreground});
      if(method==='bind')return Promise.resolve({returnValue:true,binded:true,broadcastId:'native'});
      if(method==='getCurrentChannel')return Promise.resolve({returnValue:true,channel:f.channel});
      f.running=true;return Promise.resolve({returnValue:true});
    }
    return call(uri,payload);
  };return f;
}
test('opt-in early bootstrap starts a hidden player only after two native fallback observations',async function(){
  var f=earlyFixture();assert.strictEqual(await configure(f.options),true);
  assert.deepStrictEqual(f.calls.slice(0,8),['running','getForegroundAppInfo','bind','getCurrentChannel','getForegroundAppInfo','bind','getCurrentChannel','launch']);
  assert.strictEqual(f.calls.filter(function(m){return m==='launch';}).length,1);assert.strictEqual(f.calls[f.calls.length-1],'setDmostUrl');
});
test('another foreground app cannot trigger an early hidden-player launch',async function(){
  var f=earlyFixture();f.foreground='other';assert.strictEqual(await configure(f.options),false);assert(!f.calls.includes('launch'));
});
test('early bootstrap survives transient Home beyond the ordinary thirty-second window',async function(){
  var f=earlyFixture(),call=f.call;f.foreground='com.webos.app.home';
  f.call=function(uri,payload){if(f.time>=35000)f.foreground='com.webos.app.livetv';return call(uri,payload);};
  assert.strictEqual(await configure(f.options),true);assert.strictEqual(f.calls.filter(function(m){return m==='launch';}).length,1);
  assert(f.time>=35000&&f.time<90000);
});
test('persistent Home reaches the bounded early deadline without a player launch',async function(){
  var f=earlyFixture();f.foreground='com.webos.app.home';
  assert.strictEqual(await configure(f.options),false);assert.strictEqual(f.time,90000);
  assert(!f.calls.includes('launch'));assert(!f.calls.includes('setDmostUrl'));
});
test('an existing early launch claim prevents a duplicate JS launch',async function(){
  var f=earlyFixture();f.options.claimEarlyPlayer=function(){return false;};assert.strictEqual(await configure(f.options),false);assert(!f.calls.includes('launch'));
});
test('configured RF, locked and unknown channel selections cannot trigger early launch',async function(){
  for(var change of [{isSkipped:false},{isLocked:true},{channelName:'Configured'},{channelId:'foreign'}]){
    var f=earlyFixture();Object.assign(f.channel,change);assert.strictEqual(await configure(f.options),false);assert(!f.calls.includes('launch'));
  }
});
test('a foreground change during prelaunch inspection cancels the mutation',async function(){
  var f=earlyFixture(),call=f.call;
  f.call=function(uri,payload){var result=call(uri,payload);if(/getCurrentChannel$/.test(uri))f.foreground='other';return result;};
  assert.strictEqual(await configure(f.options),false);assert(!f.calls.includes('launch'));
});
test('an uncertain early launch acknowledgement is never sent twice',async function(){
  var f=earlyFixture(),call=f.call;
  f.call=function(uri,payload){var result=call(uri,payload);return /\/launch$/.test(uri)?Promise.reject(new Error('lost acknowledgement')):result;};
  assert.strictEqual(await configure(f.options),true);assert.strictEqual(f.calls.filter(function(m){return m==='launch';}).length,1);
});
test('slow prelaunch inspection cannot initiate a launch after the deadline',async function(){
  var f=earlyFixture(),call=f.call;
  f.call=function(uri,payload){var result=call(uri,payload);if(/getCurrentChannel$/.test(uri))f.time=90000;return result;};
  assert.strictEqual(await configure(f.options),false);assert(!f.calls.includes('launch'));
});
test('parallel manager startup waits for bridge readiness instead of failing on a missing socket',async function(){
  var time=0,probes=0;
  assert.strictEqual(await waitForNative({now:function(){return time;},sleep:function(ms){time+=ms;return Promise.resolve();},probe:function(){probes++;return time<750?Promise.reject(new Error('socket missing')):Promise.resolve({returnValue:true});}}),true);
  assert.strictEqual(time,750);assert.strictEqual(probes,4);
});
test('an unavailable bridge has a finite deadline and a sanitized startup error',async function(){
  var time=0,error;
  try{await waitForNative({now:function(){return time;},sleep:function(ms){time+=ms;return Promise.resolve();},probe:function(){return Promise.reject(new Error('private native data'));}});}catch(e){error=e;}
  assert(error&&error.safe);assert.strictEqual(error.message,'The native TV bridge did not become ready during startup.');assert.strictEqual(time,10000);
});
test('a negative bridge acknowledgement is not readiness',async function(){
  var time=0;
  assert.strictEqual(await waitForNative({now:function(){return time;},sleep:function(ms){time+=ms;return Promise.resolve();},probe:function(){return Promise.resolve({returnValue:time>=250});}}),true);
  assert.strictEqual(time,250);
});
(async function(){for(var t of tests){await t.run();console.log('ok - '+t.name);}console.log(tests.length+' boot-player tests passed');}()).catch(function(e){console.error(e);process.exitCode=1;});
