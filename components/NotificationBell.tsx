"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { getAllBookings } from "@/services/bookingsService";
import { getInventoryItems, getStockForAllItems } from "@/services/inventoryService";
import { getDayCloseStatus } from "@/services/dayCloseService";
import type { MockBooking } from "@/lib/mockData";

function todayISO(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
const taka=(n:number)=>`৳${Math.round(n).toLocaleString()}`;
type LowItem={ id:string; name:string; qty:number; threshold:number };

export default function NotificationBell(){
  const { role, user } = useAuth();
  const isAdmin = role==="admin";
  const [open,setOpen]=useState(false);
  const [bookings,setBookings]=useState<MockBooking[]>([]);
  const [lowStock,setLowStock]=useState<LowItem[]>([]);
  const [dayClose,setDayClose]=useState<{lastClosedDate:string;missed:number}|null>(null);
  const [lastSeen,setLastSeen]=useState(0);
  const ref=useRef<HTMLDivElement>(null);
  const today=todayISO();

  const load=useCallback(async ()=>{
    try{ const bk=await getAllBookings(); setBookings(bk); }catch{/* ignore */}
    if(isAdmin){
      try{
        const [items,stock]=await Promise.all([getInventoryItems({activeOnly:true}),getStockForAllItems()]);
        const low=items.filter(i=>i.lowStockThreshold!=null && (stock.get(i.id)??0)<=(i.lowStockThreshold as number))
          .map(i=>({id:i.id,name:i.name,qty:stock.get(i.id)??0,threshold:i.lowStockThreshold as number}));
        setLowStock(low);
      }catch{/* ignore */}
      try{ const s=await getDayCloseStatus(); setDayClose({lastClosedDate:s.lastClosedDate,missed:s.missedDays.length}); }catch{/* ignore */}
    }
  },[isAdmin]);

  useEffect(()=>{
    load();
    const id=setInterval(load,30000);
    const onVis=()=>{ if(document.visibilityState==="visible") load(); };
    document.addEventListener("visibilitychange",onVis);
    window.addEventListener("focus",onVis);
    return ()=>{ clearInterval(id); document.removeEventListener("visibilitychange",onVis); window.removeEventListener("focus",onVis); };
  },[load]);

  useEffect(()=>{ if(!user?.id)return; const v=localStorage.getItem(`notif_seen_${user.id}`); setLastSeen(v?(parseInt(v,10)||0):0); },[user?.id]);

  useEffect(()=>{ if(!open)return; const h=(e:MouseEvent)=>{ if(ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown",h); return ()=>document.removeEventListener("mousedown",h); },[open]);

  const cat=useMemo(()=>{
    const arrivals  = bookings.filter(b=>b.checkInISO===today && b.status==="Confirmed");
    const departures= bookings.filter(b=>b.checkOutISO===today && b.status==="Checked In");
    const overdue   = bookings.filter(b=>!!b.checkOutISO && b.checkOutISO<today && b.status==="Checked In");
    const balanceDue= bookings.filter(b=>b.status==="Checked In" && b.payment!=="Paid" && b.amountPaid<b.totalAmount && !!b.checkOutISO && b.checkOutISO<=today);
    const latest    = bookings.slice(0,5);
    return { arrivals, departures, overdue, balanceDue, latest };
  },[bookings,today]);

  const dayNotClosed = isAdmin && dayClose ? dayClose.lastClosedDate<today : false;
  const startOfToday=useMemo(()=>{ const d=new Date(); d.setHours(0,0,0,0); return d.getTime(); },[]);
  const newBookingsCount=useMemo(()=>bookings.filter(b=>b.createdAt && Date.parse(b.createdAt)>lastSeen).length,[bookings,lastSeen]);
  const actionableCount=cat.arrivals.length+cat.departures.length+cat.overdue.length+cat.balanceDue.length+(isAdmin?lowStock.length:0)+(dayNotClosed?1:0);
  const showDot=newBookingsCount>0 || (actionableCount>0 && startOfToday>lastSeen);
  const badge=showDot?Math.min(99,newBookingsCount+actionableCount):0;
  const totalItems=actionableCount+cat.latest.length;

  function toggle(){ const next=!open; setOpen(next); if(next){ load(); if(user?.id){ const now=Date.now(); localStorage.setItem(`notif_seen_${user.id}`,String(now)); setLastSeen(now); } } }

  const bookingRow=(b:MockBooking,detail:string,tone:string)=>(
    <a key={b.id} href={`/bookings/${b.id}/reservation`} className="block px-4 py-2.5 hover:bg-slate-50 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-slate-800 truncate">{b.guestName}</span>
        <span className={`text-[11px] font-semibold ${tone}`}>{b.id}</span>
      </div>
      <div className="text-[11.5px] text-slate-500 truncate">{detail}</div>
    </a>
  );
  const Header=({label,count}:{label:string;count:number})=>(
    <div className="px-4 pt-3 pb-1 flex items-center gap-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
      <span className="text-[10.5px] font-semibold text-slate-400">{count}</span>
    </div>
  );

  return (
    <div className="relative" ref={ref}>
      <button onClick={toggle} aria-label="Notifications" className="relative p-1.5 text-slate-400 hover:text-slate-600 transition-colors rounded-lg hover:bg-slate-100">
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        {showDot && (badge>0 ? (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-bold text-white bg-red-500 rounded-full">{badge>9?"9+":badge}</span>
        ) : (
          <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-red-500 rounded-full" />
        ))}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[360px] max-h-[480px] overflow-y-auto bg-white rounded-xl border border-slate-200 shadow-xl z-50">
          <div className="px-4 py-3 border-b border-slate-100 sticky top-0 bg-white">
            <span className="text-[13px] font-semibold text-slate-800">Notifications</span>
          </div>
          {totalItems===0 ? (
            <div className="px-4 py-12 text-center text-[13px] text-slate-400">You’re all caught up.</div>
          ) : (
            <div>
              {cat.overdue.length>0 && (<><Header label="Overdue checkout" count={cat.overdue.length}/>{cat.overdue.map(b=>bookingRow(b,`Was due to leave ${b.checkOutISO}`,"text-red-600"))}</>)}
              {cat.departures.length>0 && (<><Header label="Departures today" count={cat.departures.length}/>{cat.departures.map(b=>bookingRow(b,(b.payment!=="Paid"&&b.amountPaid<b.totalAmount)?`Balance due ${taka(b.totalAmount-b.amountPaid)}`:"Checking out today","text-amber-600"))}</>)}
              {cat.arrivals.length>0 && (<><Header label="Arrivals today" count={cat.arrivals.length}/>{cat.arrivals.map(b=>bookingRow(b,`Arriving today · ${b.totalGuests} guest${b.totalGuests===1?"":"s"}`,"text-emerald-600"))}</>)}
              {cat.balanceDue.length>0 && (<><Header label="Payment due" count={cat.balanceDue.length}/>{cat.balanceDue.map(b=>bookingRow(b,`Owes ${taka(b.totalAmount-b.amountPaid)} · out ${b.checkOutISO}`,"text-red-600"))}</>)}
              {isAdmin && lowStock.length>0 && (<><Header label="Low stock" count={lowStock.length}/>{lowStock.map(i=>(
                <a key={i.id} href="/inventory" className="block px-4 py-2.5 hover:bg-slate-50 transition-colors">
                  <div className="flex items-center justify-between gap-2"><span className="text-[12.5px] font-medium text-slate-800 truncate">{i.name}</span><span className="text-[11px] font-semibold text-amber-600">{i.qty} / {i.threshold}</span></div>
                  <div className="text-[11.5px] text-slate-500">At or below reorder level</div>
                </a>))}</>)}
              {isAdmin && dayNotClosed && (<><Header label="Cashbook" count={1}/>
                <a href="/accounts/cashbook" className="block px-4 py-2.5 hover:bg-slate-50 transition-colors">
                  <div className="text-[12.5px] font-medium text-slate-800">Day not closed</div>
                  <div className="text-[11.5px] text-slate-500">{dayClose && dayClose.missed>0?`${dayClose.missed} day${dayClose.missed===1?"":"s"} unclosed · last ${dayClose.lastClosedDate}`:`Last closed ${dayClose?.lastClosedDate}`}</div>
                </a></>)}
              {cat.latest.length>0 && (<><Header label="Latest bookings" count={cat.latest.length}/>{cat.latest.map(b=>bookingRow(b,`${b.status}${b.checkInISO?` · ${b.checkInISO}`:""}${b.checkOutISO?` → ${b.checkOutISO}`:""}`,"text-slate-400"))}</>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
