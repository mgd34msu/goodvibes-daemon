// ---------------------------------------------------------------------------
// conversation-rewind-port.ts — the daemon's RewindConversationPort for the
// SDK's unified rewind service.
//
// The SDK's UnifiedRewindService (platform/rewind) joins files rewind (workspace
// checkpoints) with conversation rewind through two ports. The conversation port
// is "a daemon-hosted mutable conversation store": preview() reports how many
// messages would truncate to a recorded turn boundary, and rewind() performs the
// truncation and captures the pre-/post-truncation snapshots so the reversal can
// be undone and re-applied. The truncation boundary is the message count recorded
// for the anchor's turnId at TURN_COMPLETED (rewind-turn-anchors.ts) — the same
// join key files rewind uses against the workspace checkpoint.
//
// This module is the daemon's implementation of that port. It resolves the live
// conversation per anchor.sessionId from the registry below, which is populated
// by whatever process hosts the conversation. While conversation loops run in
// the surfaces (the terminal app and the agent), the daemon's registry is empty
// and conversation-scope rewind reports "nothing to drop" rather than a
// fabricated count; files-scope rewind, which is entirely daemon-owned, is
// unaffected. When session hosting moves here, the registry fills in and the
// same code serves it.
//
// The port is written against a structural conversation shape rather than any
// one surface's conversation class, so nothing about it is terminal-specific.
// ---------------------------------------------------------------------------

import type {
  RewindAnchor,
  RewindConversationOutcome,
  RewindConversationPort,
  RewindConversationPreview,
} from '@pellux/goodvibes-sdk/platform/rewind';
import { resolveTurnAnchor } from '../core/rewind-turn-anchors.ts';

/** Whatever a conversation is serialized as by the process that owns it. */
type ConversationJson = unknown;

/**
 * The five operations a rewind needs from a conversation. Any host that can
 * count its messages, serialize them, truncate to a boundary and reload a
 * snapshot satisfies this.
 */
export interface RewindableConversation {
  getMessageCount(): number;
  toJSON(): ConversationJson;
  fromJSON(json: ConversationJson): void;
  rebuildHistory(): void;
  removeMessagesAfter(count: number): void;
}

/** The port plus the reversal accessors an undo/redo surface needs. */
export interface ConversationRewindPort extends RewindConversationPort {
  /** Restore the pre-truncation conversation (the /undo direction). */
  restoreBefore(undoSnapshotId: string): boolean;
  /** Restore the post-truncation conversation (the /redo direction). */
  restoreAfter(undoSnapshotId: string): boolean;
}

/** One truncation's captured state — the target conversation and its snapshots. */
interface SnapshotPair {
  readonly conv: RewindableConversation;
  readonly before: ConversationJson;
  readonly after: ConversationJson;
}

/**
 * Build a conversation rewind port. `resolveConversation` maps an anchor's
 * sessionId to the live conversation: the daemon looks the session up in the
 * registry below. A null resolution means no live conversation for that session,
 * reported as "nothing to drop" rather than a fabricated count.
 */
export function createConversationRewindPort(
  resolveConversation: (sessionId: string) => RewindableConversation | null,
): ConversationRewindPort {
  const snapshots = new Map<string, SnapshotPair>();

  function keepFor(anchor: RewindAnchor): { conv: RewindableConversation | null; keep: number; total: number } {
    const conv = resolveConversation(anchor.sessionId);
    if (!conv) return { conv: null, keep: 0, total: 0 };
    const total = conv.getMessageCount();
    const rec = anchor.turnId ? resolveTurnAnchor(anchor.sessionId, anchor.turnId) : null;
    const keep = rec ? Math.min(rec.messageCount, total) : total;
    return { conv, keep, total };
  }

  function restore(snapshot: SnapshotPair | undefined, which: 'before' | 'after'): boolean {
    if (!snapshot) return false;
    snapshot.conv.fromJSON(snapshot[which]);
    snapshot.conv.rebuildHistory();
    return true;
  }

  return {
    async preview(anchor: RewindAnchor): Promise<RewindConversationPreview> {
      const { keep, total } = keepFor(anchor);
      return { messagesToDrop: Math.max(0, total - keep), messagesRemaining: keep };
    },

    async rewind(anchor: RewindAnchor): Promise<RewindConversationOutcome> {
      const { conv, keep, total } = keepFor(anchor);
      const undoSnapshotId = `rwc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      if (!conv) return { droppedMessages: 0, undoSnapshotId };
      const before = conv.toJSON();
      conv.removeMessagesAfter(keep);
      conv.rebuildHistory();
      const after = conv.toJSON();
      snapshots.set(undoSnapshotId, { conv, before, after });
      return { droppedMessages: Math.max(0, total - keep), undoSnapshotId };
    },

    restoreBefore(undoSnapshotId: string): boolean {
      return restore(snapshots.get(undoSnapshotId), 'before');
    },

    restoreAfter(undoSnapshotId: string): boolean {
      return restore(snapshots.get(undoSnapshotId), 'after');
    },
  };
}

// ---------------------------------------------------------------------------
// Live per-session conversation registry — the daemon-hosted mutable store the
// composed daemon's rewind.plan/apply verbs resolve conversations from. The TUI
// registers its active session's conversation; a session
// with no registration reports conversation rewind as "nothing to drop".
// ---------------------------------------------------------------------------

const liveConversations = new Map<string, RewindableConversation>();

/** Register a session's live conversation so the daemon rewind verbs can serve it. */
export function registerSessionConversation(sessionId: string, conversation: RewindableConversation): void {
  if (sessionId) liveConversations.set(sessionId, conversation);
}

/** Drop a session's conversation registration. */
export function unregisterSessionConversation(sessionId: string): void {
  liveConversations.delete(sessionId);
}

/**
 * The conversation rewind port the composed daemon threads into
 * registerGatewayVerbGroups — it resolves each anchor's live conversation from
 * the registry above, so the daemon's own rewind verbs serve conversation scope
 * live in this process.
 */
export function createSessionConversationRewindPort(): ConversationRewindPort {
  return createConversationRewindPort((sessionId) => liveConversations.get(sessionId) ?? null);
}
