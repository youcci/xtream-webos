'use strict';
var fs=require('fs'),path=require('path'),u=require('./util');
// Optional early-entry lease. A failed early boot leaves the next boot to
// Homebrew; only a healthy, settled boot arms another early attempt.
function Health(manager,resume,watchdog,options){
  options=options||{};this.manager=manager;this.resume=resume;this.watchdog=watchdog;
  this.now=options.now||Date.now;this.uptime=options.uptime||function(){return Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0]);};
  this.runtime=options.runtimeDir||'/run/xtream-native';this.failsafe=options.failsafe||'/var/luna/preferences/webosbrew_failsafe';
  this.directory=path.join(manager.base,'early-entry');this.since=null;this.last=null;this.done=false;
}
Health.prototype.tick=function(){
  if(this.done)return false;
  var self=this,m=self.manager,p=m.player||{},at=self.uptime();
  if(!Number.isFinite(at)||at>=300){self.stop();return false;}
  if(!fs.existsSync(path.join(self.runtime,'early-start'))||!fs.existsSync(path.join(self.directory,'auto-rearm')))return false;
  if(fs.existsSync(self.failsafe)||!m.nativeReady||m.saving||m.sync.running)return false;
  var state=self.resume.state,skipped=state.status==='skipped'&&['another-app','another-channel'].indexOf(state.reason)>=0;
  if(!skipped){
    var healthy=state.status==='resumed'&&self.watchdog.state.reloads===0&&m.byNative[p.channelId]&&p.active&&p.readyState>=2&&p.width>0&&p.height>0&&self.now()-p.updatedAt<15000;
    if(!healthy){self.since=null;self.last=null;return false;}
    if(!self.last||self.last.id!==p.channelId||p.currentTime<=self.last.time){self.since=at;}
    self.last={id:p.channelId,time:p.currentTime};
    if(self.since===null||at-self.since<30)return false;
  }
  if(at<90)return false;
  u.write(path.join(self.directory,'armed'),{healthyAtUptime:at});self.stop();return true;
};
Health.prototype.stop=function(){this.done=true;if(this.timer)clearInterval(this.timer);};
Health.prototype.start=function(){
  var self=this;
  if(!fs.existsSync(path.join(self.runtime,'early-start'))||!fs.existsSync(path.join(self.directory,'auto-rearm')))return;
  self.timer=setInterval(function(){try{self.tick();}catch(e){self.stop();}},10000);self.timer.unref();
};
module.exports=Health;
