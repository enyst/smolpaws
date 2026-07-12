import type { FastifyInstance } from 'fastify';

import { agentProfilePayloadSchema, renameProfileRequestSchema } from './models.js';
import { param, parseBody } from './routeUtils.js';
import type { ServerStateService } from './serverState.js';

export function registerAgentProfileRoutes(app: FastifyInstance, state: ServerStateService): void {
  app.get('/api/agent-profiles', async () => state.listAgentProfiles());
  app.get('/api/agent-profiles/:name', async (request, reply) => {
    const profile = await state.getAgentProfile(param(request, 'name'));
    if (profile === null) {
      reply.status(404).send({ detail: 'Agent profile not found' });
      return undefined;
    }
    return profile;
  });
  app.post('/api/agent-profiles', async (request, reply) => {
    const profile = await state.saveAgentProfile(parseBody(agentProfilePayloadSchema, request.body));
    reply.status(201);
    return profile;
  });
  app.post('/api/agent-profiles/:name', async (request, reply) => {
    const name = param(request, 'name');
    const profile = await state.saveAgentProfile(parseBody(agentProfilePayloadSchema, { ...(isRecord(request.body) ? request.body : {}), name }));
    reply.status(201);
    return profile;
  });
  app.delete('/api/agent-profiles/:name', async (request) => {
    const name = param(request, 'name');
    await state.deleteAgentProfile(name);
    return { name, message: `Agent profile '${name}' deleted` };
  });
  app.post('/api/agent-profiles/:name/rename', async (request, reply) => {
    const name = param(request, 'name');
    const { new_name: newName } = parseBody(renameProfileRequestSchema, request.body);
    try {
      await state.renameAgentProfile(name, newName);
    } catch (error) {
      reply.status(error instanceof Error && error.message === 'profile_exists' ? 409 : 404).send({ detail: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
    return { name: newName, message: name === newName ? `Agent profile '${name}' unchanged (same name)` : `Agent profile '${name}' renamed to '${newName}'` };
  });
  app.post('/api/agent-profiles/:profile_id/activate', async (request, reply) => {
    const profileId = param(request, 'profile_id');
    try {
      await state.activateAgentProfile(profileId);
    } catch {
      reply.status(404).send({ detail: 'Agent profile not found' });
      return undefined;
    }
    return { id: profileId, message: `Agent profile '${profileId}' activated` };
  });
  app.post('/api/agent-profiles/:name/materialize', async (request, reply) => {
    const profile = await state.getAgentProfile(param(request, 'name'));
    if (profile === null) {
      reply.status(404).send({ detail: 'Agent profile not found' });
      return undefined;
    }
    return { valid: true, errors: [], resolved_settings: redactedSettings(profile) };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactedSettings(profile: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(profile).replace(/api[_-]?key|secret/giu, 'redacted')) as Record<string, unknown>;
}
