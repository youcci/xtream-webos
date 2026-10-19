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
