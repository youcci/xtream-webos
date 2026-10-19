'use strict';
var fs=require('fs'),http=require('http'),url=require('url'),URL=url.URL;
module.exports=function(manager){
  // These are opaque references, not authentication tokens. A bounded OS
  // random read separates process lifetimes without loading TLS/crypto.
  var nonce=Buffer.alloc(16),fd=fs.openSync('/dev/urandom','r');
  try{var offset=0;while(offset<nonce.length){var n=fs.readSync(fd,nonce,offset,nonce.length-offset,null);if(!n)throw new Error('proxy_nonce_unavailable');offset+=n;}}finally{fs.closeSync(fd);}
  var prefix=nonce.toString('hex'),serial=0,targets=new Map(),keys=new Map();
  function remember(target){
    var key=keys.get(target);if(!key){key=prefix+'_'+(++serial).toString(36);keys.set(target,key);}
    targets.delete(key);targets.set(key,{url:target,time:Date.now()});
    while(targets.size>2000){var oldest=targets.keys().next().value;keys.delete(targets.get(oldest).url);targets.delete(oldest);}
    return '/proxy/'+key;
  }
  function proxy(target,req,res,redirects){
    var parsed;try{parsed=new URL(target);}catch(e){res.writeHead(502);res.end();return;}
    if(!/^https?:$/.test(parsed.protocol)){res.writeHead(502);res.end();return;}
    var options=Object.assign(url.parse(parsed.href),{headers:{'User-Agent':'Mozilla/5.0 XtreamNative/1.0',Accept:'*/*'}});
    if(req.headers.range)options.headers.Range=req.headers.range;
    var upstream=(parsed.protocol==='https:'?require('https'):http).get(options,function(response){
      if(response.statusCode>=300&&response.statusCode<400&&response.headers.location&&redirects<6){response.resume();try{return proxy(new URL(response.headers.location,target).href,req,res,redirects+1);}catch(e){res.writeHead(502);res.end();return;}}
      if(response.statusCode!==200&&response.statusCode!==206){response.resume();if(!res.headersSent)res.writeHead(response.statusCode===404?404:502);res.end();return;}
      var type=response.headers['content-type'] || '';
      if(/mpegurl/i.test(type)||/\.m3u8(?:\?|$)/i.test(parsed.pathname)){
        var parts=[],size=0;response.on('data',function(b){size+=b.length;if(size>2*1024*1024){upstream.destroy();res.destroy();}else parts.push(b);});
        response.on('end',function(){if(res.destroyed)return;var body=Buffer.concat(parts).toString('utf8');
          if(body.indexOf('#EXTM3U')!==0){res.writeHead(502);res.end();return;}
          try{body=body.split(/\r?\n/).map(function(line){
            if(line&&line[0]!=='#')return remember(new URL(line.trim(),target).href);
            return line.replace(/URI="([^"]+)"/g,function(_,v){return 'URI="'+remember(new URL(v,target).href)+'"';});
          }).join('\n');}catch(e){res.writeHead(502);res.end();return;}
          res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'no-store'});res.end(body);
        });
      }else{
        var headers={'Content-Type':type || 'video/mp2t','Cache-Control':'no-store'};
        ['content-length','content-range','accept-ranges'].forEach(function(k){if(response.headers[k])headers[k]=response.headers[k];});
        res.writeHead(response.statusCode,headers);response.pipe(res);
      }
      response.on('error',function(){res.destroy();});
    });
    upstream.setTimeout(20000,function(){upstream.destroy();});
    upstream.on('error',function(){if(!res.headersSent)res.writeHead(502);res.end();});
    res.on('close',function(){upstream.destroy();});
  }
  return function(req,res,pathname){
    if(pathname.indexOf('/proxy/')===0){var t=targets.get(pathname.slice(7));if(!t||Date.now()-t.time>600000){res.writeHead(410);res.end();}else proxy(t.url,req,res,0);return true;}
    var match=/^\/streams\/(\d+)\.m3u8$/.exec(pathname);
    if(!match)return false;
    if(!manager.byId[match[1]]||!manager.activeAccount){res.writeHead(404);res.end();return true;}
    var a=manager.activeAccount;
    proxy(a.url+'/live/'+encodeURIComponent(a.username)+'/'+encodeURIComponent(a.password)+'/'+match[1]+'.m3u8',req,res,0);return true;
  };
};
