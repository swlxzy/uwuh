"use strict";

/* ---------- Database ---------- */
const DB_NAME="UWHIRMY_DB", DB_VERSION=2;
let db=null, dbAvailable=true;
const defaultSettings={theme:"obsidian",background:"ps2",visualizer:"spectrum",visualizerColor:"theme",customVizColor:"#9a72d7",sensitivity:"medium",volume:.82,shuffle:false,repeat:"off",lastTrackId:null,lastPosition:0,reducedMotion:false,fps:"auto",eqPreset:"flat",eqBass:0,eqMid:0,eqTreble:0,bassBoost:false,bassBoostLevel:6,dynamicArtwork:true,logoStyle:"triad",logoParticles:"pixel",lyricColor:"#f4f5f7",lyricColor2:"#8b5cf6",lyricColor3:"#22d3ee",lyricColorMode:"solid",lyricAngle:90,lyricFont:"Inter",lyricEffect:"none",lyricSize:24};
const state={tracks:[],current:null,settings:{...defaultSettings},filter:"all",query:"",audioUrl:null,removeId:null,sourceReady:false,ctx:null,analyser:null,source:null,filters:null,raf:0,lastFrame:0,particles:[],canvasDpr:1,lyricsCache:{},lyricsStyle:"normal",lyricsOpen:false,lyricsToken:0,lyricsSync:null};

function openDB(){
  return new Promise((resolve,reject)=>{
    if(!("indexedDB" in window)){dbAvailable=false;reject(new Error("IndexedDB unavailable"));return}
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{const d=req.result;
      if(!d.objectStoreNames.contains("tracks"))d.createObjectStore("tracks",{keyPath:"id"});
      if(!d.objectStoreNames.contains("settings"))d.createObjectStore("settings",{keyPath:"key"});
      if(!d.objectStoreNames.contains("lyrics"))d.createObjectStore("lyrics",{keyPath:"trackId"});
    };
    req.onsuccess=()=>{db=req.result;db.onerror=()=>{dbAvailable=false};resolve(db)};
    req.onerror=()=>{dbAvailable=false;reject(req.error)};
  });
}
function tx(store,mode="readonly"){return db.transaction(store,mode).objectStore(store)}
function getAllTracks(){return new Promise((res,rej)=>{if(!db)return rej();const r=tx("tracks").getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)})}
function putTrack(t){return new Promise((res,rej)=>{try{const r=tx("tracks","readwrite").put(t);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)}catch(e){rej(e)}})}
function deleteTrack(id){return new Promise((res,rej)=>{const r=tx("tracks","readwrite").delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function getLyrics(id){return new Promise((res,rej)=>{if(!db)return res(null);try{const r=tx("lyrics").get(id);r.onsuccess=()=>res(r.result||null);r.onerror=()=>rej(r.error)}catch(e){res(null)}})}
function putLyrics(l){return new Promise((res,rej)=>{try{const r=tx("lyrics","readwrite").put(l);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)}catch(e){rej(e)}})}
function deleteLyrics(id){return new Promise((res,rej)=>{try{const r=tx("lyrics","readwrite").delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)}catch(e){res()}})}
function saveSetting(key,value){return new Promise((res,rej)=>{try{const r=tx("settings","readwrite").put({key,value});r.onsuccess=()=>res();r.onerror=()=>rej(r.error)}catch(e){rej(e)}})}
async function loadSettings(){if(!db)return;try{const arr=await new Promise((res,rej)=>{const r=tx("settings").getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)});arr.forEach(x=>state.settings[x.key]=x.value)}catch{}}

/* ---------- Metadata / covers ---------- */
function cleanName(n){n=String(n||'');return n.replace(/\.[^/.]+$/,'').replace(/[_-]+/g,' ').trim()||'Untitled'}
function textFromBytes(bytes,start,len){let s='';for(let i=start;i<Math.min(bytes.length,start+len);i++)s+=String.fromCharCode(bytes[i]);return s.replace(/\0/g,'').trim()}
function synchsafe(a,b,c,d){return (a<<21)|(b<<14)|(c<<7)|d}
function blobToDataURL(blob){
  return new Promise(resolve=>{
    try{const r=new FileReader();r.onload=()=>resolve(String(r.result||''));r.onerror=()=>resolve(null);r.readAsDataURL(blob)}catch{resolve(null)}
  });
}
function decodeId3FrameText(b,start,len){
  if(len<=0||start>=b.length)return null;
  const enc=b[start];
  return decodeText(b.slice(start+1,start+len),enc).replace(/\0+$/,'').trim()||null;
}
function findTerminated(b,start,end,enc){
  if(enc===1||enc===2){for(let i=start;i+1<end;i+=2)if(b[i]===0&&b[i+1]===0)return i;return end}
  for(let i=start;i<end;i++)if(b[i]===0)return i;return end;
}
function extractImageFromID3(b,start,end){
  // ID3v2.3/v2.4 APIC picture frames, plus older v2.2 PIC frames.
  let p=start;
  while(p+10<=end){
    const id=String.fromCharCode(b[p],b[p+1],b[p+2],b[p+3]);
    let n=b[3]===4?synchsafe(b[p+4],b[p+5],b[p+6],b[p+7]):readU32(b,p+4);
    if(!id.trim()||n<=0||p+10+n>end){p++;continue}
    if(id==='APIC'){
      const q=p+10, frameEnd=q+n, enc=b[q]; let x=q+1, mimeEnd=x;
      while(mimeEnd<frameEnd&&b[mimeEnd]!==0)mimeEnd++;
      let mime=textFromBytes(b,x,mimeEnd-x)||'image/jpeg'; x=Math.min(frameEnd,mimeEnd+1);
      if(x<frameEnd){x++; const descEnd=findTerminated(b,x,frameEnd,enc); x=(enc===1||enc===2)?Math.min(frameEnd,descEnd+2):Math.min(frameEnd,descEnd+1); if(x<frameEnd)return new Blob([b.slice(x,frameEnd)],{type:mime.startsWith('image/')?mime:'image/jpeg'});}
    }else if(id==='PIC'){
      const q=p+10, frameEnd=q+n; if(q+6<frameEnd){const enc=b[q],fmt=textFromBytes(b,q+1,3).toLowerCase();let x=q+4;x++;const descEnd=findTerminated(b,x,frameEnd,enc);x=(enc===1||enc===2)?Math.min(frameEnd,descEnd+2):Math.min(frameEnd,descEnd+1);if(x<frameEnd)return new Blob([b.slice(x,frameEnd)],{type:fmt==='png'?'image/png':'image/jpeg'});}
    }
    p+=10+n;
  }
  return null;
}
function scanImageBytes(b){
  // Fallback for common JPEG/PNG images embedded in an MP3 when APIC parsing is unusual.
  for(let i=0;i<b.length-8;i++){
    if(b[i]===0xff&&b[i+1]===0xd8&&b[i+2]===0xff){
      let j=i+3; while(j+9<b.length){
        if(b[j]===0xff&&b[j+1]===0xd9)return new Blob([b.slice(i,j+2)],{type:'image/jpeg'});
        if(b[j]===0xff&&(b[j+1]===0xda||b[j+1]===0xc0||b[j+1]===0xc2||b[j+1]===0xc4||b[j+1]===0xdb)){let k=j+2;while(k+1<b.length&&!(b[k]===0xff&&b[k+1]===0xd9))k++;if(k+1<b.length)return new Blob([b.slice(i,k+2)],{type:'image/jpeg'});}
        j++;
      }
    }
    if(b[i]===0x89&&b[i+1]===0x50&&b[i+2]===0x4e&&b[i+3]===0x47&&b[i+4]===0x0d&&b[i+5]===0x0a&&b[i+6]===0x1a&&b[i+7]===0x0a){
      for(let j=i+8;j+12<b.length;j++){if(b[j]===0x49&&b[j+1]===0x45&&b[j+2]===0x4e&&b[j+3]===0x44)return new Blob([b.slice(i,j+12)],{type:'image/png'});}
    }
  }
  return null;
}
function decodeText(raw,enc){try{if(enc===1||enc===2)return new TextDecoder(enc===1?'utf-16':'utf-16le').decode(raw).replace(/^\uFEFF/,'');if(enc===3)return new TextDecoder('utf-8').decode(raw);return new TextDecoder('iso-8859-1').decode(raw)}catch{return String.fromCharCode(...raw)}}
function parseID3(file){
  return new Promise(resolve=>{
    const out={title:null,artist:null,album:null,cover:null,lyrics:null}; const reader=new FileReader();
    reader.onerror=()=>resolve(out);
    reader.onload=()=>{try{
      const b=new Uint8Array(reader.result); if(b.length<10||String.fromCharCode(b[0],b[1],b[2])!=='ID3'){resolve(out);return}
      const ver=b[3],flags=b[5],size=synchsafe(b[6],b[7],b[8],b[9]);let p=10,end=Math.min(b.length,10+size);
      // Skip ID3v2 extended header when present.
      if(flags&0x40){if(ver>=4&&p+4<=end){const ex=synchsafe(b[p],b[p+1],b[p+2],b[p+3]);p+=4+ex}else if(p+4<=end){const ex=((b[p]<<24)|(b[p+1]<<16)|(b[p+2]<<8)|b[p+3])>>>0;p+=4+ex}}
      // Common metadata frames.
      while(p+10<=end){
        const id=String.fromCharCode(b[p],b[p+1],b[p+2],b[p+3]);
        let n=ver>=4?synchsafe(b[p+4],b[p+5],b[p+6],b[p+7]):((b[p+4]<<24)|(b[p+5]<<16)|(b[p+6]<<8)|b[p+7]);
        if(!id.trim()||n<=0||p+10+n>end){p++;continue}
        if(id==='TIT2'||id==='TPE1'||id==='TALB'){const val=decodeId3FrameText(b,p+10,n);if(id==='TIT2')out.title=val;if(id==='TPE1')out.artist=val;if(id==='TALB')out.album=val}else if(id==='USLT'){const q=p+10,frameEnd=q+n,enc=b[q],lang=textFromBytes(b,q+1,3);let x=q+4;const descEnd=findTerminated(b,x,frameEnd,enc);x=(enc===1||enc===2)?Math.min(frameEnd,descEnd+2):Math.min(frameEnd,descEnd+1);const text=decodeText(b.slice(x,frameEnd),enc).replace(/\0/g,'').trim();if(text)out.lyrics={source:'embedded',format:'plain',text}}
        p+=10+n;
      }
      out.cover=extractImageFromID3(b,10,end)||scanImageBytes(b.slice(0,end));
    }catch{} resolve(out)};
    reader.readAsArrayBuffer(file.slice(0,Math.min(file.size,16*1024*1024)));
  });
}
function readU32(b,p){return ((b[p]<<24)|(b[p+1]<<16)|(b[p+2]<<8)|b[p+3])>>>0}
function findMP4Atom(b,target,start=0,end=b.length){let p=start;while(p+8<=end){let size=readU32(b,p),type=textFromBytes(b,p+4,4),head=8;if(size===1&&p+16<=end){size=Number((BigInt(readU32(b,p+8))<<32n)|BigInt(readU32(b,p+12)));head=16}if(size<8||p+size>end)break;if(type===target)return {p,size,head};p+=size}return null}
function findMP4Deep(b,target,start=0,end=b.length,depth=0){const direct=findMP4Atom(b,target,start,end);if(direct)return direct;if(depth>8)return null;let p=start;while(p+8<=end){let size=readU32(b,p),type=textFromBytes(b,p+4,4),head=8;if(size===1&&p+16<=end){size=Number((BigInt(readU32(b,p+8))<<32n)|BigInt(readU32(b,p+12)));head=16}if(size<8||p+size>end)break;if(type!=='mdat'&&type!=='free'&&type!=='skip'&&type!=='wide'){const found=findMP4Deep(b,target,p+head,p+size,depth+1);if(found)return found}p+=size}return null}
function parseMP4(file){return new Promise(resolve=>{const out={title:null,artist:null,album:null,cover:null,lyrics:null};const r=new FileReader();r.onerror=()=>resolve(out);r.onload=()=>{try{const b=new Uint8Array(r.result);const moov=findMP4Deep(b,'moov');if(!moov){resolve(out);return}const ilst=findMP4Deep(b,'ilst',moov.p+moov.head,moov.p+moov.size);if(!ilst){resolve(out);return}
      let p=ilst.p+ilst.head,end=ilst.p+ilst.size;while(p+8<=end){let aSize=readU32(b,p),type=textFromBytes(b,p+4,4);if(aSize<8||p+aSize>end)break;const innerStart=p+8,innerEnd=p+aSize;
        const data=findMP4Atom(b,'data',innerStart,innerEnd);if(data&&data.p+data.head+8<=innerEnd){const payload=data.p+data.head+8;const payloadEnd=innerEnd; if(type==='covr'){const mime=(b[payload]===0x89&&b[payload+1]===0x50)?'image/png':(b[payload]===0xff&&b[payload+1]===0xd8?'image/jpeg':'image/jpeg');out.cover=new Blob([b.slice(payload,payloadEnd)],{type:mime})}else if(type==='©nam'||type==='©ART'||type==='©alb'||type==='©lyr'){const raw=b.slice(payload,payloadEnd);const val=new TextDecoder('utf-8').decode(raw).replace(/\0/g,'').trim();if(type==='©nam')out.title=val;if(type==='©ART')out.artist=val;if(type==='©alb')out.album=val;if(type==='©lyr'&&val)out.lyrics={source:'embedded',format:'plain',text:val}}}
        p+=aSize;
      }
    }catch{}resolve(out)};r.readAsArrayBuffer(file.slice(0,Math.min(file.size,12*1024*1024)))})}
function parseVorbisPicture(file){return new Promise(resolve=>{const out={title:null,artist:null,album:null,cover:null,lyrics:null};const r=new FileReader();r.onerror=()=>resolve(out);r.onload=()=>{try{const b=new Uint8Array(r.result);let ascii='';for(let i=0;i<b.length;i++)ascii+=String.fromCharCode(b[i]);const get=(key)=>{const re=new RegExp(key+'=([^\\0\\n\\r]+)','i');const m=ascii.match(re);return m?m[1].trim():null};out.title=get('TITLE');out.artist=get('ARTIST');out.album=get('ALBUM');const lyr=get('LYRICS')||get('UNSYNCEDLYRICS');if(lyr)out.lyrics={source:'embedded',format:'plain',text:lyr};const m=ascii.match(/METADATA_BLOCK_PICTURE=([A-Za-z0-9+/=]+)/i);if(m){const raw=Uint8Array.from(atob(m[1]),c=>c.charCodeAt(0));let p=0;const u32=()=>{const n=readU32(raw,p);p+=4;return n};if(raw.length>=32){u32();const ml=u32();const mime=textFromBytes(raw,p,ml)||'image/jpeg';p+=ml;const dl=u32();p+=dl;p+=16;const bl=u32();if(bl&&p+bl<=raw.length)out.cover=new Blob([raw.slice(p,p+bl)],{type:mime})}}if(!out.cover)out.cover=scanImageBytes(b)}catch{}resolve(out)};r.readAsArrayBuffer(file.slice(0,Math.min(file.size,16*1024*1024)))})}

async function metadata(file){
  const name=String(file?.name||''); const base={title:cleanName(name),artist:'Unknown Artist',album:'Unknown Album',cover:null,lyrics:null};
  if(file.type==='audio/mpeg'||/\.mp3$/i.test(name)){const m=await parseID3(file);Object.assign(base,{title:m.title||base.title,artist:m.artist||base.artist,album:m.album||base.album,cover:m.cover,lyrics:m.lyrics||base.lyrics})}
  else if(file.type==='audio/mp4'||file.type==='audio/x-m4a'||/\.(m4a|mp4)$/i.test(name)){const m=await parseMP4(file);Object.assign(base,{title:m.title||base.title,artist:m.artist||base.artist,album:m.album||base.album,cover:m.cover,lyrics:m.lyrics||base.lyrics})}
  else if(file.type==='audio/flac'||/\.flac$/i.test(name)){const m=await parseVorbisPicture(file);Object.assign(base,{title:m.title||base.title,artist:m.artist||base.artist,album:m.album||base.album,cover:m.cover,lyrics:m.lyrics||base.lyrics})}
  else if(file.type.includes('ogg')||/\.(ogg|oga|opus)$/i.test(name)){const m=await parseVorbisPicture(file);Object.assign(base,{title:m.title||base.title,artist:m.artist||base.artist,album:m.album||base.album,cover:m.cover,lyrics:m.lyrics||base.lyrics})}
  if(!base.cover){try{const raw=new Uint8Array(await file.slice(0,Math.min(file.size,16*1024*1024)).arrayBuffer());base.cover=scanImageBytes(raw)}catch{}}
  if(base.cover) base.cover=await blobToDataURL(base.cover);
  return base;
}
function placeholderData(title,variant=0){const safe=String(title).slice(0,20).replace(/[<>&"]/g,'');const hue=[210,195,160,280,20,120][variant%6];const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue},15%,8%)"/><stop offset="1" stop-color="hsl(${hue},25%,25%)"/></linearGradient></defs><rect width="800" height="800" fill="url(#g)"/><circle cx="400" cy="400" r="210" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2"/><circle cx="400" cy="400" r="170" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="22"/><path d="M40 520 Q220 390 400 510 T760 470" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="7"/><text x="400" y="670" fill="white" opacity=".72" text-anchor="middle" font-family="Arial" font-size="34" letter-spacing="8">${safe}</text></svg>`;return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)}
function coverSrc(track){if(!track)return '';if(track._coverUrl)return track._coverUrl;if(track.cover instanceof Blob){try{return track._coverUrl=URL.createObjectURL(track.cover)}catch{}}if(typeof track.cover==='string'&&track.cover)return track.cover;return placeholderData(track.title,track.id||0)}

/* ---------- Synchronized Lyrics ---------- */
function parseTimecode(v){
  const m=String(v||'').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,3})(?:\.(\d{1,3}))?$/);
  if(!m)return NaN;
  if(m[1]!=null)return (+m[1]*3600)+(+m[2]*60)+(+m[3])+(m[4]?Number("0."+m[4]):0);
  return (+m[2]*60)+(+m[3])+(m[4]?Number("0."+m[4]):0);
}
function parseLyricsPayload(text,format='plain',duration=0){
  text=String(text||'').replace(/\r/g,'').trim();
  if(!text)return {format:'plain',text:'',lines:[]};
  const lines=[];
  const rows=text.split('\n');
  const timed=/^\s*\[(\d{1,2}:\d{1,2}(?:\.\d{1,3})?)\]\s*(.*)$/;
  rows.forEach((row,idx)=>{
    const m=row.match(timed);
    if(m){
      const start=parseTimecode(m[1]);
      let raw=m[2].trim();
      const words=[];const wr=/<(\d{1,2}:\d{1,2}(?:\.\d{1,3})?)>([^<]+)/g;let wm,last=0;
      while((wm=wr.exec(raw))){if(wm.index>last)words.push({start:last===0?start:start,end:start,text:raw.slice(last,wm.index).trim()});words.push({start:parseTimecode(wm[1]),end:null,text:wm[2].trim()});last=wr.lastIndex}
      const clean=raw.replace(/<\d{1,2}:\d{1,2}(?:\.\d{1,3})?>/g,'').trim();
      lines.push({start:Number.isFinite(start)?start:null,end:null,text:clean,words:words.filter(w=>w.text)});
    }else if(row.trim()&&!/^\s*\[[a-z]+:.*\]\s*$/i.test(row)) lines.push({start:null,end:null,text:row.trim(),words:[],index:idx});
  });
  if(!lines.some(x=>x.start!=null)){
    const plain=rows.filter(x=>x.trim()).map(x=>x.trim());
    const gap=duration>0&&plain.length?duration/plain.length:4;
    return {format:'plain',text:plain.join('\n'),lines:plain.map((x,i)=>({start:i*gap,end:(i+1)*gap,text:x,words:[]}))};
  }
  lines.sort((a,b)=>(a.start??1e12)-(b.start??1e12));
  lines.forEach((l,i)=>{l.end=lines[i+1]?.start??(duration>l.start?duration:l.start+5);});
  return {format:'lrc',text,lines};
}
function lyricsToLRC(ly){
  if(!ly?.lines?.length)return ly?.text||'';
  return ly.lines.map(l=>`[${fmtLrc(l.start||0)}] ${l.text||''}`).join('\n');
}
function fmtLrc(sec){sec=Math.max(0,Number(sec)||0);const m=Math.floor(sec/60),s=(sec-m*60).toFixed(2).padStart(5,'0');return String(m).padStart(2,'0')+':'+s}
async function loadLyricsForTrack(track,token){
  if(!track)return;
  try{
    let ly=state.lyricsCache[track.id]||await getLyrics(track.id);
    if(!ly&&track.lyrics)ly=track.lyrics;
    if(!ly&&track.file){
      const m=await metadata(track.file);
      if(m.lyrics){ly=parseLyricsPayload(m.lyrics.text,m.lyrics.format,audio.duration||track.duration||0);await putLyrics({trackId:track.id,...ly});}
    }
    if(token!==state.lyricsToken||state.current?.id!==track.id)return;
    state.lyricsCache[track.id]=ly||{format:'plain',text:'',lines:[]};
    track.lyrics=state.lyricsCache[track.id];
    renderLyrics();
  }catch{if(token===state.lyricsToken)renderLyrics()}
}
function currentLyricIndex(){
  const ly=state.current?.lyrics||state.lyricsCache[state.current?.id];
  if(!ly?.lines?.length)return -1;
  const lines=ly.lines,t=audio.currentTime||0;
  let lo=0,hi=lines.length-1,idx=-1;
  while(lo<=hi){
    const mid=(lo+hi)>>1,st=Number(lines[mid].start||0);
    if(t>=st){idx=mid;lo=mid+1}else hi=mid-1;
  }
  return idx;
}
function activeWordHtml(line){
  if(!line?.words?.length)return esc(line?.text||'');
  const t=audio.currentTime||0;let out='',pos=0;
  line.words.forEach((w,i)=>{const st=Number(w.start)||0,en=w.end==null?(line.words[i+1]?.start??line.end??st+.6):Number(w.end);const raw=String(w.text||'');const at=line.text.indexOf(raw,pos);const a=at>=0?at:pos;const b=a+raw.length;if(a>pos)out+=esc(line.text.slice(pos,a));out+=`<span class="lyric-word" style="opacity:${t>=st&&t<=en?1:.72}">${esc(line.text.slice(a,b))}</span>`;pos=b});if(pos<line.text.length)out+=esc(line.text.slice(pos));return out;
}
let lyricsDomKey="";
let lyricsDomIndex=-999;
let lyricsDomStyle="";
function applyLyricFill(el){
  if(!el)return; const s=state.settings, mode=s.lyricColorMode||"solid", c=s.lyricColor||"#f4f5f7", grad=getComputedStyle(document.documentElement).getPropertyValue("--lyric-gradient").trim();
  if(mode!=="solid"){el.classList.add("lyric-gradient");el.style.backgroundImage=grad;el.style.backgroundSize="320% 100%";el.style.backgroundPosition="0% 50%";el.style.backgroundRepeat="no-repeat";el.style.backgroundClip="text";el.style.webkitBackgroundClip="text";el.style.color="transparent";el.style.webkitTextFillColor="transparent";}
  else{el.classList.remove("lyric-gradient");el.style.backgroundImage="none";el.style.backgroundSize="";el.style.backgroundPosition="";el.style.backgroundRepeat="";el.style.backgroundClip="initial";el.style.webkitBackgroundClip="initial";el.style.color=c;el.style.webkitTextFillColor=c;}
}
function renderLyrics(force=false){
  applyLyricStyle();
  const panel=$("#lyricsPanel"),view=$("#lyricsView");if(!view||!panel)return;
  const ly=state.current?.lyrics||state.lyricsCache[state.current?.id];
  panel.classList.add("show");
  $$("#lyricsPanel .lyrics-style").forEach(b=>b.classList.toggle("active",b.dataset.lyricsStyle===state.lyricsStyle));
  if(state.lyricsStyle!=="normal"&&state.lyricsStyle!=="fade")state.lyricsStyle="normal";
  const styleClass=state.lyricsStyle==="fade"?"lyrics-fade":"";
  const key=(state.current?.id||"")+"|"+(ly?.lines?.length||0);

  if(!ly?.lines?.length){
    if(force||lyricsDomKey!=="EMPTY")view.innerHTML=`<div class="lyrics-empty"><strong>No synced lyrics</strong>Add your own lyrics for this track. Timed LRC gives the most accurate sync.</div>`;
    lyricsDomKey="EMPTY";lyricsDomIndex=-999;lyricsDomStyle=styleClass;return;
  }

  if(force||key!==lyricsDomKey||view.className!=="lyrics-view "+styleClass){
    view.className="lyrics-view "+styleClass;
    view.innerHTML=ly.lines.map((l,i)=>`<div class="lyrics-line lyric-gradient-target" data-lyric-index="${i}">${activeWordHtml(l)}</div>`).join("");
    lyricsDomKey=key;lyricsDomIndex=-999;lyricsDomStyle=styleClass;
  }

  const idx=currentLyricIndex();
  if(force||idx!==lyricsDomIndex||styleClass!==lyricsDomStyle){
    const els=view.querySelectorAll(".lyrics-line");
    els.forEach((el,i)=>{
      el.classList.toggle("active",i===idx);
      el.classList.toggle("prev",i<idx);
      el.classList.toggle("next",i>idx);
      applyLyricFill(el);
    });
    if(state.lyricsStyle==="normal"&&idx>=0){
      const el=view.querySelector(`[data-lyric-index="${idx}"]`);
      if(el){const target=el.offsetTop-(view.clientHeight-el.offsetHeight)/2;view.scrollTop=Math.max(0,target);}
    }
    lyricsDomIndex=idx;lyricsDomStyle=styleClass;
  }
}
function applyLyricStyle(){
  const root=document.documentElement,s=state.settings,c=s.lyricColor||"#f4f5f7",c2=s.lyricColor2||"#8b5cf6",c3=s.lyricColor3||"#22d3ee",f=s.lyricFont||"Inter",size=Number(s.lyricSize)||24,eff=s.lyricEffect||"none",mode=s.lyricColorMode||"solid",angle=Number(s.lyricAngle)||90;
  const grad=mode==='gradient3'?`linear-gradient(${angle}deg,${c},${c2},${c3})`:mode==='gradient2'?`linear-gradient(${angle}deg,${c},${c2})`:`linear-gradient(${angle}deg,${c},${c})`;
  root.style.setProperty("--lyric-color",c);root.style.setProperty("--lyric-gradient",grad);root.style.setProperty("--lyric-font",`"${f}"`);root.style.setProperty("--lyric-size",size+"px");
  ["lyrics-soft","lyrics-wave","lyrics-blur"].forEach(x=>document.body.classList.remove(x));
  if(eff!=="none")document.body.classList.add("lyrics-"+eff);
  const fs=$("#lyricsFullscreen");
  if(fs){
    fs.classList.remove("lyrics-effect-soft","lyrics-effect-wave","lyrics-effect-blur");
    if(eff!=="none")fs.classList.add("lyrics-effect-"+eff);
  }
  document.querySelectorAll(".lyrics-line").forEach(applyLyricFill);
  const pc=$("#lyricPreview");if(pc){pc.style.fontFamily=f;pc.style.fontSize=size+"px";pc.classList.toggle("lyric-gradient",mode!=="solid");pc.style.color=mode==='solid'?c:"transparent";pc.style.backgroundImage=mode==='solid'?"none":grad;pc.style.backgroundSize="320% 100%";pc.style.backgroundRepeat="no-repeat";pc.style.webkitBackgroundClip=mode==='solid'?"initial":"text";pc.style.backgroundClip=mode==='solid'?"initial":"text";pc.style.webkitTextFillColor=mode==='solid'?c:"transparent";pc.style.textShadow=eff==='soft'&&mode==='solid'?`0 0 16px ${c}`:"none";}
}
function openFullLyrics(){
  if(!state.current){toast("Add music to open lyrics");return}
  const ly=state.current?.lyrics||state.lyricsCache[state.current?.id];if(!ly?.lines?.length){toast("Add synced lyrics first");return}
  $("#fullLyricsTitle").textContent=state.current.title;$("#fullLyricsArtist").textContent=state.current.artist;
  const fs=$("#lyricsFullscreen");fs.classList.add("show");fs.setAttribute("aria-hidden","false");renderFullLyrics(true);
}
function closeFullLyrics(){$("#lyricsFullscreen").classList.remove("show");$("#lyricsFullscreen").setAttribute("aria-hidden","true")}
let fullDomKey="",fullDomIndex=-999,fullDomStyle="";
function renderFullLyrics(force=false){
  const view=$("#fullLyricsView");if(!view)return;
  const ly=state.current?.lyrics||state.lyricsCache[state.current?.id];if(!ly?.lines?.length)return;
  if(state.lyricsStyle!=="normal"&&state.lyricsStyle!=="fade")state.lyricsStyle="normal";
  const styleClass=state.lyricsStyle==="fade"?"lyrics-fade":"";
  const key=(state.current?.id||"")+"|"+ly.lines.length;

  if(force||key!==fullDomKey||view.className!=="lyrics-view lyrics-full-view "+styleClass){
    view.className="lyrics-view lyrics-full-view "+styleClass;
    view.innerHTML=ly.lines.map((l,i)=>`<div class="lyrics-line lyric-gradient-target" data-lyric-index="${i}">${activeWordHtml(l)}</div>`).join("");
    fullDomKey=key;fullDomIndex=-999;fullDomStyle=styleClass;
  }

  const idx=currentLyricIndex();
  if(force||idx!==fullDomIndex||styleClass!==fullDomStyle){
    const els=view.querySelectorAll(".lyrics-line");
    els.forEach((el,i)=>{
      const active=i===idx;
      el.classList.toggle("active",active);
      el.classList.toggle("prev",i<idx);
      el.classList.toggle("next",i>idx);
      el.style.pointerEvents=active?"auto":"none";
      applyLyricFill(el);
    });
    if(state.lyricsStyle==="normal"&&idx>=0){
      const el=view.querySelector(`[data-lyric-index="${idx}"]`);
      if(el) view.scrollTop=Math.max(0,el.offsetTop-(view.clientHeight-el.offsetHeight)/2);
    }
    fullDomIndex=idx;fullDomStyle=styleClass;
  }

  $("#fullLyricsTime").textContent=fmt(audio.currentTime||0);
  $("#fullLyricsDuration").textContent=fmt(audio.duration||0);
}
function openLyricsCustomizer(){const s=state.settings;$("#lyricColor").value=s.lyricColor||"#f4f5f7";$("#lyricColor2").value=s.lyricColor2||"#8b5cf6";$("#lyricColor3").value=s.lyricColor3||"#22d3ee";$("#lyricColorMode").value=s.lyricColorMode||"solid";$("#lyricAngle").value=s.lyricAngle||90;$("#lyricFont").value=s.lyricFont||"Inter";$("#lyricEffect").value=s.lyricEffect||"none";$("#lyricSize").value=s.lyricSize||24;$("#lyricsCustomizer").classList.add("show");applyLyricStyle()}
function saveLyricsCustomizer(){state.settings.lyricColor=$("#lyricColor").value;state.settings.lyricColor2=$("#lyricColor2").value;state.settings.lyricColor3=$("#lyricColor3").value;state.settings.lyricColorMode=$("#lyricColorMode").value;state.settings.lyricAngle=Number($("#lyricAngle").value);state.settings.lyricFont=$("#lyricFont").value;state.settings.lyricEffect=$("#lyricEffect").value;state.settings.lyricSize=Number($("#lyricSize").value);["lyricColor","lyricColor2","lyricColor3","lyricColorMode","lyricAngle","lyricFont","lyricEffect","lyricSize"].forEach(k=>saveSetting(k,state.settings[k]));applyLyricStyle();renderLyrics(true);if($("#lyricsFullscreen").classList.contains("show"))renderFullLyrics(true);$("#lyricsCustomizer").classList.remove("show");toast("Lyrics style applied")}

function openLyricsEditor(){
  const t=state.current;if(!t){toast("Add music to edit lyrics");return}
  const ly=t.lyrics||state.lyricsCache[t.id];
  $("#lyricsEditorTrack").textContent=`${t.title} · ${t.artist}`;
  $("#lyricsInput").value=ly?.format==="lrc"?lyricsToLRC(ly):(ly?.text||'');
  $("#lyricsEditor").classList.add("show");state.lyricsSync=null;$("#lyricsSync").classList.remove("show");$("#toggleSync").textContent="SYNC MODE";$("#syncStamp").textContent="START SYNC";$("#syncCurrent").textContent="Press START SYNC";
}
function saveLyricsFromEditor(){
  const t=state.current;if(!t)return;
  const raw=$("#lyricsInput").value.trim();
  if(!raw){deleteLyrics(t.id).catch(()=>{});delete state.lyricsCache[t.id];t.lyrics=null;renderLyrics();$("#lyricsEditor").classList.remove("show");toast("Lyrics removed");return}
  const ly=parseLyricsPayload(raw,'lrc',audio.duration||t.duration||0);
  state.lyricsCache[t.id]=ly;t.lyrics=ly;putLyrics({trackId:t.id,...ly}).catch(()=>{});renderLyrics();$("#lyricsEditor").classList.remove("show");toast("Lyrics saved");
}
function toggleLyricsSync(){
  const box=$("#lyricsSync");const on=!box.classList.contains("show");box.classList.toggle("show",on);$("#toggleSync").textContent=on?"CLOSE SYNC":"SYNC MODE";
  if(on){
    const raw=$("#lyricsInput").value.trim();const plain=raw.split('\n').map(x=>x.replace(/^\s*\[\d{1,2}:\d{1,2}(?:\.\d{1,3})?\]\s*/,'').trim()).filter(Boolean);
    state.lyricsSync={lines:plain,index:0,stamps:[]};updateSyncUI();
  }else state.lyricsSync=null;
}
function updateSyncUI(){
  const q=state.lyricsSync;if(!q){return}
  $("#syncCurrent").textContent=q.index<q.lines.length?q.lines[q.index]:"All lines stamped";
  $("#syncStamp").textContent=q.index===0?"START / STAMP NEXT":"STAMP NEXT LINE";
  $("#syncMeta").textContent=`${Math.min(q.index,q.lines.length)} / ${q.lines.length} lines · current ${fmt(audio.currentTime||0)}`;
}
function stampNextLyric(){
  const q=state.lyricsSync;if(!q||q.index>=q.lines.length){toast("Sync complete");return}
  q.stamps.push({start:audio.currentTime||0,text:q.lines[q.index]});q.index++;
  if(q.index>=q.lines.length){
    const lines=q.stamps.map((x,i)=>({start:x.start,end:q.stamps[i+1]?.start??(audio.duration||x.start+5),text:x.text,words:[]}));
    const ly={format:'lrc',text:lines.map(l=>`[${fmtLrc(l.start)}] ${l.text}`).join('\n'),lines};
    const t=state.current;state.lyricsCache[t.id]=ly;t.lyrics=ly;putLyrics({trackId:t.id,...ly}).catch(()=>{});renderLyrics();toast("Lyrics synced");$("#syncStamp").textContent="SYNC COMPLETE";
  }else updateSyncUI();
}

/* ---------- Player / audio engine ---------- */
const audio=document.getElementById("audio");
function buildAudioFilters(){
  const ctx=state.ctx;
  const bass=ctx.createBiquadFilter();bass.type="lowshelf";bass.frequency.value=120;
  const mid=ctx.createBiquadFilter();mid.type="peaking";mid.frequency.value=1000;mid.Q.value=.8;
  const treble=ctx.createBiquadFilter();treble.type="highshelf";treble.frequency.value=7000;
  const boost=ctx.createBiquadFilter();boost.type="lowshelf";boost.frequency.value=95;
  state.filters={bass,mid,treble,boost};applyEQ();
}
function applyEQ(){if(!state.filters)return;state.filters.bass.gain.value=Number(state.settings.eqBass)||0;state.filters.mid.gain.value=Number(state.settings.eqMid)||0;state.filters.treble.gain.value=Number(state.settings.eqTreble)||0;state.filters.boost.gain.value=state.settings.bassBoost?Number(state.settings.bassBoostLevel||6):0}
function setEqPreset(name){const presets={flat:[0,0,0],bass:[5,0,1],vocal:[-1,4,2],treble:[-1,1,5],warm:[4,2,-1]};const v=presets[name]||presets.flat;state.settings.eqPreset=name;["eqBass","eqMid","eqTreble"].forEach((k,i)=>state.settings[k]=v[i]);["eqPreset","eqBass","eqMid","eqTreble"].forEach(k=>saveSetting(k,state.settings[k]));applyEQ();renderSettings();toast("EQ: "+name.toUpperCase())}
function setEqBand(k,v){state.settings[k]=Number(v);state.settings.eqPreset="custom";saveSetting(k,state.settings[k]);saveSetting("eqPreset","custom");applyEQ();renderSettings()}
function toggleBassBoost(){state.settings.bassBoost=!state.settings.bassBoost;saveSetting("bassBoost",state.settings.bassBoost);applyEQ();renderSettings();toast(state.settings.bassBoost?"Bass Boost on":"Bass Boost off")}
function setBassBoostLevel(v){state.settings.bassBoostLevel=Number(v);saveSetting("bassBoostLevel",state.settings.bassBoostLevel);applyEQ()}
function ensureAudioEngine(){
  try{
    if(!state.ctx){
      const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw new Error();
      state.ctx=new AC();state.analyser=state.ctx.createAnalyser();state.analyser.fftSize=2048;state.analyser.smoothingTimeConstant=.82;
      state.source=state.ctx.createMediaElementSource(audio);
      buildAudioFilters();
      state.source.connect(state.filters.bass);state.filters.bass.connect(state.filters.mid);state.filters.mid.connect(state.filters.treble);state.filters.treble.connect(state.filters.boost);state.filters.boost.connect(state.analyser);state.analyser.connect(state.ctx.destination);
      state.sourceReady=true;
    }
    if(state.ctx.state==="suspended")state.ctx.resume();
    startVisualizer();
  }catch(e){toast("Audio visualizer is unavailable in this browser")}
}
function setAudioTrack(track,autoplay=false){
  if(!track)return;
  if(state.audioUrl)URL.revokeObjectURL(state.audioUrl);
  state.audioUrl=URL.createObjectURL(track.file);audio.src=state.audioUrl;audio.load();
  state.current=track;state.lyricsToken++;loadLyricsForTrack(track,state.lyricsToken);updateHomeTrack();updateNow();renderMiniPlayer();updateArtworkTheme();updateNotify();updateMediaSession();
  if(autoplay)play();
}
async function play(){
  if(!state.current){toast("Add music to start");return}
  ensureAudioEngine();
  try{
    await audio.play();
    if('mediaSession' in navigator) navigator.mediaSession.playbackState='playing';
    state.current.lastPlayed=Date.now();state.current.playCount=(state.current.playCount||0)+1;await putTrack(state.current);state.settings.lastTrackId=state.current.id;await saveSetting("lastTrackId",state.current.id);updateHomeTrack();updateNow();renderMiniPlayer()
  }catch(e){toast("This audio format is not supported by your browser.")}
}
function pause(){
  audio.pause();
  if('mediaSession' in navigator) navigator.mediaSession.playbackState='paused';
  savePosition()
}
function togglePlay(){if(audio.paused)play();else pause()}
function updateArtworkTheme(){if(!state.current||!state.settings.dynamicArtwork){document.documentElement.style.setProperty("--art-glow","transparent");document.documentElement.style.setProperty("--art-accent",getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()||"#d8dde5");return}const img=new Image();const src=coverSrc(state.current);img.onload=()=>{try{const c=document.createElement("canvas"),x=c.getContext("2d");c.width=c.height=24;x.drawImage(img,0,0,24,24);const d=x.getImageData(0,0,24,24).data;let r=0,g=0,b=0,n=0;for(let i=0;i<d.length;i+=4){if(d[i+3]<80)continue;r+=d[i];g+=d[i+1];b+=d[i+2];n++}if(n){r=Math.round(r/n);g=Math.round(g/n);b=Math.round(b/n);document.documentElement.style.setProperty("--art-glow",`rgba(${r},${g},${b},.42)`);document.documentElement.style.setProperty("--art-accent",`rgb(${r},${g},${b})`);document.documentElement.style.setProperty("--art-rgb",`${r},${g},${b}`)}}catch{}};img.src=src}

function closeIcon(){return '<svg class=\"svg\" viewBox=\"0 0 24 24\"><path d=\"M6 6l12 12M18 6L6 18\"/></svg>'}
function notifyIcon(type){if(type==='play')return playIcon();if(type==='prev')return prevIcon();if(type==='next')return nextIcon();return ''}
function renderNotifyMarkup(target){if(!target)return;const t=state.current;if(!t){target.innerHTML='';return}const d=audio.duration||t.duration||0,cur=audio.currentTime||0,pct=d?Math.min(100,cur/d*100):0;const title=esc(t.title||'Unknown Track');target.innerHTML=`<div class="notify-shell"><div class="notify-left"><div class="notify-main"><img class="notify-cover" src="${coverSrc(t)}" alt=""><div class="notify-copy"><div class="notify-title" id="notifyTitle"><span class="notify-title-track">${title}</span></div><div class="notify-artist">${esc(t.artist||'Unknown Artist')} · ${esc(t.album||'Unknown Album')}</div><div class="notify-controls"><button class="notify-btn" data-notify="prev" aria-label="Previous">${notifyIcon('prev')}</button><button class="notify-btn main" data-notify="play" aria-label="Play or pause">${notifyIcon('play')}</button><button class="notify-btn" data-notify="next" aria-label="Next">${notifyIcon('next')}</button></div></div></div><div class="notify-progress"><div class="notify-progressbar"><i style="width:${pct}%"></i></div><div class="notify-time"><span class="notify-cur">${fmt(cur)}</span> / <span class="notify-dur">${fmt(d)}</span></div></div></div><div class="notify-right"><div class="notify-bars">${Array.from({length:40},()=>'<i class="notify-bar"></i>').join('')}</div></div><button class="notify-close" data-notify="close" aria-label="Close">${closeIcon()}</button></div>`;const nt=target.querySelector('.notify-title');if(nt){const sp=nt.querySelector('.notify-title-track');requestAnimationFrame(()=>{if(sp&&sp.scrollWidth>nt.clientWidth+8)nt.classList.add('is-long')})}target.querySelectorAll('[data-notify]').forEach(b=>b.onclick=e=>{const a=b.dataset.notify;if(a==='prev')previous();else if(a==='next')next();else if(a==='play')togglePlay();else if(a==='close')target.classList.remove('show')});updateNotifyBars(target)}
function updateNotifyBars(target){if(!target)return;const bars=target.querySelectorAll('.notify-bar');if(!bars.length)return;if(target.id==='notifyDemo'&&!$('#settingsPage')?.classList.contains('active'))return;let values;if(state.analyser){state.analyser.getByteFrequencyData(freq);values=[...bars].map((_,i)=>{const pos=i/(bars.length-1);const idx=Math.floor(Math.pow(pos,1.7)*(freq.length-1));const raw=(freq[idx]||0)/255;const bass=(freq[Math.min(freq.length-1,Math.floor(idx*.45))]||0)/255;return Math.min(1,Math.pow(raw,0.68)*1.05+bass*.38)})}else values=[...bars].map((_,i)=>audio.paused?.05:(.12+.08*Math.sin(i*.7+performance.now()/220)));bars.forEach((bar,i)=>{const v=values[i]||0;const pulse=audio.paused?0:v*(.18+.82*Math.abs(Math.sin(performance.now()/105+i*.52)));const h=Math.max(4,Math.min(96,6+v*72+pulse*22));bar.style.height=h+'%';bar.style.opacity=(.28+v*.72).toFixed(2)});if(target.classList.contains('show'))requestAnimationFrame(()=>updateNotifyBars(target))}
function updateNotifyProgress(){document.querySelectorAll('.notify-preview.show,.notify-demo-wrap .notify-preview').forEach(target=>{if(!target||!state.current)return;const d=audio.duration||state.current.duration||0,cur=audio.currentTime||0,pct=d?Math.min(100,cur/d*100):0;const fill=target.querySelector('.notify-progressbar i'),ct=target.querySelector('.notify-cur'),dt=target.querySelector('.notify-dur');if(fill)fill.style.width=pct+'%';if(ct)ct.textContent=fmt(cur);if(dt)dt.textContent=fmt(d);const playBtn=target.querySelector('[data-notify="play"]');if(playBtn)playBtn.innerHTML=notifyIcon('play')})}
function updateNotify(){['notifyPreview','notifyDemo'].forEach(id=>{const el=$('#'+id);if(el)renderNotifyMarkup(el)});updateMediaSession();}

function renderMiniPlayer(){const el=$("#miniPlayer");if(!el)return;if(!state.current){el.hidden=true;return}el.hidden=false;const t=state.current;$("#miniCover").src=coverSrc(t);$("#miniTitle").textContent=t.title;$("#miniMeta").textContent=`${t.artist} · ${t.album}`;$("#miniPlay").innerHTML=playIcon();const d=audio.duration||t.duration||0;$("#miniProgress").style.width=(d?Math.min(100,(audio.currentTime||0)/d*100):0)+"%";}
function savePosition(){if(state.current){state.settings.lastPosition=audio.currentTime||0;saveSetting("lastPosition",state.settings.lastPosition).catch(()=>{})}}
function next(){
  if(!state.tracks.length)return;
  let list=filteredForPlayback(),idx=list.findIndex(t=>t.id===state.current?.id),nextTrack;
  if(state.settings.shuffle&&list.length>1){const pool=list.filter(t=>t.id!==state.current?.id);nextTrack=pool[Math.floor(Math.random()*pool.length)]}
  else if(idx>=0&&idx<list.length-1)nextTrack=list[idx+1];
  else if(state.settings.repeat==="all")nextTrack=list[0];
  else {audio.currentTime=0;pause();return}
  setAudioTrack(nextTrack,true);
}
function previous(){
  if(!state.current)return;
  if(audio.currentTime>3){audio.currentTime=0;return}
  const list=filteredForPlayback(),idx=list.findIndex(t=>t.id===state.current.id);let prev=idx>0?list[idx-1]:(state.settings.repeat==="all"?list[list.length-1]:null);
  if(prev)setAudioTrack(prev,true);else audio.currentTime=0;
}
function filteredForPlayback(){return state.tracks.slice().sort((a,b)=>(a.dateAdded||0)-(b.dateAdded||0))}
function cycleRepeat(){state.settings.repeat=state.settings.repeat==="off"?"all":state.settings.repeat==="all"?"one":"off";saveSetting("repeat",state.settings.repeat);renderSettings();updateControlStates();toast("Repeat: "+state.settings.repeat.toUpperCase())}
function toggleShuffle(){state.settings.shuffle=!state.settings.shuffle;saveSetting("shuffle",state.settings.shuffle);updateControlStates();renderSettings();toast(state.settings.shuffle?"Shuffle on":"Shuffle off")}
async function toggleFavorite(id=state.current?.id){const t=state.tracks.find(x=>x.id===id);if(!t)return;t.favorite=!t.favorite;await putTrack(t);state.current=t;renderAll();updateNow();toast(t.favorite?"Added to favorites":"Removed from favorites")}

/* ---------- Android/Web Media Session bridge ---------- */
window.__uwhirmyNativeAction=function(action,positionMs){
  try{
    if(action==='play')play();
    else if(action==='pause')pause();
    else if(action==='previous')previous();
    else if(action==='next')next();
    else if(action==='seek'&&Number.isFinite(Number(positionMs))){audio.currentTime=Number(positionMs)/1000;updateProgress();updateMediaSessionPosition()}
  }catch{}
};
function syncNativeMediaMeta(){
  try{if(window.AndroidBridge&&state.current){
    const t=state.current;
    window.AndroidBridge.syncMedia(JSON.stringify({title:t.title||'Unknown Track',artist:t.artist||'Unknown Artist',album:t.album||'Unknown Album',durationMs:Math.round((audio.duration||t.duration||0)*1000),positionMs:Math.round((audio.currentTime||0)*1000),playing:!audio.paused,cover:(typeof t.cover==='string'?t.cover:'')}));
  }}catch{}
}
function syncNativeMediaPosition(){
  try{if(window.AndroidBridge&&state.current)window.AndroidBridge.syncPosition(Math.round((audio.currentTime||0)*1000),Math.round((audio.duration||state.current.duration||0)*1000),!audio.paused)}catch{}
}
function updateMediaSession(){
  if(!('mediaSession' in navigator)||!state.current)return;
  try{
    const t=state.current,art=coverSrc(t);
    navigator.mediaSession.metadata=new MediaMetadata({title:t.title||'Unknown Track',artist:t.artist||'Unknown Artist',album:t.album||'Unknown Album',artwork:art?[{src:art,sizes:'512x512',type:'image/png'}]:[]});
    ['play','pause','previoustrack','nexttrack','seekbackward','seekforward'].forEach(a=>{try{navigator.mediaSession.setActionHandler(a,null)}catch{}});
    const handlers={play:()=>play(),pause:()=>pause(),previoustrack:()=>previous(),nexttrack:()=>next(),seekbackward:d=>{audio.currentTime=Math.max(0,audio.currentTime-(d.seekOffset||10));syncNativeMediaPosition()},seekforward:d=>{audio.currentTime=Math.min(audio.duration||audio.currentTime+10,audio.currentTime+(d.seekOffset||10));syncNativeMediaPosition()}};
    Object.entries(handlers).forEach(([a,h])=>{try{navigator.mediaSession.setActionHandler(a,h)}catch{}});
    navigator.mediaSession.playbackState=audio.paused?'paused':'playing';
    updateMediaSessionPosition();
  }catch{}
  syncNativeMediaMeta();
}
function updateMediaSessionPosition(){
  const d=audio.duration,cur=audio.currentTime;
  if('mediaSession' in navigator&&navigator.mediaSession.setPositionState&&Number.isFinite(d)&&d>0&&Number.isFinite(cur)){try{navigator.mediaSession.setPositionState({duration:d,playbackRate:audio.playbackRate||1,position:Math.min(cur,d)})}catch{}}
  syncNativeMediaPosition();
}
audio.addEventListener("play",()=>{ensureAudioEngine();updateNow();renderMiniPlayer();updateNotifyProgress();updateMediaSession();startVisualizer()});
audio.addEventListener("pause",()=>{savePosition();updateNow();updateHomeTrack();renderMiniPlayer();updateNotifyProgress();updateMediaSession()});
audio.addEventListener("ended",()=>{if(state.settings.repeat==="one"){audio.currentTime=0;play()}else next()});
audio.addEventListener("timeupdate",()=>{
  updateProgress();renderMiniPlayer();updateNotifyProgress();updateMediaSessionPosition();
  const lyricIndex=currentLyricIndex();
  if(lyricIndex!==state._lastLyricIndex){
    state._lastLyricIndex=lyricIndex;
    if(state.lyricsOpen)renderLyrics();
    if($("#lyricsFullscreen")?.classList.contains("show"))renderFullLyrics();
  }
  if(state.lyricsSync)updateSyncUI();
  if(Math.floor(audio.currentTime)%5===0)savePosition()
});
audio.addEventListener("loadedmetadata",()=>{updateProgress();updateNow();updateNotifyProgress();updateMediaSession()});
audio.addEventListener("error",()=>toast("This audio format is not supported by your browser."));
window.addEventListener("beforeunload",savePosition);
document.addEventListener("visibilitychange",()=>{if(document.hidden)savePosition()});


/* ---------- UI ---------- */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function fmt(sec){if(!Number.isFinite(sec)||sec<0)return"0:00";sec=Math.floor(sec);return Math.floor(sec/60)+":"+String(sec%60).padStart(2,"0")}
function toast(msg){const el=$("#toast");el.textContent=msg;el.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove("show"),2100)}

function setNowView(view){const lyrics=view==='lyrics';$("#nowSlider")?.classList.toggle('lyrics-active',lyrics);$("#nowMusicTab")?.classList.toggle('active',!lyrics);$("#nowLyricsTab")?.classList.toggle('active',lyrics);$("#nowMusicTab")?.setAttribute('aria-selected',String(!lyrics));$("#nowLyricsTab")?.setAttribute('aria-selected',String(lyrics));state.lyricsOpen=lyrics;if(lyrics)renderLyrics(true)}
$("#nowMusicTab")?.addEventListener('click',()=>setNowView('music'));
$("#nowLyricsTab")?.addEventListener('click',()=>setNowView('lyrics'));
$("#openFullLyrics")?.addEventListener("click",openFullLyrics);$("#closeFullLyrics")?.addEventListener("click",closeFullLyrics);$("#cancelLyricsCustomize")?.addEventListener("click",()=>$("#lyricsCustomizer").classList.remove("show"));$("#saveLyricsCustomize")?.addEventListener("click",saveLyricsCustomizer);$("#lyricColor")?.addEventListener("input",()=>{state.settings.lyricColor=$("#lyricColor").value;applyLyricStyle()});$("#lyricColor2")?.addEventListener("input",()=>{state.settings.lyricColor2=$("#lyricColor2").value;applyLyricStyle()});$("#lyricColor3")?.addEventListener("input",()=>{state.settings.lyricColor3=$("#lyricColor3").value;applyLyricStyle()});$("#lyricColorMode")?.addEventListener("change",()=>{state.settings.lyricColorMode=$("#lyricColorMode").value;applyLyricStyle()});$("#lyricAngle")?.addEventListener("input",()=>{state.settings.lyricAngle=Number($("#lyricAngle").value);applyLyricStyle()});$("#lyricFont")?.addEventListener("change",()=>{state.settings.lyricFont=$("#lyricFont").value;applyLyricStyle()});$("#lyricEffect")?.addEventListener("change",()=>{state.settings.lyricEffect=$("#lyricEffect").value;applyLyricStyle()});$("#lyricSize")?.addEventListener("input",()=>{state.settings.lyricSize=Number($("#lyricSize").value);applyLyricStyle()});
$$("#lyricsPanel .lyrics-style").forEach(b=>b.addEventListener("click",()=>{state.lyricsStyle=b.dataset.lyricsStyle;renderLyrics(true)}));
$("#editLyrics")?.addEventListener("click",openLyricsEditor);
$("#cancelLyrics")?.addEventListener("click",()=>$("#lyricsEditor").classList.remove("show"));
$("#saveLyrics")?.addEventListener("click",saveLyricsFromEditor);
$("#toggleSync")?.addEventListener("click",toggleLyricsSync);
$("#syncStamp")?.addEventListener("click",stampNextLyric);
$("#lyricsView")?.addEventListener("click",e=>{const line=e.target.closest(".lyrics-line");if(!line)return;const ly=state.current?.lyrics;if(ly?.lines?.[+line.dataset.lyricIndex]?.start!=null)audio.currentTime=ly.lines[+line.dataset.lyricIndex].start});
function coverHTML(t,size="small"){const src=coverSrc(t);return `<img class="cover ${size}" src="${src}" alt="" onerror="this.src='${placeholderData(t.title,t.id)}'">`}
function trackCard(t){
  const playing=state.current?.id===t.id&&!audio.paused;
  return `<article class="track-card" data-id="${t.id}">
    ${coverHTML(t,"small")}
    <button class="track-main" data-action="play" style="text-align:left">
      <div class="track-name">${esc(t.title)}</div><div class="track-sub">${esc(t.artist)} · ${esc(t.album)} · ${fmt(t.duration)}</div>
    </button>
    <div class="track-actions">
      <button class="mini ${t.favorite?"active":""}" data-action="favorite" aria-label="Favorite">${heartIcon(t.favorite)}</button>
      <button class="mini" data-action="delete" aria-label="Delete">${trashIcon()}</button>
      ${playing?`<span style="width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--glow)"></span>`:""}
    </div>
  </article>`
}
function heartIcon(fill){return `<svg class="svg" viewBox="0 0 24 24"><path d="M20.8 8.8c0 5-8.8 10-8.8 10s-8.8-5-8.8-10A4.8 4.8 0 0 1 12 6.4a4.8 4.8 0 0 1 8.8 2.4z" ${fill?'fill="currentColor"':''}/></svg>`}
function trashIcon(){return `<svg class="svg" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>`}
function renderHome(){
  const el=$("#homeContent");
  if(!state.current){
    el.innerHTML=`<div class="section card empty"><div class="empty-icon"><svg class="svg" viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg></div><h2>NO MUSIC YET</h2><p>Your library is empty.</p><button class="add-btn" data-add><svg class="svg" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>ADD MUSIC</button></div>`;return
  }
  const t=state.current;
  el.innerHTML=`<div class="section card hero">
    <div>${coverHTML(t,"")}</div>
    <div>
      <div class="kicker">Now Playing</div><div class="track-title">${esc(t.title)}</div><div class="track-meta">${esc(t.artist)} · ${esc(t.album)}</div>
      <div class="progress-wrap"><input class="progress" id="homeProgress" type="range" min="0" max="1000" value="0"><div class="time-row"><span id="homeElapsed">0:00</span><span id="homeDuration">0:00</span></div></div>
      <div class="controls">
        <button class="control" id="homeShuffle">${shuffleIcon()}</button><button class="control" id="homePrev">${prevIcon()}</button><button class="play" id="homePlay">${playIcon()}</button><button class="control next" id="homeNext">${nextIcon()}</button><button class="control" id="homeRepeat">${repeatIcon()}</button>
      </div>
      <div class="quick-row"><button class="pill" id="homeFavorite">${heartIcon(t.favorite)} Favorite</button><button class="pill" id="homeOpenNow">Open Now Playing</button><button class="add-btn" id="homeAddMusic" data-add><svg class="svg" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>ADD MUSIC</button></div>
    </div></div>`;
  bindHomeControls();updateProgress();updateControlStates()
}
function updateHomeTrack(){
  const t=state.current;if(!t)return;
  const hero=$("#homeContent .hero");
  if(!hero){renderHome();return}
  const title=hero.querySelector(".track-title"),meta=hero.querySelector(".track-meta"),cover=hero.querySelector("img");
  if(title)title.textContent=t.title;
  if(meta)meta.textContent=`${t.artist} · ${t.album}`;
  if(cover){cover.src=coverSrc(t);cover.alt=t.title||"Album cover"}
  const fav=$("#homeFavorite");if(fav)fav.innerHTML=heartIcon(t.favorite)+" Favorite";
  const playBtn=$("#homePlay");if(playBtn)playBtn.innerHTML=playIcon();
  updateProgress();updateControlStates();
}
function playIcon(){return audio.paused?'<svg class="svg" viewBox="0 0 24 24"><path d="m9 6 10 6-10 6z" fill="currentColor" stroke="none"/></svg>':'<svg class="svg" viewBox="0 0 24 24"><path d="M8 6v12M16 6v12" stroke="currentColor" stroke-width="2.4"/></svg>'}
function prevIcon(){return '<svg class="svg" viewBox="0 0 24 24"><path d="M6 5v14M18 6 9 12l9 6z"/></svg>'}
function nextIcon(){return '<svg class="svg" viewBox="0 0 24 24"><path d="m6 6 9 6-9 6zM18 5v14"/></svg>'}
function shuffleIcon(){return '<svg class="svg" viewBox="0 0 24 24"><path d="M4 7h3c4 0 6 10 10 10h3M17 5l3 2-3 2M4 17h3c1.7 0 2.8-1.1 3.7-2.3M17 15l3 2-3 2"/></svg>'}
function repeatIcon(){return '<svg class="svg" viewBox="0 0 24 24"><path d="M7 7h10l-2.5-2.5M17 17H7l2.5 2.5M17 7a5 5 0 0 1 1.5 3.5M7 17A5 5 0 0 1 5.5 13"/></svg>'}
function bindHomeControls(){
  $("#homePlay")?.addEventListener("click",togglePlay);$("#homePrev")?.addEventListener("click",previous);$("#homeNext")?.addEventListener("click",next);
  $("#homeShuffle")?.addEventListener("click",toggleShuffle);$("#homeRepeat")?.addEventListener("click",cycleRepeat);$("#homeFavorite")?.addEventListener("click",()=>toggleFavorite());
  $("#homeOpenNow")?.addEventListener("click",()=>{$("#nowOverlay").classList.add("show");setNowView("music")});$("#homeProgress")?.addEventListener("input",e=>seek(e.target.value))
}
function renderLibrary(){
  const list=$("#libraryList");let arr=state.tracks.slice();
  const q=state.query.trim().toLowerCase();if(q)arr=arr.filter(t=>[t.title,t.artist,t.album].some(x=>String(x).toLowerCase().includes(q)));
  if(state.filter==="favorite")arr=arr.filter(t=>t.favorite);if(state.filter==="played")arr=arr.filter(t=>(t.lastPlayed||0)>0).sort((a,b)=>(b.lastPlayed||0)-(a.lastPlayed||0));if(state.filter==="added")arr.sort((a,b)=>(b.dateAdded||0)-(a.dateAdded||0));else if(state.filter!=="played")arr.sort((a,b)=>(b.dateAdded||0)-(a.dateAdded||0));
  list.innerHTML=arr.length?arr.map(trackCard).join(""):`<div class="card empty"><div class="empty-icon">${state.filter==="favorite"?heartIcon(false):state.filter==="played"?prevIcon():'<svg class="svg" viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>'}</div><h2>${state.filter==="favorite"?"NO FAVORITES":state.filter==="played"?"NOTHING PLAYED YET":"NO MUSIC YET"}</h2><p>${state.filter==="all"?"Your music library is empty.":"Nothing matches this view yet."}</p>${state.filter==="all"?'<button class="add-btn" data-add><svg class="svg" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>ADD MUSIC</button>':""}</div>`;
  list.querySelectorAll(".track-card").forEach(card=>card.addEventListener("click",e=>{const id=Number(card.dataset.id),t=state.tracks.find(x=>x.id===id);if(!t)return;const action=e.target.closest("[data-action]")?.dataset.action;if(action==="favorite"){toggleFavorite(id);return}if(action==="delete"){openRemove(t);return}setAudioTrack(t,true)}));
}
function renderRecent(){
  const arr=state.tracks.filter(t=>t.lastPlayed).sort((a,b)=>b.lastPlayed-a.lastPlayed).slice(0,4);
  $("#recentHome").innerHTML=arr.length?arr.map(trackCard).join(""):`<div class="card empty"><h3>NOTHING PLAYED YET</h3><p>Played tracks will appear here.</p></div>`;
  $("#recentHome").querySelectorAll(".track-card").forEach(card=>card.addEventListener("click",e=>{const t=state.tracks.find(x=>x.id===Number(card.dataset.id));const action=e.target.closest("[data-action]")?.dataset.action;if(action==="favorite")toggleFavorite(t.id);else if(action==="delete")openRemove(t);else setAudioTrack(t,true)}));
}
function updateProgress(){
  const d=audio.duration||state.current?.duration||0,cur=audio.currentTime||0,v=d?Math.round(cur/d*1000):0;
  ["homeProgress","nowProgress"].forEach(id=>{const x=$("#"+id);if(x){x.value=v;x.max=1000}});
  [["homeElapsed",cur],["nowElapsed",cur],["homeDuration",d],["nowDuration",d]].forEach(([id,v])=>{const x=$("#"+id);if(x)x.textContent=fmt(v)});
}
function seek(v){const d=audio.duration;if(d)audio.currentTime=(Number(v)/1000)*d}
function updateControlStates(){
  const sh=state.settings.shuffle, rep=state.settings.repeat;
  ["homeShuffle","nowShuffle"].forEach(id=>$("#"+id)?.classList.toggle("active",sh));
  ["homeRepeat","nowRepeat"].forEach(id=>$("#"+id)?.classList.toggle("active",rep!=="off"));
  $("#settingShuffle")?.classList.toggle("active",sh);$("#settingRepeat")?.classList.toggle("active",rep!=="off");$("#repeatLabel")&&( $("#repeatLabel").textContent=rep.toUpperCase());
}
function updateNow(){
  const t=state.current;if(!t){renderMiniPlayer();return;}
  $("#nowTitle").textContent=t.title;$("#nowMeta").textContent=`${t.artist} · ${t.album}`;$("#nowCover").src=coverSrc(t);$("#nowFavorite").innerHTML=heartIcon(t.favorite);$("#nowPlay").innerHTML=playIcon();$("#nowOverlay").classList.toggle("now-playing",!audio.paused);$("#nowOverlay").classList.toggle("paused",audio.paused);updateProgress();updateControlStates();renderMiniPlayer();updateNotify();renderLyrics();
}
function renderAll(){renderHome();renderLibrary();renderRecent();updateNow();renderMiniPlayer();renderStorage();renderLyrics()}

/* ---------- Files ---------- */
function addFiles(files){
  const arr=[...files].filter(f=>f.type.startsWith("audio/")||/\.(mp3|wav|ogg|oga|m4a|mp4|aac|flac|webm|opus)$/i.test(f.name));
  if(!arr.length){toast("No supported audio files found");return}
  let count=0;
  (async()=>{for(const file of arr){try{
    const m=await metadata(file);
    const t={id:Date.now()+Math.floor(Math.random()*100000),file,title:m.title,artist:m.artist,album:m.album,duration:0,cover:m.cover,favorite:false,dateAdded:Date.now(),lastPlayed:0,playCount:0};
    const temp=URL.createObjectURL(file);const probe=new Audio();probe.preload="metadata";probe.src=temp;
    await new Promise(resolve=>{const done=()=>{t.duration=Number.isFinite(probe.duration)?probe.duration:0;URL.revokeObjectURL(temp);resolve()};probe.onloadedmetadata=done;probe.onerror=()=>{URL.revokeObjectURL(temp);resolve()};setTimeout(done,3500)});
    await putTrack(t);if(m.lyrics){try{const ly=parseLyricsPayload(m.lyrics.text||'',m.lyrics.format||'plain',t.duration);t.lyrics=ly;await putLyrics({trackId:t.id,...ly})}catch{}}state.tracks.push(t);count++;
  }catch(e){toast("A file could not be added. Storage may be full.")}}
  renderAll();toast(`${count} track${count===1?"":"s"} added`);
  })();
}
function openRemove(t){state.removeId=t.id;$("#removeName").textContent=`Remove “${t.title}” from this device?`;$("#confirmModal").classList.add("show")}
async function confirmRemove(){const id=state.removeId,t=state.tracks.find(x=>x.id===id);if(!t)return;try{await deleteTrack(id);await deleteLyrics(id);delete state.lyricsCache[id];state.tracks=state.tracks.filter(x=>x.id!==id);if(state.current?.id===id){audio.pause();if(state.audioUrl)URL.revokeObjectURL(state.audioUrl);state.audioUrl=null;state.current=null;try{window.AndroidBridge&&window.AndroidBridge.clearMedia()}catch{}}$("#confirmModal").classList.remove("show");renderAll();toast("Track deleted")}catch{toast("Could not delete this track")}}
$("#fileInput").addEventListener("change",e=>{addFiles(e.target.files);e.target.value=""});
document.addEventListener("click",e=>{const add=e.target.closest("[data-add]");if(add){e.preventDefault();e.stopPropagation();$("#fileInput").click();}});
$("#dropzone").addEventListener("dragover",e=>{e.preventDefault();$("#dropzone").classList.add("drag")});
$("#dropzone").addEventListener("dragleave",()=>$("#dropzone").classList.remove("drag"));
$("#dropzone").addEventListener("drop",e=>{e.preventDefault();$("#dropzone").classList.remove("drag");addFiles(e.dataTransfer.files)});
$("#cancelRemove").onclick=()=>$("#confirmModal").classList.remove("show");$("#confirmRemove").onclick=confirmRemove;

/* ---------- Navigation ---------- */
$$(".nav-btn").forEach(btn=>btn.addEventListener("click",()=>goPage(btn.dataset.page)));
function goPage(id){$$(".page").forEach(p=>p.classList.toggle("active",p.id===id));$$(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.page===id));if(id==="visualizerPage"){requestAnimationFrame(()=>{resizeCanvas();startVisualizer()})}}
$("#brandBtn").onclick=()=>goPage("homePage");$("#homeLibraryBtn").onclick=()=>goPage("libraryPage");
$("#closeNow").onclick=()=>$("#nowOverlay").classList.remove("show");$("#miniOpen").onclick=()=>$("#nowOverlay").classList.add("show");$("#miniCoverBtn").onclick=()=>$("#nowOverlay").classList.add("show");$("#miniPlay").onclick=togglePlay;$("#miniNext").onclick=next;

let nowTouchX=0;$("#nowOverlay").addEventListener("touchstart",e=>{nowTouchX=e.touches[0].clientX},{passive:true});$("#nowOverlay").addEventListener("touchend",e=>{const dx=e.changedTouches[0].clientX-nowTouchX;if(Math.abs(dx)>70){if(dx<0)next();else previous()}});
$("#nowPlay").onclick=togglePlay;$("#nowPrev").onclick=previous;$("#nowNext").onclick=next;$("#nowShuffle").onclick=toggleShuffle;$("#nowRepeat").onclick=cycleRepeat;$("#nowFavorite").onclick=()=>toggleFavorite();$("#nowProgress").addEventListener("input",e=>seek(e.target.value));
$("#searchInput").addEventListener("input",e=>{state.query=e.target.value;renderLibrary()});
$$(".filter").forEach(b=>b.addEventListener("click",()=>{state.filter=b.dataset.filter;$$(".filter").forEach(x=>x.classList.toggle("active",x===b));renderLibrary()}));


/* ---------- Home logo customization ---------- */
const logoStyles={
 triad:(c)=>`<svg class="mini-logo" viewBox="0 0 64 64"><g class="logo-outer-spin"><path d="M32 4 39 23 58 32 39 41 32 60 25 41 6 32 25 23Z" fill="none" stroke="${c}" stroke-width="3" stroke-linejoin="round"/></g><g class="logo-inner-spin"><path d="M32 9 43 45 10 24 54 24 21 45Z" fill="none" stroke="${c}" stroke-width="3.5" stroke-linejoin="round"/><path d="M32 18 36 29 48 32 36 35 32 47 28 35 16 32 28 29Z" fill="${c}" opacity=".16"/></g></svg>`,
 orbit:(c)=>`<svg class="mini-logo" viewBox="0 0 64 64"><g class="logo-outer-spin"><path d="M32 5 39 25 59 32 39 39 32 59 25 39 5 32 25 25Z" fill="none" stroke="${c}" stroke-width="3"/></g><g class="logo-inner-spin"><path d="M32 12 44 40 32 34 20 40Z" fill="none" stroke="${c}" stroke-width="3.5"/></g></svg>`,
 hex:(c)=>`<svg class="mini-logo" viewBox="0 0 64 64"><g class="logo-outer-spin"><path d="M32 4 39 23 58 32 39 41 32 60 25 41 6 32 25 23Z" fill="none" stroke="${c}" stroke-width="3"/></g><g class="logo-inner-spin"><path d="m32 11 18 10v22L32 53 14 43V21Z" fill="none" stroke="${c}" stroke-width="3.5"/><path d="m32 19 10 6v14l-10 6-10-6V25Z" fill="${c}" opacity=".13"/></g></svg>`,
 blade:(c)=>`<svg class="mini-logo" viewBox="0 0 64 64"><g class="logo-outer-spin"><path d="M32 4 39 23 58 32 39 41 32 60 25 41 6 32 25 23Z" fill="none" stroke="${c}" stroke-width="3"/></g><g class="logo-inner-spin"><path d="M32 8c4 12 10 20 22 24-12 4-18 12-22 24-4-12-10-20-22-24 12-4 18-12 22-24Z" fill="none" stroke="${c}" stroke-width="3.5"/></g></svg>`
};
const logoParticleStyles={pixel:"PIXEL",dot:"DOT",diamond:"DIAMOND",cross:"CROSS",off:"OFF"};
function renderHomeLogo(){
 const core=$("#logoCore"),particles=$("#logoParticles");if(!core||!particles)return;
 const c=getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()||"#fff";
 core.innerHTML=(logoStyles[state.settings.logoStyle]||logoStyles.triad)(c);particles.innerHTML="";
 const type=state.settings.logoParticles||"pixel";if(type==="off")return;
 const shapes=type==="pixel"?["pixel","dot","diamond","cross"]:[type,"dot","diamond"];
 const count=8;
 for(let i=0;i<count;i++){
   const p=document.createElement("i"),shape=shapes[Math.floor(Math.random()*shapes.length)];
   p.className=`logo-particle ${shape} ${i<3?"burst":"spark"}`;
   const a=Math.random()*Math.PI*2,r=19+Math.random()*17;
   p.style.left=(19+Math.cos(a)*r)+"px";p.style.top=(19+Math.sin(a)*r)+"px";
   p.style.setProperty("--tx",`${Math.cos(a)*(10+Math.random()*18)}px`);p.style.setProperty("--ty",`${Math.sin(a)*(10+Math.random()*18)}px`);
   p.style.setProperty("--pd",`${6.5+Math.random()*4.5}s`);p.style.setProperty("--delay",`${-(Math.random()*8)}s`);
   const size=(1.4+Math.random()*1.2).toFixed(2);p.style.width=size+"px";p.style.height=size+"px";
   particles.appendChild(p);
 }
}
function renderLogoSettings(){const wrap=$("#logoStyleOptions"),pw=$("#logoParticleOptions");if(!wrap||!pw)return;const c=getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()||"#fff";wrap.innerHTML=[["triad","TRIAD"],["orbit","ORBIT"],["hex","HEX"],["blade","BLADE"]].map(([k,n])=>`<button class="logo-style-option ${state.settings.logoStyle===k?"active":""}" data-logo="${k}">${logoStyles[k](c)}<span>${n}</span></button>`).join("");$$('#logoStyleOptions .logo-style-option').forEach(b=>b.onclick=()=>{state.settings.logoStyle=b.dataset.logo;saveSetting("logoStyle",b.dataset.logo);renderLogoSettings();renderHomeLogo()});pw.innerHTML=Object.entries(logoParticleStyles).map(([k,n])=>`<button class="option ${state.settings.logoParticles===k?"active":""}" data-particle="${k}"><strong>${n}</strong><span>Logo particles</span></button>`).join("");$$('#logoParticleOptions .option').forEach(b=>b.onclick=()=>{state.settings.logoParticles=b.dataset.particle;saveSetting("logoParticles",b.dataset.particle);renderLogoSettings();renderHomeLogo()});}

/* ---------- Themes / settings ---------- */
const themes=[
 ["obsidian","OBSIDIAN","#0b0d11","#8d98a8"],["red","RED / BLACK","#09090b","#cf3844"],["white","WHITE","#f2f3f5","#15181d"],["silver","SILVER","#15181d","#aab2bd"],
 ["ocean","OCEAN BLUE","#07131d","#3f91cf"],["forest","FOREST","#07120e","#58a37c"],["violet","VIOLET","#0f0a16","#9a72d7"],["orange","BURNT ORANGE","#160d08","#d27a3b"],
 ["rose","ROSE","#160b10","#d47a91"],["cyan","CYAN","#071417","#55c6cf"],["gold","GOLD","#141109","#c8a35a"],
 ["whiteRed","WHITE / RED","#f4f4f1","#d6424d"],["whiteGreen","WHITE / GREEN","#f3f6f3","#3e9a68"],["whiteBlue","WHITE / BLUE","#f1f5f9","#3f7fd0"],
 ["whitePurple","WHITE / PURPLE","#f5f2f8","#8d62c8"],["whiteGold","WHITE / GOLD","#f6f4ed","#b58a32"],["pearl","PEARL / CYAN","#eef7f8","#43aeb7"],["frost","FROST / BLUE","#edf5fa","#4b9bc7"],["whiteSilver","WHITE / SILVER","#f4f5f6","#7f8995"]
];
function applyTheme(name){const t=themes.find(x=>x[0]===name)||themes[0];const isLight=t[2].startsWith('#f');document.documentElement.classList.toggle("light",isLight);document.documentElement.style.setProperty("--bg",t[2]);document.documentElement.style.setProperty("--accent",t[3]);document.documentElement.style.setProperty("--accent2",t[3]);document.documentElement.style.setProperty("--glow",`color-mix(in srgb, ${t[3]} 24%, transparent)`);state.settings.theme=name;saveSetting("theme",name);renderSettings();renderHomeLogo();renderLogoSettings();toast("Theme updated")}
function renderSettings(){
  renderLogoSettings();
  $("#themeGrid").innerHTML=themes.map(t=>`<button class="theme-card ${state.settings.theme===t[0]?"active":""}" data-theme="${t[0]}"><div class="theme-swatch" style="--sw1:${t[2]};--sw2:${t[3]}"></div><span>${t[1]}</span></button>`).join("");
  $$("#themeGrid .theme-card").forEach(b=>b.onclick=()=>applyTheme(b.dataset.theme));
  const bg=[["ps2","PS2 ATMOSPHERE","CRT fog + grain"],["liquid","LIQUID","Flowing color motion"],["minimal","MINIMAL","Ultra low power"],["grid","GRID","Moving precision grid"],["grain","FILM GRAIN","Film texture + vignette"],["off","OFF","No background effect"]];
  $("#backgroundOptions").innerHTML=bg.map(x=>`<button class="option ${state.settings.background===x[0]?"active":""}" data-bg="${x[0]}"><strong>${x[1]}</strong><span>${x[2]}</span></button>`).join("");
  $$("#backgroundOptions .option").forEach(b=>b.onclick=()=>{state.settings.background=b.dataset.bg;saveSetting("background",b.dataset.bg);applyBackground();renderSettings();toast("Background updated")});
  const v=[["spectrum","Spectrum"],["circular","Circular"],["waveform","Waveform"],["particle","Particle"],["neon","Neon Pulse"]];
  $("#visualizerOptions").innerHTML=v.map(x=>`<button class="option ${state.settings.visualizer===x[0]?"active":""}" data-vizopt="${x[0]}"><strong>${x[1]}</strong><span>Live audio response</span></button>`).join("");
  $$("#visualizerOptions .option").forEach(b=>b.onclick=()=>{state.settings.visualizer=b.dataset.vizopt;saveSetting("visualizer",b.dataset.vizopt);renderSettings();renderVizButtons();toast("Visualizer changed")});
  $("#vizColorOptions").innerHTML=vizColorPresets.map(x=>{const color=x[0]==="theme"?"var(--accent)":x[0]==="custom"?state.settings.customVizColor:x[2];return `<button class="viz-color ${state.settings.visualizerColor===x[0]?"active":""}" data-vizcolor="${x[0]}"><i class="viz-dot" style="background:${color}"></i>${x[1]}</button>`}).join("");
  $$("#vizColorOptions .viz-color").forEach(b=>b.onclick=()=>{state.settings.visualizerColor=b.dataset.vizcolor;saveSetting("visualizerColor",b.dataset.vizcolor);renderSettings();toast("Visualizer color updated")});
  $("#vizCustomWrap").classList.toggle("show",state.settings.visualizerColor==="custom");$("#vizCustomColor").value=state.settings.customVizColor||"#9a72d7";$("#vizCustomColor").oninput=e=>{state.settings.customVizColor=e.target.value;state.settings.visualizerColor="custom";saveSetting("customVizColor",e.target.value);saveSetting("visualizerColor","custom");renderSettings()};
  const s=[["low","Low"],["medium","Medium"],["high","High"]];$("#sensitivityOptions").innerHTML=s.map(x=>`<button class="option ${state.settings.sensitivity===x[0]?"active":""}" data-sens="${x[0]}"><strong>${x[1]}</strong><span>Analysis response</span></button>`).join("");
  $$("#sensitivityOptions .option").forEach(b=>b.onclick=()=>{state.settings.sensitivity=b.dataset.sens;saveSetting("sensitivity",b.dataset.sens);renderSettings()});
  const fps=[["auto","AUTO"],["30","30 FPS"],["60","60 FPS"]];$("#fpsOptions").innerHTML=fps.map(x=>`<button class="option ${state.settings.fps===x[0]?"active":""}" data-fps="${x[0]}"><strong>${x[1]}</strong><span>Canvas target</span></button>`).join("");
  $$("#fpsOptions .option").forEach(b=>b.onclick=()=>{state.settings.fps=b.dataset.fps;saveSetting("fps",b.dataset.fps);renderSettings()});
  const eqPresets=[["flat","FLAT"],["bass","BASS"],["vocal","VOCAL"],["treble","TREBLE"],["warm","WARM"]];$("#eqPresets").innerHTML=eqPresets.map(x=>`<button class="eq-preset ${state.settings.eqPreset===x[0]?"active":""}" data-eq="${x[0]}">${x[1]}</button>`).join("");$$("#eqPresets .eq-preset").forEach(b=>b.onclick=()=>setEqPreset(b.dataset.eq));$("#eqBass").value=state.settings.eqBass;$("#eqMid").value=state.settings.eqMid;$("#eqTreble").value=state.settings.eqTreble;$("#bassBoostLevel").value=state.settings.bassBoostLevel;$("#eqBass").oninput=e=>setEqBand("eqBass",e.target.value);$("#eqMid").oninput=e=>setEqBand("eqMid",e.target.value);$("#eqTreble").oninput=e=>setEqBand("eqTreble",e.target.value);$("#bassBoostSwitch").classList.toggle("active",state.settings.bassBoost);$("#dynamicArtworkSwitch").classList.toggle("active",state.settings.dynamicArtwork);
  $("#volumeSetting").value=state.settings.volume;$("#settingShuffle").classList.toggle("active",state.settings.shuffle);$("#settingRepeat").classList.toggle("active",state.settings.repeat!=="off");$("#repeatLabel").textContent=state.settings.repeat.toUpperCase();$("#motionOption").classList.toggle("active",state.settings.reducedMotion);$("#motionLabel").textContent=state.settings.reducedMotion?"ON":"OFF";
}
$("#settingShuffle").onclick=toggleShuffle;$("#settingRepeat").onclick=cycleRepeat;$("#volumeSetting").addEventListener("input",e=>{state.settings.volume=Number(e.target.value);audio.volume=state.settings.volume;saveSetting("volume",state.settings.volume)});
$("#motionOption").onclick=()=>{state.settings.reducedMotion=!state.settings.reducedMotion;saveSetting("reducedMotion",state.settings.reducedMotion);document.body.classList.toggle("reduced-user",state.settings.reducedMotion);renderSettings();toast(state.settings.reducedMotion?"Reduced motion on":"Reduced motion off")};
$("#bassBoostSwitch").onclick=toggleBassBoost;$("#bassBoostLevel").oninput=e=>setBassBoostLevel(e.target.value);$("#dynamicArtworkSwitch").onclick=()=>{state.settings.dynamicArtwork=!state.settings.dynamicArtwork;saveSetting("dynamicArtwork",state.settings.dynamicArtwork);renderSettings();updateArtworkTheme()};
function applyBackground(){
  const b=state.settings.background;
  const layer=$("#bgLayer");
  layer.className="bg-layer "+(b==="ps2"?"ps2":b==="liquid"?"liquid-mode":b==="grid"?"grid-mode":b==="grain"?"grain-mode":b==="minimal"?"minimal-mode":"off-mode");
  if(!layer.innerHTML.trim()) layer.innerHTML='<div class="bg-orb a"></div><div class="bg-orb b"></div><div class="liquid"></div><div class="grid-bg"></div>';
  const orbA=layer.querySelector('.bg-orb.a'),orbB=layer.querySelector('.bg-orb.b'),liq=layer.querySelector('.liquid'),grid=layer.querySelector('.grid-bg');
  [orbA,orbB,liq,grid].forEach(e=>{if(e)e.style.display=""});
  layer.style.background="";
  if(b==="off"){layer.innerHTML="";layer.style.background="var(--bg)";return}
  if(b==="minimal"){if(orbA)orbA.style.display="none";if(orbB)orbB.style.display="none";if(liq)liq.style.display="none";if(grid)grid.style.display="none";layer.style.background="var(--bg)";return}
  if(b==="ps2"){if(orbB)orbB.style.opacity=".08";if(liq)liq.style.display="none";if(grid)grid.style.display="none"}
  if(b==="liquid"){if(grid)grid.style.display="none";if(orbA)orbA.style.opacity=".12";if(orbB)orbB.style.opacity=".12"}
  if(b==="grid"){if(liq)liq.style.display="none";if(orbA)orbA.style.opacity=".08";if(orbB)orbB.style.opacity=".08"}
  if(b==="grain"){if(orbA)orbA.style.display="none";if(orbB)orbB.style.display="none";if(liq)liq.style.display="none";if(grid)grid.style.display="none"}
}
function renderStorage(){let bytes=state.tracks.reduce((n,t)=>n+(t.file?.size||0),0);$("#storageTracks").textContent=state.tracks.length;$("#storageSize").textContent=(bytes/1048576).toFixed(bytes<10485760?1:0)+" MB"}

/* ---------- Visualizer ---------- */
const canvas=$("#visualCanvas"),ctx2=canvas.getContext("2d"),freq=new Uint8Array(1024),wave=new Uint8Array(2048);
function resizeCanvas(){const r=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,1.5);const cssW=Math.max(1,Math.floor(r.width)),cssH=Math.max(1,Math.floor(r.height));const w=Math.max(1,Math.floor(cssW*d)),h=Math.max(1,Math.floor(cssH*d));if(canvas.width!==w||canvas.height!==h){state.canvasDpr=d;canvas.width=w;canvas.height=h;ctx2.setTransform(1,0,0,1,0,0);ctx2.scale(d,d)}}
window.addEventListener("resize",resizeCanvas);
applyLyricStyle();
function bands(){if(!state.analyser)return{bass:0,mid:0,treble:0,overall:0};state.analyser.getByteFrequencyData(freq);let bass=0,mid=0,treble=0,all=0,n=freq.length;for(let i=0;i<n;i++){const v=freq[i]/255;all+=v;if(i<n*.12)bass+=v;else if(i<n*.48)mid+=v;else treble+=v}return{bass:bass/(n*.12),mid:mid/(n*.36),treble:treble/(n*.52),overall:all/n}}
const vizColorPresets=[['theme','THEME',null],['aurora','AURORA','#7CFFB2'],['purple','PURPLE','#A66CFF'],['ocean','OCEAN','#36B8FF'],['crimson','CRIMSON','#FF4D6D'],['emerald','EMERALD','#35E0A1'],['sunset','SUNSET','#FF9F43'],['mono','MONO','#E5E7EB'],['custom','CUSTOM',null]];
function getVizColor(){let c=state.settings.visualizerColor;if(c==='theme'){c=state.settings.dynamicArtwork?getComputedStyle(document.documentElement).getPropertyValue('--art-accent').trim()||getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#d8dde5':getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#d8dde5'}else if(c==='custom')c=state.settings.customVizColor||'#9a72d7';else c=(vizColorPresets.find(x=>x[0]===c)||vizColorPresets[0])[2]||'#d8dde5';return c}
function hexToRgb(hex){const m=String(hex).trim().replace('#','');if(m.length===3)return m.split('').map(x=>parseInt(x+x,16));if(/^[0-9a-f]{6}$/i.test(m))return [parseInt(m.slice(0,2),16),parseInt(m.slice(2,4),16),parseInt(m.slice(4,6),16)];const q=String(hex).match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);return q?[+q[1],+q[2],+q[3]]:[216,221,229]}
function vizRgba(a=1){const [r,g,b]=hexToRgb(getVizColor());return `rgba(${r},${g},${b},${a})`}
function renderSpectrum(w,h,b){ctx2.clearRect(0,0,w,h);const bars=72,gap=3,bw=w/bars-gap;for(let i=0;i<bars;i++){const idx=Math.floor(i/freq.length*bars*3);const v=Math.pow((freq[Math.min(idx,freq.length-1)]||0)/255,1.3);const boost=i<12?1+b.bass*.55:1;const bh=Math.max(2,v*h*.72*boost);const x=i*(bw+gap);ctx2.fillStyle=vizRgba(.45+v*.55);ctx2.fillRect(x,h-bh,bw,bh)}}
function renderCircular(w,h,b){ctx2.clearRect(0,0,w,h);const cx=w/2,cy=h/2,r=Math.min(w,h)*.19+b.bass*24;ctx2.beginPath();ctx2.arc(cx,cy,r,0,Math.PI*2);ctx2.strokeStyle=vizRgba(.16);ctx2.lineWidth=2;ctx2.stroke();const count=160;for(let i=0;i<count;i++){const v=(freq[Math.floor(i/count*freq.length)]||0)/255,len=6+v*70+b.bass*12,a=i/count*Math.PI*2,x1=cx+Math.cos(a)*r,y1=cy+Math.sin(a)*r,x2=cx+Math.cos(a)*(r+len),y2=cy+Math.sin(a)*(r+len);ctx2.strokeStyle=vizRgba(.16+v*.72);ctx2.lineWidth=1.5;ctx2.beginPath();ctx2.moveTo(x1,y1);ctx2.lineTo(x2,y2);ctx2.stroke()}}
function renderWave(w,h){ctx2.clearRect(0,0,w,h);if(!state.analyser)return;state.analyser.getByteTimeDomainData(wave);ctx2.beginPath();for(let i=0;i<w;i++){const y=(wave[Math.floor(i/w*wave.length)]/255)*h;const x=i;if(i===0)ctx2.moveTo(x,y);else ctx2.lineTo(x,y)}ctx2.strokeStyle=vizRgba(.95);ctx2.lineWidth=2;ctx2.stroke()}
function renderParticles(w,h,b){ctx2.clearRect(0,0,w,h);const count=90;while(state.particles.length<count)state.particles.push({x:Math.random()*w,y:Math.random()*h,vx:(Math.random()-.5),vy:(Math.random()-.5),r:1+Math.random()*2});for(const p of state.particles){p.x+=p.vx*(1+b.overall*2);p.y+=p.vy*(1+b.bass*2);if(p.x<0||p.x>w)p.vx*=-1;if(p.y<0||p.y>h)p.vy*=-1;const a=.18+b.overall*.55;ctx2.beginPath();ctx2.arc(p.x,p.y,p.r+b.bass*3,0,Math.PI*2);ctx2.fillStyle=vizRgba(a);ctx2.fill()}}
function renderNeon(w,h,b){ctx2.clearRect(0,0,w,h);const cx=w/2,cy=h/2,r=Math.min(w,h)*.18+b.bass*70;for(let k=3;k>0;k--){ctx2.beginPath();ctx2.arc(cx,cy,r+k*10+b.overall*12,0,Math.PI*2);ctx2.strokeStyle=vizRgba(.06+k*.04);ctx2.lineWidth=7-k*2;ctx2.shadowBlur=22;ctx2.shadowColor=vizRgba(.75);ctx2.stroke()}ctx2.shadowBlur=0;ctx2.beginPath();ctx2.arc(cx,cy,r,0,Math.PI*2);ctx2.strokeStyle=vizRgba(.9);ctx2.lineWidth=2;ctx2.stroke()}
function drawViz(ts){const fps=state.settings.fps==="30"?30:state.settings.fps==="60"?60:((navigator.hardwareConcurrency||4)<=4?30:45);if(ts-state.lastFrame<1000/fps){state.raf=requestAnimationFrame(drawViz);return}state.lastFrame=ts;const w=canvas.clientWidth,h=canvas.clientHeight,b=bands();const sens=state.settings.sensitivity==="low"?.7:state.settings.sensitivity==="high"?1.35:1; b.bass*=sens;b.mid*=sens;b.treble*=sens;b.overall*=sens;$("#bassValue").textContent=Math.min(100,Math.round(b.bass*100))+"%";$("#midValue").textContent=Math.min(100,Math.round(b.mid*100))+"%";$("#trebleValue").textContent=Math.min(100,Math.round(b.treble*100))+"%";$("#overallValue").textContent=Math.min(100,Math.round(b.overall*100))+"%";switch(state.settings.visualizer){case"circular":renderCircular(w,h,b);break;case"waveform":renderWave(w,h);break;case"particle":renderParticles(w,h,b);break;case"neon":renderNeon(w,h,b);break;default:renderSpectrum(w,h,b)}state.raf=requestAnimationFrame(drawViz)}
function startVisualizer(){if(!state.raf)state.raf=requestAnimationFrame(drawViz)}
function renderVizButtons(){$$("#vizSwitch .viz-btn").forEach(b=>b.classList.toggle("active",b.dataset.viz===state.settings.visualizer))}

$$('.settings-category').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.settingsTarget;if(id)document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});}));
$('#settingsLyricsDesign')?.addEventListener('click',()=>openLyricsCustomizer());

$$(".viz-btn").forEach(b=>b.onclick=()=>{state.settings.visualizer=b.dataset.viz;saveSetting("visualizer",b.dataset.viz);renderVizButtons();renderSettings();toast("Visualizer changed")});

/* ---------- Startup ---------- */
async function init(){
  audio.volume=state.settings.volume;
  try{await openDB();await loadSettings();state.tracks=await getAllTracks();
    // Migrate older tracks: convert Blob covers to portable data URLs and recover covers from the stored audio when needed.
    for(const t of state.tracks){
      let changed=false;
      if(t.cover instanceof Blob){const d=await blobToDataURL(t.cover);if(d){t.cover=d;changed=true}}
      if(!t.cover && t.file){try{const m=await metadata(t.file);if(m.cover){t.cover=m.cover;changed=true;if(m.title&&t.title===cleanName(t.file.name))t.title=m.title;if(m.artist&&t.artist==='Unknown Artist')t.artist=m.artist;if(m.album&&t.album==='Unknown Album')t.album=m.album}}catch{}}
      if(changed){try{await putTrack(t)}catch{}}
    }
  }catch{toast("Persistent storage is unavailable in this browser")}
  applyTheme(state.settings.theme);applyBackground();audio.volume=state.settings.volume;renderSettings();renderHomeLogo();applyEQ();updateArtworkTheme();renderVizButtons();renderAll();
  if(state.settings.lastTrackId){const t=state.tracks.find(x=>x.id===state.settings.lastTrackId);if(t){setAudioTrack(t,false);audio.addEventListener("loadedmetadata",()=>{if(state.settings.lastPosition)audio.currentTime=Math.min(state.settings.lastPosition,audio.duration||state.settings.lastPosition)}, {once:true})}}
  resizeCanvas();startVisualizer();
}
/* V37 — fullscreen controls above lyric stage */
(function(){
  const fs=document.getElementById("lyricsFullscreen");
  if(!fs)return;
  const head=fs.querySelector(".lyrics-full-head");
  const stage=fs.querySelector(".full-lyrics-stage");
  if(head)head.style.pointerEvents="auto";
  if(stage)stage.style.pointerEvents="none";
  fs.addEventListener("click",function(e){
    const back=e.target.closest("#closeFullLyrics");
    if(back){e.preventDefault();e.stopPropagation();closeFullLyrics();return;}
  },true);
})();

init();
