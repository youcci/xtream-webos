'use strict';
var fs=require('fs'),path=require('path'),http=require('http'),URL=require('url').URL,u=require('./lib/util'),client=require('./lib/client'),Manager=require('./lib/manager');
var manager=new Manager(__dirname),proxy=require('./lib/proxy')(manager);
fs.writeFileSync(path.join(__dirname,'server.pid'),String(process.pid),{mode:384});
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));}
function body(req){return new Promise(function(resolve,reject){var parts=[],size=0;req.on('data',function(b){size+=b.length;if(size>16384){req.destroy();reject(u.fail('Request is too large.'));}else parts.push(b);});req.on('end',function(){try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'));}catch(e){reject(u.fail('Invalid request.'));}});req.on('error',reject);});}
function file(res,name,type){fs.readFile(path.join(__dirname,name),function(e,b){if(e){res.writeHead(404);res.end();}else{res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(b);}});}
function tune(channel){
  return u.luna('luna://com.webos.applicationManager/launch',{id:'com.webos.app.livetv',params:{id:'channelChange',channelId:channel.nativeId}}).then(function(){
    var started=Date.now();
    return new Promise(function(resolve,reject){function check(){
      if(manager.player.channelId===channel.nativeId&&manager.player.active)return resolve({ok:true});
      if(Date.now()-started>6000)return reject(u.fail('LG has not activated this channel yet. Try Watch again.'));
      setTimeout(check,200);
    }check();});
  });
}
http.createServer(function(req,res){
  var parsed=new URL(req.url,'http://127.0.0.1:17651'),p=parsed.pathname;
  if(proxy(req,res,p))return;
  if(req.method==='GET'&&p==='/player.html')return file(res,'player.html','text/html');
  if(req.method==='GET'&&p==='/channel'){
    var c=manager.byNative[parsed.searchParams.get('id')];return json(res,c?200:404,c?{channelId:c.nativeId,name:c.name,stream:'/streams/'+c.id+'.m3u8'}:{error:'Unknown channel'});
  }
  if(req.method==='GET'&&p==='/status')return json(res,200,{ok:true,channels:manager.catalog.channels.length,player:manager.player,sync:manager.sync,guide:manager.guide});
  if(req.method==='POST'&&p==='/telemetry')return body(req).then(function(v){
    var c=manager.byNative[v.channelId];if(v.type==='snapshot')manager.player={channelId:v.channelId || null,streamId:c?c.id:null,name:c?c.name:null,currentTime:Number(v.currentTime)||0,readyState:v.readyState,paused:!!v.paused,width:v.width,height:v.height,error:v.error,active:!!v.active,updatedAt:Date.now()};
    if(c&&v.active&&v.readyState>=2&&manager.history.lastChannelId!==c.nativeId){manager.history.lastChannelId=c.nativeId;manager.persistHistory();}
    json(res,200,{ok:true});
  }).catch(function(){json(res,400,{error:'Invalid telemetry'});});
  if(req.method==='GET'&&(p==='/app/'||p==='/app/index.html'))return file(res,'app/index.html','text/html');
  var assets={'/app/app.js':['app/app.js','application/javascript'],'/app/styles.css':['app/styles.css','text/css'],'/app/icon.svg':['app/icon.svg','image/svg+xml']};
  if(req.method==='GET'&&assets[p])return file(res,assets[p][0],assets[p][1]);
  if(p.indexOf('/api/')!==0)return json(res,404,{error:'Not found'});
  // Only the locally installed management app has this per-device token.
  var token=String(req.headers['x-xtream-token'] || '');
  var origin=req.headers.origin;
  if(token!==manager.settings.token || (origin&&origin!=='http://127.0.0.1:17651'))return json(res,403,{error:'Open Xtream TV on the television.'});
  Promise.resolve().then(function(){
    if(req.method==='GET'){
      if(p==='/api/status')return manager.status();
      if(p==='/api/settings')return manager.publicSettings();
      if(p==='/api/categories')return {categories:manager.catalog.categories};
      if(p==='/api/category-selection')return manager.selection();
      if(p==='/api/channels'){
        var category=parsed.searchParams.get('category'),q=String(parsed.searchParams.get('q') || '').toLowerCase(),offset=Math.max(0,Number(parsed.searchParams.get('offset'))||0),limit=Math.max(1,Math.min(100,Number(parsed.searchParams.get('limit'))||40));
        var items=manager.catalog.channels.filter(function(c){return (!category||category==='all'||c.categoryId===category)&&(!q||(c.name+' '+c.number).toLowerCase().indexOf(q)>=0);});
        return {items:items.slice(offset,offset+limit).map(function(c){return {id:c.id,nativeId:c.nativeId,number:c.number,name:c.name,categoryName:c.categoryName};}),total:items.length,offset:offset,limit:limit};
      }
    }
    return body(req).then(function(b){
      if(req.method==='PUT'&&p==='/api/settings')return manager.save(b);
      if(req.method==='POST'&&p==='/api/test-account')return client.test(manager.candidate(b));
      if(req.method==='POST'&&p==='/api/sync')return manager.startSync();
      if(req.method==='POST'&&p==='/api/category-selection')return manager.select(b.ids);
      if(req.method==='POST'&&p==='/api/refresh-guide')return manager.startGuide(true);
      if(req.method==='POST'&&p==='/api/tune'){
        var c=manager.byId[String(b.id)];if(!c)throw u.fail('This channel is no longer in the account.');
        return tune(c);
      }
      if(req.method==='POST'&&p==='/api/open-guide'){
        var current=manager.byNative[manager.player.channelId] || manager.byNative[manager.history.lastChannelId] || manager.catalog.channels[0];
        if(!current)throw u.fail('Choose categories and apply the selection first.');
        return tune(current).then(function(){return u.luna('luna://com.webos.applicationManager/launch',{id:'com.webos.app.livemenu',params:{activateType:'tvguide',keepState:true,epgLastTime:false}});}).then(function(){return {ok:true};});
      }
      throw u.fail('Unknown action.');
    });
  }).then(function(v){json(res,(p==='/api/sync'||p==='/api/refresh-guide'||p==='/api/category-selection')?202:200,v);}).catch(function(e){json(res,400,{ok:false,error:u.safe(e)});});
}).listen(17651,'127.0.0.1',function(){manager.start();});
process.on('uncaughtException',function(e){console.error('Unexpected service error:',e && e.code || 'internal');process.exit(1);});
