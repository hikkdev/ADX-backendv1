export type ListTicketsOptions = {
  limit?: number;
  offset?: number;
  status?: string;
  search?: string;
};

export type NewTicket = {
  userId: string;
  title: string;
  description: string;
  category?: string;
  relatedOrderId?: string;
};

export type NewReply = {
  ticketId: string;
  authorId: string;
  authorName: string;
  message: string;
};
