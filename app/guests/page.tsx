// app/guests/page.tsx — Guests
// Hotel guest directory with avatar initials, contact info,
// current stay details, and a static search bar.
// All data is demo data — no database connected yet.

type Guest = {
  id:          string;
  name:        string;
  email:       string;
  phone:       string;
  nationality: string;
  idType:      string;
  room:        string | null; // null = not currently staying
  checkIn:     string | null;
  checkOut:    string | null;
  visits:      number;       // total number of past stays
  vip:         boolean;
};

// ── 8 demo guests ─────────────────────────────────────────────
const guests: Guest[] = [
  { id: "G-001", name: "James Whitfield",  email: "j.whitfield@email.com",  phone: "+1 617 555 0101", nationality: "American",   idType: "Passport",     room: "204",  checkIn: "Apr 21", checkOut: "Apr 24", visits: 4,  vip: true  },
  { id: "G-002", name: "Priya Nair",       email: "priya.nair@email.com",    phone: "+91 98 5550 102", nationality: "Indian",      idType: "Passport",     room: "312",  checkIn: "Apr 21", checkOut: "Apr 26", visits: 2,  vip: false },
  { id: "G-003", name: "Carlos Mendez",    email: "c.mendez@email.com",      phone: "+52 55 5550 103", nationality: "Mexican",     idType: "Passport",     room: "115",  checkIn: "Apr 21", checkOut: "Apr 23", visits: 1,  vip: false },
  { id: "G-004", name: "Sophie Laurent",   email: "s.laurent@email.com",     phone: "+33 6 5550 0104", nationality: "French",      idType: "Passport",     room: "408",  checkIn: "Apr 21", checkOut: "Apr 28", visits: 7,  vip: true  },
  { id: "G-005", name: "Robert Kim",       email: "r.kim@email.com",         phone: "+82 10 5550 105", nationality: "South Korean",idType: "National ID",  room: null,   checkIn: null,     checkOut: null,     visits: 3,  vip: false },
  { id: "G-006", name: "Amina Hassan",     email: "a.hassan@email.com",      phone: "+971 50 555 0106",nationality: "Emirati",     idType: "National ID",  room: null,   checkIn: null,     checkOut: null,     visits: 5,  vip: true  },
  { id: "G-007", name: "David Okoye",      email: "d.okoye@email.com",       phone: "+234 80 5550 107",nationality: "Nigerian",    idType: "Passport",     room: null,   checkIn: null,     checkOut: null,     visits: 1,  vip: false },
  { id: "G-008", name: "Yuki Tanaka",      email: "y.tanaka@email.com",      phone: "+81 90 5550 108", nationality: "Japanese",    idType: "Passport",     room: null,   checkIn: null,     checkOut: null,     visits: 9,  vip: true  },
];

// Generate initials from a full name, e.g. "James Whitfield" → "JW"
function initials(name: string): string {
  return name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

// Consistent avatar background colour based on the first letter
function avatarColor(name: string): string {
  const colors = [
    "bg-violet-100 text-violet-700",
    "bg-blue-100 text-blue-700",
    "bg-emerald-100 text-emerald-700",
    "bg-rose-100 text-rose-700",
    "bg-amber-100 text-amber-700",
    "bg-teal-100 text-teal-700",
    "bg-indigo-100 text-indigo-700",
    "bg-pink-100 text-pink-700",
  ];
  return colors[name.charCodeAt(0) % colors.length];
}

const inHouse  = guests.filter(g => g.room !== null).length;
const vipCount = guests.filter(g => g.vip).length;

export default function GuestsPage() {
  return (
    <div className="p-7 max-w-[1400px]">

      {/* ── Page header ───────────────────────────────────── */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">Guests</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {guests.length} registered guests · {inHouse} currently in-house · {vipCount} VIP
          </p>
        </div>
        <button className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-[13px] font-medium px-4 py-2.5 rounded-lg transition-colors shadow-sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add Guest
        </button>
      </div>

      {/* ── Search bar (static — no logic yet) ────────────── */}
      <div className="relative mb-6 max-w-sm">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="text"
          placeholder="Search guests by name, email, or nationality…"
          className="w-full pl-10 pr-4 py-2.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg shadow-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
          readOnly
        />
      </div>

      {/* ── Guests table ──────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {["Guest", "Contact", "Nationality / ID", "Current Stay", "Past Visits", ""].map((h) => (
                <th key={h} className="text-left px-5 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {guests.map((guest) => (
              <tr key={guest.id} className="hover:bg-slate-50/70 transition-colors">

                {/* Avatar + name + VIP badge */}
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-[12px] font-bold ${avatarColor(guest.name)}`}>
                      {initials(guest.name)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-800">{guest.name}</p>
                        {guest.vip && (
                          <span className="bg-amber-100 text-amber-700 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide">
                            VIP
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400">{guest.id}</p>
                    </div>
                  </div>
                </td>

                {/* Email + phone */}
                <td className="px-5 py-3.5">
                  <p className="text-slate-700">{guest.email}</p>
                  <p className="text-[12px] text-slate-400 mt-0.5">{guest.phone}</p>
                </td>

                {/* Nationality + ID type */}
                <td className="px-5 py-3.5">
                  <p className="text-slate-700">{guest.nationality}</p>
                  <span className="inline-block mt-0.5 bg-slate-100 text-slate-500 text-[11px] font-medium px-2 py-0.5 rounded">
                    {guest.idType}
                  </span>
                </td>

                {/* Current stay or —  */}
                <td className="px-5 py-3.5">
                  {guest.room ? (
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full inline-block" />
                        <p className="font-semibold text-slate-800">Room {guest.room}</p>
                      </div>
                      <p className="text-[12px] text-slate-400 mt-0.5">
                        {guest.checkIn} → {guest.checkOut}
                      </p>
                    </div>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>

                {/* Total past visits */}
                <td className="px-5 py-3.5">
                  <span className="font-semibold text-slate-700">{guest.visits}</span>
                  <span className="text-slate-400"> stay{guest.visits !== 1 ? "s" : ""}</span>
                </td>

                {/* Actions */}
                <td className="px-5 py-3.5">
                  <button className="text-[12px] font-medium text-slate-400 hover:text-slate-700 border border-slate-200 hover:border-slate-300 px-3 py-1.5 rounded-lg transition-colors">
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50">
          <p className="text-[12px] text-slate-400">
            {guests.length} guests total · Sorted by most recent activity
          </p>
        </div>
      </div>

    </div>
  );
}
