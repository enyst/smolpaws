export type GithubEventPayload = {
  action?: string;
  sender?: { login?: string; id?: number };
  comment?: { body?: string; id?: number };
  repository?: {
    full_name?: string;
    owner?: { login?: string };
  };
  issue?: { number?: number };
  pull_request?: { number?: number };
  installation?: { id?: number };
};
