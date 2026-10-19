'use strict';
var fs=require('fs'),path=require('path'),u=require('./util');
var APP='luna://com.webos.applicationManager/',TV='luna://com.webos.service.utp.broadcast/';
function boot(){
  var uptime=Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0]);
  if(!Number.isFinite(uptime)||uptime<0)throw new Error('uptime_unavailable');return {uptime:uptime};
}
function claim(base){
  // /run is boot-local tmpfs. This TV repeats its kernel boot_id after reboot.
  try{fs.mkdirSync(base,448);}catch(e){if(e.code!=='EEXIST')throw e;}
  var fd;
  try{fd=fs.openSync(path.join(base,'startup-resume.claim'),'wx',384);}
  catch(e){if(e.code==='EEXIST')return false;throw e;}
  fs.closeSync(fd);return true;
}
function placeholder(channel){
  // This exact empty/skipped RF row is LG's boot fallback on the tested TV.
  // A configured antenna channel is a user selection, not a resume trigger.
  return channel&&channel.channelId==='1_0_1_0_0_0_0'&&channel.channelName===''&&channel.channelModeName==='Terrestrial'&&channel.isSkipped===true&&channel.isLocked===false;
}
function Resume(manager,options){
  options=options||{};this.manager=manager;this.call=options.call||u.luna;this.now=options.now||Date.now;
  this.boot=options.boot||boot;this.startedAt=this.now();this.busy=false;this.done=false;this.selected=false;this.observedAt=null;
  this.targetId=manager.history.lastChannelId;
  this.state={status:'waiting',reason:null,attempts:0,lastStage:'boot',lastError:null,resumedAt:null};
  try{
    var info=this.boot();
    if(!Number.isFinite(info.uptime)||info.uptime<0)throw new Error('uptime_unavailable');
    if(info.uptime>=300)this.finish('skipped','outside-boot-window');
    else if(!(options.claim||claim)(options.markerDir||'/run/xtream-native'))this.finish('skipped','already-checked-this-boot');
    else if(!this.target())this.finish('skipped','no-imported-history');
  }catch(e){this.finish('skipped','boot-state-unavailable');}
}
Resume.prototype.finish=function(status,reason){this.done=true;this.state.status=status;this.state.reason=reason;if(this.timer)clearInterval(this.timer);};
Resume.prototype.target=function(){return this.targetId&&this.manager.history.lastChannelId===this.targetId&&this.manager.byNative[this.targetId];};
Resume.prototype.request=function(stage,uri,payload){
  var self=this;self.state.lastStage=stage;
  return Promise.resolve().then(function(){return self.call(uri,payload);}).then(function(reply){
    if(!reply||reply.returnValue===false)throw new Error('native_request_failed');return reply;
  });
};
Resume.prototype.inspect=function(){
  var self=this;
  return self.request('foreground',APP+'getForegroundAppInfo',{}).then(function(foreground){
    if(!foreground.appId)throw new Error('foreground_unavailable');
    if(foreground.appId!=='com.webos.app.livetv'){self.finish('skipped','another-app');return null;}
    return self.request('tv-binding',TV+'bind',{}).then(function(binding){
      if(!binding.binded||!binding.broadcastId)throw new Error('binding_unavailable');
      return self.request('selected-channel',TV+'getCurrentChannel',{broadcastId:binding.broadcastId,subscribe:false});
    }).then(function(reply){
      if(!reply.channel||!reply.channel.channelId)throw new Error('selection_unavailable');return reply.channel;
    });
  });
};
Resume.prototype.tick=function(){
  var self=this;
  if(self.done||self.busy||self.now()-self.startedAt<10000)return Promise.resolve(false);
  try{
    if(self.boot().uptime>=300){self.finish(self.selected?'failed':'skipped','boot-window-ended');return Promise.resolve(false);}
  }catch(e){self.finish('skipped','boot-state-unavailable');return Promise.resolve(false);}
  var player=self.manager.player||{};
  if(self.selected){
    if(player.channelId===self.targetId&&player.active&&player.readyState>=2&&player.width>0&&player.height>0&&self.now()-player.updatedAt<15000){
      self.state.resumedAt=new Date(self.now()).toISOString();self.state.lastError=null;self.finish('resumed','last-watched-channel');return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
  if(!self.target()){self.finish('skipped','history-or-selection-changed');return Promise.resolve(false);}
  if(!self.manager.nativeReady||self.manager.sync.running||self.manager.saving)return Promise.resolve(false);
  self.busy=true;self.state.attempts++;
  return self.inspect().then(function(channel){
    if(!channel)return false;
    if(!placeholder(channel)){self.finish('skipped','another-channel');return false;}
    if(self.observedAt===null){self.observedAt=self.now();return false;}
    if(self.now()-self.observedAt<5000)return false;
    // Recheck after asynchronous native reads. Use the ordinary TV selection
    // path so LG retains its lock/parental-control handling for the target.
    if(!self.target()||!self.manager.nativeReady||self.manager.sync.running||self.manager.saving)return false;
    if(self.boot().uptime>=300){self.finish('skipped','boot-window-ended');return false;}
    self.selected=true;self.state.status='awaiting-playback';
    // A timed-out launch may still have taken effect. Never send it twice.
    return self.request('selecting-channel',APP+'launch',{id:'com.webos.app.livetv',params:{id:'channelChange',channelId:self.targetId}}).then(function(){self.state.lastError=null;return true;});
  }).catch(function(){
    self.observedAt=null;self.state.lastError='Startup resume unavailable at '+self.state.lastStage;return false;
  }).then(function(result){self.busy=false;return result;});
};
Resume.prototype.start=function(){var self=this;if(!self.done&&!self.timer){self.timer=setInterval(function(){self.tick();},5000);self.timer.unref();}};
Resume.claim=claim;
module.exports=Resume;
