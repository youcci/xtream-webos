'use strict';
var u=require('./util');
var APP='luna://com.webos.applicationManager/',DMOST='luna://com.webos.service.wampluggable.dmost/';
var CURRENT='luna://com.webos.service.utp.broadcast/getCurrentChannel',BIND='luna://com.webos.service.utp.broadcast/bind',PLAYER='com.webos.app.livedmost';
var BLOCKED=/^(locked|block|blocked|stop|deactivate)$/i;
function Watchdog(manager,options){
  options=options||{};this.manager=manager;this.call=options.call||u.luna;
  this.now=options.now||Date.now;this.sleep=options.sleep||function(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});};
  this.startedAt=this.now();this.lastAttempt=null;this.inactiveSince=null;this.busy=false;
  this.state={checks:0,reloads:0,starts:0,replays:0,lastRecovery:null,lastError:null,lastStage:'idle',reason:null};
}
Watchdog.prototype.fresh=function(){
  var player=this.manager.player||{};
  return Number(player.updatedAt)>0&&this.now()-Number(player.updatedAt)<15000;
};
Watchdog.prototype.healthy=function(){return this.fresh()&&!!this.manager.player.active;};
Watchdog.prototype.request=function(stage,uri,payload){
  var self=this;self.state.lastStage=stage;
  return Promise.resolve().then(function(){return self.call(uri,payload);}).then(function(reply){
    if(!reply||reply.returnValue===false)throw new Error('native_request_failed');
    return reply;
  });
};
Watchdog.prototype.owned=function(channel){
  return !!(channel&&channel.isLocked===false&&this.manager.byNative[channel.channelId]);
};
Watchdog.prototype.context=function(id){
  var self=this;
  return self.request('foreground',APP+'getForegroundAppInfo',{}).then(function(foreground){
    if(foreground.appId!=='com.webos.app.livetv')return null;
    // Same native read path as LG's TV adapter, without its caller ACL. Binding
    // attaches to the existing broadcast; it does not select or play a channel.
    return self.request('tv-binding',BIND,{}).then(function(binding){
      if(!binding.binded||typeof binding.broadcastId!=='string'||!binding.broadcastId)throw new Error('missing_tv_binding');
      return self.request('selected-channel',CURRENT,{broadcastId:binding.broadcastId,subscribe:false}).then(function(reply){return {channel:reply.channel,broadcastId:binding.broadcastId};});
    }).then(function(reply){
      var channel=reply.channel&&Object.assign({},reply.channel,{broadcastId:reply.broadcastId});
      return self.owned(channel)&&(!id||channel.channelId===id)?channel:null;
    });
  });
};
Watchdog.prototype.running=function(){
  return this.request('running-apps',APP+'running',{}).then(function(reply){
    if(!Array.isArray(reply.running))throw new Error('invalid_app_inventory');
    return reply.running.some(function(app){return app.id===PLAYER;});
  });
};
Watchdog.prototype.waitPlayer=function(attempt){
  var self=this;
  return self.running().then(function(running){
    if(running)return;
    self.state.lastStage='waiting-player';
    if(attempt>=9)throw new Error('player_start_timeout');
    return self.sleep(500).then(function(){return self.waitPlayer(attempt+1);});
  });
};
Watchdog.prototype.waitPage=function(since,attempt){
  var self=this;self.state.lastStage='waiting-page';
  if(Number(self.manager.playerReadyAt)>=since)return Promise.resolve();
  if(attempt>=30)return Promise.reject(new Error('player_page_timeout'));
  return self.sleep(500).then(function(){return self.waitPage(since,attempt+1);});
};
Watchdog.prototype.repair=function(channel,start,replay,reason){
  var self=this;
  if(self.healthy())return Promise.resolve(false);
  return self.context(channel.channelId).then(function(current){
    if(!current||self.healthy())return false;
    self.lastAttempt=self.now();self.state.reason=reason;
    var ready=Promise.resolve();
    if(start)ready=self.request('starting-player',APP+'launch',{id:PLAYER}).then(function(){return self.waitPlayer(0);}).then(function(){self.state.starts++;});
    return ready.then(function(){
      var loadingAt=self.now();self.manager.playerReadyAt=0;
      return self.request('loading-player',DMOST+'setDmostUrl',{url:'http://127.0.0.1:17651/player.html?v=full-3'}).then(function(){return self.waitPage(loadingAt,0);});
    }).then(function(){
      self.state.reloads++;self.state.lastRecovery=new Date(self.now()).toISOString();
      if(!replay)return;
      // A new player has forgotten UTP's tune. Replay only the still-selected
      // owned channel, never a historical/default channel.
      return self.context(channel.channelId).then(function(selected){
        if(!selected)return;
        // LiveTV ignores a duplicate UI channel selection. Ask its existing
        // native broadcast binding to update that channel instead.
        return self.request('replaying-channel','luna://com.webos.service.utp.broadcast/changeChannel',{broadcastId:selected.broadcastId,channelId:selected.channelId,update:true}).then(function(){self.state.replays++;});
      });
    }).then(function(){self.state.lastError=null;self.state.lastStage='awaiting-playback';return true;});
  });
};
Watchdog.prototype.tick=function(){
  var self=this,now=self.now();
  if(self.busy||now-self.startedAt<30000||(self.lastAttempt!==null&&now-self.lastAttempt<60000))return Promise.resolve(false);
  if(self.healthy()){self.inactiveSince=null;return Promise.resolve(false);}
  if(self.fresh()){
    if(self.inactiveSince===null)self.inactiveSince=now;
    if(now-self.inactiveSince<15000)return Promise.resolve(false);
  }
  self.busy=true;self.state.checks++;
  return self.context().then(function(selected){
    if(!selected)return false;
    return self.running().then(function(running){
      // The absent app's WAM calls do not respond. Start it before querying WAM.
      if(!running)return self.repair(selected,true,true,'player-app-missing');
      return self.request('native-channel',DMOST+'getChannel',{subscribe:false}).then(function(channel){
        if(BLOCKED.test(channel.channelChange||''))return false;
        if(channel.channelId===selected.channelId)return self.repair(selected,false,false,'heartbeat-missing');
        if(channel.channelId==='_'&&channel.channelChange==='unlocked')return self.repair(selected,false,true,'player-uninitialized');
        return false;
      });
    });
  }).catch(function(){
    self.lastAttempt=self.now();self.state.lastError='Native player recovery unavailable at '+self.state.lastStage;return false;
  }).then(function(result){self.busy=false;return result;});
};
Watchdog.prototype.start=function(){
  var self=this;
  if(!self.timer){self.timer=setInterval(function(){self.tick();},10000);self.timer.unref();}
};
module.exports=Watchdog;
