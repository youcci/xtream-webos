'use strict';
// Native Guide compatibility. LG's original network feed remains disabled.
var fs=require('fs'),path=require('path'),http=require('http'),Service=require('/usr/lib/node_modules/webos-service'),u=require('./lib/util');
var state=require('./provider-state.json');
var service=new Service('com.webos.service.pbsw',null,{idleTimer:86400});
var catalogue={channels:[],categories:[]},mtime=0;
fs.writeFileSync(path.join(__dirname,'provider.pid'),String(process.pid),{mode:384});
function current(){try{var f=path.join(__dirname,'catalog.private.json'),s=fs.statSync(f);if(s.mtime.getTime()!==mtime){catalogue=u.read(f);mtime=s.mtime.getTime();}}catch(e){}return catalogue;}
function handler(name,factory){service.register(name,function(message){message.respond(Object.assign({},factory(message.payload || {}),{subscribed:!!message.isSubscription}));},function(){});}
function publishPolicy(){
  var sent=0;
  Object.keys(service.subscriptions).forEach(function(key){var message=service.subscriptions[key];if(message.method==='getCountryPolicy'){message.respond(Object.assign({},state.policy,{subscribed:true}));sent++;}});
  return sent;
}
// The native cache creator listens to policy updates. Republishing unchanged
// capabilities rebuilds its SQL-backed channel cache without importing an LG feed.
handler('xtreamRefresh',function(){return {returnValue:true,notified:publishPolicy()};});
fs.watchFile(path.join(__dirname,'catalog.private.json'),{interval:1500},function(now,previous){if(now.mtime.getTime()!==previous.mtime.getTime()){current();publishPolicy();}});
handler('getCountryPolicy',function(){return state.policy;});
handler('getEpgStatus',function(){return state.status;});
handler('getChannelList',function(){var channels=current().channels.map(function(c){return {channelId:c.nativeId,channelNumber:String(c.number),channelName:c.name,channelCode:c.code,channelGenreCode:String(c.genreCode),channelMode:'IP',channelSource:'IP',playerService:'com.webos.service.dmost',streamURI:'http://127.0.0.1:17651/streams/'+c.id+'.m3u8'};});return {returnValue:true,channelListCount:channels.length,channelList:channels};});
handler('getDbFilePath',function(){return {returnValue:true,dbFilePath:'/mnt/lg/cmn_data/iepg/db/channel.sql'};});
handler('notifyChannelListChanged',function(){return {returnValue:true,changed:false,channelSource:'IP',channelListCount:current().channels.length};});
handler('updateEpgInfo',function(){return {returnValue:true,epgType:'IP',epgUpdateReason:'none',epgUpdateReasonId:0};});
handler('getMCPList',function(){return {returnValue:true,mcpList:[],MCPList:[]};});
handler('getChannelGroupList',function(){return {returnValue:true,channelGroupList:[]};});
handler('notifyGenreChanged',function(){return {returnValue:true,changed:false};});
handler('notifyInternetChannelStatusUpdate',function(){return {returnValue:true,changed:false};});
handler('getServiceStatus',function(){return {returnValue:true,status:true};});
handler('ping',function(){return {returnValue:true};});
// Private IPC for the management process. The directory is 0700 and this
// socket is 0600; native calls stay on this resident LS2 handle.
var nativeSocket=path.join(__dirname,'native.sock');
try{fs.unlinkSync(nativeSocket);}catch(e){if(e.code!=='ENOENT')throw e;}
var allowed=[
  'luna://com.webos.service.iepg/getChannelInfo',
  'luna://com.webos.service.utp.channel/getChannelSortMode',
  'luna://com.webos.service.utp.channel/setChannelSortMode',
  'luna://com.webos.applicationManager/launch',
  'luna://com.webos.applicationManager/getForegroundAppInfo',
  'luna://com.webos.applicationManager/running',
  'luna://com.webos.service.utp.broadcast/bind',
  'luna://com.webos.service.utp.broadcast/getCurrentChannel',
  'luna://com.webos.service.utp.broadcast/changeChannel',
  'luna://com.webos.service.wampluggable.dmost/getChannel',
  'luna://com.webos.service.wampluggable.dmost/setDmostUrl'
];
http.createServer(function(req,res){
  var parts=[],size=0;
  function reply(value){if(res.finished)return;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
  req.on('data',function(b){size+=b.length;if(size>16384)req.destroy();else parts.push(b);});
  req.on('end',function(){
    var data;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch(e){return reply({returnValue:false,errorCode:'invalid_request'});}
    if(data.uri==='ping')return reply({returnValue:true});
    if(data.uri==='luna://com.webos.service.pbsw/xtreamRefresh')return reply({returnValue:true,notified:publishPolicy()});
    if(allowed.indexOf(data.uri)<0)return reply({returnValue:false,errorCode:'method_not_allowed'});
    var timer=setTimeout(function(){reply({returnValue:false,errorCode:'timeout'});},18000);
    try{service.call(data.uri,data.payload || {},function(message){clearTimeout(timer);reply(message.payload || {returnValue:false,errorCode:'empty_response'});});}
    catch(e){clearTimeout(timer);reply({returnValue:false,errorCode:'native_call_failed'});}
  });
}).listen(nativeSocket,function(){fs.chmodSync(nativeSocket,384);});
