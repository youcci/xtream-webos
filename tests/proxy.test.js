'use strict';
var assert=require('assert'),http=require('http'),Module=require('module'),load=Module._load,proxy=require('../runtime/lib/proxy');
var upstream,local,other,tests=0,base;
function listen(server){return new Promise(function(resolve){server.listen(0,'127.0.0.1',function(){resolve('http://127.0.0.1:'+server.address().port);});});}
function get(url){return new Promise(function(resolve,reject){http.get(url,function(r){var body='';r.on('data',function(b){body+=b;});r.on('end',function(){resolve({status:r.statusCode,body:body});});}).on('error',reject);});}
function serve(manager){var route=proxy(manager);return http.createServer(function(req,res){if(!route(req,res,req.url)){res.writeHead(404);res.end();}});}
(async function(){try{
  upstream=http.createServer(function(req,res){
    if(req.url.indexOf('/live/')===0){res.writeHead(302,{Location:'/folder/live.m3u8'});res.end();}
    else if(req.url==='/folder/live.m3u8'){res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'});res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts\n');}
    else{res.writeHead(200);res.end(req.url==='/folder/key.bin'?'synthetic-key':'synthetic-video');}
  });
  base=await listen(upstream);var manager={byId:{'1':{}},activeAccount:{url:base,username:'synthetic-user',password:'synthetic-password'}};
  Module._load=function(name){if(name==='https'||name==='crypto')throw new Error('HTTP playback loaded '+name);return load.apply(this,arguments);};
  local=serve(manager);var url=await listen(local),first=await get(url+'/streams/1.m3u8');assert.strictEqual(first.status,200);
  assert(!/synthetic-user|synthetic-password|http:/.test(first.body));
  var paths=first.body.match(/\/proxy\/[a-z0-9_]+/g);assert.strictEqual(paths.length,2);
  assert.strictEqual((await get(url+paths[0])).body,'synthetic-key');assert.strictEqual((await get(url+paths[1])).body,'synthetic-video');tests++;console.log('ok - HTTP redirects, relative segments and encryption-key URLs proxy without crypto/TLS loading or credential URLs');
  assert.strictEqual((await get(url+'/streams/1.m3u8')).body,first.body);tests++;console.log('ok - repeated target URLs retain stable handles within one process');
  other=serve(manager);var second=await get((await listen(other))+'/streams/1.m3u8');assert.notStrictEqual(second.body,first.body);tests++;console.log('ok - process-local proxy instances cannot collide with stale handles');
  assert.strictEqual((await get(url+'/streams/999.m3u8')).status,404);assert.strictEqual((await get(url+'/proxy/unknown')).status,410);tests++;console.log('ok - unknown channels and handles are rejected');
  console.log(tests+' proxy tests passed');
}finally{Module._load=load;[local,other,upstream].forEach(function(s){if(s)s.close();});}}()).catch(function(e){console.error(e);process.exitCode=1;});
