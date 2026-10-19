'use strict';
var assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),Health=require('../runtime/lib/early-health');
var tests=[];
function test(name,run){tests.push({name:name,run:run});}
function fixture(){
  var base=fs.mkdtempSync(path.join(os.tmpdir(),'xtream-health-')),runtime=path.join(base,'run'),directory=path.join(base,'early-entry');
  fs.mkdirSync(runtime);fs.mkdirSync(directory);fs.writeFileSync(path.join(runtime,'early-start'),'');fs.writeFileSync(path.join(directory,'auto-rearm'),'');
  var f={base:base,runtime:runtime,directory:directory,at:50,now:100000,resume:{state:{status:'resumed'}},watchdog:{state:{reloads:0}}};
  f.manager={base:base,nativeReady:true,sync:{running:false},byNative:{owned:{}},player:{channelId:'owned',active:true,readyState:4,width:1280,height:720,updatedAt:f.now,currentTime:10}};
  f.health=new Health(f.manager,f.resume,f.watchdog,{runtimeDir:runtime,failsafe:path.join(base,'failsafe'),uptime:function(){return f.at;},now:function(){return f.now;}});
  f.arm=path.join(directory,'armed');f.advance=function(seconds){f.at+=seconds;f.now+=seconds*1000;f.manager.player.updatedAt=f.now;f.manager.player.currentTime+=seconds;};
  f.remove=function(){fs.rmSync(base,{recursive:true,force:true});};return f;
}
test('a settled boot with advancing decoded video arms one later boot after ninety seconds',function(){
  var f=fixture();try{assert.strictEqual(f.health.tick(),false);f.advance(30);assert.strictEqual(f.health.tick(),false);f.advance(10);assert.strictEqual(f.health.tick(),true);assert(fs.existsSync(f.arm));assert.strictEqual(fs.statSync(f.arm).mode&511,384);var data=fs.readFileSync(f.arm,'utf8');f.advance(20);assert.strictEqual(f.health.tick(),false);assert.strictEqual(fs.readFileSync(f.arm,'utf8'),data);}finally{f.remove();}
});
test('missing opt-in, missing early entry, failsafe, pending native work and recovery cannot rearm',function(){
  var changes=[function(f){fs.unlinkSync(path.join(f.directory,'auto-rearm'));},function(f){fs.unlinkSync(path.join(f.runtime,'early-start'));},function(f){fs.writeFileSync(path.join(f.base,'failsafe'),'');},function(f){f.manager.nativeReady=false;},function(f){f.manager.sync.running=true;},function(f){f.watchdog.state.reloads=1;},function(f){f.resume.state={status:'skipped',reason:'already-checked-this-boot'};}];
  for(var change of changes){var f=fixture();try{change(f);f.health.tick();f.advance(50);assert.strictEqual(f.health.tick(),false);assert(!fs.existsSync(f.arm));}finally{f.remove();}}
});
test('stale, frozen or undecoded video leaves the next boot to Homebrew',function(){
  for(var mode of ['stale','frozen','undecoded']){var f=fixture();try{f.health.tick();f.advance(50);if(mode==='stale')f.manager.player.updatedAt=f.now-20000;if(mode==='frozen')f.manager.player.currentTime=10;if(mode==='undecoded')f.manager.player.width=0;assert.strictEqual(f.health.tick(),false);assert(!fs.existsSync(f.arm));f.at=300;assert.strictEqual(f.health.tick(),false);assert(f.health.done);}finally{f.remove();}}
});
test('a legitimate skipped app or channel selection preserves early entry without retuning',function(){
  for(var reason of ['another-app','another-channel']){var f=fixture();try{f.resume.state={status:'skipped',reason:reason};f.at=89;assert.strictEqual(f.health.tick(),false);f.at=90;assert.strictEqual(f.health.tick(),true);}finally{f.remove();}}
});
for(var t of tests){t.run();console.log('ok - '+t.name);}console.log(tests.length+' early health tests passed');
