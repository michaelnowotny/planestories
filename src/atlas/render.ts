import type { AtlasGraph } from "./model.ts";

/**
 * Render a self-contained Project Atlas HTML page for a graph. Everything is
 * inlined (styles, script, data): no server, no CDN, works offline, and the file
 * is safe to email, commit, or open directly. The layout is a hand-rolled
 * left-to-right tidy tree in SVG (no D3).
 *
 * Inspired by Project Atlas in linearstories (Ijonas Kisselbach), rethought for
 * planestories and Plane.
 */
export function renderAtlasHtml(graph: AtlasGraph): string {
	// Escape the JSON so a title containing "</script>" can't break out of the tag.
	const data = JSON.stringify(graph).replace(/</g, "\\u003c");
	const title = `${escapeHtml(graph.project)} — Project Atlas`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="dot"></span>
    <div>
      <div class="project" id="projectName"></div>
      <div class="sub" id="projectSub"></div>
    </div>
  </div>
  <div class="stats" id="stats"></div>
  <div class="actions">
    <input id="search" type="search" placeholder="Search title or ID…" autocomplete="off" />
    <button id="fit" title="Fit to view">Fit</button>
    <button id="expand" title="Expand all">Expand</button>
    <button id="collapse" title="Collapse to epics">Collapse</button>
    <button id="theme" title="Toggle theme" aria-label="Toggle theme">◐</button>
  </div>
</header>
<div class="filters" id="filters"></div>
<main>
  <div class="canvas" id="canvas">
    <svg id="graph" xmlns="http://www.w3.org/2000/svg"><g id="viewport"></g></svg>
    <div class="empty" id="empty" hidden>No items match the current filters.</div>
  </div>
  <aside class="panel" id="panel" hidden></aside>
</main>
<footer class="foot">
  planestories atlas · inspired by Project Atlas (linearstories, Ijonas Kisselbach) · drag to pan, scroll to zoom
</footer>
<script>
const GRAPH = ${data};
${SCRIPT}
</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const STYLES = `
:root{
  --bg:#f6f7f9; --panel:#ffffff; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0;
  --card:#ffffff; --card-line:#dfe4ea; --shadow:0 1px 2px rgba(15,23,42,.06),0 4px 12px rgba(15,23,42,.05);
  --accent:#4f46e5; --epic:#6d28d9; --link:#c7ccd6;
  --g-backlog:#94a3b8; --g-unstarted:#64748b; --g-started:#2563eb; --g-completed:#16a34a; --g-cancelled:#ef4444; --g-unknown:#94a3b8;
  --flag:#d97706; --flag-bg:#fef3c7;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#0b1220; --panel:#111a2b; --ink:#e6ebf5; --muted:#93a1b8; --line:#1f2b40;
  --card:#141f33; --card-line:#25344f; --shadow:0 1px 2px rgba(0,0,0,.35),0 6px 18px rgba(0,0,0,.35);
  --accent:#818cf8; --epic:#a78bfa; --link:#2c3a56;
  --g-started:#60a5fa; --g-completed:#4ade80; --g-cancelled:#f87171; --flag:#fbbf24; --flag-bg:#3a2f12;
}}
:root[data-theme=dark]{
  --bg:#0b1220; --panel:#111a2b; --ink:#e6ebf5; --muted:#93a1b8; --line:#1f2b40;
  --card:#141f33; --card-line:#25344f; --shadow:0 1px 2px rgba(0,0,0,.35),0 6px 18px rgba(0,0,0,.35);
  --accent:#818cf8; --epic:#a78bfa; --link:#2c3a56;
  --g-started:#60a5fa; --g-completed:#4ade80; --g-cancelled:#f87171; --flag:#fbbf24; --flag-bg:#3a2f12;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;gap:16px;padding:10px 16px;background:var(--panel);
  border-bottom:1px solid var(--line);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;min-width:200px}
.brand .dot{width:10px;height:10px;border-radius:50%;background:var(--accent)}
.project{font-weight:650;font-size:15px}
.sub{color:var(--muted);font-size:12px}
.stats{display:flex;gap:14px;color:var(--muted);font-size:12.5px;flex:1}
.stats b{color:var(--ink);font-weight:600}
.stats .flag b{color:var(--flag)}
.actions{display:flex;gap:8px;align-items:center}
.actions input,.actions button{font:inherit;border:1px solid var(--card-line);background:var(--card);
  color:var(--ink);border-radius:8px;padding:6px 10px}
.actions input{width:180px}
.actions button{cursor:pointer}
.actions button:hover{border-color:var(--accent)}
.filters{display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
.chip{font-size:12px;border:1px solid var(--card-line);background:var(--card);color:var(--muted);
  border-radius:999px;padding:3px 10px;cursor:pointer;user-select:none;display:inline-flex;gap:6px;align-items:center}
.chip .sw{width:8px;height:8px;border-radius:50%}
.chip.on{color:var(--ink);border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--card))}
.chip.flag.on{border-color:var(--flag);background:var(--flag-bg);color:var(--flag)}
main{flex:1;display:flex;min-height:0}
.canvas{position:relative;flex:1;overflow:hidden;cursor:grab}
.canvas.grabbing{cursor:grabbing}
#graph{width:100%;height:100%;display:block}
[hidden]{display:none!important}
.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted)}
.link{fill:none;stroke:var(--link);stroke-width:1.5}
.node{cursor:pointer}
.node .card{fill:var(--card);stroke:var(--card-line);stroke-width:1;rx:9}
.node.epic .card{stroke:var(--epic)}
.node.project .card{fill:color-mix(in srgb,var(--accent) 10%,var(--card));stroke:var(--accent)}
.node.selected .card{stroke:var(--accent);stroke-width:2}
.node.dim{opacity:.32}
.node .title{fill:var(--ink);font-size:12.5px;font-weight:550}
.node .id{fill:var(--muted);font-size:10.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.node.completed .title{fill:var(--muted)}
.node .sdot{r:4}
.node .badge{fill:var(--muted);font-size:10px}
.node .flagmark{fill:var(--flag)}
.node .ac{stroke-width:2.4;fill:none}
.panel{width:340px;max-width:44vw;background:var(--panel);border-left:1px solid var(--line);
  padding:16px 18px;overflow:auto}
.panel h2{margin:.1em 0 .2em;font-size:16px;line-height:1.3}
.panel .pid{font-family:ui-monospace,monospace;color:var(--muted);font-size:12px}
.panel .row{margin:12px 0;font-size:13px}
.panel .k{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.panel .tags{display:flex;flex-wrap:wrap;gap:6px}
.panel .tag{font-size:11.5px;border:1px solid var(--card-line);border-radius:6px;padding:2px 7px;color:var(--muted)}
.panel ul{margin:6px 0 0;padding-left:0;list-style:none}
.panel li{display:flex;gap:8px;align-items:flex-start;margin:5px 0}
.panel li .box{margin-top:2px;width:13px;height:13px;border:1.5px solid var(--card-line);border-radius:4px;flex:none}
.panel li.done .box{background:var(--g-completed);border-color:var(--g-completed)}
.panel li.done span{color:var(--muted);text-decoration:line-through}
.panel .flags{background:var(--flag-bg);border:1px solid color-mix(in srgb,var(--flag) 40%,transparent);
  color:var(--flag);border-radius:8px;padding:8px 10px}
.panel .flags .k{color:var(--flag)}
.panel a.plane{display:inline-block;margin-top:6px;color:var(--accent);text-decoration:none;font-size:13px}
.panel a.plane:hover{text-decoration:underline}
.panel .close{float:right;cursor:pointer;color:var(--muted);border:none;background:none;font-size:18px}
.foot{padding:6px 16px;color:var(--muted);font-size:11.5px;border-top:1px solid var(--line);background:var(--panel);text-align:center}
`;

const SCRIPT = `
const NS="http://www.w3.org/2000/svg";
const GROUPS=["backlog","unstarted","started","completed","cancelled","unknown"];
const state={collapsed:new Set(),statusOn:new Set(),labelOn:new Set(),flaggedOnly:false,q:"",selected:null,
  view:{x:60,y:20,scale:1}};

// Synthetic project root so the whole board hangs off one node.
const ROOT={id:"__root__",kind:"project",title:GRAPH.project,identifier:null,url:null,status:null,
  statusGroup:"unknown",labels:[],assignee:null,criteria:[],quality:null,children:GRAPH.nodes};

const el=id=>document.getElementById(id);
const svg=el("graph"), viewport=el("viewport"), canvas=el("canvas");

function esc(s){return s==null?"":String(s)}
function progressOf(node){
  if(node.kind==="epic"){let d=0,t=0;for(const c of node.children){const p=childProgress(c);d+=p.done;t+=p.total;}return{done:d,total:t};}
  return childProgress(node);
}
function childProgress(node){
  if(node.criteria.length)return{done:node.criteria.filter(c=>c.checked).length,total:node.criteria.length};
  return{done:node.statusGroup==="completed"?1:0,total:1};
}
function matches(node){
  if(node.kind==="project")return true;
  if(state.statusOn.size&&!state.statusOn.has(node.statusGroup))return false;
  if(state.labelOn.size&&!node.labels.some(l=>state.labelOn.has(l)))return false;
  if(state.flaggedOnly&&!(node.quality&&!node.quality.ok))return false;
  if(state.q){const h=(node.title+" "+(node.identifier||"")).toLowerCase();if(!h.includes(state.q))return false;}
  return true;
}
function countDesc(node){let n=0;for(const c of node.children){n+=1+countDesc(c);}return n;}

// Build the visible display tree honoring filters + collapse.
function display(node,depth){
  const kids=[];
  const collapsed=state.collapsed.has(node.id);
  if(!collapsed){for(const c of node.children){const d=display(c,depth+1);if(d)kids.push(d);}}
  const self=matches(node);
  if(!self&&kids.length===0)return null;
  return {ref:node,depth,children:kids,
    hidden:collapsed?countDesc(node):(node.children.length-kids.length)};
}
const ROW=48,COL=250;
let maxX=0,maxY=0;
function layout(d,yc){
  d.x=d.depth*COL;
  if(d.children.length===0){d.y=yc.v*ROW;yc.v++;}
  else{for(const c of d.children)layout(c,yc);d.y=(d.children[0].y+d.children[d.children.length-1].y)/2;}
  maxX=Math.max(maxX,d.x);maxY=Math.max(maxY,d.y);
  return d;
}
function flat(d,out){out.push(d);for(const c of d.children)flat(c,out);return out;}

function render(){
  viewport.replaceChildren();
  maxX=0;maxY=0;
  const tree=display(ROOT,0);
  el("empty").hidden=!!tree;
  if(!tree){applyView();return;}
  layout(tree,{v:0});
  const nodes=flat(tree,[]);
  // links
  for(const d of nodes){for(const c of d.children){
    const p=document.createElementNS(NS,"path");
    const x1=d.x+220,y1=d.y+18,x2=c.x,y2=c.y+18,mx=(x1+x2)/2;
    p.setAttribute("d",\`M\${x1},\${y1} C\${mx},\${y1} \${mx},\${y2} \${x2},\${y2}\`);
    p.setAttribute("class","link");viewport.appendChild(p);
  }}
  // nodes
  for(const d of nodes)viewport.appendChild(nodeEl(d));
  autoFitIfFresh();applyView();
}

function nodeEl(d){
  const n=d.ref, g=document.createElementNS(NS,"g");
  let cls="node "+n.kind+(n.statusGroup==="completed"?" completed":"");
  if(state.selected===n.id)cls+=" selected";
  g.setAttribute("class",cls);
  g.setAttribute("transform",\`translate(\${d.x},\${d.y})\`);
  const W=n.kind==="project"?200:220,H=36;
  const card=rect(0,0,W,H,"card");g.appendChild(card);
  // status dot
  if(n.kind!=="project"){const dot=document.createElementNS(NS,"circle");
    dot.setAttribute("class","sdot");dot.setAttribute("cx",13);dot.setAttribute("cy",18);
    dot.setAttribute("fill",\`var(--g-\${n.statusGroup})\`);g.appendChild(dot);}
  const x0=n.kind==="project"?12:26;
  g.appendChild(text(x0,15,clip(n.title,n.kind==="project"?24:26),"title"));
  const meta=n.kind==="project"?\`\${GRAPH.counts.epics} epics · \${GRAPH.counts.stories} stories\`
    :(n.identifier||"unlinked");
  g.appendChild(text(x0,29,meta,"id"));
  // acceptance-criteria ring / progress
  if(n.kind!=="project"){const pr=progressOf(n);if(pr.total){
    ring(g,W-16,18,7,pr.done/pr.total,n.statusGroup);}}
  // quality flag mark
  if(n.quality&&!n.quality.ok){const t=text(W-30,15,"▲","flagmark");g.appendChild(t);}
  // collapse affordance / hidden count
  if(d.hidden>0){const b=text(W-4,H+11,"+"+d.hidden,"badge");b.setAttribute("text-anchor","end");g.appendChild(b);}
  g.addEventListener("click",e=>{e.stopPropagation();
    if(n.children.length){toggle(n.id);} select(n.id);});
  return g;
}
function rect(x,y,w,h,cls){const r=document.createElementNS(NS,"rect");
  r.setAttribute("x",x);r.setAttribute("y",y);r.setAttribute("width",w);r.setAttribute("height",h);
  r.setAttribute("rx",9);r.setAttribute("class",cls);return r;}
function text(x,y,s,cls){const t=document.createElementNS(NS,"text");
  t.setAttribute("x",x);t.setAttribute("y",y);t.setAttribute("class",cls);t.textContent=s;return t;}
function clip(s,n){return s.length>n?s.slice(0,n-1)+"…":s;}
function ring(g,cx,cy,r,frac,group){
  const bg=document.createElementNS(NS,"circle");bg.setAttribute("cx",cx);bg.setAttribute("cy",cy);
  bg.setAttribute("r",r);bg.setAttribute("class","ac");bg.setAttribute("stroke","var(--card-line)");g.appendChild(bg);
  if(frac<=0)return;const c=2*Math.PI*r;
  const arc=document.createElementNS(NS,"circle");arc.setAttribute("cx",cx);arc.setAttribute("cy",cy);
  arc.setAttribute("r",r);arc.setAttribute("class","ac");arc.setAttribute("stroke",\`var(--g-\${group})\`);
  arc.setAttribute("stroke-dasharray",\`\${c*Math.min(1,frac)} \${c}\`);
  arc.setAttribute("transform",\`rotate(-90 \${cx} \${cy})\`);g.appendChild(arc);
}

function toggle(id){if(state.collapsed.has(id))state.collapsed.delete(id);else state.collapsed.add(id);render();}
function select(id){state.selected=id;renderPanel();render();}

function renderPanel(){
  const p=el("panel");const n=findNode(state.selected);
  if(!n||n.kind==="project"){p.hidden=true;return;}
  p.hidden=false;p.replaceChildren();
  const close=document.createElement("button");close.className="close";close.textContent="×";
  close.onclick=()=>{state.selected=null;renderPanel();render();};p.appendChild(close);
  const h=document.createElement("h2");h.textContent=n.title;p.appendChild(h);
  if(n.identifier){const id=document.createElement("div");id.className="pid";
    id.textContent=n.identifier+" · "+(n.kind==="epic"?"Epic":"User story");p.appendChild(id);}
  p.appendChild(row("Status",n.status||"—"));
  if(n.assignee)p.appendChild(row("Assignee",n.assignee));
  if(n.labels.length){const r=rowEl("Labels");const t=document.createElement("div");t.className="tags";
    for(const l of n.labels){const s=document.createElement("span");s.className="tag";s.textContent=l;t.appendChild(s);}
    r.appendChild(t);p.appendChild(r);}
  if(n.quality&&!n.quality.ok){const r=document.createElement("div");r.className="row flags";
    const k=document.createElement("div");k.className="k";k.textContent="Spec check";r.appendChild(k);
    r.appendChild(document.createTextNode(n.quality.flags.join(" · ")));p.appendChild(r);}
  if(n.criteria.length){const r=rowEl("Acceptance criteria ("+n.criteria.filter(c=>c.checked).length+"/"+n.criteria.length+")");
    const ul=document.createElement("ul");
    for(const c of n.criteria){const li=document.createElement("li");if(c.checked)li.className="done";
      const b=document.createElement("span");b.className="box";li.appendChild(b);
      const s=document.createElement("span");s.textContent=c.text;li.appendChild(s);ul.appendChild(li);}
    r.appendChild(ul);p.appendChild(r);}
  if(n.url){const a=document.createElement("a");a.className="plane";a.href=n.url;a.target="_blank";
    a.rel="noreferrer";a.textContent="Open in Plane →";p.appendChild(a);}
}
function rowEl(k){const r=document.createElement("div");r.className="row";const kk=document.createElement("div");
  kk.className="k";kk.textContent=k;r.appendChild(kk);return r;}
function row(k,v){const r=rowEl(k);r.appendChild(document.createTextNode(v));return r;}

function findNode(id,list){for(const n of (list||[ROOT])){if(n.id===id)return n;const f=findNode(id,n.children);if(f)return f;}return null;}

// filters
function buildFilters(){
  const f=el("filters");f.replaceChildren();
  for(const gname of GROUPS){if(!GRAPH.statuses.length&&gname==="unknown")continue;
    const c=chip(gname,()=>{tog(state.statusOn,gname);render();buildFilters();},state.statusOn.has(gname));
    const sw=document.createElement("span");sw.className="sw";sw.style.background="var(--g-"+gname+")";
    c.prepend(sw);f.appendChild(c);}
  for(const l of GRAPH.labels){f.appendChild(chip(l,()=>{tog(state.labelOn,l);render();buildFilters();},state.labelOn.has(l)));}
  if(GRAPH.counts.flagged){const c=chip("⚠ "+GRAPH.counts.flagged+" flagged",()=>{state.flaggedOnly=!state.flaggedOnly;render();buildFilters();},state.flaggedOnly);
    c.classList.add("flag");f.appendChild(c);}
}
function chip(label,on,active){const b=document.createElement("span");b.className="chip"+(active?" on":"");
  b.append(document.createTextNode(label));b.onclick=on;return b;}
function tog(set,v){if(set.has(v))set.delete(v);else set.add(v);}

// pan + zoom
function applyView(){viewport.setAttribute("transform",\`translate(\${state.view.x},\${state.view.y}) scale(\${state.view.scale})\`);}
let fresh=true;
function autoFitIfFresh(){if(fresh){fresh=false;fit();}}
function fit(){
  const w=canvas.clientWidth,h=canvas.clientHeight;
  const gw=maxX+260,gh=maxY+90;
  const s=Math.min(1,Math.min(w/gw,h/gh))*0.94||1;
  state.view.scale=s;state.view.x=(w-gw*s)/2+20;state.view.y=Math.max(20,(h-gh*s)/2);
  applyView();
}
let drag=null;
canvas.addEventListener("mousedown",e=>{drag={x:e.clientX,y:e.clientY,vx:state.view.x,vy:state.view.y};canvas.classList.add("grabbing");});
window.addEventListener("mousemove",e=>{if(!drag)return;state.view.x=drag.vx+(e.clientX-drag.x);state.view.y=drag.vy+(e.clientY-drag.y);applyView();});
window.addEventListener("mouseup",()=>{drag=null;canvas.classList.remove("grabbing");});
canvas.addEventListener("click",()=>{if(state.selected){state.selected=null;renderPanel();render();}});
canvas.addEventListener("wheel",e=>{e.preventDefault();
  const f=e.deltaY<0?1.1:0.9,r=canvas.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  const ns=Math.min(2.4,Math.max(0.2,state.view.scale*f));
  state.view.x=mx-(mx-state.view.x)*(ns/state.view.scale);
  state.view.y=my-(my-state.view.y)*(ns/state.view.scale);
  state.view.scale=ns;applyView();},{passive:false});

// controls
el("search").addEventListener("input",e=>{state.q=e.target.value.trim().toLowerCase();render();});
el("fit").onclick=fit;
el("expand").onclick=()=>{state.collapsed.clear();render();};
el("collapse").onclick=()=>{state.collapsed.clear();for(const n of GRAPH.nodes)if(n.kind==="epic")state.collapsed.add(n.id);render();};
el("theme").onclick=()=>{const r=document.documentElement;
  const cur=r.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");
  r.setAttribute("data-theme",cur==="dark"?"light":"dark");};

// header
el("projectName").textContent=GRAPH.project;
el("projectSub").textContent=GRAPH.source==="board"?"live Plane board":"markdown file";
el("stats").innerHTML=\`<span>Epics <b>\${GRAPH.counts.epics}</b></span>\`+
  \`<span>Stories <b>\${GRAPH.counts.stories}</b></span>\`+
  \`<span>Criteria <b>\${GRAPH.counts.criteria}</b></span>\`+
  (GRAPH.counts.flagged?\`<span class="flag">Flagged <b>\${GRAPH.counts.flagged}</b></span>\`:"");

buildFilters();render();
window.addEventListener("resize",applyView);
`;
