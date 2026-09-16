/**
 * How the dashboard finds its map bubbles.
 *
 * `leads` reads `agents` (an agent profile answers "who is asking"), and
 * `visits` reads both; if `agents` read `leads` back for the clusters the
 * three would form a cycle, which breaks at runtime under CommonJS. So the
 * dependency is inverted: `agents` declares what it needs, `leads` implements
 * it, and `bootstrap/register-modules` connects the two — the same shape the
 * QR module uses for publisher onboarding.
 *
 * Unregistered, the layer is empty rather than an error: the header, the
 * wallet and the day's counters are what the dashboard is for.
 */
export type LeadClusterScope =
  | { point: { latitude: number; longitude: number; radiusKm: number }; city?: undefined }
  | { point?: undefined; city: string };

/**
 * A cluster of prospects on the map — the "5 LEADS" chips the frames draw.
 * Declared here, at the bottom of the graph, so the service and the port can
 * both read it without either reading the other.
 */
export type LeadCluster = {
  latitude: number;
  longitude: number;
  count: number;
  /** The locality the cluster is named after. */
  label: string;
};

export interface LeadLayerPort {
  clusters(scope: LeadClusterScope): Promise<LeadCluster[]>;
}

let registered: LeadLayerPort | null = null;

export function registerLeadLayerPort(port: LeadLayerPort): void {
  registered = port;
}

export function leadLayer(): LeadLayerPort {
  return registered ?? { clusters: async () => [] };
}
