'use strict';
var http=require('http'),https=require('https'),url=require('url'),URL=url.URL,u=require('./util');
function account(candidate,previous) {
  candidate=candidate || {};previous=previous || {};
  var base=String(candidate.url || '').trim().replace(/\/+$/,'');
  var parsed;
  try {parsed=new URL(base);}catch(e){throw u.fail('Enter a valid http or https server address.');}
  if(!/^https?:$/.test(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw u.fail('Use the server address without account details or query parameters.');
  var username=String(candidate.username || '').trim();
  var password=candidate.password;
  if(password===undefined || password==='') {
    if(base===previous.url&&username===previous.username)password=previous.password;
  }
  if(!username||!password)throw u.fail('Enter the username and password.');
  if(username.length>512||String(password).length>512)throw u.fail('Account details are too long.');
  return {url:base,username:username,password:String(password)};
}
function api(a,action,extra) {
  var target=new URL(a.url+'/player_api.php');
  target.searchParams.set('username',a.username);target.searchParams.set('password',a.password);
  if(action)target.searchParams.set('action',action);
  Object.keys(extra || {}).forEach(function(k){target.searchParams.set(k,extra[k]);});
  return new Promise(function(resolve,reject){
    var options=Object.assign(url.parse(target.href),{headers:{'User-Agent':'XtreamNative/1.0','Accept':'application/json'}});
    var req=(target.protocol==='https:'?https:http).get(options,function(res){
      if(res.statusCode!==200){res.resume();return reject(u.fail('Provider returned HTTP '+res.statusCode+'.'));}
      var bytes=0,parts=[];
      res.on('data',function(b){bytes+=b.length;if(bytes>48*1024*1024){req.destroy();reject(u.fail('Provider response exceeds the safe size limit.'));}else parts.push(b);});
      res.on('end',function(){try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch(e){reject(u.fail('Provider returned an invalid channel response.'));}});
      res.on('error',function(){reject(u.fail('Provider download was interrupted.'));});
    });
    req.setTimeout(45000,function(){req.destroy();});req.on('error',function(){reject(u.fail('Could not reach the provider. Check the server address and network.'));});
  });
}
function test(a){return api(a).then(function(r){var v=r.user_info || {};if(Number(v.auth)!==1 || (v.status&&v.status!=='Active'))throw u.fail('The provider did not accept this account.');return {ok:true,status:v.status || 'Active',maxConnections:Number(v.max_connections)||1,expires:v.exp_date?Number(v.exp_date):null};});}
exports.account=account;exports.api=api;exports.test=test;
