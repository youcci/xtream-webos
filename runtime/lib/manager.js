'use strict';
var fs=require('fs'),path=require('path'),EventEmitter=require('events'),u=require('./util'),client=require('./client'),catalogue=require('./catalog'),nativeDb=require('./native-db');
function Manager(base) {
  this.base=base;this.file=path.join(base,'settings.private.json');
  this.settings=u.read(this.file,{syncHours:6,epgMinutes:60,selectedCategoryIds:[]});
  if(!this.settings.token)this.settings.token=require('crypto').randomBytes(32).toString('hex');
  this.activeAccount=this.settings.activeAccount || this.settings.account;
  if(this.activeAccount)this.settings.activeAccount=this.activeAccount;
  u.write(this.file,this.settings);
  this.catalog=u.read(path.join(base,'catalog.private.json'),{channels:[],categories:[]});
  // Unselected provider metadata is needed by the category UI/refresh, not
  // playback. Avoid parsing the full library on the boot critical path.
  var self=this,library,loaded=false;
  Object.defineProperty(this,'library',{enumerable:true,configurable:true,get:function(){
    if(!loaded){library=u.read(path.join(base,'library.private.json'),self.catalog);loaded=true;}return library;
  },set:function(value){library=value;loaded=true;}});
  this.history=u.read(path.join(base,'history.json'),{});
  this.sync={running:false,phase:'idle',progress:0,lastSuccess:this.history.lastSync || null,error:null};
  this.guide={running:false,lastSuccess:this.history.lastGuide || null,error:null,programmes:this.history.programmes || 0};
  this.player={};this.nativeReady=false;this.reindex();this.channelDb=process.env.XTREAM_CHANNEL_DB || '/mnt/lg/cmn_data/iepg/db/channel.sql';
  this.guideDb=process.env.XTREAM_GUIDE_DB || '/tmp/epg/PBS_EPG_DB.db';
  this.lastBulk=this.history.lastGuide?Date.parse(this.history.lastGuide):0;this.lastCurrent=Date.now();
}
Manager.prototype.reindex=function(){var self=this;self.byId=Object.create(null);self.byNative=Object.create(null);self.catalog.channels.forEach(function(c){self.byId[c.id]=c;self.byNative[c.nativeId]=c;});};
Manager.prototype.filter=function(library,ids){
  if(!Array.isArray(ids))return library;
  var chosen=Object.create(null);ids.forEach(function(id){chosen[String(id)]=true;});
  return Object.assign({},library,{categories:library.categories.filter(function(c){return chosen[c.id];}),channels:library.channels.filter(function(c){return chosen[c.categoryId];})});
};
Manager.prototype.selection=function(){return {categories:this.library.categories,selectedIds:Array.isArray(this.settings.selectedCategoryIds)?this.settings.selectedCategoryIds:this.library.categories.map(function(c){return c.id;}),importedChannels:this.catalog.channels.length};};
Manager.prototype.waitNativeCache=function(catalog){
  var expected=Object.create(null),started=Date.now();catalog.channels.forEach(function(c){expected[c.nativeId]=true;});
  return new Promise(function(resolve,reject){
    function check(){
      if(!catalog.channels.length)return setTimeout(resolve,1500);
      var cache=u.read('/mnt/lg/cmn_data/simplified_chlist.json',{}),names=cache.names || {},idIndex=names.channelId;
      var ids=(cache.values || []).filter(function(r){return String(r[idIndex]).indexOf('11_')===0;}).map(function(r){return r[idIndex];});
      if(ids.length===catalog.channels.length&&ids.every(function(id){return expected[id];}))return resolve();
      if(Date.now()-started>15000)return reject(u.fail('LG is still rebuilding its channel list. Try applying the selection again.'));
      setTimeout(check,250);
    }
    check();
  });
};
Manager.prototype.commit=function(pending){
  var self=this;
  u.write(path.join(self.base,'catalog-transaction.private.json'),pending);
  return nativeDb.apply(pending.catalog,self.channelDb,pending.preserve).then(function(){
    u.write(path.join(self.base,'library.private.json'),pending.library || pending.catalog);
    u.write(path.join(self.base,'catalog.private.json'),pending.catalog);
    self.library=pending.library || pending.catalog;self.catalog=pending.catalog;self.reindex();
    self.activeAccount=pending.account;self.settings.activeAccount=pending.account;
    if(Array.isArray(pending.selectedIds))self.settings.selectedCategoryIds=pending.selectedIds;
    u.write(self.file,self.settings);fs.unlinkSync(path.join(self.base,'catalog-transaction.private.json'));
    return u.luna('luna://com.webos.service.pbsw/xtreamRefresh',{}).then(function(){return self.waitNativeCache(pending.catalog);}).then(function(){return u.refreshMap();});
  });
};
Manager.prototype.select=function(ids){
  var self=this;if(self.startupMaintenancePending||self.saving||self.sync.running)throw u.fail('Wait for the current channel update to finish.');
  if(!Array.isArray(ids)||ids.length>998)throw u.fail('Choose valid categories.');
  var known=Object.create(null);self.library.categories.forEach(function(c){known[c.id]=true;});
  ids=ids.map(String).filter(function(v,i,a){return a.indexOf(v)===i;});
  if(ids.some(function(id){return !known[id];}))throw u.fail('The category list changed. Reopen the selector and try again.');
  var catalog=self.filter(self.library,ids);
  self.sync={running:true,phase:'Applying categories',progress:30,lastSuccess:self.sync.lastSuccess,error:null};
  if(self.guideSignal){self.guideSignal.aborted=true;self.guideSignal.emit('abort');}
  Promise.resolve(self.guidePromise).then(function(){return self.commit({account:self.activeAccount,library:self.library,catalog:catalog,selectedIds:ids,preserve:true});}).then(function(){
    self.sync.phase='Updating selected Guide';self.sync.progress=85;
    // Remove guide entries for excluded channels, keeping only the chosen list.
    var codes=catalog.channels.map(function(c){return u.sql(c.code);});
    var remove="DELETE FROM PBS_BROADCAST_SCHEDULE WHERE substr(chan_code,1,7)='xtream_'"+(codes.length?' AND chan_code NOT IN ('+codes.join(',')+')':'')+';';
    return u.sqlite(self.guideDb,remove+"DELETE FROM PBS_BROADCAST_PROGRAM WHERE substr(contents_id,1,7)='xtream_' AND NOT EXISTS(SELECT 1 FROM PBS_BROADCAST_SCHEDULE s WHERE s.contents_id=PBS_BROADCAST_PROGRAM.contents_id AND s.seq_no=PBS_BROADCAST_PROGRAM.seq_no); VACUUM;").then(function(){return self.snapshotGuide();}).catch(function(){});
  }).then(function(){self.sync.phase='Complete';self.sync.progress=100;self.sync.lastSuccess=new Date().toISOString();self.history.lastSync=self.sync.lastSuccess;self.persistHistory();}).catch(function(e){self.sync.error=u.safe(e);self.sync.phase='Category update failed';}).then(function(){self.sync.running=false;if(!self.sync.error&&catalog.channels.length)self.startGuide(true);});
  return {ok:true,job:'categories'};
};
Manager.prototype.persistHistory=function(){u.write(path.join(this.base,'history.json'),this.history);};
Manager.prototype.snapshotGuide=function(){
  var self=this;
  return u.sqlite(self.guideDb,"SELECT count(*) FROM PBS_BROADCAST_SCHEDULE WHERE substr(chan_code,1,7)='xtream_';").then(function(out){
    self.guide.programmes=Number(out.trim())||0;self.history.programmes=self.guide.programmes;self.persistHistory();
    if(fs.statSync(self.guideDb).size>160*1024*1024)return;
    var cache=path.join(self.base,'guide-cache.sqlite');
    return u.sqlite(self.guideDb,'.backup '+u.sql(cache+'.new')).then(function(){fs.renameSync(cache+'.new',cache);fs.chmodSync(cache,384);});
  });
};
Manager.prototype.status=function(){return {configured:!!this.settings.account,counts:{channels:this.catalog.channels.length,categories:this.catalog.categories.length},sync:this.sync,guide:this.guide,player:this.player,nextSync:this.history.lastSync?new Date(new Date(this.history.lastSync).getTime()+this.settings.syncHours*3600000).toISOString():null};};
Manager.prototype.publicSettings=function(){var a=this.settings.account || {};return {account:{url:a.url || '',username:a.username || '',passwordSet:!!a.password},syncHours:this.settings.syncHours,epgMinutes:this.settings.epgMinutes};};
Manager.prototype.candidate=function(body){return client.account(body.account,this.settings.account);};
Manager.prototype.save=function(body){
  var self=this;if(self.startupMaintenancePending||self.saving||self.sync.running||self.guide.running)return Promise.reject(u.fail('Wait for the current refresh to finish before changing the account.'));
  var a=self.candidate(body),hours=Number(body.syncHours),minutes=Number(body.epgMinutes);
  if(!Number.isInteger(hours)||hours<1||hours>168)throw u.fail('Channel refresh must be between 1 and 168 hours.');
  if(!Number.isInteger(minutes)||minutes<5||minutes>1440)throw u.fail('Guide refresh must be between 5 and 1440 minutes.');
  self.saving=true;
  return client.test(a).then(function(test){
    var changed=!self.settings.account||JSON.stringify(a)!==JSON.stringify(self.settings.account);
    self.settings.account=a;self.settings.syncHours=hours;self.settings.epgMinutes=minutes;u.write(self.file,self.settings);
    if(changed){self.history.lastSync=null;self.history.lastGuide=null;self.lastBulk=0;self.persistHistory();}
    return {ok:true,account:test};
  }).then(function(r){self.saving=false;return r;},function(e){self.saving=false;throw e;});
};
Manager.prototype.startSync=function(){
  var self=this;if(self.sync.running) return {ok:true,job:'sync',alreadyRunning:true};
  if(self.startupMaintenancePending)throw u.fail('Wait for startup channel checks to finish.');
  if(self.saving)throw u.fail('Wait for the account check to finish.');
  if(self.guide.running)throw u.fail('Wait for the Guide refresh to finish.');
  if(!self.settings.account)throw u.fail('Save an Xtream account first.');
  self.sync={running:true,phase:'Checking account',progress:5,lastSuccess:self.sync.lastSuccess,error:null};
  var account=self.settings.account;
  var sameAccount=self.activeAccount&&self.activeAccount.url===account.url&&self.activeAccount.username===account.username;
  Promise.resolve().then(function(){return client.test(account);}).then(function(){
    self.sync.phase='Downloading live channels';self.sync.progress=15;
    return Promise.all([client.api(account,'get_live_categories'),client.api(account,'get_live_streams')]);
  }).then(function(raw){
    self.sync.phase='Preparing native channel list';self.sync.progress=45;
    var library=catalogue.build(raw[0],raw[1],sameAccount?self.library:undefined);
    var selectedIds=sameAccount?self.settings.selectedCategoryIds:[];
    var catalog=self.filter(library,selectedIds);
    self.sync.phase='Refreshing LG channel map';self.sync.progress=65;
    return self.commit({account:account,library:library,catalog:catalog,preserve:sameAccount,selectedIds:selectedIds});
  }).then(function(){
    self.sync.lastSuccess=new Date().toISOString();self.history.lastSync=self.sync.lastSuccess;self.persistHistory();self.sync.progress=100;self.sync.phase='Complete';
  }).catch(function(e){self.sync.error=u.safe(e);self.sync.phase='Refresh failed';}).then(function(){self.sync.running=false;if(!self.sync.error&&self.catalog.channels.length)self.startGuide(true);});
  return {ok:true,job:'sync'};
};
Manager.prototype.startGuide=function(force){
  var self=this;if(self.guide.running)return {ok:true,job:'guide',alreadyRunning:true};
  if(self.startupMaintenancePending)throw u.fail('Wait for startup channel checks to finish.');
  if(self.saving)throw u.fail('Wait for the account check to finish.');
  if(!self.settings.account||!self.catalog.channels.length)throw u.fail('Import the channel list first.');
  if(self.sync.running)throw u.fail('Wait for the channel refresh to finish.');
  self.guide.running=true;self.guide.error=null;self.guide.errorCode=null;
  self.guideSignal=new EventEmitter();self.guideSignal.aborted=false;
  var epg=require('./epg');
  var options={account:self.activeAccount,catalog:self.catalog.channels,dbPath:self.guideDb,schemaPath:path.join(self.base,'guide-schema.sql'),workDir:'/tmp/xtream-native',currentStreamId:self.player.streamId,windowHours:36,sqliteTimeoutMs:600000,onProgress:function(p){self.guide.phase=typeof p==='string'?p:(p.phase || 'Downloading Guide');if(p.bytes)self.guide.downloadBytes=p.bytes;if(p.programmes)self.guide.stagedProgrammes=p.programmes;if(p.error)self.guide.bulkError=p.error;}};
  var bulk=!!force||Date.now()-self.lastBulk>self.settings.epgMinutes*60000;
  if(!bulk&&!self.player.streamId){self.guide.running=false;self.lastCurrent=Date.now();return {ok:true,job:'guide',idle:true};}
  if(bulk)self.lastBulk=Date.now();
  options.signal=self.guideSignal;
  self.guidePromise=Promise.resolve().then(function(){return bulk?epg.refresh(options):epg.refreshCurrent(options);}).then(function(r){
    self.guide.lastSuccess=new Date().toISOString();self.guide.source=r.source;if(r.source==='xmltv'){self.guide.programmes=r.programmes||self.guide.programmes;self.guide.bulkError=null;}
    self.history.lastGuide=self.guide.lastSuccess;self.history.programmes=self.guide.programmes;self.persistHistory();
    if(r.source==='xmltv')self.lastBulk=Date.now();
    return self.snapshotGuide();
  }).catch(function(e){if(e.code!=='EPG_CANCELLED'){self.guide.error=u.safe(e);self.guide.errorCode=e.code || null;}}).then(function(){self.lastCurrent=Date.now();self.guide.running=false;self.guideSignal=null;});
  return {ok:true,job:'guide'};
};
Manager.prototype.beginInitialRefresh=function(){
  if(!this.initialRefreshPending)return;
  this.initialRefreshPending=false;
  if(this.initialRefreshTimer)clearTimeout(this.initialRefreshTimer);
  if(!this.settings.account||this.saving||this.sync.running||this.guide.running)return;
  if(!this.history.lastSync||Date.now()-Date.parse(this.history.lastSync)>this.settings.syncHours*3600000)this.startSync();
  else if(this.catalog.channels.length&&process.env.XTREAM_SKIP_INITIAL_GUIDE!=='1'&&(!fs.existsSync(this.guideDb)||Date.now()-this.lastBulk>this.settings.epgMinutes*60000))this.startGuide(true);
};
Manager.prototype.queueInitialRefresh=function(){
  var self=this;self.initialRefreshPending=true;
  self.initialRefreshTimer=setTimeout(function(){self.beginInitialRefresh();},30000);
  self.initialRefreshTimer.unref();
  if(self.player.active&&self.player.readyState>=2&&self.player.width>0&&self.player.height>0)self.beginInitialRefresh();
};
Manager.prototype.checkStartupTarget=function(){
  var self=this,id=self.history.lastChannelId,c=self.byNative[id];
  if(!fs.existsSync('/run/xtream-native/early-start')||!c||typeof c.code!=='string'||!/^xtream_\d+$/.test(c.code)||!self.activeAccount)return Promise.resolve(false);
  return u.luna('luna://com.webos.service.iepg/getChannelInfo',{dataType:0,channelId:id}).then(function(reply){
    var rows=reply&&reply.channelList,row=Array.isArray(rows)&&rows.length===1?rows[0]:null;
    // Read one persistent, owned IP row before deferring the full maintenance
    // pass. IEPG uses different lock-field names from getCurrentChannel.
    if(!reply||reply.returnValue!==true||reply.channelListCount!==1||!row||row.channelId!==id||row.chanCode!==c.code||row.IPChannelCode!==c.code||row.channelMode!=='IP'||row.playerService!=='com.webos.service.dmost'||row.locked!==false||row.skipped!==false||row.Invisible!==false)return false;
    self.startupTargetReady=id;return true;
  }).catch(function(){return false;});
};
Manager.prototype.waitStartupPlayback=function(){
  var self=this;
  self.startupMaintenancePending=true;
  return new Promise(function(resolve){
    var timer=setTimeout(function(){self.releaseNativeStartup();},30000);timer.unref();
    self.releaseNativeStartup=function(){
      clearTimeout(timer);self.releaseNativeStartup=function(){};resolve();
    };
    if(self.player.active&&self.player.readyState>=2&&self.player.width>0&&self.player.height>0)self.releaseNativeStartup();
  });
};
Manager.prototype.start=function(){
  var self=this;
  // The native channel database is persistent; the Guide is a volatile SQLite
  // database, restored from our persistent snapshot by control.sh.
  var ready=u.waitForNative();
  var pending=u.read(path.join(self.base,'catalog-transaction.private.json'),null);
  if(pending){
    ready=ready.then(function(){return self.commit(pending);});
  }else if(self.catalog.channels.length)ready=ready.then(function(){return self.checkStartupTarget();}).then(function(fast){return fast?self.waitStartupPlayback():null;}).then(function(){return nativeDb.apply(self.catalog,self.channelDb);}).then(function(){return u.refreshMap();});
  ready.then(function(){self.nativeReady=true;}).catch(function(e){self.sync.error=u.safe(e);}).then(function(){
    self.startupMaintenancePending=false;self.startupTargetReady=null;
    self.queueInitialRefresh();
  });
  setInterval(function(){
    if(self.initialRefreshPending||!self.settings.account||self.saving||self.sync.running||self.guide.running)return;
    if(!self.history.lastSync||Date.now()-Date.parse(self.history.lastSync)>self.settings.syncHours*3600000)self.startSync();
    else if(self.catalog.channels.length&&Date.now()-self.lastCurrent>Math.min(self.settings.epgMinutes,15)*60000)self.startGuide(false);
  },60000);
};
module.exports=Manager;
