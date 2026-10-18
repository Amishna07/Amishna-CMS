'use strict';
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {test}=require('node:test');
const vm=require('node:vm');
const source=readFileSync(join(__dirname,'../public/dashboard.js'),'utf8');
function context(){
  const ctx=vm.createContext({structuredClone,crypto:globalThis.crypto});ctx.window=ctx;ctx.matchMedia=()=>({matches:false});ctx.document={querySelector:()=>null};
  vm.runInContext(source.slice(0,source.indexOf('/* data.js */')),ctx);
  vm.runInContext(readFileSync(join(__dirname,'../public/societies.js'),'utf8'),ctx);
  vm.runInContext(source.slice(source.indexOf('/* catalog.js */'),source.indexOf('/* database-import.js */')),ctx);
  vm.runInContext(source.slice(source.indexOf('/* insights.js'),source.indexOf('/* insights.js end */')),ctx);
  return ctx;
}
function fixture(){return {
  projects:[{id:'movie',title:'Film',type:'Movie',episodes:[]},{id:'serial',title:'Serial',type:'Series',episodes:[{number:1},{number:2}]}],
  artists:[{id:'dual',name:'Dual Writer',societies:['IPRS','PRS'],roles:['Composer']},{id:'prs',name:'PRS Writer',societies:['PRS'],roles:['Composer']},{id:'singer',name:'Singer',societies:['ASCAP'],roles:['Performer']}],
  works:[{id:'w1',title:'One',artistIds:['singer'],recordingDuration:'00:03:00',isrc:'IN123',tuneCode:'123',parties:[{artistId:'dual',name:'Dual Writer',role:'Composer',share:100,society:'IPRS/PRS'}],createdAt:'2026-01-01',updatedAt:'2026-02-01'},{id:'w2',title:'Two',artist:'PRS Writer',artistIds:['prs'],parties:[{artistId:'prs',name:'PRS Writer',role:'Composer',share:100,society:'PRS'}],createdAt:'2026-01-03',updatedAt:'2026-01-04'}],
  cues:[{id:'c1',workId:'w1',projectId:'movie',duration:60,start:0,end:60,usage:'FV'},{id:'c2',workId:'w1',projectId:'serial',episode:1,duration:90,start:0,end:90,usage:'FV'},{id:'c3',workId:'w2',projectId:'serial',episode:2,duration:30,start:0,end:30,usage:'FV'}],
  exports:[{id:'x1',projectTitle:'Film',society:'IPRS',date:'2026-02-01',snapshot:{cues:[{workId:'w1'}]}},{id:'x2',projectTitle:'Old',society:'PRS',date:'2025-01-01'}],imports:[],activity:[],preferences:{}};}

test('workspace and project music statistics deduplicate artists/songs and separate movies from serial episodes',()=>{
 const a=context().CueInsights.analyze(fixture());
 assert.equal(a.movies,1);assert.equal(a.serials,1);assert.equal(a.episodes,2);assert.equal(a.musicDuration,180);assert.equal(a.averageCue,60);assert.equal(a.averageUsage,90);
 const serial=a.projectData.get('serial');assert.equal(serial.songs.size,2);assert.equal(serial.artists.size,3);assert.equal(serial.cues,2);assert.equal(serial.duration,120);assert.equal(serial.units,2);
 const song=a.workData.get('w1');assert.equal(song.cues.length,2);assert.equal(song.episodes.size,1);assert.equal(song.projectIds.size,2);assert.equal(song.duration,150);
});

test('society breakdown counts dual members in both and excludes PRS-only rights from IPRS music usage',()=>{
 const a=context().CueInsights.analyze(fixture());assert.equal(a.society.IPRS.artists,1);assert.equal(a.society.PRS.artists,2);assert.equal(a.society.ASCAP.artists,1);
 assert.equal(a.society.IPRS.songs,1);assert.equal(a.society.IPRS.cues,2);assert.equal(a.society.IPRS.duration,150);assert.equal(a.society.PRS.duration,180);assert.equal(a.society.ASCAP.cues,0);assert.equal(a.society.prsOnlyArtists,1);
});

test('quality catches missing data, duplicate normalized names, invalid timing and preserves optional fields',()=>{
 const state=fixture(),before=structuredClone(state);state.works.push({id:'w3',title:'O n e',parties:[]});state.cues.push({id:'bad',projectId:'serial',workId:'w3',episode:99,duration:'invalid',start:null,end:2,usage:''});
 const a=context().CueInsights.analyze(state);assert.equal(a.quality.duplicateSongs.length,2);assert.ok(a.quality.missingComposer.includes('w3'));assert.ok(a.quality.missingLyricist.includes('w1'));assert.ok(a.quality.missingPrs.includes('w2'));assert.ok(a.quality.incompleteCues.includes('bad'));assert.equal(a.musicDuration,180);assert.deepEqual(state.works[0],before.works[0]);
});

test('song export history requires an actual retained snapshot and recent activities use real dates',()=>{
 const a=context().CueInsights.analyze(fixture());assert.equal(a.exportHistory.get('w1').length,1);assert.equal(a.exportHistory.has('w2'),false);assert.equal(a.recent.added[0].id,'w2');assert.equal(a.recent.edited[0].id,'w1');assert.equal(a.recent.episodes.length,0);
});

test('empty workspace and malformed cue durations remain finite',()=>{
 const ctx=context(),a=ctx.CueInsights.analyze({});assert.equal(a.musicDuration,0);assert.equal(a.averageCue,0);assert.equal(a.averageUsage,0);assert.equal(a.missingSongs,0);
 const state=fixture();state.cues[0].duration=Infinity;assert.equal(ctx.CueInsights.analyze(state).musicDuration,120);
});

test('song library applies society and contributor filters independently while retaining edit actions',()=>{
 const ctx=context(),state=fixture();let renders=0;
 const catalog=ctx.CueCatalog.create({state:()=>state,revision:()=>0,esc:value=>String(value??''),icon:()=>'',render:()=>renders++,date:String});
 catalog.change({target:{dataset:{catalog:'song-society'},value:'IPRS'}});let html=catalog.songs();assert.ok(html.includes('data-id="w1"'));assert.ok(!html.includes('data-id="w2"'));assert.ok(html.includes('song-shares'));assert.ok(html.includes('song-merge'));
 catalog.change({target:{dataset:{catalog:'song-role'},value:'Publisher'}});html=catalog.songs();assert.ok(html.includes('No songs match your filters'));assert.equal(renders,2);
});

test('song pagination limits visible rows and direct record navigation reaches records beyond the first page',()=>{
 const ctx=context(),state=fixture();state.works=Array.from({length:95},(_,i)=>({id:'song-'+i,title:'Song '+String(i).padStart(3,'0'),parties:[]}));state.cues=[];let page='';
 const catalog=ctx.CueCatalog.create({state:()=>state,revision:()=>0,esc:value=>String(value??''),icon:()=>'',render:()=>{},go:value=>page=value,date:String});
 let html=catalog.songs();assert.equal((html.match(/data-catalog="song-check"/g)||[]).length,40);assert.ok(html.includes('Page 1 of 3'));
 const element={dataset:{catalog:'song-open',id:'song-91'}};catalog.click({target:{closest:()=>element},preventDefault(){}});html=catalog.songs();assert.equal(page,'works');assert.ok(html.includes('Page 3 of 3'));assert.ok(html.includes('<h2>Song 091</h2>'));
});

test('derived models are reused across library and report navigation and refresh after saves or workspace replacement',()=>{
 const api=context().CueInsights,state=fixture(),first=api.get(state,1);assert.equal(api.get(state,1),first);state.cues.push({...state.cues[0],id:'new'});const saved=api.get(state,2);assert.notEqual(saved,first);assert.equal(saved.musicDuration,240);assert.notEqual(api.get(structuredClone(state),2),saved);
});
