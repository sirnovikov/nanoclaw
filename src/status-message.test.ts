import { describe, expect, it } from 'vitest';
import type { ContainerOutput } from './container-runner.js';
import { type StatusState, resolveStatusAction } from './status-message.js';

function makeState(overrides: Partial<StatusState> = {}): StatusState {
  return {
    statusMsgId: 100,
    pipedStatusId: undefined,
    outputSentToUser: false,
    lastStatusEdit: 0,
    now: 5000,
    throttleMs: 2000,
    ...overrides,
  };
}

function toolUseResult(name: string, input?: string): ContainerOutput {
  return { status: 'success', result: null, toolUse: { name, input } };
}

const thinkingResult: ContainerOutput = { status: 'success', result: null };

function realOutput(text: string): ContainerOutput {
  return { status: 'success', result: text };
}

describe('resolveStatusAction', () => {
  describe('tool-use updates', () => {
    it('edits status message with tool label', () => {
      const action = resolveStatusAction(
        makeState(),
        toolUseResult('Read', 'src/index.ts'),
      );
      expect(action).toEqual({
        type: 'edit',
        messageId: 100,
        text: '_Reading_ `src/index.ts`',
      });
    });

    it('throttles rapid tool-use updates', () => {
      const state = makeState({ lastStatusEdit: 4000, now: 5000 });
      const action = resolveStatusAction(state, toolUseResult('Bash'));
      expect(action).toEqual({ type: 'none' });
    });

    it('allows update after throttle window', () => {
      const state = makeState({ lastStatusEdit: 2000, now: 5000 });
      const action = resolveStatusAction(
        state,
        toolUseResult('Bash', 'npm test'),
      );
      expect(action.type).toBe('edit');
    });

    it('skips update when no status message exists', () => {
      const state = makeState({ statusMsgId: undefined });
      const action = resolveStatusAction(state, toolUseResult('Read'));
      expect(action).toEqual({ type: 'none' });
    });

    it('skips update when output already sent and no piped status', () => {
      const state = makeState({ outputSentToUser: true });
      const action = resolveStatusAction(state, toolUseResult('Read'));
      expect(action).toEqual({ type: 'none' });
    });

    it('updates piped status even after output was sent', () => {
      const state = makeState({
        statusMsgId: undefined,
        pipedStatusId: 200,
        outputSentToUser: true,
      });
      const action = resolveStatusAction(state, toolUseResult('Grep', 'TODO'));
      expect(action).toEqual({
        type: 'edit',
        messageId: 200,
        text: '_Searching_ `TODO`',
      });
    });
  });

  describe('thinking updates', () => {
    it('edits status to thinking on session-update marker', () => {
      const action = resolveStatusAction(makeState(), thinkingResult);
      expect(action).toEqual({
        type: 'edit',
        messageId: 100,
        text: '_Agent thinking..._',
      });
    });

    it('updates piped status to thinking after output was sent', () => {
      const state = makeState({
        statusMsgId: undefined,
        pipedStatusId: 200,
        outputSentToUser: true,
      });
      const action = resolveStatusAction(state, thinkingResult);
      expect(action).toEqual({
        type: 'edit',
        messageId: 200,
        text: '_Agent thinking..._',
      });
    });

    it('throttles thinking updates', () => {
      const state = makeState({ lastStatusEdit: 4500, now: 5000 });
      const action = resolveStatusAction(state, thinkingResult);
      expect(action).toEqual({ type: 'none' });
    });
  });

  describe('real output → delete status messages', () => {
    it('deletes container-start status on first output', () => {
      const action = resolveStatusAction(makeState(), realOutput('Hello'));
      expect(action).toEqual({ type: 'delete', messageIds: [100] });
    });

    it('deletes piped status on output', () => {
      const state = makeState({
        statusMsgId: undefined,
        pipedStatusId: 200,
        outputSentToUser: true,
      });
      const action = resolveStatusAction(state, realOutput('Hello'));
      expect(action).toEqual({ type: 'delete', messageIds: [200] });
    });

    it('deletes both status messages when both exist', () => {
      const state = makeState({ pipedStatusId: 200 });
      const action = resolveStatusAction(state, realOutput('Hello'));
      expect(action).toEqual({ type: 'delete', messageIds: [100, 200] });
    });

    it('skips delete when output already sent and no piped status', () => {
      const state = makeState({ outputSentToUser: true });
      const action = resolveStatusAction(state, realOutput('More output'));
      expect(action).toEqual({ type: 'none' });
    });

    it('returns none when no status messages exist', () => {
      const state = makeState({ statusMsgId: undefined });
      const action = resolveStatusAction(state, realOutput('Hello'));
      expect(action).toEqual({ type: 'none' });
    });
  });

  describe('prefers statusMsgId over pipedStatusId', () => {
    it('uses statusMsgId when both exist for tool updates', () => {
      const state = makeState({ pipedStatusId: 200 });
      const action = resolveStatusAction(state, toolUseResult('Read'));
      expect(action).toEqual({
        type: 'edit',
        messageId: 100,
        text: '_Reading..._',
      });
    });
  });
});
