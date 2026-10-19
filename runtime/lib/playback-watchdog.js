'use strict';
var u=require('./util');
var ENDPOINT='luna://com.webos.service.wampluggable.dmost/';
// A restored native player can disappear while native tuning remains active.
// Recover only a missing heartbeat for an owned, unlocked LiveTV channel.
function Watchdog(manager,options){
  options=options||{};this.manager=manager;this.call=options.call||u.luna;
  this.now=options.now||Date.now;this.startedAt=this.now();this.lastAttempt=null;this.busy=false;
  this.state={checks:0,reloads:0,lastRecovery:null,lastError:null};
}
Watchdog.prototype.fresh=function(){
  var player=this.manager.player||{};
  return Number(player.updatedAt)>0&&this.now()-Number(player.updatedAt)<15000;
};
Watchdog.prototype.tick=function(){
  var self=this,now=self.now();
  if(self.busy||now-self.startedAt<30000||self.fresh()||(self.lastAttempt!==null&&now-self.lastAttempt<60000))return Promise.resolve(false);
  self.busy=true;self.state.checks++;
  return Promise.resolve().then(function(){
    return self.call('luna://com.webos.applicationManager/getForegroundAppInfo',{});
  }).then(function(foreground){
    if(foreground.appId!=='com.webos.app.livetv')return false;
    return self.call(ENDPOINT+'getChannel',{subscribe:false}).then(function(channel){
      if(channel.returnValue===false||!self.manager.byNative[channel.channelId]||/^(locked|block|blocked|stop|deactivate)$/i.test(channel.channelChange||''))return false;
      // The player may have resumed while the native queries were in flight.
      if(self.fresh())return false;
      self.lastAttempt=self.now();
      return self.call(ENDPOINT+'setDmostUrl',{url:'http://127.0.0.1:17651/player.html?v=full-3'}).then(function(reply){
        if(reply.returnValue===false)throw new Error('native_request_failed');
        self.state.reloads++;self.state.lastRecovery=new Date(self.now()).toISOString();self.state.lastError=null;
        return true;
      });
    });
  }).catch(function(){
    // Never publish raw LS2 errors or provider/account data in status.
    self.lastAttempt=self.now();self.state.lastError='Native player recovery unavailable';return false;
  }).then(function(result){self.busy=false;return result;});
};
Watchdog.prototype.start=function(){
  var self=this;
  if(!self.timer){self.timer=setInterval(function(){self.tick();},10000);self.timer.unref();}
};
module.exports=Watchdog;
