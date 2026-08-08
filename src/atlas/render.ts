import type { AtlasGraph } from "./model.ts";

/**
 * Render a self-contained Project Atlas HTML page for a graph — the "Cockpit"
 * design (docs/DESIGN_atlas-cockpit.md, operator-approved 2026-08-08). Everything
 * is inlined (styles, script, data): no server, no CDN, works offline, and the
 * file is safe to email, commit, or open directly.
 *
 * The scene is a deep-blue celestial navigation cockpit. Work items are PLANETS,
 * never stars: status maps to a terraforming ladder (backlog=rock, todo=ice,
 * started=Mars, done=Earth, cancelled=cinder) and planet SIZE encodes dev-day
 * effort on a clipped log scale. Epics are dark void-core hubs wearing a
 * segmented progress ring (one tick per story, lit when done). Far-away clusters
 * render as status-tinted NEBULAE; planets condense out of the gas as a cluster
 * gains screen room (per-cluster LOD — there is no intermediate "star" form).
 * Selection is the only theatrical act: a rotating amber lighthouse beam + pulse
 * rings on the locked target. The header is a bridge-instrument bar (live MAG /
 * BRG, a draggable zoom needle, the SCAN field with a contact list); the right
 * sidebar is a glass panel with a story view, an epic dossier, and a NO-TARGET
 * empty state.
 *
 * The layout stays a hand-rolled FORCE-DIRECTED simulation on `<canvas>` (no
 * D3/CDN): nodes repel, parent/dependency springs pull, epic pairs repel 7x so
 * hubs never overlap, and per-cluster nebula/LOD geometry is measured from the
 * SETTLED positions. Dependency edges are drawn as animated supply lanes
 * (blocks = golden dashes, relates = purple dashes).
 *
 * Inspired by Project Atlas in linearstories (Ijonas Kisselbach), rethought for
 * planestories and Plane.
 */
export function renderAtlasHtml(graph: AtlasGraph): string {
	// Escape the JSON so a title containing "</script>" can't break out of the tag.
	const data = JSON.stringify(graph).replace(/</g, "\\u003c");
	const title = `${graph.project} — Project Atlas`; // escaped once, at insertion

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="top">
  <div class="brand">
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="11.4" stroke="rgba(110,231,255,.55)" stroke-width="1"/>
      <circle cx="13" cy="13" r="1.6" fill="#6ee7ff"/>
      <path d="M13 2.6 L14.6 11.4 L13 13 L11.4 11.4 Z" fill="#6ee7ff" opacity=".9"/>
      <path d="M13 23.4 L14.6 14.6 L13 13 L11.4 14.6 Z" fill="rgba(110,231,255,.4)"/>
      <path d="M2.6 13 L11.4 11.4 L13 13 L11.4 14.6 Z" fill="rgba(110,231,255,.4)"/>
      <path d="M23.4 13 L14.6 14.6 L13 13 L14.6 11.4 Z" fill="rgba(110,231,255,.4)"/>
    </svg>
    <div><b id="projectName"></b><span id="projectSub"></span></div>
  </div>
  <div class="gauges">
    <div class="cell"><div class="k">EPICS</div><div class="v" id="gEpics">0</div></div>
    <div class="cell"><div class="k">STORIES</div><div class="v" id="gStories">0</div></div>
    <div class="cell"><div class="k">SUPPLY LINES</div><div class="v" id="gEdges">0</div></div>
    <div class="cell warn"><div class="k">FLAGGED</div><div class="v" id="gFlag">0</div></div>
    <div class="cell nav"><div class="k">MAG</div><div class="v" id="mag">1.00&#215;</div></div>
    <div class="cell nav"><div class="k">BRG</div><div class="v" id="brg">000&#176;</div></div>
  </div>
  <div class="scanwrap">
    <input class="search" id="scan" placeholder="SCAN TITLE OR ID&#8230;" autocomplete="off" />
    <div class="contacts" id="contacts" hidden></div>
  </div>
  <button class="key" id="fitBtn" title="Fit to view (F)">FIT</button>
  <button class="key" id="pngBtn" title="Export the current view as a PNG">PNG</button>
</div>
<div class="ruler" id="ruler" title="Zoom needle — drag to zoom, double-click to fit"><i class="caret" id="caret"></i></div>
<div class="chips" id="chips"></div>
<main>
  <div id="stage">
    <canvas class="main" id="cv"></canvas>
    <canvas id="minimap" title="Minimap — click or drag to navigate"></canvas>
    <div class="hint"><b>CLICK</b> PLANET = LOCK TARGET &#183; <b>CLICK</b> RING = LOCK EPIC &#183;
      <b>DRAG</b> PAN / MOVE NODE &#183; <b>WHEEL</b> ZOOM<br /><b>SCAN</b>: TYPE &#8593;&#8595; &#9166; &#183;
      <b>ESC</b> END SCAN &#183; <b>NEEDLE</b>: DRAG TO ZOOM &#183; LOD: NEBULA &#8594; WORLDS &#183; SIZE = EFFORT (LOG)<br />
      <span class="credit">PLANESTORIES ATLAS &#183; AFTER PROJECT ATLAS (LINEARSTORIES)</span></div>
    <div class="settling" id="settling" hidden><span class="spin"></span> ARRANGING&#8230;</div>
    <div class="empty" id="empty" hidden>NO CONTACTS MATCH THE ACTIVE FILTERS</div>
  </div>
  <aside id="sidebar">
    <div id="sbEmpty">NO TARGET LOCKED<br />SELECT A PLANET OR AN EPIC &#8212; OR SCAN THE FIELD</div>
    <div id="sbEpic" hidden>
      <div class="id-row"><span class="wid" id="seId">&#8212;</span><span class="close" id="seClose">&#10005;</span></div>
      <h1 class="title" id="seTitle">&#8212;</h1>
      <div class="sec" style="margin-top:0"><h3>Progress</h3>
        <div class="epic-card" style="cursor:default">
          <svg width="44" height="44" viewBox="0 0 34 34" id="seRing"></svg>
          <div><div class="n" id="seSub">&#8212;</div><div class="s" id="seSub2">&#8212;</div></div>
        </div></div>
      <div class="sec"><h3>Status breakdown</h3>
        <div class="bdown" id="seBar"></div>
        <div id="seCounts"></div></div>
      <div class="sec"><h3>Effort</h3>
        <div class="meta">
          <div class="cell2"><div class="k">Total</div><div class="v" id="seTot">&#8212;</div></div>
          <div class="cell2"><div class="k">Remaining</div><div class="v" id="seRem">&#8212;</div></div>
        </div></div>
      <div class="sec"><h3>Supply lines &#183; epic boundary</h3><div id="seDeps"></div></div>
      <div class="sec"><h3>Heaviest stories</h3><div id="seStories"></div></div>
      <a class="open" id="seOpen" target="_blank" rel="noreferrer" hidden>Open in Plane <span style="font-size:15px">&#8599;</span></a>
    </div>
    <div id="sbContent" hidden>
      <div class="id-row"><span class="wid" id="sbId">&#8212;</span><span class="close" id="sbClose">&#10005;</span></div>
      <h1 class="title" id="sbTitle">&#8212;</h1>
      <div class="sec" style="margin-top:0"><h3>Status</h3>
        <span class="status-pill" id="sbPill"><span class="d" id="sbDot"></span><span id="sbStatus">&#8212;</span></span></div>
      <div class="sec"><h3>Details</h3>
        <div class="meta">
          <div class="cell2"><div class="k">Effort</div><div class="v" id="sbEffort">&#8212;</div></div>
          <div class="cell2"><div class="k">Priority</div><div class="v" id="sbPrio">&#8212;</div></div>
          <div class="cell2" style="grid-column:1/3"><div class="k">Labels</div>
            <div class="v" id="sbLabels">&#8212;</div></div>
        </div></div>
      <div class="sec" id="sbFlagSec" hidden><h3>Spec flags</h3><div id="sbFlags"></div></div>
      <div class="sec" id="sbEpicSec"><h3>Epic</h3>
        <div class="epic-card" id="sbEpicCard">
          <svg width="34" height="34" viewBox="0 0 34 34" id="sbRing"></svg>
          <div><div class="n" id="sbEpicName">&#8212;</div><div class="s" id="sbEpicSub">&#8212;</div></div>
        </div></div>
      <div class="sec" id="sbCritSec"><h3 id="sbCritH">Acceptance criteria</h3>
        <ul class="crit" id="sbCrit"></ul></div>
      <div class="sec"><h3>Supply lines</h3><div id="sbDeps"></div></div>
      <a class="open" id="sbOpen" target="_blank" rel="noreferrer" hidden>Open in Plane <span style="font-size:15px">&#8599;</span></a>
    </div>
  </aside>
</main>
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
  --bg0:#0a1024; --bg1:#030510; --panel:rgba(10,16,36,.72); --panel-line:rgba(120,150,220,.16);
  --ink:#e9efff; --muted:#8b9bc4; --faint:#5d6c95;
  --red:#f87171; --neutral:#93a7d1;
  --orange:#ff9f43; --purple:#a78bfa; --cyan:#6ee7ff; --amber:#ffb054;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;color:var(--ink);display:flex;flex-direction:column;
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;overflow:hidden;
  background:radial-gradient(130% 100% at 42% 30%,var(--bg0) 0%,var(--bg1) 74%)}
[hidden]{display:none!important}
.top{display:flex;align-items:center;gap:16px;padding:10px 18px 8px;flex-wrap:wrap;
  background:linear-gradient(180deg,rgba(10,16,34,.85),rgba(8,12,28,.55));
  backdrop-filter:blur(10px);position:relative;z-index:60}
.brand{display:flex;align-items:center;gap:12px;min-width:196px}
.brand svg{filter:drop-shadow(0 0 6px rgba(110,231,255,.5));flex:none}
.brand b{font-size:14.5px;font-weight:680;display:block;max-width:230px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brand span{color:var(--faint);font:600 9px var(--mono);letter-spacing:.22em}
.gauges{display:flex;gap:8px;flex:1;flex-wrap:wrap}
.cell{border:1px solid var(--panel-line);border-radius:8px;background:rgba(14,22,48,.5);
  padding:4px 12px 5px;min-width:74px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 2px 8px rgba(0,0,0,.25)}
.cell .k{font:600 8.5px var(--mono);letter-spacing:.18em;color:var(--faint)}
.cell .v{font:600 13.5px var(--mono);margin-top:1px;letter-spacing:.03em}
.cell.warn .v{color:var(--amber);text-shadow:0 0 8px rgba(255,176,84,.5)}
.cell.nav .v{color:var(--cyan)}
.scanwrap{position:relative}
.search{width:220px;background:rgba(14,22,48,.6);border:1px solid var(--panel-line);
  border-radius:8px;color:var(--ink);font:600 11px var(--mono);letter-spacing:.08em;
  padding:8px 12px;outline:none}
.search::placeholder{color:var(--faint)}
.search:focus{border-color:rgba(110,231,255,.5)}
.key{background:rgba(14,22,48,.6);border:1px solid var(--panel-line);color:var(--ink);
  border-radius:8px;padding:8px 14px;font:600 11px var(--mono);letter-spacing:.14em;cursor:pointer}
.key:hover{border-color:rgba(110,231,255,.55);color:var(--cyan)}
.ruler{position:relative;height:10px;cursor:ew-resize;flex:none;
  background:
    repeating-linear-gradient(90deg,rgba(140,170,230,.28) 0 1px,transparent 1px 8px),
    repeating-linear-gradient(90deg,rgba(140,170,230,.45) 0 1px,transparent 1px 40px);
  background-size:100% 4px,100% 8px;background-position:bottom left;background-repeat:repeat-x;
  border-bottom:1px solid var(--panel-line)}
.ruler .caret{position:absolute;left:3%;bottom:0;width:0;height:0;
  border-left:5px solid transparent;border-right:5px solid transparent;
  border-bottom:6px solid var(--cyan);filter:drop-shadow(0 0 5px rgba(110,231,255,.8))}
.contacts{position:absolute;top:calc(100% + 8px);right:0;width:430px;z-index:80;
  background:rgba(10,16,36,.94);backdrop-filter:blur(14px);
  border:1px solid rgba(110,231,255,.28);border-radius:12px;overflow:hidden;
  box-shadow:0 24px 60px rgba(0,0,0,.6)}
.contacts .ch{display:flex;justify-content:space-between;padding:8px 14px;
  font:600 9.5px var(--mono);letter-spacing:.16em;color:var(--faint);
  border-bottom:1px solid var(--panel-line);background:rgba(110,231,255,.04)}
.contacts .ch b{color:var(--cyan);font-weight:600}
.crow{display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;font-size:12.5px}
.crow+.crow{border-top:1px solid rgba(120,150,220,.08)}
.crow .st{flex:none;font-size:11px;line-height:1}
.crow b{font:600 11px var(--mono);color:var(--cyan);flex:none}
.crow .ttl{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}
.crow .ttl .hl{font-style:normal;color:var(--cyan)}
.crow .kindtag{flex:none;color:var(--faint);font:600 9px var(--mono);letter-spacing:.14em}
.crow.focus{background:rgba(110,231,255,.09);box-shadow:inset 2.5px 0 0 var(--cyan)}
.crow.focus .ttl{color:var(--ink)}
.contacts .more{padding:7px 14px;font:600 9.5px var(--mono);letter-spacing:.14em;color:var(--faint);
  border-top:1px solid var(--panel-line)}
.chips{display:flex;gap:7px;padding:9px 18px;flex-wrap:wrap;flex:none;
  background:rgba(8,12,28,.42);border-bottom:1px solid var(--panel-line)}
.chip{font-size:11.5px;color:var(--muted);border:1px solid var(--panel-line);
  background:rgba(14,22,48,.55);border-radius:999px;padding:3px 12px;cursor:pointer;
  display:inline-flex;align-items:center;gap:7px;user-select:none}
.chip .st{font-size:11px;line-height:1}
.chip.on{color:var(--ink);border-color:rgba(110,231,255,.45);background:rgba(110,231,255,.08)}
main{flex:1;display:flex;min-height:0}
#stage{flex:1;position:relative;cursor:grab;min-width:0}
#stage.grabbing{cursor:grabbing}
canvas.main{display:block;width:100%;height:100%}
#minimap{position:absolute;right:14px;top:14px;width:190px;height:130px;
  border:1px solid rgba(110,231,255,.25);border-radius:10px;background:rgba(8,12,28,.78);
  box-shadow:0 10px 30px rgba(0,0,0,.45);cursor:pointer;backdrop-filter:blur(6px)}
aside{width:368px;background:var(--panel);backdrop-filter:blur(14px);
  border-left:1px solid var(--panel-line);padding:22px 22px 18px;overflow-y:auto;
  box-shadow:-30px 0 60px rgba(0,0,0,.35)}
.id-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.wid{font:600 12px var(--mono);color:var(--cyan);letter-spacing:.04em}
.wid .kind{color:var(--faint);margin-left:8px;letter-spacing:.08em}
.close{color:var(--faint);cursor:pointer;font-size:16px}
.close:hover{color:var(--ink)}
h1.title{font-size:16.5px;line-height:1.42;font-weight:650;margin:0 0 16px}
.sec{margin-top:18px}
.sec h3{font-size:10.5px;font-weight:650;letter-spacing:.14em;color:var(--faint);
  text-transform:uppercase;margin:0 0 9px}
.status-pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--panel-line);
  border-radius:999px;padding:5px 13px;font-size:12.5px}
.status-pill .d{width:8px;height:8px;border-radius:50%}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
.meta .cell2{background:rgba(14,22,48,.5);border:1px solid var(--panel-line);
  border-radius:10px;padding:9px 12px}
.meta .k{font-size:10px;letter-spacing:.1em;color:var(--faint);text-transform:uppercase}
.meta .v{font-size:13px;margin-top:3px}
.lbl{display:inline-block;font-size:11px;color:var(--muted);border:1px solid var(--panel-line);
  border-radius:999px;padding:1px 9px;margin:2px 3px 0 0}
.epic-card{display:flex;align-items:center;gap:12px;background:rgba(14,22,48,.5);
  border:1px solid var(--panel-line);border-radius:12px;padding:10px 12px;cursor:pointer}
.epic-card:hover{border-color:rgba(110,231,255,.4)}
.epic-card .n{font-size:12.5px;line-height:1.35}
.epic-card .s{color:var(--faint);font-size:11px;margin-top:2px}
.crit{list-style:none;margin:0;padding:0}
.crit li{display:flex;gap:10px;font-size:12.5px;line-height:1.45;color:var(--muted);
  padding:5px 0;align-items:flex-start}
.crit li.done{color:var(--ink)}
.crit .m{flex:none;width:15px;height:15px;border-radius:50%;margin-top:2px;
  border:1.4px solid var(--faint);position:relative}
.crit li.done .m{border-color:#5eb2ff;background:rgba(94,178,255,.14)}
.crit li.done .m::after{content:"";position:absolute;left:4px;top:1.5px;width:4px;height:7px;
  border:solid #5eb2ff;border-width:0 1.6px 1.6px 0;transform:rotate(42deg)}
.dep{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:10px;
  border:1px solid var(--panel-line);background:rgba(14,22,48,.5);margin-bottom:7px;font-size:12px;
  cursor:pointer}
.dep:hover{border-color:rgba(110,231,255,.4)}
.dep .ln{flex:none;width:22px;height:2px;border-radius:2px}
.dep.blocks .ln{background:var(--orange)}
.dep.relates .ln{background:repeating-linear-gradient(90deg,var(--purple) 0 4px,transparent 4px 7px)}
.dep .t{color:var(--faint);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
  width:70px;flex:none}
.dep b{font-weight:600;color:var(--cyan);font-family:var(--mono);font-size:11px}
.dep .dt{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}
.open{display:flex;justify-content:center;gap:8px;margin-top:20px;text-decoration:none;
  border:1px solid rgba(110,231,255,.4);color:var(--cyan);border-radius:10px;
  padding:9px 0;font-size:13px;cursor:pointer;background:rgba(110,231,255,.05)}
.open:hover{background:rgba(110,231,255,.12)}
.bdown{display:flex;height:9px;border-radius:5px;overflow:hidden;border:1px solid var(--panel-line)}
.bdown i{height:100%}
#seCounts{margin-top:8px;font:600 10px var(--mono);letter-spacing:.06em;color:var(--muted);line-height:1.9}
.srow{display:flex;gap:9px;align-items:center;padding:6px 10px;border:1px solid var(--panel-line);
  border-radius:10px;background:rgba(14,22,48,.5);margin-bottom:6px;font-size:12px;cursor:pointer}
.srow:hover{border-color:rgba(110,231,255,.4)}
.srow b{font:600 10.5px var(--mono);color:var(--cyan)}
.srow .st{font-size:10px}
.srow .ttl2{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}
.srow .eff{color:var(--faint);font:600 10px var(--mono)}
.nodeps{color:var(--faint);font:600 10px var(--mono);letter-spacing:.14em}
.morestories{color:var(--faint);font:600 9.5px var(--mono);letter-spacing:.14em;padding:4px 2px}
#sbEmpty{color:var(--faint);text-align:center;padding:60px 10px;
  font:600 11px var(--mono);letter-spacing:.18em;line-height:2}
#sbFlags{color:var(--amber);font:600 10px var(--mono);letter-spacing:.06em;line-height:1.9}
.hint{position:absolute;left:16px;bottom:14px;background:var(--panel);backdrop-filter:blur(10px);
  border:1px solid var(--panel-line);border-radius:12px;padding:10px 14px;
  font:600 10px var(--mono);letter-spacing:.11em;color:var(--faint);line-height:1.9;
  pointer-events:none}
.hint b{color:var(--cyan);font-weight:600}
.hint .credit{color:rgba(93,108,149,.6);font-size:8.5px}
.settling{position:absolute;right:14px;bottom:14px;background:var(--panel);backdrop-filter:blur(6px);
  border:1px solid var(--panel-line);border-radius:999px;padding:6px 13px;
  font:600 9.5px var(--mono);letter-spacing:.16em;color:var(--cyan);
  display:flex;align-items:center;gap:8px}
.settling .spin{width:10px;height:10px;border-radius:50%;border:2px solid rgba(110,231,255,.25);
  border-top-color:var(--cyan);animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  color:var(--faint);font:600 11px var(--mono);letter-spacing:.18em;pointer-events:none}
`;

const SCRIPT = `
"use strict";
const el=id=>document.getElementById(id);
const cv=el("cv"),x=cv.getContext("2d"),stage=el("stage");
const mini=el("minimap"),mctx=mini.getContext("2d");
const MONO="ui-monospace,SFMono-Regular,Menlo,monospace";
const CYAN="#6ee7ff",AMBER="#ffb054";

// --- Terraforming ladder: status group -> world kind + accent hue -------------
// Hue is identity and survives every zoom level (nebula tint, ring, pills,
// chips, contact glyphs all derive from ACC). Unknown renders as rock/neutral.
const WKIND={completed:"earth",started:"mars",unstarted:"ice",backlog:"rock",
  cancelled:"cinder",unknown:"rock"};
const ACC={completed:"#57a7e8",started:"#e0824f",unstarted:"#b9dcf2",
  backlog:"#93a7d1",cancelled:"#f87171",unknown:"#93a7d1"};
const GROUPS=["completed","started","unstarted","backlog","cancelled","unknown"];

// --- Flatten the tree into nodes + parent/dependency edges --------------------
const NODES=[],byId=new Map();
(function flatten(list){for(const n of list){NODES.push(n);byId.set(n.id,n);
  if(n.children&&n.children.length)flatten(n.children);}})(GRAPH.nodes);
const parentOf=new Map(),childrenOf=new Map();
(function walk(list,parent){for(const n of list){if(parent){parentOf.set(n.id,parent.id);
    (childrenOf.get(parent.id)||childrenOf.set(parent.id,[]).get(parent.id)).push(n.id);}
  if(n.children&&n.children.length)walk(n.children,n);}})(GRAPH.nodes,null);
const HUBS=NODES.filter(n=>n.kind==="epic");
const DEPS=(GRAPH.edges||[]).filter(e=>byId.has(e.source)&&byId.has(e.target));
const EDGES=[];
for(const [child,par] of parentOf)EDGES.push({s:par,t:child,type:"parent"});
for(const e of DEPS)EDGES.push({s:e.source,t:e.target,type:e.type});

// Nodes that participate in the dependency web (+ their FULL ancestor chain for
// context — a dep two levels under a nested epic must keep the grandparent hub).
const inDeps=new Set();
for(const e of DEPS){inDeps.add(e.source);inDeps.add(e.target);}
for(const id of [...inDeps]){let p=parentOf.get(id);
  while(p&&!inDeps.has(p)){inDeps.add(p);p=parentOf.get(p);}}

// Direct non-epic children of an epic = its cluster stories.
const storiesOf=new Map();
for(const h of HUBS)storiesOf.set(h.id,
  (childrenOf.get(h.id)||[]).map(id=>byId.get(id)).filter(c=>c&&c.kind!=="epic"));
// Per-epic completion (non-cancelled children): drives ring + dossier.
const epicProg=new Map();
for(const h of HUBS){const kids=storiesOf.get(h.id);
  const countable=kids.filter(c=>c.statusGroup!=="cancelled");
  epicProg.set(h.id,{done:countable.filter(c=>c.statusGroup==="completed").length,
    total:countable.length,stories:kids.length});}
// Epic subtree membership (epic + ALL descendants) for boundary supply lines.
const subtreeOf=new Map();
for(const h of HUBS){const set=new Set([h.id]);
  (function grow(id){for(const cid of (childrenOf.get(id)||[])){set.add(cid);grow(cid);}})(h.id);
  subtreeOf.set(h.id,set);}
// Nearest ANCESTOR epic of a node (for cluster LOD + the story view's epic card).
const epicOf=new Map();
for(const n of NODES){let p=parentOf.get(n.id);
  while(p&&byId.get(p)&&byId.get(p).kind!=="epic")p=parentOf.get(p);
  if(p&&n.kind!=="epic")epicOf.set(n.id,p);}

// --- Layout state (unchanged physics from the previous atlas) -----------------
const P=new Map();
(function seed(){const R=Math.max(200,Math.sqrt(NODES.length)*30);let i=0;
  for(const n of NODES){const a=i*2.399963,r=R*Math.sqrt(i/NODES.length);
    // Epic world radius grows with its story count, so big epics read as big hubs.
    const wr=n.kind==="epic"?13+Math.min(11,Math.sqrt((childrenOf.get(n.id)||[]).length)*1.9):6;
    P.set(n.id,{x:Math.cos(a)*r,y:Math.sin(a)*r,vx:0,vy:0,r:wr,pin:false});i++;}
})();
const REP=300,SPRING={parent:0.12,blocks:0.03,relates:0.02},REST={parent:26,blocks:110,relates:120},
  GRAV=0.06,VDECAY=0.7,DECAY=0.012,AMIN=0.02;
let alpha=1;
function tick(){
  const arr=NODES,n=arr.length;
  for(let i=0;i<n;i++){const a=P.get(arr[i].id),aEpic=arr[i].kind==="epic";
    for(let j=i+1;j<n;j++){const b=P.get(arr[j].id);
      let dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy;
      if(d2<0.01){dx=Math.random()-0.5;dy=Math.random()-0.5;d2=dx*dx+dy*dy+0.01;}
      // epic pairs repel harder so cluster hubs never overlap each other
      const f=(aEpic&&arr[j].kind==="epic"?REP*7:REP)/d2,fx=dx*f,fy=dy*f;
      a.vx+=fx*alpha;a.vy+=fy*alpha;b.vx-=fx*alpha;b.vy-=fy*alpha;}}
  for(const e of EDGES){const a=P.get(e.s),b=P.get(e.t);
    let dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||0.01;
    // parent rest grows with the epic's radius so a fat hub can't swallow its stories
    const rest=e.type==="parent"?a.r+16:REST[e.type];
    const f=(d-rest)/d*SPRING[e.type]*alpha,fx=dx*f,fy=dy*f;a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;}
  for(const nd of arr){const p=P.get(nd.id);
    p.vx-=p.x*GRAV*alpha;p.vy-=p.y*GRAV*alpha;
    if(p.pin){p.vx=0;p.vy=0;continue;}
    p.vx*=VDECAY;p.vy*=VDECAY;p.x+=p.vx;p.y+=p.vy;}
  alpha*=(1-DECAY);
}

// --- Cluster geometry from SETTLED positions (design 7.2) ---------------------
// extent = max hub->story distance + pad (the nebula radius). spacing = AREAL
// room per story, sqrt(pi*extent^2/n) — the LOD driver. A mean-radius driver is
// wrong here: radius GROWS with cluster size, which would resolve big clusters
// first; areal spacing is nearly flat across cluster sizes and slightly larger
// for small epics, so small clusters condense first (the telescopic feel).
// Recomputed while the sim is hot and once when it cools.
const GEO=new Map();
function computeGeo(){
  for(const h of HUBS){const hp=P.get(h.id);let cnt=0,mx=0;
    for(const c of storiesOf.get(h.id)){const cp=P.get(c.id);
      const d=Math.hypot(cp.x-hp.x,cp.y-hp.y);cnt++;if(d>mx)mx=d;}
    const extent=cnt?mx+16:hp.r+30;
    GEO.set(h.id,{extent,
      spacing:Math.sqrt(Math.PI*extent*extent/Math.max(1,cnt))});}}
computeGeo();

// --- View / camera ------------------------------------------------------------
let W=0,H=0,dpr=1;
const view={x:0,y:0,scale:1};
let fitScale=0,anim=null,brgV=0,miniDirty=true,lastMiniAt=0;
function fs(){return fitScale||view.scale||1;}
function resize(){dpr=window.devicePixelRatio||1;W=cv.clientWidth;H=cv.clientHeight;
  cv.width=Math.max(1,W*dpr);cv.height=Math.max(1,H*dpr);x.setTransform(dpr,0,0,dpr,0,0);
  mini.width=Math.max(1,mini.clientWidth*dpr);mini.height=Math.max(1,mini.clientHeight*dpr);
  if(fitted)fitScale=fitScaleFor();
  miniDirty=true;}
function visBounds(){let mnx=1e9,mny=1e9,mxx=-1e9,mxy=-1e9,any=false;
  for(const n of NODES){if(!visible(n))continue;any=true;const p=P.get(n.id);
    mnx=Math.min(mnx,p.x);mny=Math.min(mny,p.y);mxx=Math.max(mxx,p.x);mxy=Math.max(mxy,p.y);}
  if(!any)return null;return[mnx,mny,mxx,mxy];}
// SCREEN-space gutter: nodes have minimum screen sizes, so padding is budgeted
// in pixels — world padding collapses to nothing at small scales.
function fitBox(mnx,mny,mxx,mxy,animate,G){
  G=G||64;const aw=Math.max(80,W-2*G),ah=Math.max(80,H-2*G);
  const s=Math.min(aw/Math.max(1,mxx-mnx),ah/Math.max(1,mxy-mny));
  const tx=W/2-((mnx+mxx)/2)*s,ty=H/2-((mny+mxy)/2)*s;
  if(animate)flyTo(s,tx,ty);else{view.scale=s;view.x=tx;view.y=ty;miniDirty=true;}
  return s;}
function fitScaleFor(){const b=visBounds();if(!b)return view.scale||1;
  const G=64,aw=Math.max(80,W-2*G),ah=Math.max(80,H-2*G);
  return Math.min(aw/Math.max(1,b[2]-b[0]),ah/Math.max(1,b[3]-b[1]));}
function fitAll(animate){const b=visBounds();if(!b)return;
  fitScale=fitBox(b[0],b[1],b[2],b[3],animate);}
function flyTo(s,tx,ty){HOV=null; // a camera fly invalidates the pointer's world position
  anim={f:{s:view.scale,x:view.x,y:view.y},g:{s,x:tx,y:ty},
  t0:performance.now(),d:520};}
function flyToNode(n,mag){const p=P.get(n.id),s=Math.min(fs()*40,Math.max(view.scale,fs()*(mag||5)));
  flyTo(s,W/2-p.x*s,H/2-p.y*s);}
// Frame an epic's cluster so its planets fully condense (spacing target 50px,
// past the gas band's 42px upper edge).
function flyToCluster(h){const g=GEO.get(h.id),p=P.get(h.id);
  const s=Math.min(fs()*40,50/(g?g.spacing:80));
  flyTo(s,W/2-p.x*s,H/2-p.y*s);}
el("fitBtn").onclick=()=>fitAll(true);
// Ruler = draggable zoom needle (log scale over the 1x..40x MAG band).
const ruler=el("ruler");
function rulerZoom(e){const r=ruler.getBoundingClientRect(),
  frac=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));
  const s=fs()*Math.exp(frac*Math.log(40));
  const cxp=W/2,cyp=H/2,wx=(cxp-view.x)/view.scale,wy=(cyp-view.y)/view.scale;
  view.scale=s;view.x=cxp-wx*s;view.y=cyp-wy*s;anim=null;miniDirty=true;}
let rulerDrag=false;
ruler.addEventListener("mousedown",e=>{rulerDrag=true;rulerZoom(e);});
window.addEventListener("mousemove",e=>{if(rulerDrag)rulerZoom(e);});
window.addEventListener("mouseup",()=>{rulerDrag=false;});
ruler.addEventListener("dblclick",()=>fitAll(true));

// --- Filters ------------------------------------------------------------------
const state={statusOn:new Set(),labelOn:new Set(),flaggedOnly:false,depsOnly:false};
function visible(n){return !(state.depsOnly&&!inDeps.has(n.id));}
function matches(n){
  if(state.statusOn.size&&!state.statusOn.has(n.statusGroup))return false;
  if(state.labelOn.size&&!n.labels.some(l=>state.labelOn.has(l)))return false;
  if(state.flaggedOnly&&!(n.quality&&!n.quality.ok))return false;
  return true;}

// --- Selection + scan state ---------------------------------------------------
let SEL=null,HOV=null,scanQ="",scanMatches=[],scanFocus=0,pingT0=0,savedView=null;
function esc(s){return (s==null?"":String(s)).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
// Only http(s) may reach an href: a file-sourced plane_url could otherwise
// smuggle a javascript: scheme into the sidebar's Open in Plane anchor.
function safeUrl(u){return u&&/^https?:\\/\\//i.test(u)?u:null;}
function reEsc(s){return s.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g,"\\\\$&");}
function clip(s,n){return s.length>n?s.slice(0,n-1)+"\\u2026":s;}
function matchesOf(q){q=q.toLowerCase();
  return NODES.filter(n=>visible(n)&&(n.title.toLowerCase().includes(q)||
    (n.identifier||"").toLowerCase().includes(q)));}
const scanEl=el("scan"),contactsEl=el("contacts");
scanEl.addEventListener("input",()=>{
  const was=scanQ;scanQ=scanEl.value.trim();
  // Save the viewport once per scan SESSION (survives backspace-to-empty +
  // retype), so Esc restores the true pre-scan camera, not a mid-scan one.
  if(!was&&scanQ&&!savedView)savedView={s:view.scale,x:view.x,y:view.y};
  scanMatches=scanQ?matchesOf(scanQ):[];scanFocus=0;pingT0=performance.now();
  renderContacts();
  if(scanQ.length>=2&&scanMatches.length){
    let mnx=1e9,mny=1e9,mxx=-1e9,mxy=-1e9;
    for(const m of scanMatches){const p=P.get(m.id);
      mnx=Math.min(mnx,p.x-60);mny=Math.min(mny,p.y-60);
      mxx=Math.max(mxx,p.x+60);mxy=Math.max(mxy,p.y+60);}
    fitBox(mnx,mny,mxx,mxy,true,56);}
});
scanEl.addEventListener("keydown",e=>{
  const cap=Math.min(5,scanMatches.length-1);
  if(e.key==="ArrowDown"){e.preventDefault();scanFocus=Math.min(cap,scanFocus+1);renderContacts();}
  else if(e.key==="ArrowUp"){e.preventDefault();scanFocus=Math.max(0,scanFocus-1);renderContacts();}
  else if(e.key==="Enter"&&scanMatches.length){intercept(scanMatches[scanFocus]);}
  else if(e.key==="Escape"){endScan(true);}});
function endScan(restore){scanQ="";scanEl.value="";scanMatches=[];contactsEl.hidden=true;
  if(restore&&savedView)flyTo(savedView.s,savedView.x,savedView.y);
  savedView=null;scanEl.blur();}
function intercept(n){
  if(!visible(n))return; // a stale contact row must never lock a hidden node
  if(n.kind==="epic"){selectEpic(n);flyToCluster(n);}
  else{select(n);flyToNode(n,6);}
  endScan(false);}
// Visibility changed (deps-only toggle): contacts listing hidden nodes would
// let Enter lock a node the renderer skips — recompute against visible().
function refreshScan(){if(!scanQ)return;
  scanMatches=matchesOf(scanQ);
  scanFocus=Math.max(0,Math.min(scanFocus,Math.min(5,scanMatches.length-1)));
  renderContacts();}
function renderContacts(){
  if(!scanQ){contactsEl.hidden=true;return;}
  contactsEl.hidden=false;
  let html='<div class="ch"><span><b>'+scanMatches.length+' CONTACT'+
    (scanMatches.length===1?"":"S")+
    '</b></span><span>\\u2191\\u2193 NAVIGATE \\u00b7 \\u23ce INTERCEPT \\u00b7 ESC END SCAN</span></div>';
  const hl=new RegExp("("+reEsc(esc(scanQ))+")","ig");
  scanMatches.slice(0,6).forEach((m,i)=>{
    const t=esc(m.title).replace(hl,'<i class="hl">$1</i>');
    const glyph=m.kind==="epic"?"\\u25cb":"\\u2726";
    html+='<div class="crow'+(i===scanFocus?" focus":"")+'" data-i="'+i+'">'+
      '<span class="st" style="color:'+(m.kind==="epic"?CYAN:ACC[m.statusGroup]||ACC.unknown)+'">'+
      glyph+'</span><b>'+esc(m.identifier||"\\u00b7")+'</b>'+
      '<span class="ttl">'+t+'</span>'+
      (m.kind==="epic"?'<span class="kindtag">EPIC</span>':"")+'</div>';});
  if(scanMatches.length>6)html+='<div class="more">\\u2026AND '+(scanMatches.length-6)+
    ' MORE \\u2014 KEEP TYPING TO NARROW</div>';
  if(!scanMatches.length)html+='<div class="more">NO RETURN \\u2014 ADJUST SCAN</div>';
  contactsEl.innerHTML=html;
  contactsEl.querySelectorAll(".crow").forEach(row=>{
    row.onclick=()=>intercept(scanMatches[+row.dataset.i]);});}

// --- Sidebar ------------------------------------------------------------------
function miniRing(total,done){
  const r=13.6;let paths='<circle cx="17" cy="17" r="15.4" fill="rgba(6,12,28,.9)"/>';
  if(total<=0){paths+='<circle cx="17" cy="17" r="'+r+
    '" fill="none" stroke="rgba(120,160,255,.25)" stroke-width="2.4"/>';}
  else if(total<=12){const gapA=0.10;
    for(let i=0;i<total;i++){
      const a0=-Math.PI/2+i*(6.2832/total)+gapA,a1=-Math.PI/2+(i+1)*(6.2832/total)-gapA;
      const x0=17+r*Math.cos(a0),y0=17+r*Math.sin(a0),x1=17+r*Math.cos(a1),y1=17+r*Math.sin(a1);
      paths+='<path d="M'+x0.toFixed(2)+' '+y0.toFixed(2)+' A'+r+' '+r+' 0 0 1 '+
        x1.toFixed(2)+' '+y1.toFixed(2)+'" fill="none" stroke-linecap="round" stroke-width="2.4" stroke="'+
        (i<done?"#5eb2ff":"rgba(120,160,255,.25)")+'"/>';}}
  else{paths+='<circle cx="17" cy="17" r="'+r+
    '" fill="none" stroke="rgba(120,160,255,.25)" stroke-width="2.4"/>';
    const frac=done/total,a1=-Math.PI/2+6.2832*Math.min(0.9999,frac);
    if(frac>0){const x1=17+r*Math.cos(a1),y1=17+r*Math.sin(a1);
      paths+='<path d="M17 3.4 A'+r+' '+r+' 0 '+(frac>0.5?1:0)+' 1 '+x1.toFixed(2)+' '+y1.toFixed(2)+
        '" fill="none" stroke-linecap="round" stroke-width="2.4" stroke="#5eb2ff"/>';}}
  paths+='<text x="17" y="18" text-anchor="middle" dominant-baseline="middle" font-size="8" '+
    'font-weight="700" fill="#e9efff">'+done+"/"+total+'</text>';
  return paths;}
function fmtDays(v){return (Math.round(v*10)/10)+"";}
function depCard(kind,role,ident,text,targetId){
  return '<div class="dep '+(kind==="relates"?"relates":"blocks")+'" data-t="'+targetId+
    '"><span class="ln"></span><span class="t">'+role+'</span><b>'+esc(ident||"\\u00b7")+
    '</b><span class="dt">'+esc(text)+'</span></div>';}
function wireDeps(container){
  container.querySelectorAll(".dep").forEach(card=>{
    card.onclick=()=>{const n=byId.get(card.dataset.t);
      if(!n||!visible(n))return; // never fly the camera to a hidden target
      if(n.kind==="epic"){selectEpic(n);flyToCluster(n);}
      else{select(n);flyToNode(n,6);}};});}
function depsOf(id){const out=[];
  for(const e of DEPS){
    if(e.type==="blocks"&&e.target===id)out.push({node:byId.get(e.source),role:"Blocked by",kind:"blocks"});
    else if(e.type==="blocks"&&e.source===id)out.push({node:byId.get(e.target),role:"Blocks",kind:"blocks"});
    else if(e.type==="relates"&&(e.source===id||e.target===id))
      out.push({node:byId.get(e.source===id?e.target:e.source),role:"Relates",kind:"relates"});}
  return out;}
function select(n){
  if(n&&!visible(n))return; // no entry point may lock a node the renderer skips
  SEL=n;
  el("sbEpic").hidden=true;
  el("sbEmpty").hidden=!!n;el("sbContent").hidden=!n;
  miniDirty=true;
  if(!n)return;
  el("sbId").innerHTML=esc(n.identifier||"UNLINKED")+'<span class="kind">\\u00b7 USER STORY</span>';
  el("sbTitle").textContent=n.title;
  el("sbStatus").textContent=n.status||"\\u2014";
  const ac=ACC[n.statusGroup]||ACC.unknown;
  el("sbDot").style.background=ac;
  el("sbDot").style.boxShadow="0 0 8px "+ac;
  el("sbPill").style.background="color-mix(in srgb,"+ac+" 10%,transparent)";
  el("sbEffort").textContent=n.effortDays==null?"\\u2014":fmtDays(n.effortDays)+" dev-days";
  el("sbPrio").textContent=n.priority?n.priority.charAt(0).toUpperCase()+n.priority.slice(1):"\\u2014";
  el("sbLabels").innerHTML=n.labels.length?
    n.labels.map(l=>'<span class="lbl">'+esc(l)+'</span>').join(""):"\\u2014";
  const flagged=n.quality&&!n.quality.ok;
  el("sbFlagSec").hidden=!flagged;
  if(flagged)el("sbFlags").innerHTML=n.quality.flags.map(f=>"\\u25b2 "+esc(f)).join("<br />");
  const hubId=epicOf.get(n.id),hub=hubId?byId.get(hubId):null;
  el("sbEpicSec").hidden=!hub;
  if(hub){const pr=epicProg.get(hub.id)||{done:0,total:0};
    el("sbEpicName").textContent=hub.title;
    el("sbEpicSub").textContent=pr.done+" of "+pr.total+" stories complete";
    el("sbRing").innerHTML=miniRing(pr.total,pr.done);
    el("sbEpicCard").onclick=()=>{selectEpic(hub);flyToCluster(hub);};}
  el("sbCritSec").hidden=!n.criteria.length;
  if(n.criteria.length){
    const done=n.criteria.filter(c=>c.checked).length;
    el("sbCritH").textContent="Acceptance criteria \\u00b7 "+done+" of "+n.criteria.length;
    el("sbCrit").innerHTML=n.criteria.map(c=>
      '<li class="'+(c.checked?"done":"")+'"><span class="m"></span><span>'+esc(c.text)+
      '</span></li>').join("");}
  const dl=depsOf(n.id).filter(d=>d.node);
  el("sbDeps").innerHTML=dl.length?dl.map(d=>
    depCard(d.kind,d.role,d.node.identifier,clip(d.node.title,34),d.node.id)).join(""):
    '<div class="nodeps">NO SUPPLY LINES</div>';
  wireDeps(el("sbDeps"));
  const su=safeUrl(n.url);
  el("sbOpen").hidden=!su;if(su)el("sbOpen").href=su;}
el("sbClose").onclick=()=>select(null);
function selectEpic(h){
  if(!visible(h))return;
  SEL=h;
  el("sbEmpty").hidden=true;el("sbContent").hidden=true;el("sbEpic").hidden=false;
  miniDirty=true;
  const pr=epicProg.get(h.id)||{done:0,total:0,stories:0};
  el("seId").innerHTML=esc(h.identifier||"UNLINKED")+'<span class="kind">\\u00b7 EPIC</span>';
  el("seTitle").textContent=h.title;
  el("seRing").innerHTML=miniRing(pr.total,pr.done);
  el("seSub").textContent=pr.done+" of "+pr.total+" stories complete";
  el("seSub2").textContent=Math.round(100*pr.done/Math.max(1,pr.total))+"% COMPLETE";
  const kids=storiesOf.get(h.id)||[];
  const nb={completed:0,started:0,unstarted:0,backlog:0,cancelled:0,unknown:0};
  let tot=0,rem=0,unest=0,est=0;
  for(const st of kids){nb[st.statusGroup]=(nb[st.statusGroup]||0)+1;
    if(st.effortDays==null){unest++;continue;}
    est++;tot+=st.effortDays;
    if(st.statusGroup==="started"||st.statusGroup==="unstarted"||st.statusGroup==="backlog")
      rem+=st.effortDays;}
  el("seBar").innerHTML=kids.length?GROUPS.filter(g=>nb[g]).map(g=>
    '<i style="width:'+(100*nb[g]/kids.length)+'%;background:'+ACC[g]+'"></i>').join(""):"";
  el("seCounts").innerHTML=
    '<span style="color:#57a7e8">'+nb.completed+' DONE</span> \\u00b7 '+
    '<span style="color:#e0824f">'+nb.started+' IN PROGRESS</span> \\u00b7 '+
    '<span style="color:#b9dcf2">'+nb.unstarted+' TODO</span> \\u00b7 '+
    nb.backlog+' BACKLOG \\u00b7 <span style="color:#f87171">'+nb.cancelled+' CANCELLED</span>'+
    (nb.unknown?' \\u00b7 '+nb.unknown+' UNKNOWN':"");
  // Gate on the COUNT of estimated stories, not the sum: an epic whose only
  // estimate is 0 dev-days shows "0", never "-" (null vs zero distinction).
  el("seTot").textContent=(est?fmtDays(tot)+" dev-days":"\\u2014")+
    (unest?" (+"+unest+" unest.)":"");
  el("seRem").textContent=est?fmtDays(rem)+" dev-days":"\\u2014";
  // Boundary supply lines: dependency edges crossing the epic's subtree.
  const sub=subtreeOf.get(h.id);let dh="";
  for(const e of DEPS){const aIn=sub.has(e.source),bIn=sub.has(e.target);
    if(aIn===bIn)continue;
    const other=byId.get(aIn?e.target:e.source);if(!other)continue;
    const role=e.type==="relates"?"Relates":(aIn?"Blocks":"Blocked by");
    const oEpicId=other.kind==="epic"?other.id:epicOf.get(other.id);
    const oEpic=oEpicId?byId.get(oEpicId):null;
    dh+=depCard(e.type,role,other.identifier,clip(oEpic?oEpic.title:other.title,26),other.id);}
  el("seDeps").innerHTML=dh||'<div class="nodeps">SELF-CONTAINED \\u2014 NO BOUNDARY LINES</div>';
  wireDeps(el("seDeps"));
  const top=[...kids].sort((a,b)=>(b.effortDays==null?-1:b.effortDays)-(a.effortDays==null?-1:a.effortDays)).slice(0,5);
  el("seStories").innerHTML=top.map((st,i)=>
    '<div class="srow" data-i="'+i+'"><span class="st" style="color:'+(ACC[st.statusGroup]||ACC.unknown)+
    '">\\u25cf</span><b>'+esc(st.identifier||"\\u00b7")+'</b><span class="ttl2">'+esc(st.title)+
    '</span><span class="eff">'+(st.effortDays==null?"\\u2014":fmtDays(st.effortDays)+"d")+'</span></div>').join("")+
    (kids.length>5?'<div class="morestories">\\u2026AND '+(kids.length-5)+' MORE IN ORBIT</div>':"");
  el("seStories").querySelectorAll(".srow").forEach(row=>{
    row.onclick=()=>{const st=top[+row.dataset.i];
      if(!visible(st))return; // fly only when the select can actually take
      select(st);flyToNode(st,8);};});
  const su=safeUrl(h.url);
  el("seOpen").hidden=!su;if(su)el("seOpen").href=su;}
el("seClose").onclick=()=>select(null);

// --- Pointer: pan / drag-node / hover / click-select --------------------------
function S(id){const p=P.get(id);return{x:p.x*view.scale+view.x,y:p.y*view.scale+view.y};}
// LOD thresholds, MEASURED against the real 47x742 board (probe 2026-08-08):
// areal spacing is 76-129 world units, fitScale ~0.13-0.19, so screen spacing
// at fit sits around 14-24px — below the gas band (24..42), giving nebulae at
// fit. Far out, planets ride the 2.6px minimum radius, so their glow crowds
// once spacing drops under ~3-4 floor-diameters (~24px): that is where gas
// takes over. Small clusters (wider spacing) resolve by ~2.5x MAG, the biggest
// by ~4x.
function hubLOD(h){const g=GEO.get(h.id),sp=(g?g.spacing:80)*view.scale;
  const res=sstep(24,42,sp);return{res,neb:1-res};}
// Board-orphan stories (no parent epic) have no cluster to condense into.
// They stay planets at every zoom but ride a global-MAG fade: subdued at fit
// (0.3) so the nebula field reads calm, full presence by ~2.6x MAG. Honest:
// unfiled work drifts between the clusters instead of vanishing.
function lodRes(n){if(n.kind==="epic")return 1;
  const hid=epicOf.get(n.id);
  if(!hid)return 0.3+0.7*sstep(1.6,2.6,view.scale/fs());
  return hubLOD(byId.get(hid)).res;}
function storyR(n,hov){
  // SIZE = EFFORT: log2 scale, clipped. Unknown effort renders as the honest
  // mid-weight (never "small" — absence is not smallness).
  const wq=n.effortDays==null?5.7:
    Math.max(3.2,Math.min(8.2,4.6+1.5*Math.log2(Math.max(0.0625,n.effortDays))));
  return Math.max(2.6,Math.min(wq*2.3,wq*view.scale*1.9))*(hov?1.15:1);}
function hubR(h){return Math.max(11,Math.min(30,P.get(h.id).r*view.scale*1.9));}
function nodeAt(mx,my){
  // stories first (drawn over cluster interiors once resolved), then hubs
  let best=null,bd=1e9;
  for(const n of NODES){
    if(n.kind==="epic"||!visible(n))continue;
    if(lodRes(n)<=0.15&&SEL!==n)continue;
    const p=S(n.id),d=Math.hypot(p.x-mx,p.y-my);
    const r=Math.max(10,storyR(n,false)+4);
    if(d<r&&d<bd){bd=d;best=n;}}
  if(best)return best;
  for(const h of HUBS){if(!visible(h))continue;
    const c=S(h.id);
    if(Math.hypot(c.x-mx,c.y-my)<=hubR(h)+3)return h;}
  return null;}
let dragS=null;
stage.addEventListener("mousedown",e=>{if(e.target!==cv)return;
  const r=cv.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  const hit=nodeAt(mx,my);
  if(hit){const p=P.get(hit.id),wx=(mx-view.x)/view.scale,wy=(my-view.y)/view.scale;
    p.pin=true;
    // keep the pointer-to-centre offset so grabbing a rim doesn't jump the node
    dragS={node:hit,ox:p.x-wx,oy:p.y-wy,moved:false};}
  else dragS={pan:true,x:e.clientX,y:e.clientY,vx:view.x,vy:view.y,moved:false};
  stage.classList.add("grabbing");});
window.addEventListener("mousemove",e=>{
  if(rulerDrag||miniDrag)return;
  if(dragS){
    if(dragS.pan){const dx=e.clientX-dragS.x,dy=e.clientY-dragS.y;
      if(Math.hypot(dx,dy)>3)dragS.moved=true;
      view.x=dragS.vx+dx;view.y=dragS.vy+dy;anim=null;miniDirty=true;
      if(Math.hypot(dx,dy)>8)brgV=((Math.atan2(-dy,dx)*180/Math.PI)+450)%360;}
    else{const r=cv.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
      const wx=(mx-view.x)/view.scale,wy=(my-view.y)/view.scale,p=P.get(dragS.node.id);
      p.x=wx+dragS.ox;p.y=wy+dragS.oy;p.vx=0;p.vy=0;dragS.moved=true;reheat(0.3);}
    return;}
  const r=cv.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  if(overMini(e)||mx<0||my<0||mx>W||my>H){HOV=null;return;}
  const hit=nodeAt(mx,my);
  HOV=hit;
  stage.style.cursor=hit?"pointer":"grab";});
window.addEventListener("mouseup",e=>{
  if(!dragS)return;
  const wasNode=dragS.node,moved=dragS.moved;
  if(wasNode)P.get(wasNode.id).pin=false;
  dragS=null;stage.classList.remove("grabbing");
  if(moved)return;
  const r=cv.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  if(mx<0||my<0||mx>W||my>H)return;
  const hit=wasNode||nodeAt(mx,my);
  if(!hit){select(null);return;}
  if(hit.kind==="epic"){selectEpic(hit);flyToCluster(hit);}
  else select(hit);});
stage.addEventListener("wheel",e=>{e.preventDefault();anim=null;
  const r=cv.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  // floor never exceeds the CURRENT scale: zoom-out below fit refuses, never snaps IN
  const f=e.deltaY<0?1.13:0.885,floor=Math.min(fs(),view.scale);
  const ns=Math.min(fs()*40,Math.max(floor,view.scale*f));
  view.x=mx-(mx-view.x)*(ns/view.scale);view.y=my-(my-view.y)*(ns/view.scale);
  view.scale=ns;miniDirty=true;},{passive:false});

// --- Minimap (kept from the previous atlas, cockpit-restyled) -----------------
let miniT=null,miniDrag=false;
function lerpHex(a,b,t){
  const pa=[parseInt(a.slice(1,3),16),parseInt(a.slice(3,5),16),parseInt(a.slice(5,7),16)];
  const pb=[parseInt(b.slice(1,3),16),parseInt(b.slice(3,5),16),parseInt(b.slice(5,7),16)];
  return "rgb("+Math.round(pa[0]+(pb[0]-pa[0])*t)+","+Math.round(pa[1]+(pb[1]-pa[1])*t)+","+
    Math.round(pa[2]+(pb[2]-pa[2])*t)+")";}
const hubMiniCol=new Map();
for(const h of HUBS){const pr=epicProg.get(h.id);
  hubMiniCol.set(h.id,lerpHex("#6e8ce1","#57a7e8",pr.total?pr.done/pr.total:0));}
function drawMinimap(){
  mctx.setTransform(dpr,0,0,dpr,0,0);mctx.clearRect(0,0,mini.width,mini.height);
  const MW=mini.clientWidth,MH=mini.clientHeight,b=visBounds();
  if(!b){miniT=null;return;}
  const pad=40,mnx=b[0]-pad,mny=b[1]-pad,mxx=b[2]+pad,mxy=b[3]+pad;
  const gw=mxx-mnx,gh=mxy-mny,s=Math.min(MW/gw,MH/gh)*0.9;
  const ox=(MW-gw*s)/2-mnx*s,oy=(MH-gh*s)/2-mny*s;
  miniT={s,ox,oy};
  for(const n of NODES){if(!visible(n))continue;const p=P.get(n.id);
    mctx.beginPath();
    mctx.arc(p.x*s+ox,p.y*s+oy,n.kind==="epic"?2.6:1.2,0,6.283);
    mctx.fillStyle=n.kind==="epic"?hubMiniCol.get(n.id):(ACC[n.statusGroup]||ACC.unknown);
    mctx.globalAlpha=n.kind==="epic"?0.95:0.6;mctx.fill();}
  mctx.globalAlpha=1;
  const x0=(-view.x)/view.scale,y0=(-view.y)/view.scale,
    x1=(W-view.x)/view.scale,y1=(H-view.y)/view.scale;
  mctx.strokeStyle=CYAN;mctx.lineWidth=1.2;
  mctx.strokeRect(x0*s+ox,y0*s+oy,(x1-x0)*s,(y1-y0)*s);}
function overMini(e){const r=mini.getBoundingClientRect();
  return e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom;}
// getBoundingClientRect is the BORDER box; drawing happens in the CONTENT box,
// so subtract clientLeft/clientTop or the 1px border magnifies the offset.
function miniPan(e){if(!miniT)return;const r=mini.getBoundingClientRect();
  const wx=(e.clientX-r.left-mini.clientLeft-miniT.ox)/miniT.s,
    wy=(e.clientY-r.top-mini.clientTop-miniT.oy)/miniT.s;
  view.x=W/2-wx*view.scale;view.y=H/2-wy*view.scale;anim=null;miniDirty=true;}
mini.addEventListener("mousedown",e=>{e.stopPropagation();miniDrag=true;HOV=null;miniPan(e);});
window.addEventListener("mousemove",e=>{if(miniDrag)miniPan(e);});
window.addEventListener("mouseup",()=>{miniDrag=false;});

// --- Render core (nebula -> worlds LOD) ---------------------------------------
function sstep(a,b,v){const u=Math.min(1,Math.max(0,(v-a)/(b-a)));return u*u*(3-2*u);}
const WSPR=new Map();
function worldSprite(kind,r){
  // Half-pixel cache buckets, floored at the TRUE 2.6px screen minimum — a 5px
  // clamp here would draw far-out planets ~2x their calculated size and defeat
  // the LOD math (Codex round-1 finding).
  const key=kind+"|"+(r=Math.max(2.6,Math.round(r*2)/2));
  let s=WSPR.get(key);
  if(!s){const R=Math.ceil(r*1.7),D=R*2,c=document.createElement("canvas");
    c.width=D;c.height=D;const g=c.getContext("2d");
    // Worlds carry their STATUS HUE so identity survives every zoom level.
    const COLS={rock:["#a2a8b4","#4e535e"],mars:["#e08a5a","#6e3018"],
      earth:["#57a7e8","#123a68"],ice:["#d8ecf8","#5a7d99"],cinder:["#8a4a52","#2e181c"]};
    const pair=COLS[kind]||COLS.rock,base=pair[0],dark=pair[1];
    // soft atmospheric halo (planetary, NOT a star glow)
    const at=g.createRadialGradient(R,R,r*0.8,R,R,Math.min(R,r*1.6));
    at.addColorStop(0,"rgba(0,0,0,0)");at.addColorStop(0.45,base+"44");at.addColorStop(1,base+"00");
    g.beginPath();g.arc(R,R,Math.min(R,r*1.6),0,6.283);g.fillStyle=at;g.fill();
    const gr=g.createRadialGradient(R-r*0.42,R-r*0.46,r*0.15,R,R,r*1.12);
    gr.addColorStop(0,base);gr.addColorStop(1,dark);
    g.beginPath();g.arc(R,R,r,0,6.283);g.fillStyle=gr;g.fill();
    if(r>=7){
      if(kind==="earth"){ // blue living world: bold green landmasses + a cloud band
        g.fillStyle="rgba(62,196,118,.95)";
        g.beginPath();g.ellipse(R-r*0.26,R-r*0.12,r*0.5,r*0.3,0.5,0,6.283);g.fill();
        g.beginPath();g.ellipse(R+r*0.32,R+r*0.34,r*0.3,r*0.18,-0.4,0,6.283);g.fill();
        g.fillStyle="rgba(255,255,255,.5)";
        g.beginPath();g.ellipse(R-r*0.1,R-r*0.55,r*0.34,r*0.1,0.2,0,6.283);g.fill();}
      if(kind==="mars"){ // rust world: polar cap + dark basin
        g.fillStyle="rgba(255,255,255,.7)";
        g.beginPath();g.ellipse(R,R-r*0.76,r*0.3,r*0.12,0,0,6.283);g.fill();
        g.fillStyle="rgba(0,0,0,.18)";
        g.beginPath();g.ellipse(R+r*0.2,R+r*0.15,r*0.34,r*0.2,0.6,0,6.283);g.fill();}
      if(kind==="rock"){g.fillStyle="rgba(0,0,0,.25)";
        for(const cr of [[-0.3,-0.1,0.18],[0.25,0.3,0.14],[0.08,-0.42,0.11]]){
          g.beginPath();g.arc(R+cr[0]*r,R+cr[1]*r,cr[2]*r,0,6.283);g.fill();}}
      if(kind==="ice"){ // Europa lineae: faint crack lines across the glacier
        g.strokeStyle="rgba(80,120,150,.55)";g.lineWidth=1;
        g.beginPath();g.moveTo(R-r*0.6,R-r*0.1);g.quadraticCurveTo(R,R+r*0.15,R+r*0.55,R-r*0.2);g.stroke();
        g.beginPath();g.moveTo(R-r*0.35,R+r*0.45);g.quadraticCurveTo(R+r*0.1,R+r*0.2,R+r*0.4,R+r*0.5);g.stroke();
        g.fillStyle="rgba(255,255,255,.55)";
        g.beginPath();g.ellipse(R-r*0.3,R-r*0.45,r*0.3,r*0.13,0.4,0,6.283);g.fill();}
      if(kind==="cinder"){g.strokeStyle="rgba(255,120,90,.4)";g.lineWidth=1;
        g.beginPath();g.moveTo(R-r*0.5,R+r*0.1);g.quadraticCurveTo(R,R-r*0.2,R+r*0.45,R+r*0.3);g.stroke();}}
    g.strokeStyle="rgba(0,0,0,.35)";g.lineWidth=1;
    g.beginPath();g.arc(R,R,r,0,6.283);g.stroke();
    s={c,R};WSPR.set(key,s);}
  return s;}
function drawWorld(kind,p,r,alpha2){if(alpha2<=0.02)return;
  const s=worldSprite(kind,r);
  x.globalAlpha=alpha2;x.drawImage(s.c,p.x-s.R,p.y-s.R);x.globalAlpha=1;}
function drawNebula(h,hi,neb,t,dim){
  const c=S(h.id),g=GEO.get(h.id),R=(g?g.extent:60)*view.scale*1.15;
  if(R<9)return;
  const pr=epicProg.get(h.id),gf=pr.total?pr.done/pr.total:0;
  const kids=storiesOf.get(h.id);
  const hasStarted=kids.some(s2=>s2.statusGroup==="started");
  x.globalCompositeOperation="lighter";
  const blobs=[
    [0,0,1.0,"110,140,225",0.11],
    [Math.cos(hi*2.4)*0.3,Math.sin(hi*2.4)*0.3,0.66,"87,167,232",0.04+0.12*gf],
    [Math.cos(hi*5.1)*0.34,Math.sin(hi*5.1)*0.34,0.48,"224,130,80",hasStarted?0.05:0]];
  for(const bl of blobs){const al=bl[4];if(al<=0.005)continue;
    const rr=R*bl[2],cx2=c.x+bl[0]*R,cy2=c.y+bl[1]*R;
    const gr=x.createRadialGradient(cx2,cy2,0,cx2,cy2,rr);
    gr.addColorStop(0,"rgba("+bl[3]+","+(al*neb*dim)+")");gr.addColorStop(1,"rgba("+bl[3]+",0)");
    x.fillStyle=gr;x.beginPath();x.arc(cx2,cy2,rr,0,6.283);x.fill();}
  for(let k=0;k<3&&kids.length;k++){const s2=kids[(k*3)%kids.length];
    if(!visible(s2))continue; // deps-only must not sparkle at hidden stories
    const p=S(s2.id);
    x.globalAlpha=neb*dim*(0.25+0.3*Math.abs(Math.sin(t*0.0009+hi+k*2)));
    x.beginPath();x.arc(p.x,p.y,1.1,0,6.283);x.fillStyle="#dfe9ff";x.fill();}
  x.globalAlpha=1;x.globalCompositeOperation="source-over";}
function segRing(cx,cy,r,total,done,dim){
  if(total<=0){x.strokeStyle="rgba(120,160,255,"+(0.16*dim)+")";
    x.lineWidth=Math.max(2.6,r*0.11);
    x.beginPath();x.arc(cx,cy,r,0,6.283);x.stroke();return;}
  const gap=total>24?0.02:0.055,lw=Math.max(2.6,r*0.11);
  x.lineCap="round";
  for(let i=0;i<total;i++){
    const a0=-Math.PI/2+i*(6.2832/total)+gap,a1=-Math.PI/2+(i+1)*(6.2832/total)-gap,lit=i<done;
    if(a1<=a0)continue;
    if(lit){x.strokeStyle="rgba(94,178,255,"+(0.30*dim)+")";x.lineWidth=lw*2.1;
      x.beginPath();x.arc(cx,cy,r,a0,a1);x.stroke();}
    x.strokeStyle=lit?"rgba(94,178,255,"+dim+")":"rgba(120,160,255,"+(0.16*dim)+")";x.lineWidth=lw;
    x.beginPath();x.arc(cx,cy,r,a0,a1);x.stroke();}}
const bgstars=Array.from({length:240},()=>({x:Math.random(),y:Math.random(),
  r:Math.random()<0.86?0.7:1.3,tw:Math.random()*6.28}));
let lastMag="",lastBrg="",lastFrac=-1;
function draw(t){
  if(anim){const u=Math.min(1,(t-anim.t0)/anim.d),e=1-Math.pow(1-u,3);
    view.scale=anim.f.s+(anim.g.s-anim.f.s)*e;
    view.x=anim.f.x+(anim.g.x-anim.f.x)*e;
    view.y=anim.f.y+(anim.g.y-anim.f.y)*e;
    miniDirty=true;
    if(u>=1)anim=null;}
  x.clearRect(0,0,W,H);
  for(const s2 of bgstars){x.globalAlpha=0.28+0.36*Math.abs(Math.sin(t*0.0005+s2.tw));
    x.beginPath();x.arc(s2.x*W,s2.y*H,s2.r,0,6.283);x.fillStyle="#c8d4ff";x.fill();}
  x.globalAlpha=1;
  const SC=scanQ?new Set(scanMatches):null;
  const hubHasMatch=h=>!SC||SC.has(h)||storiesOf.get(h.id).some(s2=>SC.has(s2));
  // nebulae (never fully vanish: a whisper of cluster atmosphere stays at close zoom)
  HUBS.forEach((h,hi)=>{if(!visible(h))return;const L=hubLOD(h);
    drawNebula(h,hi,L.neb*0.85+0.15,t,hubHasMatch(h)?1:0.3);});
  x.lineCap="round";
  // spokes: hub -> its direct stories; epic -> sub-epic links drawn a touch brighter
  for(const h of HUBS){if(!visible(h))continue;const L=hubLOD(h);
    const hc=S(h.id),hd=hubHasMatch(h)?1:0.35;
    if(L.res>0.05){
      x.strokeStyle="rgba(130,155,215,"+(0.13*L.res*hd)+")";x.lineWidth=1;
      for(const s2 of storiesOf.get(h.id)){if(!visible(s2))continue;const p=S(s2.id);
        x.beginPath();x.moveTo(hc.x,hc.y);x.lineTo(p.x,p.y);x.stroke();}}
    for(const cid of (childrenOf.get(h.id)||[])){const c=byId.get(cid);
      if(!c||c.kind!=="epic"||!visible(c))continue;const p=S(c.id);
      x.strokeStyle="rgba(130,155,215,"+(0.22*hd)+")";x.lineWidth=1;
      x.beginPath();x.moveTo(hc.x,hc.y);x.lineTo(p.x,p.y);x.stroke();}}
  // supply lanes: blocks = golden dashes (+underglow), relates = purple dashes
  const laneDim=SC?0.3:1;
  for(const d of DEPS){
    const A=byId.get(d.source),B=byId.get(d.target);
    if(!visible(A)||!visible(B))continue;
    const a=S(d.source),b=S(d.target);
    const mx2=(a.x+b.x)/2,my2=(a.y+b.y)/2,dx=b.x-a.x,dy=b.y-a.y,dd=Math.hypot(dx,dy)||1;
    const bow=Math.min(40,dd*0.1),rel=d.type==="relates";
    x.setLineDash(rel?[3,8]:[9,7]);x.lineDashOffset=-t*(rel?0.02:0.03);
    if(!rel){x.strokeStyle="rgba(255,159,67,"+(0.22*laneDim)+")";x.lineWidth=4;
      x.beginPath();x.moveTo(a.x,a.y);x.quadraticCurveTo(mx2-dy/dd*bow,my2+dx/dd*bow,b.x,b.y);x.stroke();}
    x.strokeStyle=rel?"rgba(167,139,250,"+(0.55*laneDim)+")":"rgba(255,159,67,"+(0.8*laneDim)+")";
    x.lineWidth=rel?1.3:1.6;
    x.beginPath();x.moveTo(a.x,a.y);x.quadraticCurveTo(mx2-dy/dd*bow,my2+dx/dd*bow,b.x,b.y);x.stroke();}
  x.setLineDash([]);
  // selection pulsar (beam + pulses) — the ONLY theatrical act, locked target only
  const selP=SEL?S(SEL.id):null;
  if(selP){
    x.save();x.translate(selP.x,selP.y);x.rotate(t*0.00045);
    const beam=x.createRadialGradient(0,0,8,0,0,170);
    beam.addColorStop(0,"rgba(255,176,84,.20)");beam.addColorStop(1,"rgba(255,176,84,0)");
    x.globalCompositeOperation="lighter";
    x.beginPath();x.moveTo(0,0);x.arc(0,0,170,-0.10,0.10);x.closePath();
    x.fillStyle=beam;x.fill();x.restore();x.globalCompositeOperation="source-over";
    for(const ph of [0,0.5]){const p=((t*0.00042)+ph)%1,pr=10+p*110;
      x.strokeStyle="rgba(255,176,84,"+(0.30*(1-p))+")";x.lineWidth=1.2;
      x.beginPath();x.arc(selP.x,selP.y,pr,0,6.283);x.stroke();}}
  // stories: planets condensing out of the gas; scan dim + one-shot cyan pings
  const pingAge=pingT0?Math.min(1,(t-pingT0)/700):1;
  for(const n of NODES){
    if(n.kind==="epic"||!visible(n))continue;
    const isSel=SEL===n,isHov=HOV===n;
    const res=lodRes(n);
    if(res<=0.02&&!isSel)continue;
    const p=S(n.id);
    if(p.x<-30||p.y<-30||p.x>W+30||p.y>H+30)continue;
    const dimS=(SC?(SC.has(n)?1:0.22):1)*(matches(n)?1:0.18);
    const r=storyR(n,isHov&&!isSel);
    drawWorld(WKIND[n.statusGroup]||"rock",p,r,(isSel?1:res)*dimS);
    if(SC&&SC.has(n)&&pingAge<1){
      x.strokeStyle="rgba(110,231,255,"+(0.5*(1-pingAge))+")";x.lineWidth=1.2;
      x.beginPath();x.arc(p.x,p.y,r+4+pingAge*24,0,6.283);x.stroke();}
    if(n.quality&&!n.quality.ok&&res>0.5){
      x.beginPath();x.moveTo(p.x+8,p.y-11);x.lineTo(p.x+11.4,p.y-5.5);x.lineTo(p.x+4.6,p.y-5.5);
      x.closePath();x.fillStyle="rgba(255,176,84,"+(0.85*res*dimS)+")";x.fill();}
    if(isHov&&!isSel){x.strokeStyle="rgba(110,231,255,.55)";x.lineWidth=1.2;
      x.beginPath();x.arc(p.x,p.y,r+5,0,6.283);x.stroke();
      x.font="600 10px "+MONO;x.textAlign="left";x.textBaseline="middle";
      x.fillStyle="#9fb6dd";
      x.fillText((n.identifier||"\\u00b7")+" \\u00b7 "+clip(n.title,34),p.x+r+8,p.y+1);}
    if(isSel){
      x.setLineDash([6,5]);x.lineDashOffset=-t*0.035;
      x.strokeStyle=AMBER;x.lineWidth=1.7;
      x.beginPath();x.arc(p.x,p.y,Math.max(13,r+6),0,6.283);x.stroke();
      x.setLineDash([]);x.globalAlpha=0.28;
      x.beginPath();x.arc(p.x,p.y,Math.max(18,r+11),0,6.283);x.lineWidth=1;x.stroke();x.globalAlpha=1;
      x.font="600 10px "+MONO;x.textAlign="left";x.textBaseline="middle";
      x.fillStyle="#ffe9c9";x.fillText(n.identifier||n.title,p.x+Math.max(18,r+11)+5,p.y+1);}}
  // hubs (void core + segmented ring + count) with greedy label declutter
  const placedRects=[];
  const order=[...HUBS].filter(h=>visible(h)).sort((a,b)=>
    (epicProg.get(b.id).stories)-(epicProg.get(a.id).stories));
  for(const h of order){const c=S(h.id);
    if(c.x<-80||c.y<-80||c.x>W+80||c.y>H+80)continue;
    const hd=(hubHasMatch(h)?1:0.35)*(matches(h)?1:0.5);
    const er=hubR(h),pr=epicProg.get(h.id);
    const vg=x.createRadialGradient(c.x,c.y,0,c.x,c.y,er);
    vg.addColorStop(0,"rgba(9,18,40,"+(0.96*hd)+")");vg.addColorStop(1,"rgba(3,7,18,"+(0.96*hd)+")");
    x.beginPath();x.arc(c.x,c.y,er,0,6.283);x.fillStyle=vg;x.fill();
    segRing(c.x,c.y,er*0.88,pr.total,pr.done,hd);
    if(HOV===h&&SEL!==h){x.strokeStyle="rgba(110,231,255,.55)";x.lineWidth=1.2;
      x.beginPath();x.arc(c.x,c.y,er+3,0,6.283);x.stroke();}
    if(SC&&SC.has(h)&&pingAge<1){ // epic contacts get the locator ping too
      x.strokeStyle="rgba(110,231,255,"+(0.5*(1-pingAge))+")";x.lineWidth=1.2;
      x.beginPath();x.arc(c.x,c.y,er+4+pingAge*24,0,6.283);x.stroke();}
    x.font="700 "+Math.max(9,er*0.42)+"px "+MONO;
    x.textAlign="center";x.textBaseline="middle";
    x.globalAlpha=hd;
    x.shadowColor=CYAN;x.shadowBlur=8;x.fillStyle="#eef4ff";
    x.fillText(String(pr.stories),c.x,c.y+1);x.shadowBlur=0;
    const txt=clip(h.title,30).toUpperCase();
    x.font="650 10px "+MONO;
    const tw2=x.measureText(txt).width,lx=c.x-tw2/2,ly=c.y+er+8;
    const win=SEL===h||HOV===h;
    let collide=false;
    if(!win)for(const rr of placedRects){
      if(lx<rr.x+rr.w&&lx+tw2>rr.x&&ly<rr.y+rr.h&&ly+14>rr.y){collide=true;break;}}
    if(!collide){placedRects.push({x:lx-4,y:ly,w:tw2+8,h:14});
      x.fillStyle="#b9cae8";x.shadowColor="rgba(3,5,14,.9)";x.shadowBlur=5;
      x.fillText(txt,c.x,ly+7);x.shadowBlur=0;}
    x.globalAlpha=1;}
  if(SEL&&SEL.kind==="epic"&&visible(SEL)){const c=S(SEL.id);
    const er=hubR(SEL);
    x.setLineDash([6,5]);x.lineDashOffset=-t*0.035;
    x.strokeStyle=AMBER;x.lineWidth=1.8;
    x.beginPath();x.arc(c.x,c.y,er+7,0,6.283);x.stroke();
    x.setLineDash([]);x.globalAlpha=0.28;
    x.beginPath();x.arc(c.x,c.y,er+12,0,6.283);x.lineWidth=1;x.stroke();x.globalAlpha=1;
    x.font="600 10px "+MONO;x.textAlign="left";x.textBaseline="middle";
    x.fillStyle="#ffe9c9";x.fillText(SEL.identifier||SEL.title,c.x+er+17,c.y+1);}
  // live instruments (writes guarded — same-value DOM churn is wasted work)
  const mag=(view.scale/fs()).toFixed(2)+"\\u00d7";
  if(mag!==lastMag){lastMag=mag;el("mag").textContent=mag;}
  const brg=String(Math.round(brgV)).padStart(3,"0")+"\\u00b0";
  if(brg!==lastBrg){lastBrg=brg;el("brg").textContent=brg;}
  const frac=Math.min(1,Math.max(0,Math.log(view.scale/fs())/Math.log(40)));
  if(Math.abs(frac-lastFrac)>0.002){lastFrac=frac;
    el("caret").style.left=(3+frac*94)+"%";}
  // minimap: redraw only when dirty, at most ~4x/s (it is a nav aid, not a scene)
  if(miniDirty&&t-lastMiniAt>250){miniDirty=false;lastMiniAt=t;drawMinimap();}
  el("empty").hidden=!NODES.some(n=>visible(n))?false:
    NODES.some(n=>visible(n)&&matches(n));
}

// --- Chips (wired filters) ----------------------------------------------------
function buildChips(){
  const box=el("chips");box.replaceChildren();
  const chip=(html,active,fn)=>{const b=document.createElement("span");
    b.className="chip"+(active?" on":"");b.innerHTML=html;b.onclick=fn;box.appendChild(b);};
  if(DEPS.length)chip('<span class="st" style="color:#ff9f43">\\u25c6</span>Supply lines',
    state.depsOnly,()=>{toggleDeps();});
  const present=new Set(NODES.map(n=>n.statusGroup));
  for(const g of GROUPS){if(!present.has(g))continue;
    const label=g==="unstarted"?"todo":g;
    chip('<span class="st" style="color:'+ACC[g]+'">\\u2726</span>'+label,
      state.statusOn.has(g),()=>{tog(state.statusOn,g);buildChips();});}
  for(const l of GRAPH.labels)chip(esc(l),state.labelOn.has(l),
    ()=>{tog(state.labelOn,l);buildChips();});
  if(GRAPH.counts.flagged)chip('<span class="st" style="color:#ffb054">\\u25b2</span>'+
    GRAPH.counts.flagged+" flagged",state.flaggedOnly,
    ()=>{state.flaggedOnly=!state.flaggedOnly;buildChips();});
  miniDirty=true;}
function tog(set,v){if(set.has(v))set.delete(v);else set.add(v);}
function toggleDeps(){state.depsOnly=!state.depsOnly;
  if(SEL&&!visible(SEL)){select(null);}
  refreshScan();
  fitAll(true);fitScale=fitScaleFor();buildChips();}

// --- Keyboard -----------------------------------------------------------------
window.addEventListener("keydown",e=>{
  if(e.metaKey||e.ctrlKey||e.altKey)return; // never shadow browser shortcuts
  const k=e.key.toLowerCase();
  const typing=e.target&&/^(input|select|textarea)$/i.test(e.target.tagName);
  if(k==="escape"){
    if(e.target===scanEl)return; // the scan field's own handler ends the scan
    if(typing){e.target.blur();return;}
    if(scanQ){endScan(true);return;}
    if(SEL)select(null);
    return;}
  if(typing)return;
  if(k==="f")fitAll(true);
  else if(k==="r")reheat(0.9);
  else if(k==="d"&&DEPS.length)toggleDeps();
  else if(k==="/"){e.preventDefault();scanEl.focus();}
});

// --- PNG export (capped so a 4K@2x viewport cannot freeze toDataURL) ----------
el("pngBtn").onclick=()=>{
  const CAP=8000000,cw=cv.clientWidth,ch=cv.clientHeight;
  let scale=2;if(cw*ch*scale*scale>CAP)scale=Math.max(1,Math.sqrt(CAP/(cw*ch)));
  const w=Math.max(1,Math.round(cw*scale)),h=Math.max(1,Math.round(ch*scale));
  try{
    const out=document.createElement("canvas");out.width=w;out.height=h;
    const o=out.getContext("2d");if(!o)throw new Error("no 2d context");
    o.fillStyle="#050814";o.fillRect(0,0,w,h);
    o.drawImage(cv,0,0,w,h);
    const url=out.toDataURL("image/png");
    const a=document.createElement("a");
    a.href=url;a.download=(GRAPH.project||"atlas").replace(/[^a-z0-9]+/gi,"-").toLowerCase()+"-atlas.png";
    document.body.appendChild(a);a.click();a.remove();
  }catch(err){alert("PNG export failed (view too large) - try a smaller window.\\n"+err);}
};

// --- Header content -----------------------------------------------------------
el("projectName").textContent=GRAPH.project;
el("projectSub").textContent=GRAPH.source==="board"?"LIVE PLANE BOARD":"MARKDOWN FILE";
el("gEpics").textContent=String(GRAPH.counts.epics);
el("gStories").textContent=String(GRAPH.counts.stories);
el("gEdges").textContent=String(GRAPH.counts.edges||0);
el("gFlag").textContent=String(GRAPH.counts.flagged||0);

// --- Run: settle silently, then continuous gentle loop ------------------------
window.addEventListener("resize",resize);
if(window.ResizeObserver)new ResizeObserver(()=>resize()).observe(stage);
let raf=null,fitted=false,geoTicks=0;
function frame(t){
  raf=null;
  const hot=alpha>AMIN;
  if(hot){tick();miniDirty=true;
    if(++geoTicks%20===0)computeGeo();}
  else if(!fitted){fitted=true;computeGeo();fitAll(false);}
  else if(geoTicks){geoTicks=0;computeGeo();} // sim just cooled: refresh geometry once
  el("settling").hidden=!hot;
  draw(t);
  if(!document.hidden)raf=requestAnimationFrame(frame);
}
function reheat(a){alpha=Math.max(alpha,a||0.7);}
document.addEventListener("visibilitychange",()=>{
  if(!document.hidden&&raf===null)raf=requestAnimationFrame(frame);});
resize();buildChips();el("settling").hidden=false;select(null);
raf=requestAnimationFrame(frame);
`;
