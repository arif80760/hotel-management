// app/rooms/page.tsx — Rooms
// Displays all hotel rooms with type, floor, capacity, amenities,
// status, and nightly rate. All data is demo data for now.

type Room = {
  number: string;
  type:   "Single" | "Double" | "Suite" | "Deluxe" | "Family";
  floor:  number;
  capacity: number;
  amenities: string[];
  status: "Available" | "Occupied" | "Cleaning" | "Maintenance";
  price:  string;
};

// ── 12 demo rooms ─────────────────────────────────────────────
const rooms: Room[] = [
  { number: "101", type: "Single",  floor: 1, capacity: 1, amenities: ["WiFi", "TV"],                     status: "Available",   price: "$89"  },
  { number: "102", type: "Double",  floor: 1, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar"],          status: "Occupied",    price: "$139" },
  { number: "103", type: "Double",  floor: 1, capacity: 2, amenities: ["WiFi", "TV"],                     status: "Cleaning",    price: "$139" },
  { number: "104", type: "Family",  floor: 1, capacity: 4, amenities: ["WiFi", "TV", "Kitchenette"],      status: "Available",   price: "$219" },
  { number: "201", type: "Deluxe",  floor: 2, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar", "View"], status: "Occupied",    price: "$189" },
  { number: "202", type: "Deluxe",  floor: 2, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar", "View"], status: "Occupied",    price: "$189" },
  { number: "203", type: "Suite",   floor: 2, capacity: 3, amenities: ["WiFi", "TV", "Jacuzzi", "View"],  status: "Available",   price: "$349" },
  { number: "204", type: "Deluxe",  floor: 2, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar"],         status: "Occupied",    price: "$189" },
  { number: "301", type: "Suite",   floor: 3, capacity: 3, amenities: ["WiFi", "TV", "Jacuzzi", "View"],  status: "Occupied",    price: "$349" },
  { number: "302", type: "Double",  floor: 3, capacity: 2, amenities: ["WiFi", "TV"],                     status: "Maintenance", price: "$139" },
  { number: "303", type: "Deluxe",  floor: 3, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar", "View"], status: "Available",   price: "$189" },
  { number: "401", type: "Suite",   floor: 4, capacity: 4, amenities: ["WiFi", "TV", "Jacuzzi", "View", "Butler"], status: "Occupied", price: "$549" },
];

// ── Helpers ───────────────────────────────────────────────────
function statusStyle(status: Room["status"]): string {
  const map: Record<Room["status"], string> = {
    Available:   "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    Occupied:    "bg-rose-50    text-rose-700    ring-1 ring-rose-200",
    Cleaning:    "bg-amber-50   text-amber-700   ring-1 ring-amber-200",
    Maintenance: "bg-slate-100  text-slate-600   ring-1 ring-slate-200",
  };
  return map[status];
}

function statusDot(status: Room["status"]): string {
  const map: Record<Room["status"], string> = {
    Available:   "bg-emerald-500",
    Occupied:    "bg-rose-500",
    Cleaning:    "bg-amber-500",
    Maintenance: "bg-slate-400",
  };
  return map[status];
}

function typeStyle(type: Room["type"]): string {
  const map: Record<Room["type"], string> = {
    Single:  "bg-slate-100  text-slate-600",
    Double:  "bg-blue-50    text-blue-700",
    Deluxe:  "bg-violet-50  text-violet-700",
    Suite:   "bg-amber-50   text-amber-700",
    Family:  "bg-teal-50    text-teal-700",
  };
  return map[type];
}

// Counts for the summary pills
const available   = rooms.filter(r => r.status === "Available").length;
const occupied    = rooms.filter(r => r.status === "Occupied").length;
const cleaning    = rooms.filter(r => r.status === "Cleaning").length;
const maintenance = rooms.filter(r => r.status === "Maintenance").length;

export default function RoomsPage() {
  return (
    <div className="p-7 max-w-[1400px]">

      {/* ── Page header ───────────────────────────────────── */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">Rooms</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Manage all {rooms.length} rooms across 4 floors.
          </p>
        </div>
        <button className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-[13px] font-medium px-4 py-2.5 rounded-lg transition-colors shadow-sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add Room
        </button>
      </div>

      {/* ── Summary pills ─────────────────────────────────── */}
      <div className="flex flex-wrap gap-3 mb-6">
        {[
          { label: "All Rooms",    count: rooms.length, style: "bg-white border-slate-200 text-slate-700",        dot: "bg-slate-400" },
          { label: "Available",    count: available,    style: "bg-emerald-50 border-emerald-200 text-emerald-700", dot: "bg-emerald-500" },
          { label: "Occupied",     count: occupied,     style: "bg-rose-50 border-rose-200 text-rose-700",         dot: "bg-rose-500"   },
          { label: "Cleaning",     count: cleaning,     style: "bg-amber-50 border-amber-200 text-amber-700",      dot: "bg-amber-500"  },
          { label: "Maintenance",  count: maintenance,  style: "bg-slate-100 border-slate-200 text-slate-600",     dot: "bg-slate-400"  },
        ].map((pill) => (
          <div
            key={pill.label}
            className={`flex items-center gap-2 px-4 py-2 rounded-full border text-[13px] font-medium cursor-pointer ${pill.style}`}
          >
            <span className={`w-2 h-2 rounded-full ${pill.dot}`} />
            {pill.label}
            <span className="font-bold">{pill.count}</span>
          </div>
        ))}
      </div>

      {/* ── Rooms table ───────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {["Room", "Type", "Floor", "Guests", "Amenities", "Status", "Rate / Night", ""].map((h) => (
                <th key={h} className="text-left px-5 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rooms.map((room) => (
              <tr key={room.number} className="hover:bg-slate-50/70 transition-colors">

                {/* Room number */}
                <td className="px-5 py-3.5">
                  <span className="font-bold text-slate-800 text-[15px]">{room.number}</span>
                </td>

                {/* Type badge */}
                <td className="px-5 py-3.5">
                  <span className={`px-2.5 py-1 rounded-md text-[12px] font-semibold ${typeStyle(room.type)}`}>
                    {room.type}
                  </span>
                </td>

                {/* Floor */}
                <td className="px-5 py-3.5 text-slate-500">
                  Floor {room.floor}
                </td>

                {/* Capacity */}
                <td className="px-5 py-3.5 text-slate-500">
                  {room.capacity} {room.capacity === 1 ? "guest" : "guests"}
                </td>

                {/* Amenities — show first 3, overflow as "+N" */}
                <td className="px-5 py-3.5">
                  <div className="flex flex-wrap gap-1">
                    {room.amenities.slice(0, 3).map((a) => (
                      <span key={a} className="bg-slate-100 text-slate-500 text-[11px] font-medium px-2 py-0.5 rounded">
                        {a}
                      </span>
                    ))}
                    {room.amenities.length > 3 && (
                      <span className="bg-slate-100 text-slate-400 text-[11px] px-2 py-0.5 rounded">
                        +{room.amenities.length - 3}
                      </span>
                    )}
                  </div>
                </td>

                {/* Status */}
                <td className="px-5 py-3.5">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold ${statusStyle(room.status)}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${statusDot(room.status)}`} />
                    {room.status}
                  </span>
                </td>

                {/* Price */}
                <td className="px-5 py-3.5 font-semibold text-slate-800">{room.price}</td>

                {/* Actions */}
                <td className="px-5 py-3.5">
                  <button className="text-[12px] font-medium text-slate-400 hover:text-slate-700 border border-slate-200 hover:border-slate-300 px-3 py-1.5 rounded-lg transition-colors">
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Table footer */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50">
          <p className="text-[12px] text-slate-400">
            Showing {rooms.length} rooms · Last updated just now
          </p>
        </div>
      </div>

    </div>
  );
}
