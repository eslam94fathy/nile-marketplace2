import { type AgentStatus } from '../enums';

/** A delivery agent (spec 11 §1). The login lives in identity; this is the delivery profile. */
export interface DeliveryAgent {
  id: string;
  userId: string;
  fullName: string;
  phone: string;
  homeGovernorateId: string;
  status: AgentStatus;
  onShift: boolean;
  lastAssignedAt: Date | null;
  createdAt: Date;
}

/** An agent with what its views add: the login's email and status, and its open work. */
export interface AgentView {
  agent: DeliveryAgent;
  email: string;
  userStatus: string;
  activeShipmentCount: number;
}
