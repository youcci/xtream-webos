'use strict';
var u=require('./util');
function configure(options){
  options=options||{};
  var call=options.call||u.luna,now=options.now||Date.now;
  var sleep=options.sleep||function(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});};
  var deadline=now()+30000;
  function wait(){
    if(now()>=deadline)return Promise.resolve(false);
    return Promise.resolve().then(function(){return call('luna://com.webos.applicationManager/running',{});}).then(function(reply){
      if(!reply||reply.returnValue===false||!Array.isArray(reply.running))throw new Error('app_inventory_unavailable');
      if(!reply.running.some(function(app){return app.id==='com.webos.app.livedmost';}))return false;
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
if(require.main===module)configure().then(function(ready){
  if(!ready)console.error('Native player bootstrap is pending; guarded recovery remains available.');
}).catch(function(){console.error('Native player bootstrap unavailable; guarded recovery remains available.');});
