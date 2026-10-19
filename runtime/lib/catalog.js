'use strict';
var u=require('./util');
function build(rawCategories,streams,previous) {
  if(!Array.isArray(rawCategories)||!Array.isArray(streams)||!streams.length)throw u.fail('The account returned no live channels; the existing list was retained.');
  previous=previous || {channels:[],categories:[]};
  var byCategory=Object.create(null),genres=Object.create(null),numbers=Object.create(null),old=Object.create(null),used=Object.create(null),seen=Object.create(null);
  var assignments=Object.assign({},previous.assignments || {});
  previous.channels.forEach(function(c){old[String(c.id)]=c;assignments[c.id]=c.number;});
  Object.keys(assignments).forEach(function(k){used[assignments[k]]=true;});
  previous.categories.forEach(function(c){genres[c.id]=c.genreCode;});
  var usedGenres=Object.create(null);Object.keys(genres).forEach(function(k){usedGenres[genres[k]]=true;});
  var nextGenre=100,nextNumber=1001,categories=[];
  function addCategory(id,name) {
    if(byCategory[id])return byCategory[id];
    var genre=genres[id];
    if(!genre){while(usedGenres[nextGenre]&&nextGenre<998)nextGenre++;if(nextGenre>=998)throw u.fail('Too many categories for the native Guide.');genre=nextGenre++;usedGenres[genre]=true;}
    var c={id:id,name:u.text(name)||'Uncategorised',genreCode:genre,count:0};byCategory[id]=c;categories.push(c);return c;
  }
  rawCategories.forEach(function(c){addCategory(String(c.category_id),c.category_name);});
  var channels=[],headersSkipped=0;
  streams.forEach(function(s){
    // Xtream lists also contain decorative category-divider pseudo streams.
    if(/^\s*#{3,}[\s\S]*#{3,}\s*$/.test(String(s.name || ''))){headersSkipped++;return;}
    var id=String(s.stream_id);
    if(!/^\d+$/.test(id)||seen[id])return;
    seen[id]=true;
    var cat=addCategory(String(s.category_id || 'uncategorised'),'Uncategorised');
    var number;
    if(assignments[id])number=assignments[id];
    else {while(used[nextNumber])nextNumber++;number=nextNumber++;}
    if(number>65000)throw u.fail('The native channel number range is full.');
    used[number]=true;assignments[id]=number;cat.count++;
    channels.push({id:id,nativeId:'11_3_'+number+'_65535_0_0_0',code:'xtream_'+id,number:number,name:u.text(s.name)||'Channel '+id,categoryId:cat.id,categoryName:cat.name,genreCode:cat.genreCode,epgId:u.text(s.epg_channel_id,512)});
  });
  if(channels.length<previous.channels.length/2)throw u.fail('The provider returned less than half the previous channel list; retry the refresh before replacing it.');
  return {version:1,updatedAt:new Date().toISOString(),categories:categories,channels:channels,assignments:assignments,sourceCount:streams.length,headersSkipped:headersSkipped,duplicatesOrInvalid:streams.length-channels.length-headersSkipped};
}
exports.build=build;
