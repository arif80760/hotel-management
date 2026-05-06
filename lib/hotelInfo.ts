/**
 * Hotel branding constants used in invoices and reservation
 * details. Single source of truth — when a settings module
 * is built later (Day 4+), these become DB-backed values.
 */
export const HOTEL_INFO = {
  name:       "Hotel Albatross Resort",
  address:    "Kalatali Road, Cox's Bazar, Bangladesh, 4700",
  phone:      "+8801715900807",
  email:      "booking@albatrossresort.com",
  website:    "albatrossresort.com",
  logoPath:   "/hotel-albatross-logo.png",
  footerText:            "Thank you for staying with us!",
  reservationFooterText: "We look forward to welcoming you to Hotel Albatross Resort!",
} as const;

export type HotelInfo = typeof HOTEL_INFO;
