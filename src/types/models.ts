/**
 * hotels/{hotelId} — a hotel workspace.
 *
 * InnPilot has no user accounts: a workspace is created from the landing
 * page (src/lib/onboarding.ts) and identified by its hotelId alone.
 */
export type SubscriptionPlan = "trial" | "basic" | "pro";
export type SubscriptionStatus = "active" | "past_due" | "suspended" | "cancelled";

export interface HotelSubscription {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
}

export interface HotelDoc {
  name: string;
  /** City, as entered during onboarding. */
  location: string;
  currency: string;
  phone: string;
  email: string;
  taxId: string;
  /** Platform-owned; firestore.rules forbids a workspace changing it. */
  subscription: HotelSubscription;
  createdAt?: unknown; // Firestore server timestamp
}
