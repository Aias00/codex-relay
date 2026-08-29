export type PendingInputIdentity = {
  clientEventId: string;
  signature: string;
};

export function claimInputIdentity(
  pendingByComposerKey: Map<string, PendingInputIdentity>,
  composerKey: string,
  signature: string,
  createClientEventId: () => string,
) {
  const pending = pendingByComposerKey.get(composerKey);
  if (pending?.signature === signature) {
    return pending.clientEventId;
  }

  const clientEventId = createClientEventId();
  pendingByComposerKey.set(composerKey, { clientEventId, signature });
  return clientEventId;
}

export function clearInputIdentity(
  pendingByComposerKey: Map<string, PendingInputIdentity>,
  composerKey: string,
  clientEventId: string,
) {
  if (pendingByComposerKey.get(composerKey)?.clientEventId === clientEventId) {
    pendingByComposerKey.delete(composerKey);
  }
}

export function moveInputIdentity(
  pendingByComposerKey: Map<string, PendingInputIdentity>,
  fromComposerKey: string,
  toComposerKey: string,
  clientEventId: string,
) {
  const pending = pendingByComposerKey.get(fromComposerKey);
  if (pending?.clientEventId !== clientEventId) {
    return;
  }
  pendingByComposerKey.delete(fromComposerKey);
  pendingByComposerKey.set(toComposerKey, pending);
}
