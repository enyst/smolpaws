import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { conversationSettingsSchema, openHandsAgentSettingsSchema } from '@smolpaws/openhands-agent';

import {
  secretCreateRequestSchema,
  settingsUpdateRequestSchema,
} from './models.js';
import { parseBody, param } from './routeUtils.js';
import type { ServerStateService } from './serverState.js';

export function registerSettingsRoutes(app: FastifyInstance, state: ServerStateService): void {
  app.get('/api/settings/agent-schema', async () => ({ schema: z.toJSONSchema(openHandsAgentSettingsSchema) }));
  app.get('/api/settings/conversation-schema', async () => ({ schema: z.toJSONSchema(conversationSettingsSchema) }));
  app.get('/api/settings', async () => state.settings());
  app.patch('/api/settings', async (request) => state.updateSettings(parseBody(settingsUpdateRequestSchema, request.body)));

  app.get('/api/settings/secrets', async () => ({ secrets: await state.listSecrets() }));
  app.put('/api/settings/secrets', async (request) => state.setSecret(...secretArgs(parseBody(secretCreateRequestSchema, request.body))));
  app.get('/api/settings/secrets/:name', async (request, reply) => {
    const item = await state.getSecretMetadata(param(request, 'name'));
    if (item === null) {
      reply.status(404).send({ detail: 'Secret not found' });
      return undefined;
    }
    return { ...item, value: '**********' };
  });
  app.delete('/api/settings/secrets/:name', async (request) => {
    await state.deleteSecret(param(request, 'name'));
    return { success: true };
  });
}

function secretArgs(body: { readonly name: string; readonly value: string }): [string, string] {
  return [body.name, body.value];
}
