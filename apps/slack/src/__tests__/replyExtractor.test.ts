import assert from 'node:assert/strict';
import test from 'node:test';

import { finalResponseExtractor } from '../../../../src/coordinator/coordinator.js';

test('finalResponseExtractor delivers a normal assistant MessageEvent', () => {
  const result = finalResponseExtractor({
    id: 'assistant-message-1',
    kind: 'MessageEvent',
    source: 'agent',
    llm_message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'CAPY' },
        { type: 'text', text: 'BARA' },
      ],
    },
  });

  assert.deepEqual(result, {
    payload: { kind: 'current_thread_message', text: 'CAPYBARA' },
  });
});

test('finalResponseExtractor still delivers a finish-tool observation', () => {
  const result = finalResponseExtractor({
    id: 'finish-observation-1',
    kind: 'ObservationEvent',
    source: 'environment',
    tool_name: 'finish',
    observation: { message: 'CAPYBARA-FINISH' },
  });

  assert.deepEqual(result, {
    payload: { kind: 'current_thread_message', text: 'CAPYBARA-FINISH' },
  });
});

test('finalResponseExtractor ignores user and empty assistant messages', () => {
  assert.equal(
    finalResponseExtractor({
      id: 'user-message-1',
      kind: 'MessageEvent',
      source: 'user',
      llm_message: {
        role: 'user',
        content: [{ type: 'text', text: 'do not echo me' }],
      },
    }),
    null,
  );

  assert.equal(
    finalResponseExtractor({
      id: 'assistant-message-empty',
      kind: 'MessageEvent',
      source: 'agent',
      llm_message: {
        role: 'assistant',
        content: [{ type: 'text', text: '   ' }],
      },
    }),
    null,
  );
});
