type Change = { kind: 'user' | 'membership' | 'session'; userId: string; workspaceId?: string; tokenId?: string };
const listeners = new Set<(change: Change) => Promise<void>>();

export const onAuthorizationChange = (listener: (change: Change) => Promise<void>) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const authorizationChanged = async (change: Change) => {
  await Promise.all([...listeners].map((listener) => listener(change)));
};
