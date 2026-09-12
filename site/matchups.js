/* Shared game cards and evidence views. No ledger writes. */
(function(root){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=(v,n=1)=>v==null||!Number.isFinite(Number(v))?'—':Number(v).toFixed(n);
  const pct=v=>v==null?'—':`${num(v*100,1)}%`;
  const signed=v=>v==null?'—':`${Number(v)>0?'+':''}${num(v,1)}`;
  const price=v=>v==null?'—':`${Number(v)>0?'+':''}${num(v,0)}`;
  const time=v=>!v||!Number.isFinite(Date.parse(v))?'Time unavailable':new Date(v).toLocaleString('en-US',{timeZone:'America/Toronto',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET';
  const date=v=>!v||!Number.isFinite(Date.parse(v))?'Date unconfirmed':new Date(v).toLocaleDateString('en-US',{timeZone:'America/Toronto',weekday:'long',month:'short',day:'numeric'});
  function expired(row, now=Date.now()){
    const start=Date.parse(row.game_date||row.date), observed=Date.parse(row.odds_observed_at||row.odds?.observed_at);
    if(!Number.isFinite(start)||start<=now)return 'Game has started — pregame price is closed';
    if(!Number.isFinite(observed)||observed>now||now-observed>3*3600000)return 'Price needs a fresh check';
    return '';
  }
  function gateBoard(rows,now=Date.now()){
    return rows.map(row=>{const reason=expired(row,now);return reason?{...row,tier:'PASS',filtered:reason}:row;});
  }
  function filterGames(rows,filters={},now=Date.now()){
    return rows.filter(r=>{
      if(filters.status==='upcoming'&&(r.completed||r.canceled||r.postponed||Date.parse(r.date)<=now))return false;
      if(filters.priced&&!r.has_odds)return false;
      if(filters.fbs&&(r.away_fcs||r.home_fcs))return false;
      if(filters.conference&&filters.conference!=='ALL'&&![r.away_conference,r.home_conference].includes(filters.conference))return false;
      return !filters.search||`${r.away_name} ${r.home_name} ${r.away} ${r.home}`.toLowerCase().includes(filters.search.toLowerCase());
    });
  }
  function context(info){
    const c=info||{},w=c.weather||{},f=w.forecast,a=c.availability||{},reports=a.reports||{};
    let weather=w.status==='indoor'?'Indoor venue':w.status==='available'&&f
      ?`${num(f.temp_c,0)}°C · wind ${num(f.wind_mph,0)} mph · gusts ${num(f.gust_mph,0)} · rain ${f.rain_probability==null?'—':num(f.rain_probability,0)+'%'}`
      :'Kickoff forecast unavailable';
    const injuryRows=Object.entries(reports).flatMap(([side,rs])=>(rs||[]).map(r=>`<li>${esc(side)} · ${esc(r.name)} ${esc(r.position||'')} · <b>${esc(r.status)}</b><small>${esc(time(r.reported_at))} · ${esc(r.detail)}</small></li>`));
    return `<div class="game-context"><div><span class="context-label">Weather</span><p>${esc(weather)}</p>${w.status==='available'?`<small>${esc(w.location)} · city forecast · checked ${esc(time(w.checked_at))} · <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a></small>`:''}</div><div><span class="context-label">Player availability</span>${injuryRows.length?`<ul>${injuryRows.join('')}</ul><small>Partial report; QB listing does not establish starter status.</small>`:'<p>Current availability unconfirmed</p><small>No report does not mean everyone is available.</small>'}</div>${(c.review_flags||[]).length?`<p class="context-flag">${esc(c.review_flags.join(' · '))}</p>`:''}</div>`;
  }
  function explanation(b,cfg={}){
    const p=b.projection||{},threshold=cfg.tiers?.lean??.025;
    const reason=b.filtered||b.warning||(b.tier==='PASS'?`Adjusted edge ${pct(b.action_edge)} is below the ${pct(threshold)} LEAN threshold.`:`${b.tier} · adjusted edge clears the qualification threshold.`);
    return `<details class="pick-explanation"><summary>Why ${b.tier==='PASS'?'this is held':'this qualifies'} · price & model</summary><p>${esc(reason)}</p><dl class="quote-grid"><div><dt>Model home spread</dt><dd>${signed(p.mu==null?null:-p.mu)}</dd></div><div><dt>Model total</dt><dd>${num(p.proj_total)}</dd></div><div><dt>Sportsbook</dt><dd>${esc(b.book||'Unconfirmed')}</dd></div><div><dt>Offered price</dt><dd>${esc(b.pick)} ${price(b.price)}</dd></div><div><dt>Adjusted expected return</dt><dd>${pct(b.action_edge)}</dd></div><div><dt>Data confidence</dt><dd>${pct(b.confidence)}</dd></div></dl><p class="context-meta">Price observed ${esc(time(b.odds_observed_at))} · ${esc(b.odds_source||'Source unconfirmed')}. Confidence describes the available data, not the chance this bet wins.</p><details><summary>Projection calculation</summary><p>Raw home margin ${signed(p.mu_raw)} / total ${num(p.proj_total_raw)}. Market-adjusted home margin ${signed(p.mu)} / total ${num(p.proj_total)}. Break-even ${pct(b.breakeven)}; model chance ${pct(b.model_prob)}. Adjusted return includes the selection and uncertainty reserves.</p></details>${context(b.context)}</details>`;
  }
  function cards(rows,gameMap,board,cfg={}){
    const groups=new Map();
    for(const r of rows){const key=date(r.date);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
    return [...groups].map(([label,rs])=>`<section class="schedule-day"><h3>${esc(label)} <span>${rs.length} games</span></h3><div class="matchup-grid">${rs.map(r=>{
      const g=gameMap.get(String(r.game_id))||{},p=g.projection||{},o=g.odds||{};
      const candidates=board.filter(b=>String(b.game_id)===String(r.game_id)).sort((a,b)=>(a.tier==='PASS')-(b.tier==='PASS')||(b.action_edge??b.edge)-(a.action_edge??a.edge));
      const best=candidates[0],status=r.completed?`${r.away_score}–${r.home_score} Final`:r.canceled?'Canceled':r.postponed?'Postponed':r.status||'Scheduled';
      return `<article class="matchup-card"><div class="matchup-top"><span>${esc(time(r.date))}</span><span>${esc(status)}</span></div><h4>${esc(r.away)} <span>at</span> ${esc(r.home)}</h4><p class="matchup-names">${esc(r.away_name)} at ${esc(r.home_name)}</p><p class="context-meta">${esc([r.away_conference,r.home_conference].filter((x,i,a)=>x&&a.indexOf(x)===i).join(' / ')||'Conference unconfirmed')}${r.away_fcs||r.home_fcs?' · Includes FCS opponent':''}${g.venue?' · '+esc(g.venue):''}</p><dl class="quote-grid"><div><dt>Home spread</dt><dd>${signed(r.spread_home)}</dd></div><div><dt>Total</dt><dd>${num(r.total)}</dd></div><div><dt>Away / home ML</dt><dd>${price(r.ml_away)} / ${price(r.ml_home)}</dd></div></dl><p class="context-meta">${esc(o.book||r.book||'No posted price')}${o.observed_at?' · observed '+esc(time(o.observed_at)):''}${(g.odds_quotes||[]).length>1?' · '+g.odds_quotes.length+' books checked':''}</p>${best?`<div class="game-angle"><b>${esc(best.pick)} ${price(best.price)}</b><span>${esc(best.tier==='PASS'?'Held':best.tier)} · ${pct(best.action_edge)} adjusted</span></div>${explanation(best,cfg)}`:`<p class="game-angle">${r.completed?'Final score recorded':p.mu!=null?`Model home spread ${signed(-p.mu)} · total ${num(p.proj_total)}`:'Projection becomes available closer to kickoff'}</p><details class="pick-explanation"><summary>Game conditions</summary>${context(g.context)}</details>`}</article>`;
    }).join('')}</div></section>`).join('')||'<div class="empty">No games match these filters.</div>';
  }
  function validation(data){
    const v=data?.validation||{},g=data?.games||{},season=data?.scope?.season||'',interval=g.winner?.interval95;
    return `<div class="validation-panel"><h3>${esc(season)} forecast validation</h3><p><b>${g.graded||0} graded games · ${esc(v.status||'collecting evidence')}</b>. Only forecasts saved before kickoff count.</p><div class="evidence-grid"><div><span>Winner record</span><b>${g.winner?.correct||0}–${(g.winner?.n||0)-(g.winner?.correct||0)}</b><small>${interval?'95% interval '+pct(interval[0])+'–'+pct(interval[1]):'Waiting for outcomes'}</small></div><div><span>Probability error (Brier)</span><b>${num(v.brier,3)}</b><small>Lower is better · ${v.n||0} home-win forecasts</small></div><div><span>Margin error · model / market</span><b>${num(g.margin_comparison?.model_mae)} / ${num(g.margin_comparison?.market_mae)}</b><small>${g.margin_comparison?.n||0} matched games</small></div><div><span>Total error · model / market</span><b>${num(g.total_comparison?.model_mae)} / ${num(g.total_comparison?.market_mae)}</b><small>${g.total_comparison?.n||0} matched games</small></div></div><p>Market agreement measures scale consistency. Predictive accuracy comes from settled forecasts; a small winning sample does not establish a betting edge.</p><details><summary>Home-win probability calibration</summary><div class="calibration-list">${(v.calibration||[]).map(r=>`<div><b>${esc(r.bucket)}</b><span>${r.n} games</span><span>Predicted ${pct(r.predicted)} · actual ${pct(r.actual)}</span><small>95% interval ${pct(r.interval95?.[0])}–${pct(r.interval95?.[1])}</small></div>`).join('')||'<p>Waiting for graded forecasts.</p>'}</div></details></div>`;
  }
  function audit(meta){
    const a=meta.fpi_audit||{},q=meta.quote_coverage||{},c=meta.context_health||{};
    return `<div class="validation-panel"><h3>FPI comparison · ${esc(a.status||'pending')}</h3><p>${esc(a.method||'Waiting for the first paired forecasts.')}</p><div class="evidence-grid"><div><span>Paired forecasts</span><b>${a.graded||0} graded / ${a.paired_games||0}</b><small>Baseline captured ${esc(time(a.anchor_captured_at))}</small></div><div><span>Margin MAE · current / fixed</span><b>${num(a.live?.margin_mae)} / ${num(a.frozen?.margin_mae)}</b><small>Lower error is better; same games</small></div><div><span>Total MAE · current / fixed</span><b>${num(a.live?.total_mae)} / ${num(a.frozen?.total_mae)}</b><small>Production weights change only after review</small></div></div><h3>Data coverage</h3><p>${esc((q.books||[]).join(', ')||'No verified providers')} · ${q.games_multiple_books||0} games with multiple books · ${c.weather_available||0} kickoff forecasts. Availability: ${esc(c.availability?.status||'unavailable')}; ${c.availability?.rejected_reports||0} old or undated reports excluded.</p><p>Prices older than 3 hours and games that have started cannot qualify. Weather and availability flags can reduce a play to LEAN at half size; no unvalidated point adjustment is added.</p></div>`;
  }
  const api={esc,expired,gateBoard,filterGames,cards,context,explanation,validation,audit};
  root.NCAAFViews=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
