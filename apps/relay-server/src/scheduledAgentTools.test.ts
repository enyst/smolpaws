import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { scheduledAgentTools, type SlackCheckerPort } from './scheduledAgentTools.js';
import type { ScheduledAgentConfig } from './scheduledAgents.js';

const config: ScheduledAgentConfig = {
  profile: 'checker', context_files: [], tools: ['finish'],
  slack: { workspace_id: 'TTEST', user_id: 'UTEST', workspace_url: 'https://app.slack.com/client/TTEST', state_dir: '/unused' },
};
const checker: SlackCheckerPort = {
  async check() { assert.fail('finish must not poll Slack'); },
  async recover() { assert.fail('finish must not recover Chrome'); },
  pendingSourceIds() { return []; },
  async acknowledge() { assert.fail('finish must not acknowledge activity'); },
};

test('Slack helper finish normalizes only a serialized, blank message argument', async () => {
  const scheduler = new TaskScheduler(':memory:');
  try {
    const finish = scheduledAgentTools(scheduler, 'helper', config, () => checker).find(tool => tool.name === 'finish');
    assert.ok(finish, 'Slack helper must have its own finish adaptation');
    for (const message of ['{"message":""}', '{"message": ""}', ' \n{ "message": " \\n\\t " }\n']) {
      assert.deepEqual(await finish.execute({ message }), { text: '', is_error: false });
    }
    for (const message of ['', ' \n\t ', 'Chrome needs permission.', '{"message":"Slack login needed"}',
      '{"message":"","error":"Slack failed"}', '{"message":null}', '{"message":0}', '{"message":false}',
      '[]', 'null', '42', '{}', '{"message":', '[{"message":""}]', JSON.stringify('{"message":""}')]) {
      assert.deepEqual(await finish.execute({ message }), { text: message, is_error: false });
    }
    await assert.rejects(finish.execute({ message: null }));
  } finally { scheduler.close(); }
});

test('scheduled helpers without Slack configuration retain the standard finish tool', () => {
  const scheduler = new TaskScheduler(':memory:');
  try {
    const { slack: _slack, ...generic } = config;
    assert.ok(!scheduledAgentTools(scheduler, 'helper', generic, () => checker).some(tool => tool.name === 'finish'));
  } finally { scheduler.close(); }
});
