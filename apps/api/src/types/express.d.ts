import type { UserStatus } from '../models/User.js';
import type { WorkspaceRole } from '../models/WorkspaceMember.js';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        status: UserStatus;
      };
      workspaceMembership?: {
        workspaceId: string;
        role: WorkspaceRole;
      };
    }
  }
}

export {};
