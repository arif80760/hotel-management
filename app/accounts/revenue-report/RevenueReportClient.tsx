"use client";

import { useState, useEffect, useMemo, type CSSProperties } from "react";
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, Filler, Tooltip, Legend } from "chart.js";
import ChartDataLabels from "chartjs-plugin-datalabels";
import { Line, Bar } from "react-chartjs-2";
import { getTransactions, type AccountTransaction } from "@/services/accountsService";
import { getRevenues, type Revenue } from "@/services/revenueService";
import { getAllBookings, getBookingPaymentMap } from "@/services/bookingsService";
import type { MockBooking } from "@/lib/mockData";
import { useHotel } from "@/contexts/HotelContext";
import { useReferenceData } from "@/contexts/ReferenceDataContext";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Filler, Tooltip, Legend, ChartDataLabels);

const C = { green:"#4F8B36", red:"#C5302A", orange:"#E89A3C", ink:"#3F3F3F", mut:"#8A8A8A", hair:"#EAEAEA", track:"#F2EADD" };
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const BOOKING_LABEL = "Room / Booking";

function todayISO(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function firstOfMonthISO(d=new Date()){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }
function isoFrom(y:number,m:number,day:number){ return `${y}-${String(m+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`; }
function formatAmount(n:number){ return new Intl.NumberFormat("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}).format(n); }
function formatDateLabel(iso:string){ const d=new Date(iso+"T00:00:00"); return d.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric"}); }
function trendDayLabel(iso:string){ const d=new Date(iso+"T00:00:00"); return d.toLocaleDateString("en-GB",{day:"numeric",month:"short"}); }
function trendMonthLabel(key:string){ const d=new Date(key+"-01T00:00:00"); return d.toLocaleDateString("en-GB",{month:"short",year:"numeric"}); }
function daysInclusive(fromISO:string,toISO:string){ const a=new Date(fromISO+"T00:00:00").getTime(); const b=new Date(toISO+"T00:00:00").getTime(); if(isNaN(a)||isNaN(b)||b<a)return 0; return Math.floor((b-a)/86400000)+1; }
function formatMethod(m:string){ return m.split("_").map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(" "); }
const taka=(n:number)=>`৳${Math.round(Math.abs(n)).toLocaleString()}`;
const k=(v:number)=>(v?`৳${Math.round(v/1000)}k`:"");

type Preset = "this_month" | "last_month" | "this_year" | "all" | "custom";
function rangeFilters(f:string,t:string){ const out:{fromDate?:string;toDate?:string}={}; if(f)out.fromDate=f; if(t)out.toDate=t; return out; }
async function loadTxns(f:string,t:string){
  const filters=rangeFilters(f,t);
  const [tx,rv]=await Promise.all([getTransactions(filters),getRevenues(filters)]);
  const paymentIds=tx.filter(x=>x.type==="revenue_in"&&x.bookingPaymentId).map(x=>x.bookingPaymentId as string);
  const pm=await getBookingPaymentMap(paymentIds);
  return { tx, rv, pm };
}

export default function RevenueReportClient({ oswaldFamily, archivoFamily }:{ oswaldFamily:string; archivoFamily:string }){
  const { categoryName: roomCategoryName } = useHotel();

  const [fromDate,setFromDate]=useState<string>(firstOfMonthISO());
  const [toDate,setToDate]=useState<string>(todayISO());
  const [preset,setPreset]=useState<Preset>("this_month");

  // accounts + revenue categories from the session-level reference cache.
  const { accountDefs, revenueCategories } = useReferenceData();
  const accounts   = useMemo(()=>accountDefs.map(a=>({id:a.id,name:a.name})),[accountDefs]);
  const categories = useMemo(()=>revenueCategories.map(c=>({id:c.id,name:c.name})),[revenueCategories]);

  const [txns,setTxns]=useState<AccountTransaction[]>([]);
  const [manual,setManual]=useState<Revenue[]>([]);
  const [bookingsByRef,setBookingsByRef]=useState<Map<string,MockBooking>>(new Map());
  const [paymentMap,setPaymentMap]=useState<Awaited<ReturnType<typeof getBookingPaymentMap>>>(new Map());
  const [fetching,setFetching]=useState(true);
  const [fetchError,setFetchError]=useState<string|null>(null);
  const [Y,setY]=useState({ booking:Array(12).fill(0) as number[], other:Array(12).fill(0) as number[], ready:false });
  const [page,setPage]=useState(1);

  useEffect(()=>{ let cancelled=false;
    (async()=>{
      try{
        const [{tx,rv,pm},bks]=await Promise.all([loadTxns(fromDate,toDate),getAllBookings()]);
        if(cancelled)return;
        setTxns(tx); setManual(rv); setPaymentMap(pm);
        setBookingsByRef(new Map(bks.map(b=>[b.id,b])));
      }catch(err){ if(!cancelled) setFetchError(err instanceof Error?err.message:"Failed to load."); }
      finally{ if(!cancelled) setFetching(false); }
    })();
    return ()=>{ cancelled=true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  useEffect(()=>{ if(fetching)return; let cancelled=false;
    (async()=>{ try{ const {tx,rv,pm}=await loadTxns(fromDate,toDate); if(!cancelled){ setTxns(tx); setManual(rv); setPaymentMap(pm); } }catch(err){ console.error("[RevenueReportClient] refilter failed:",err); } })();
    return ()=>{ cancelled=true; };
  },[fromDate,toDate,fetching]);

  useEffect(()=>{ let cancelled=false;
    (async()=>{
      try{
        const y=new Date().getFullYear();
        const tx=await getTransactions({fromDate:`${y}-01-01`,toDate:todayISO()});
        if(cancelled)return;
        const booking=Array(12).fill(0), other=Array(12).fill(0);
        for(const t of tx){ if(t.type!=="revenue_in")continue; const mi=parseInt(String(t.txnDate).slice(5,7),10)-1; if(mi<0||mi>11)continue;
          if(t.bookingPaymentId!==null) booking[mi]+=t.amount; else other[mi]+=t.amount; }
        setY({booking,other,ready:true});
      }catch{ if(!cancelled) setY(s=>({...s,ready:true})); }
    })();
    return ()=>{ cancelled=true; };
  },[]);

  useEffect(()=>{ setPage(1); },[fromDate,toDate]);

  function applyPreset(p:Preset){
    setPreset(p); const now=new Date();
    if(p==="this_month"){ setFromDate(firstOfMonthISO(now)); setToDate(todayISO()); }
    else if(p==="last_month"){ const lm=new Date(now.getFullYear(),now.getMonth()-1,1); const lastDay=new Date(now.getFullYear(),now.getMonth(),0).getDate(); setFromDate(isoFrom(lm.getFullYear(),lm.getMonth(),1)); setToDate(isoFrom(lm.getFullYear(),lm.getMonth(),lastDay)); }
    else if(p==="this_year"){ setFromDate(isoFrom(now.getFullYear(),0,1)); setToDate(todayISO()); }
    else if(p==="all"){ setFromDate(""); setToDate(""); }
  }

  const revenueTxns=useMemo(()=>txns.filter(t=>t.type==="revenue_in"),[txns]);
  const accountName=useMemo(()=>{ const m=new Map(accounts.map(a=>[a.id,a.name])); return (id:string|null)=>(id?m.get(id)??"Unknown":"—"); },[accounts]);
  const categoryName=useMemo(()=>{ const m=new Map(categories.map(c=>[c.id,c.name])); return (id:string)=>m.get(id)??"Uncategorized"; },[categories]);
  const manualById=useMemo(()=>{ const m=new Map<string,{category:string;payee:string}>(); for(const r of manual) m.set(r.id,{category:categoryName(r.revenueCategoryId),payee:r.payee}); return m; },[manual,categoryName]);
  const total=useMemo(()=>revenueTxns.reduce((s,t)=>s+t.amount,0),[revenueTxns]);
  const count=revenueTxns.length;
  const bookingTotal=useMemo(()=>revenueTxns.filter(t=>t.bookingPaymentId!==null).reduce((s,t)=>s+t.amount,0),[revenueTxns]);
  const otherTotal=total-bookingTotal;
  const avgPerDay=useMemo(()=>{ let f=fromDate,t=toDate; if(!f||!t){ const dates=revenueTxns.map(x=>x.txnDate).sort(); if(dates.length===0)return 0; f=f||dates[0]; t=t||dates[dates.length-1]; } const d=daysInclusive(f,t); return d>0?total/d:0; },[fromDate,toDate,revenueTxns,total]);
  const pct=(a:number)=>(total>0?Math.round((a/total)*100):0);
  const PAGE_SIZE=25;
  const pageCount=Math.max(1,Math.ceil(revenueTxns.length/PAGE_SIZE));
  const safePage=Math.min(page,pageCount);
  const pageStart=(safePage-1)*PAGE_SIZE;
  const pageRows=revenueTxns.slice(pageStart,pageStart+PAGE_SIZE);

  const bySource=useMemo(()=>{ const rows:{label:string;amount:number}[]=[]; if(bookingTotal>0)rows.push({label:BOOKING_LABEL,amount:bookingTotal}); const byCat=new Map<string,number>(); for(const r of manual){ const name=categoryName(r.revenueCategoryId); byCat.set(name,(byCat.get(name)??0)+r.amount); } for(const [label,amount] of byCat)rows.push({label,amount}); return rows.sort((a,b)=>b.amount-a.amount); },[bookingTotal,manual,categoryName]);
  const byBucket=useMemo(()=>{ const m=new Map<string,number>(); for(const t of revenueTxns){ const name=accountName(t.toAccountId); m.set(name,(m.get(name)??0)+t.amount); } return Array.from(m.entries()).map(([label,amount])=>({label,amount})).sort((a,b)=>b.amount-a.amount); },[revenueTxns,accountName]);
  const trendData=useMemo(()=>{ const dayMap=new Map<string,number>(); for(const t of revenueTxns)dayMap.set(t.txnDate,(dayMap.get(t.txnDate)??0)+t.amount); if(dayMap.size<=45){ const rows=Array.from(dayMap.entries()).sort(([a],[b])=>a.localeCompare(b)).map(([key,amount])=>({key,label:trendDayLabel(key),amount})); return {granularity:"daily" as const,rows}; } const monthMap=new Map<string,number>(); for(const [day,amt] of dayMap){ const kk=day.slice(0,7); monthMap.set(kk,(monthMap.get(kk)??0)+amt); } const rows=Array.from(monthMap.entries()).sort(([a],[b])=>a.localeCompare(b)).map(([key,amount])=>({key,label:trendMonthLabel(key),amount})); return {granularity:"monthly" as const,rows}; },[revenueTxns]);

  // ---- chart configs (any: chart.js + datalabels generics) ----
  const monthlyTotal=Y.booking.map((b,i)=>b+Y.other[i]);
  const lineData:any={ labels:MONTHS, datasets:[
    { label:"Room / Booking", data:Y.booking, borderColor:C.orange, backgroundColor:"rgba(232,154,60,.14)", borderWidth:2.4, pointBackgroundColor:C.orange, pointRadius:3, tension:.4, fill:true, datalabels:{align:"top",color:C.orange,font:{family:oswaldFamily,size:9},formatter:k} },
    { label:"Other revenue", data:Y.other, borderColor:C.ink, borderWidth:2, pointBackgroundColor:C.ink, pointRadius:2.5, tension:.4, fill:false, datalabels:{display:false} } ] };
  const lineOpts:any={ responsive:true, maintainAspectRatio:false, layout:{padding:{top:14}}, plugins:{legend:{display:true,position:"top",labels:{font:{family:archivoFamily,size:11},usePointStyle:true,boxWidth:7,color:C.ink}},tooltip:{enabled:false}}, scales:{x:{grid:{display:false},ticks:{font:{family:archivoFamily,size:10},color:C.mut}},y:{display:false,beginAtZero:true,grace:"18%"}} };
  const sparkData:any={ labels:monthlyTotal.map((_,i)=>i), datasets:[{ data:monthlyTotal, borderColor:C.green, borderWidth:1.6, pointRadius:0, tension:.35, fill:false, datalabels:{display:false} }] };
  const sparkOpts:any={ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},tooltip:{enabled:false},datalabels:{display:false}}, scales:{x:{display:false},y:{display:false}} };
  const trendBarData:any={ labels:trendData.rows.map(r=>r.label), datasets:[{ data:trendData.rows.map(r=>r.amount), backgroundColor:C.orange, borderRadius:2, datalabels:{display:false} }] };
  const trendBarOpts:any={ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},tooltip:{enabled:false}}, scales:{x:{grid:{display:false},ticks:{font:{family:archivoFamily,size:9},color:C.mut,maxRotation:50,minRotation:0,autoSkip:true,maxTicksLimit:16}},y:{display:false,beginAtZero:true,grace:"16%"}} };

  const osw=(extra:CSSProperties={}):CSSProperties=>({fontFamily:oswaldFamily,...extra});
  const card:CSSProperties={border:`1px solid ${C.hair}`,borderRadius:8,padding:"16px 18px",background:"#fff"};
  const panel:CSSProperties=card;
  const lbl:CSSProperties={fontSize:11,fontWeight:600,letterSpacing:".11em",textTransform:"uppercase",color:C.mut};
  const ptitle:CSSProperties={fontSize:11,fontWeight:600,letterSpacing:".12em",textTransform:"uppercase",textAlign:"center",marginBottom:10,color:C.ink};
  const bigNum=(color:string):CSSProperties=>osw({fontSize:34,fontWeight:600,lineHeight:1.05,marginTop:8,letterSpacing:".5px",color});
  const td:CSSProperties={fontSize:13.5,padding:"10px 2px",borderBottom:`1px solid ${C.hair}`};
  const tdNum:CSSProperties=osw({...td,textAlign:"right",fontWeight:500});

  if(fetching){
    return <div style={{fontFamily:archivoFamily,maxWidth:1040,margin:"0 auto",padding:"22px 8px"}}>
      <div style={osw({fontSize:26,fontWeight:600,letterSpacing:".05em",color:C.ink})}><span style={{color:C.green}}>REVENUE</span> REPORT</div>
      <div style={{marginTop:24,border:`1px dashed ${C.hair}`,borderRadius:8,padding:"48px",textAlign:"center",color:C.mut,fontSize:13}}>Loading…</div>
    </div>;
  }
  if(fetchError){
    return <div style={{fontFamily:archivoFamily,maxWidth:1040,margin:"0 auto",padding:"22px 8px"}}>
      <div style={osw({fontSize:26,fontWeight:600,letterSpacing:".05em",color:C.ink})}><span style={{color:C.green}}>REVENUE</span> REPORT</div>
      <div style={{marginTop:24,border:`1px solid ${C.red}`,color:C.red,borderRadius:8,padding:"12px 16px",fontSize:13}}>{fetchError}</div>
    </div>;
  }

  const selStyle:CSSProperties={fontFamily:archivoFamily,fontSize:12,fontWeight:600,letterSpacing:".03em",color:C.ink,border:`1.5px solid ${C.ink}`,borderRadius:8,padding:"8px 14px",background:"#fff"};
  const dateStyle:CSSProperties={fontFamily:archivoFamily,fontSize:12,border:`1px solid ${C.hair}`,borderRadius:6,padding:"6px 10px"};
  const badge=(bg:string,col:string):CSSProperties=>({fontFamily:archivoFamily,fontSize:11,fontWeight:600,letterSpacing:".06em",textTransform:"uppercase",padding:"2px 8px",borderRadius:999,background:bg,color:col});
  const pageBtn=(disabled:boolean):CSSProperties=>({fontFamily:archivoFamily,fontSize:12,fontWeight:600,color:disabled?C.mut:C.ink,background:"#fff",border:`1px solid ${disabled?C.hair:C.ink}`,borderRadius:6,padding:"6px 12px",cursor:disabled?"default":"pointer",opacity:disabled?0.5:1});

  return (
    <div style={{fontFamily:archivoFamily,maxWidth:1040,margin:"0 auto",padding:"22px 8px 30px",color:C.ink}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap",marginBottom:20}}>
        <div>
          <div style={osw({fontSize:26,fontWeight:600,letterSpacing:".05em"})}><span style={{color:C.green}}>REVENUE</span> REPORT</div>
          <div style={{fontSize:13,color:C.mut,marginTop:4}}>All income — room/booking and manually recorded — for the selected range.</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <a href="/accounts/revenue-management" style={{fontFamily:archivoFamily,fontSize:12,fontWeight:600,color:C.ink,border:`1px solid ${C.hair}`,borderRadius:8,padding:"8px 12px",textDecoration:"none"}}>← Revenue entries</a>
          <select value={preset} onChange={e=>{ const p=e.target.value as Preset; if(p==="custom")setPreset("custom"); else applyPreset(p); }} style={selStyle}>
            <option value="this_month">This month</option><option value="last_month">Last month</option><option value="this_year">This year</option><option value="all">All time</option><option value="custom">Custom</option>
          </select>
        </div>
      </div>

      {preset==="custom" && (
        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:14}}>
          <input type="date" value={fromDate} max={toDate||todayISO()} onChange={e=>{ setFromDate(e.target.value); setPreset("custom"); }} style={dateStyle}/>
          <span style={{fontSize:12,color:C.mut}}>to</span>
          <input type="date" value={toDate} min={fromDate||undefined} max={todayISO()} onChange={e=>{ setToDate(e.target.value); setPreset("custom"); }} style={dateStyle}/>
        </div>
      )}

      {/* KPI cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16,marginBottom:18}}>
        <div style={card}>
          <div style={lbl}>Total revenue</div>
          <div style={bigNum(C.green)}>{taka(total)}</div>
          <div style={{height:30,marginTop:6}}>{Y.ready && <Line data={sparkData} options={sparkOpts}/>}</div>
        </div>
        <div style={card}>
          <div style={lbl}>Room / booking</div>
          <div style={bigNum(C.green)}>{taka(bookingTotal)}</div>
          <div style={{fontSize:11.5,marginTop:8,color:C.mut}}><b style={{color:C.green,fontWeight:600}}>{pct(bookingTotal)}%</b> of total revenue</div>
        </div>
        <div style={card}>
          <div style={lbl}>Other revenue</div>
          <div style={bigNum(C.orange)}>{taka(otherTotal)}</div>
          <div style={{fontSize:11.5,marginTop:8,color:C.mut}}><b style={{color:C.orange,fontWeight:600}}>{pct(otherTotal)}%</b> of total revenue</div>
        </div>
        <div style={card}>
          <div style={lbl}>Avg / day</div>
          <div style={bigNum(C.ink)}>{taka(avgPerDay)}</div>
          <div style={{fontSize:11.5,marginTop:8,color:C.mut}}>{count} {count===1?"entry":"entries"} in range</div>
        </div>
      </div>

      {/* line + by source */}
      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:16,marginBottom:18}}>
        <div style={panel}>
          <div style={ptitle}>Monthly revenue · booking vs other</div>
          <div style={{position:"relative",height:230}}>{Y.ready && <Line data={lineData} options={lineOpts}/>}</div>
        </div>
        <div style={panel}>
          <div style={ptitle}>By source · range</div>
          <table style={{width:"100%",borderCollapse:"collapse"}}><tbody>
            {bySource.length===0 && <tr><td style={{fontSize:13,color:C.mut,padding:"10px 2px"}}>No revenue in range</td></tr>}
            {bySource.map(r=>(<tr key={r.label}><td style={td}>{r.label}</td><td style={tdNum}>{taka(r.amount)}</td><td style={osw({...td,textAlign:"right",color:C.mut,fontSize:12,width:46})}>{pct(r.amount)}%</td></tr>))}
          </tbody></table>
        </div>
      </div>

      {/* trend + by bucket */}
      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:16,marginBottom:18}}>
        <div style={panel}>
          <div style={ptitle}>Revenue trend · {trendData.granularity} · range</div>
          <div style={{position:"relative",height:200}}>{trendData.rows.length>0 ? <Bar data={trendBarData} options={trendBarOpts}/> : <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:C.mut,fontSize:13}}>No revenue in range</div>}</div>
        </div>
        <div style={panel}>
          <div style={ptitle}>By bucket · range</div>
          <table style={{width:"100%",borderCollapse:"collapse"}}><tbody>
            {byBucket.length===0 && <tr><td style={{fontSize:13,color:C.mut,padding:"10px 2px"}}>No revenue in range</td></tr>}
            {byBucket.map(r=>(<tr key={r.label}><td style={td}>{r.label}</td><td style={tdNum}>{taka(r.amount)}</td><td style={osw({...td,textAlign:"right",color:C.mut,fontSize:12,width:46})}>{pct(r.amount)}%</td></tr>))}
          </tbody></table>
        </div>
      </div>

      {/* transaction list */}
      <div style={{border:`1px solid ${C.hair}`,borderRadius:8,background:"#fff",overflow:"hidden"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 18px",borderBottom:`1px solid ${C.hair}`}}>
          <div style={{fontSize:11,fontWeight:600,letterSpacing:".12em",textTransform:"uppercase",color:C.ink}}>Transactions</div>
          <div style={{fontSize:12.5,color:C.mut}}>{count} {count===1?"entry":"entries"} · <b style={osw({color:C.ink})}>{taka(total)}</b></div>
        </div>
        {revenueTxns.length===0 ? (
          <div style={{padding:"40px",textAlign:"center",color:C.mut,fontSize:13}}>No revenue in this range.</div>
        ) : (
          <>
          <ul style={{listStyle:"none",margin:0,padding:0}}>
            {pageRows.map(t=>{
              const isBooking=t.bookingPaymentId!==null;
              if(!isBooking){
                const m=manualById.get(t.id); const cat=m?.category??"Revenue"; const payee=m?.payee??"";
                return (
                  <li key={t.id} style={{padding:"13px 18px",borderTop:`1px solid ${C.hair}`}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                      <span style={osw({fontSize:15,fontWeight:600,color:C.ink})}>৳{formatAmount(t.amount)}</span>
                      <span style={badge(C.track,C.orange)}>{cat}</span>
                      {payee && <span style={{fontSize:12.5,color:C.mut}}>{payee}</span>}
                    </div>
                    <div style={{marginTop:3,fontSize:12,color:C.mut}}>{formatDateLabel(t.txnDate)} · {accountName(t.toAccountId)}</div>
                  </li>
                );
              }
              const pmEntry=t.bookingPaymentId?paymentMap.get(t.bookingPaymentId):undefined;
              const booking=pmEntry?bookingsByRef.get(pmEntry.bookingRef):undefined;
              return (
                <li key={t.id} style={{padding:"13px 18px",borderTop:`1px solid ${C.hair}`}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                    <span style={osw({fontSize:15,fontWeight:600,color:C.ink})}>৳{formatAmount(t.amount)}</span>
                    <span style={badge("#EAF3E4",C.green)}>{BOOKING_LABEL}</span>
                    {booking && <span style={{fontSize:12.5,fontWeight:500,color:C.ink}}>{booking.guestName}</span>}
                    {pmEntry && <a href={`/bookings/${pmEntry.bookingRef}/reservation`} style={{fontSize:12,fontWeight:600,color:C.green,textDecoration:"none"}}>{pmEntry.bookingRef} →</a>}
                  </div>
                  <div style={{marginTop:3,fontSize:12,color:C.mut}}>{formatDateLabel(t.txnDate)} · {accountName(t.toAccountId)}{pmEntry?` · ${formatMethod(pmEntry.method)}`:""}</div>
                  {booking ? (
                    <div style={{marginTop:6,background:"#FAFAF8",border:`1px solid ${C.hair}`,borderRadius:6,padding:"8px 12px",fontSize:12,color:"#5a5a5a",lineHeight:1.6}}>
                      {booking.rooms.map(r=>(<div key={r.id}>Room {r.roomNumber} · {roomCategoryName(r.roomCategory)} · {r.checkIn} → {r.checkOut} · {r.nights} night{r.nights===1?"":"s"}</div>))}
                      <div>Guest: {booking.guestName}{booking.phone?` · ${booking.phone}`:""} · {booking.totalGuests} guest{booking.totalGuests===1?"":"s"}</div>
                      <div>Booking: {booking.status} · {booking.payment} · total ৳{formatAmount(booking.totalAmount)} / paid ৳{formatAmount(booking.amountPaid)}</div>
                    </div>
                  ) : (
                    <div style={{marginTop:4,fontSize:12,color:"#bbb",fontStyle:"italic"}}>Booking detail unavailable for this payment.</div>
                  )}
                </li>
              );
            })}
          </ul>
          {pageCount>1 && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 18px",borderTop:`1px solid ${C.hair}`}}>
              <span style={{fontSize:12,color:C.mut}}>Showing {pageStart+1}–{Math.min(pageStart+PAGE_SIZE,revenueTxns.length)} of {revenueTxns.length}</span>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <button type="button" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={safePage<=1} style={pageBtn(safePage<=1)}>← Prev</button>
                <span style={osw({fontSize:12,color:C.ink})}>{safePage} / {pageCount}</span>
                <button type="button" onClick={()=>setPage(p=>Math.min(pageCount,p+1))} disabled={safePage>=pageCount} style={pageBtn(safePage>=pageCount)}>Next →</button>
              </div>
            </div>
          )}
          </>
        )}
      </div>
    </div>
  );
}
