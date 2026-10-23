'use strict';
var fs=require('fs'),u=require('./util'),Resume=require('./startup-resume');
function claimEarlyPlayer(){
  var fd;try{fd=fs.openSync('/run/xtream-native/early-player.claim','wx',384);}catch(e){return false;}
  fs.closeSync(fd);return true;
}
function configure(options){
  options=options||{};
  var call=options.call||u.luna,now=options.now||Date.now;
  var sleep=options.sleep||function(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});};
  // Keep the opt-in bootstrap alive through the initial Home allowance. All
  // launches still require two fresh Live TV/empty-fallback observations.
  var deadline=now()+(options.earlyLaunch?90000:30000);
  var launchAttempted=false;
  function bootContext(){
    return call('luna://com.webos.applicationManager/getForegroundAppInfo',{}).then(function(foreground){
      if(!foreground||foreground.returnValue===false||foreground.appId!=='com.webos.app.livetv')return false;
      return call('luna://com.webos.service.utp.broadcast/bind',{}).then(function(binding){
        if(!binding||binding.returnValue===false||!binding.binded||!binding.broadcastId)return false;
        return call('luna://com.webos.service.utp.broadcast/getCurrentChannel',{broadcastId:binding.broadcastId,subscribe:false}).then(function(reply){
          return !!reply&&reply.returnValue!==false&&Resume.placeholder(reply.channel);
        });
      });
    });
  }
  function prelaunch(){
    if(!options.earlyLaunch||launchAttempted)return false;
    return bootContext().then(function(safe){return safe&&now()<deadline?bootContext():false;}).then(function(safe){
      if(!safe||now()>=deadline)return false;
      launchAttempted=true;
      if(!(options.claimEarlyPlayer||claimEarlyPlayer)())return false;
      return call('luna://com.webos.applicationManager/launch',{id:'com.webos.app.livedmost'}).then(function(){return false;});
    });
  }
  function wait(){
    if(now()>=deadline)return Promise.resolve(false);
    return Promise.resolve().then(function(){return call('luna://com.webos.applicationManager/running',{});}).then(function(reply){
      if(!reply||reply.returnValue===false||!Array.isArray(reply.running))throw new Error('app_inventory_unavailable');
      if(!reply.running.some(function(app){return app.id==='com.webos.app.livedmost';}))return prelaunch();
      if(now()>=deadline)return false;
      return call('luna://com.webos.service.wampluggable.dmost/setDmostUrl',{url:'http://127.0.0.1:17651/player.html?v=full-3'}).then(function(result){
        return !!result&&result.returnValue!==false;
      });
    }).catch(function(){return false;}).then(function(ready){
      if(ready)return true;
      return sleep(500).then(wait);
    });
  }
  return wait();
}
module.exports=configure;
if(require.main===module)configure({earlyLaunch:process.env.XTREAM_EARLY_PLAYER==='1'}).then(function(ready){
  if(!ready)console.error('Native player bootstrap is pending; guarded recovery remains available.');
}).catch(function(){console.error('Native player bootstrap unavailable; guarded recovery remains available.');});
