'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var http = require('http');
function read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (fallback !== undefined) return fallback; throw e; } }
function write(file, data) {
  var tmp = file + '.new';
  fs.writeFileSync(tmp, JSON.stringify(data), {mode:384});
  fs.renameSync(tmp, file);
  fs.chmodSync(file,384);
}
function fail(message) { var e = new Error(message); e.safe = true; return e; }
function safe(e) { return e && e.safe ? e.message : 'Operation failed; previous working data was retained.'; }
function text(s, max) { return String(s == null ? '' : s).replace(/<[^>]*>/g,'').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,max || 256); }
function sql(v) { if (v === null || v === undefined) return 'NULL'; if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'; return "'" + String(v).replace(/\x00/g,'').replace(/'/g,"''") + "'"; }
function sqlite(db, script) {
  return new Promise(function(resolve,reject) {
    var child = cp.spawn(process.env.XTREAM_SQLITE || '/usr/bin/sqlite3', ['-batch','-bail',db]);
    var out='', err='', done=false;
    var timer=setTimeout(function(){child.kill('SIGKILL');},60000);
    child.stdout.on('data',function(b){ if(out.length<32*1024*1024)out+=b; });
    child.stderr.on('data',function(b){ if(err.length<1024)err+=b; });
    child.on('error',function(){done=true;clearTimeout(timer);reject(fail('Native database tool could not start.'));});
    child.on('close',function(code){clearTimeout(timer);if(done)return;if(code!==0)reject(fail('Native database update failed; transaction was rolled back.'));else resolve(out);});
    child.stdin.on('error',function(){});
    if(typeof script==='string')child.stdin.end('.timeout 15000\n'+script+'\n');
    else (async function(){
      child.stdin.write('.timeout 15000\n');
      for(var statement of script){
        if(!child.stdin.write(statement+'\n'))await new Promise(function(ready,failed){
          function drain(){child.stdin.removeListener('error',error);ready();}
          function error(){child.stdin.removeListener('drain',drain);failed(new Error('pipe'));}
          child.stdin.once('drain',drain);child.stdin.once('error',error);
        });
      }
      child.stdin.end();
    }()).catch(function(){child.kill();});
  });
}
function luna(uri,payload) {
  return new Promise(function(resolve,reject) {
    var data=JSON.stringify({uri:uri,payload:payload || {}});
    var req=http.request({socketPath:path.join(__dirname,'..','native.sock'),path:'/',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},function(res){
      var out='';res.on('data',function(b){out+=b;if(out.length>1024*1024)req.destroy();});
      res.on('end',function(){var value;try{value=JSON.parse(out);if(value.returnValue===false)throw new Error();resolve(value);}catch(e){reject(fail('TV service '+uri.split('/').pop()+' did not accept the request'+(value&&value.errorCode!==undefined?' ('+String(value.errorCode).slice(0,16)+')':'')+'.'));}});
    });
    req.setTimeout(20000,function(){req.destroy();});req.on('error',function(){reject(fail('The TV control service is starting. Try again in a moment.'));});req.end(data);
  });
}
function refreshMap() {
  return luna('luna://com.webos.service.utp.channel/getChannelSortMode',{}).then(function(r){
    var original=Number((r.channelSortMode || r).channelSortModeType)===1?1:0;
    function set(n){return luna('luna://com.webos.service.utp.channel/setChannelSortMode',{channelSortModeType:n,channelSortModeName:n?'channelName':'channelNumber'});}
    return set(1-original).then(function(){return new Promise(function(resolve){setTimeout(resolve,750);});}).then(function(){return set(original);});
  });
}
function waitForNative(options){
  options=options||{};
  var probe=options.probe||function(){return luna('ping',{});},now=options.now||Date.now;
  var sleep=options.sleep||function(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});};
  var deadline=now()+10000;
  function check(){
    if(now()>=deadline)return Promise.reject(fail('The native TV bridge did not become ready during startup.'));
    return Promise.resolve().then(probe).then(function(reply){if(!reply||reply.returnValue!==true)throw new Error('bridge_not_ready');return true;}).catch(function(){
      return sleep(250).then(check);
    });
  }
  return check();
}
exports.read=read;exports.write=write;exports.fail=fail;exports.safe=safe;exports.text=text;exports.sql=sql;exports.sqlite=sqlite;exports.luna=luna;exports.refreshMap=refreshMap;exports.waitForNative=waitForNative;
