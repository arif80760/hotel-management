"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, Filler, Tooltip, Legend } from "chart.js";
import ChartDataLabels from "chartjs-plugin-datalabels";
import { Line, Bar } from "react-chartjs-2";
import { getTransactions } from "@/services/accountsService";
import { getExpenses } from "@/services/expensesService";
import { useReferenceData } from "@/contexts/ReferenceDataContext";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Filler, Tooltip, Legend, ChartDataLabels);

const C = { green:"#4F8B36", red:"#C5302A", orange:"#E89A3C", ink:"#3F3F3F", mut:"#8A8A8A", hair:"#EAEAEA", track:"#F2EADD" };
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

type Preset = "this_month" | "last_month" | "this_year" | "all" | "custom";
const PRESETS: { value: Preset; label: string }[] = [
  { value:"this_month", label:"This month" }, { value:"last_month", label:"Last month" },
  { value:"this_year", label:"This year" }, { value:"all", label:"All time" }, { value:"custom", label:"Custom" },
];
function pad(n:number){ return String(n).padStart(2,"0"); }
function isoDate(y:number,m:number,d:number){ return `${y}-${pad(m)}-${pad(d)}`; }
function todayISO(){ const d=new Date(); return isoDate(d.getFullYear(),d.getMonth()+1,d.getDate()); }
function firstOfMonthISO(){ const d=new Date(); return isoDate(d.getFullYear(),d.getMonth()+1,1); }
function presetRange(p:Preset,cf:string,ct:string):{from:string;to:string}{
  const now=new Date(); const y=now.getFullYear(); const m=now.getMonth();
  switch(p){
    case "this_month": return { from:isoDate(y,m+1,1), to:todayISO() };
    case "last_month": { const ly=m===0?y-1:y; const lm=m===0?12:m; const ld=new Date(ly,lm,0).getDate(); return { from:isoDate(ly,lm,1), to:isoDate(ly,lm,ld) }; }
    case "this_year": return { from:isoDate(y,1,1), to:todayISO() };
    case "all": return { from:"", to:"" };
    case "custom": return { from:cf, to:ct };
  }
}
const taka = (n:number)=>`৳${Math.round(Math.abs(n)).toLocaleString()}`;
const k = (v:number)=> (v ? `৳${Math.round(v/1000)}k` : "");

export default function ProfitLossClient({ oswaldFamily, archivoFamily }:{ oswaldFamily:string; archivoFamily:string }){
  const { expenseCategories } = useReferenceData();
  const [preset,setPreset]=useState<Preset>("this_month");
  const [cFrom,setCFrom]=useState(firstOfMonthISO());
  const [cTo,setCTo]=useState(todayISO());
  const [error,setError]=useState<string|null>(null);
  const [P,setP]=useState({ revenue:0, refunds:0, operating:0, remuneration:0, opByCat:[] as {name:string;total:number}[] });
  const [Y,setY]=useState({ rev:Array(12).fill(0) as number[], op:Array(12).fill(0) as number[], ebt:Array(12).fill(0) as number[], avg:0, ready:false });

  useEffect(()=>{ let cancelled=false; (async()=>{
    setError(null);
    try{
      const { from,to }=presetRange(preset,cFrom,cTo);
      const f:{fromDate?:string;toDate?:string}={}; if(from)f.fromDate=from; if(to)f.toDate=to;
      const [txns,expenses]=await Promise.all([getTransactions(f),getExpenses(f)]);
      if(cancelled)return;
      const kindById=new Map(expenseCategories.map(c=>[c.id,c.kind])); const nameById=new Map(expenseCategories.map(c=>[c.id,c.name]));
      const revenue=txns.filter(t=>t.type==="revenue_in").reduce((s,t)=>s+t.amount,0);
      const refunds=txns.filter(t=>t.type==="expense_out"&&t.bookingPaymentId!==null).reduce((s,t)=>s+t.amount,0);
      let operating=0, remuneration=0; const cm=new Map<string,number>();
      for(const e of expenses){ const kind=kindById.get(e.categoryId)??"operating";
        if(kind==="remuneration") remuneration+=e.amount;
        else { operating+=e.amount; const nm=nameById.get(e.categoryId)??"Uncategorized"; cm.set(nm,(cm.get(nm)??0)+e.amount); } }
      const opByCat=[...cm.entries()].map(([name,total])=>({name,total})).sort((a,b)=>b.total-a.total);
      setP({ revenue, refunds, operating, remuneration, opByCat });
    }catch(err){ if(!cancelled) setError((err as Error).message||"Failed to load."); }
  })(); return ()=>{ cancelled=true; }; },[preset,cFrom,cTo,expenseCategories]);

  useEffect(()=>{ let cancelled=false; (async()=>{
    try{
      const y=new Date().getFullYear();
      const f={ fromDate:`${y}-01-01`, toDate:todayISO() };
      const [txns,expenses]=await Promise.all([getTransactions(f),getExpenses(f)]);
      if(cancelled)return;
      const kindById=new Map(expenseCategories.map(c=>[c.id,c.kind]));
      const rev=Array(12).fill(0), op=Array(12).fill(0), refund=Array(12).fill(0);
      for(const t of txns){ const mi=parseInt(String(t.txnDate).slice(5,7),10)-1; if(mi<0||mi>11)continue;
        if(t.type==="revenue_in") rev[mi]+=t.amount;
        else if(t.type==="expense_out"&&t.bookingPaymentId!==null) refund[mi]+=t.amount; }
      for(const e of expenses){ const mi=parseInt(String(e.txnDate).slice(5,7),10)-1; if(mi<0||mi>11)continue;
        if((kindById.get(e.categoryId)??"operating")!=="remuneration") op[mi]+=e.amount; }
      const ebt=rev.map((r,i)=>r-refund[i]-op[i]);
      const active=rev.filter(v=>v>0).length;
      const avg=active?rev.reduce((s,v)=>s+v,0)/active:0;
      setY({ rev, op, ebt, avg, ready:true });
    }catch{ if(!cancelled) setY(s=>({...s,ready:true})); }
  })(); return ()=>{ cancelled=true; }; },[expenseCategories]);

  const { revenue,refunds,operating,remuneration,opByCat }=P;
  const netRevenue=revenue-refunds; const netProfit=netRevenue-operating; const retained=netProfit-remuneration;
  const margin=netRevenue>0?(netProfit/netRevenue*100):0;
  const retPct=revenue>0?(retained/revenue*100):0;

  const lineData:any={ labels:MONTHS, datasets:[
    { label:"Revenue", data:Y.rev, borderColor:C.orange, backgroundColor:"rgba(232,154,60,.14)", borderWidth:2.4, pointBackgroundColor:C.orange, pointRadius:3, tension:.4, fill:true,
      datalabels:{ align:"top", color:C.orange, font:{family:oswaldFamily,size:9}, formatter:k } },
    { label:"Expenses", data:Y.op, borderColor:C.ink, borderWidth:2, pointBackgroundColor:C.ink, pointRadius:2.5, tension:.4, fill:false,
      datalabels:{ align:"bottom", color:C.ink, font:{family:oswaldFamily,size:9}, formatter:k } } ] };
  const lineOpts:any={ responsive:true, maintainAspectRatio:false, layout:{padding:{top:14}},
    plugins:{ legend:{display:true,position:"top",labels:{font:{family:archivoFamily,size:11},usePointStyle:true,boxWidth:7,color:C.ink}}, tooltip:{enabled:false} },
    scales:{ x:{grid:{display:false},ticks:{font:{family:archivoFamily,size:10},color:C.mut}}, y:{display:false,beginAtZero:true,grace:"18%"} } };
  const barData:any={ labels:MONTHS, datasets:[{ data:Y.ebt, backgroundColor:C.orange, borderRadius:2,
    datalabels:{ anchor:"end", align:"top", color:C.ink, font:{family:oswaldFamily,size:9}, formatter:k } }] };
  const barOpts:any={ responsive:true, maintainAspectRatio:false, layout:{padding:{top:14}},
    plugins:{ legend:{display:false}, tooltip:{enabled:false} },
    scales:{ x:{grid:{display:false},ticks:{font:{family:archivoFamily,size:9.5},color:C.mut}}, y:{display:false,beginAtZero:true,grace:"16%"} } };
  const sparkData:any={ labels:Y.op.map((_,i)=>i), datasets:[{ data:Y.op, borderColor:C.red, borderWidth:1.6, pointRadius:0, tension:.35, fill:false, datalabels:{display:false} }] };
  const sparkOpts:any={ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},tooltip:{enabled:false},datalabels:{display:false}}, scales:{x:{display:false},y:{display:false}} };

  const osw=(extra:CSSProperties={}):CSSProperties=>({ fontFamily:oswaldFamily, ...extra });
  const card:CSSProperties={ border:`1px solid ${C.hair}`, borderRadius:8, padding:"16px 18px", background:"#fff" };
  const panel:CSSProperties=card;
  const lbl:CSSProperties={ fontSize:11, fontWeight:600, letterSpacing:".11em", textTransform:"uppercase", color:C.mut };
  const ptitle:CSSProperties={ fontSize:11, fontWeight:600, letterSpacing:".12em", textTransform:"uppercase", textAlign:"center", marginBottom:10, color:C.ink };
  const bigNum=(color:string):CSSProperties=>osw({ fontSize:36, fontWeight:600, lineHeight:1.05, marginTop:8, letterSpacing:".5px", color });

  return (
    <div style={{ fontFamily:archivoFamily, maxWidth:1040, margin:"0 auto", padding:"22px 8px 30px", color:C.ink }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, gap:12, flexWrap:"wrap" }}>
        <div style={osw({ fontSize:26, fontWeight:600, letterSpacing:".05em" })}>
          <span style={{color:C.green}}>PROFIT</span> AND <span style={{color:C.red}}>LOSS</span> DASHBOARD
        </div>
        <select value={preset} onChange={e=>setPreset(e.target.value as Preset)}
          style={{ fontFamily:archivoFamily, fontSize:12, fontWeight:600, letterSpacing:".03em", color:C.ink, border:`1.5px solid ${C.ink}`, borderRadius:8, padding:"8px 14px", background:"#fff" }}>
          {PRESETS.map(p=><option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>

      {preset==="custom" && (
        <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:14 }}>
          <input type="date" value={cFrom} max={cTo||todayISO()} onChange={e=>setCFrom(e.target.value)} style={{fontFamily:archivoFamily,fontSize:12,border:`1px solid ${C.hair}`,borderRadius:6,padding:"6px 10px"}}/>
          <span style={{fontSize:12,color:C.mut}}>to</span>
          <input type="date" value={cTo} min={cFrom} max={todayISO()} onChange={e=>setCTo(e.target.value)} style={{fontFamily:archivoFamily,fontSize:12,border:`1px solid ${C.hair}`,borderRadius:6,padding:"6px 10px"}}/>
        </div>
      )}

      {error ? (
        <div style={{ border:`1px solid ${C.red}`, color:C.red, borderRadius:8, padding:"12px 16px", fontSize:13 }}>Couldn’t load: {error}</div>
      ) : (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:16, marginBottom:18 }}>
            <div style={card}>
              <div style={lbl}>Total revenue</div>
              <div style={bigNum(C.green)}>{taka(revenue)}</div>
              <div style={{fontSize:11.5,marginTop:8,color:C.mut}}><span style={{color:C.green}}>▲</span> gross revenue · period</div>
            </div>
            <div style={card}>
              <div style={lbl}>Total expenses</div>
              <div style={bigNum(C.red)}>{taka(operating)}</div>
              <div style={{height:34,marginTop:6}}>{Y.ready && <Line data={sparkData} options={sparkOpts}/>}</div>
            </div>
            <div style={card}>
              <div style={lbl}>Net profit</div>
              <div style={bigNum(netProfit>=0?C.green:C.red)}>{netProfit<0?"-":""}{taka(netProfit)}</div>
              <div style={{fontSize:11.5,marginTop:8,color:C.mut}}><span style={{color:C.green}}>▲</span> <b style={{color:C.green,fontWeight:600}}>{margin.toFixed(1)}%</b> margin</div>
            </div>
            <div style={card}>
              <div style={lbl}>Retained profit</div>
              <div style={bigNum(C.ink)}>{retained<0?"-":""}{taka(retained)}</div>
              <div style={{height:9,background:C.track,borderRadius:5,marginTop:12,overflow:"hidden"}}><div style={{height:"100%",width:`${Math.max(0,Math.min(100,retPct))}%`,background:C.orange,borderRadius:5}}/></div>
              <div style={osw({display:"flex",justifyContent:"space-between",fontSize:10.5,color:C.mut,marginTop:5})}><span>{retPct.toFixed(1)}% of revenue</span><span>{taka(revenue)}</span></div>
            </div>
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr", gap:16, marginBottom:18 }}>
            <div style={panel}>
              <div style={ptitle}>Monthly revenue vs expenses</div>
              <div style={{position:"relative",height:230}}>{Y.ready && <Line data={lineData} options={lineOpts}/>}</div>
            </div>
            <div style={panel}>
              <div style={ptitle}>Operating expenses · period</div>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <tbody>
                  {opByCat.length===0 && <tr><td style={{fontSize:13,color:C.mut,padding:"11px 2px"}}>No operating expenses</td></tr>}
                  {opByCat.map(c=>(
                    <tr key={c.name}>
                      <td style={{fontSize:13.5,padding:"11px 2px",borderBottom:`1px solid ${C.hair}`}}>{c.name}</td>
                      <td style={osw({fontSize:13.5,padding:"11px 2px",borderBottom:`1px solid ${C.hair}`,textAlign:"right",fontWeight:500})}>{taka(c.total)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{fontSize:13.5,fontWeight:700,borderTop:`1.5px solid ${C.ink}`,paddingTop:11}}>Total operating</td>
                    <td style={osw({fontSize:13.5,fontWeight:600,borderTop:`1.5px solid ${C.ink}`,paddingTop:11,textAlign:"right",color:C.red})}>{taka(operating)}</td>
                  </tr>
                  {remuneration>0 && (
                    <tr>
                      <td style={{fontSize:13.5,padding:"11px 2px",color:C.orange}}>Director remuneration</td>
                      <td style={osw({fontSize:13.5,padding:"11px 2px",textAlign:"right",color:C.orange})}>{taka(remuneration)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr", gap:16 }}>
            <div style={panel}>
              <div style={ptitle}>Earnings before remuneration · monthly</div>
              <div style={{position:"relative",height:200}}>{Y.ready && <Bar data={barData} options={barOpts}/>}</div>
            </div>
            <div style={{...panel,display:"flex",flexDirection:"column",justifyContent:"center",textAlign:"center"}}>
              <div style={{...lbl,textAlign:"center"}}>Average monthly revenue</div>
              <div style={osw({fontSize:42,fontWeight:600,color:C.ink,marginTop:6})}>{taka(Y.avg)}</div>
              <div style={{fontSize:12,color:C.mut,marginTop:6}}>across active months</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
