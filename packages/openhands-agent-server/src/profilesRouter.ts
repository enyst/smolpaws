import type { FastifyInstance } from 'fastify';

import { llmProfilePayloadSchema, renameProfileRequestSchema } from './models.js';
import { param, parseBody } from './routeUtils.js';
import type { ServerStateService } from './serverState.js';

export function registerProfileRoutes(app: FastifyInstance, state: ServerStateService): void {
  app.get('/api/profiles', async () => state.listProfiles());
  app.get('/api/profiles/:name', async (request, reply) => {
    const profile = await state.getProfile(param(request, 'name'));
    if (profile === null) {
      reply.status(404).send({ detail: 'Profile not found' });
      return undefined;
    }
    return profile;
  });
  app.post('/api/profiles', async (request, reply) => {
    const profile = await state.saveProfile(parseBody(llmProfilePayloadSchema, request.body));
    reply.status(201);
    return profile;
  });
  app.post('/api/profiles/:name', async (request, reply) => {
    const name = param(request, 'name');
    const profile = await state.saveProfile(parseBody(llmProfilePayloadSchema, { ...(isRecord(request.body) ? request.body : {}), profileId: name }));
    reply.status(201);
    return profile;
  });
  app.delete('/api/profiles/:name', async (request) => {
    const name = param(request, 'name');
    await state.deleteProfile(name);
    return { name, message: `Profile '${name}' deleted` };
  });
  app.post('/api/profiles/:name/rename', async (request, reply) => {
    const name = param(request, 'name');
    const { new_name: newName } = parseBody(renameProfileRequestSchema, request.body);
    try {
      await state.renameProfile(name, newName);
    } catch (error) {
      reply.status(error instanceof Error && error.message === 'profile_exists' ? 409 : 404).send({ detail: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
    return { name: newName, message: name === newName ? `Profile '${name}' unchanged (same name)` : `Profile '${name}' renamed to '${newName}'` };
  });
  app.post('/api/profiles/:name/activate', async (request, reply) => {
    const name = param(request, 'name');
    try {
      await state.activateProfile(name);
    } catch {
      reply.status(404).send({ detail: 'Profile not found' });
      return undefined;
    }
    return { id: name, message: `Profile '${name}' activated` };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
