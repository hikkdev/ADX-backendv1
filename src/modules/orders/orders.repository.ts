import type { CheckIn, Order, OrderAgentAssignment } from '../../shared/database';

export type NewOrder = {
  advertiserId: string;
  listingId: string;
  campaignName?: string;
  designUrl?: string;
  budget?: number;
  startDate?: Date;
  endDate?: Date;
  notes?: string;
};

/** Order joined to its listing and that listing's publisher. */
export type OrderWithPublisher = Order & {
  listing: {
    id: string;
    title: string;
    latitude: number | null;
    longitude: number | null;
    qrToken: string | null;
    agentCanInstall: boolean;
    publisher: { id: string; userId: string | null } | null;
  };
};

export type OrderListFilters = { status?: string; limit?: number; offset?: number };

export type VerificationPatch = Partial<{
  wideAngleUrl: string | undefined;
  closeUpUrl: string | undefined;
  landmarkUrl: string;
}>;

export interface OrdersRepository {
  create(data: NewOrder): Promise<Order>;
  findById(orderId: string): Promise<Order | null>;
  findWithPublisher(orderId: string): Promise<OrderWithPublisher | null>;
  /** The full aggregate the order detail endpoint returns. */
  findDetail(orderId: string): Promise<unknown | null>;
  update(orderId: string, data: Record<string, unknown>): Promise<Order>;

  findCompletedExpiredForListing(listingId: string): Promise<Order | null>;
  /** Orders whose publisher-response timer lapsed inside a given window. */
  findPublisherTimerExpired(windowStart: Date, now: Date): Promise<{ id: string }[]>;

  findForAdvertiser(advertiserId: string): Promise<Order[]>;
  findForPublisherUser(publisherUserId: string): Promise<Order[]>;
  findForAgent(agentProfileId: string): Promise<Order[]>;
  findAll(filters: OrderListFilters): Promise<Order[]>;
  findAgentLocation(
    orderId: string,
  ): Promise<{ agentLatitude: number | null; agentLongitude: number | null; agentLocationUpdatedAt: Date | null } | null>;

  // ── Assignment ──
  findPendingAssignment(orderId: string, agentId: string): Promise<OrderAgentAssignment | null>;
  findAssignments(orderId: string): Promise<OrderAgentAssignment[]>;
  createAssignment(orderId: string, agentId: string): Promise<unknown>;
  /** Accepts the assignment and moves the order on, atomically. */
  acceptAssignment(assignmentId: string, orderId: string, agentId: string): Promise<void>;
  /** Rejects the assignment and bumps the rejection count, atomically. */
  rejectAssignment(assignmentId: string, orderId: string, reason?: string): Promise<void>;

  // ── Evidence ──
  upsertVerification(orderId: string, data: VerificationPatch): Promise<unknown>;
  upsertCheckIn(
    orderId: string,
    data: { latitude: number; longitude: number; distanceM: number },
  ): Promise<CheckIn>;
}
