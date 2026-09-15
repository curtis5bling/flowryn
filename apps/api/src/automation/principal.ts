// An internal capability, never accepted from HTTP input or stored rule data.
export const automationPrincipal = Symbol('flowryn:automation:v1');
export const automationActorId = '000000000000000000000006';
export const systemIncidentActions = new Set(['timeline', 'attach-runbook', 'edit', 'transition']);
export type AutomationContext = {
  principal: typeof automationPrincipal;
  configuredBy: string;
  initiatedBy?: string;
  correlationId: string;
  causationId: string;
  chainDepth: number;
  rulePath: string[];
};
