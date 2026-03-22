import type { ContainerOutput } from './container-runner.js';
import { formatToolStatus } from './format-tool-status.js';

/**
 * Determines what action the status message handler should take
 * given the current state and an incoming container output event.
 */
export interface StatusState {
  /** The container-start status message ID (set at container launch). */
  statusMsgId: number | undefined;
  /** The piped status message ID (set when a follow-up is sent to an active container). */
  pipedStatusId: number | undefined;
  /** Whether real output has already been sent to the user in this container session. */
  outputSentToUser: boolean;
  /** Timestamp of the last status edit (for throttling). */
  lastStatusEdit: number;
  /** Current time (injectable for testing). */
  now: number;
  /** Throttle interval in ms. */
  throttleMs: number;
}

export type StatusAction =
  | { type: 'edit'; messageId: number; text: string }
  | { type: 'delete'; messageIds: number[] }
  | { type: 'none' };

/**
 * Pure function: given status state and a container output event,
 * returns the action to take on the status message.
 */
export function resolveStatusAction(
  state: StatusState,
  result: ContainerOutput,
): StatusAction {
  const currentStatusId = state.statusMsgId ?? state.pipedStatusId;
  const canUpdate =
    currentStatusId != null &&
    (!state.outputSentToUser || state.pipedStatusId != null);
  const withinThrottle =
    state.now - state.lastStatusEdit < state.throttleMs;

  // Tool-use → edit status message with tool label
  if (result.toolUse && canUpdate && currentStatusId != null) {
    if (withinThrottle) return { type: 'none' };
    const label = formatToolStatus(result.toolUse.name, result.toolUse.input);
    return { type: 'edit', messageId: currentStatusId, text: label };
  }

  // Session-update marker (no result, no toolUse) → show "thinking"
  if (!result.toolUse && !result.result && canUpdate && currentStatusId != null) {
    if (withinThrottle) return { type: 'none' };
    return {
      type: 'edit',
      messageId: currentStatusId,
      text: '_Agent thinking..._',
    };
  }

  // Real output arrived → delete all status messages
  if (result.result) {
    const toDelete: number[] = [];
    if (state.statusMsgId != null && !state.outputSentToUser) {
      toDelete.push(state.statusMsgId);
    }
    if (state.pipedStatusId != null) {
      toDelete.push(state.pipedStatusId);
    }
    if (toDelete.length > 0) {
      return { type: 'delete', messageIds: toDelete };
    }
  }

  return { type: 'none' };
}
