// Browser fixtures exercise the production create-and-poll contract. The
// expensive inference itself is mocked, never the session transport.
export function scanJobFixture() {
  const jobs = new Map();
  return {
    async create(route, result) {
      const body = route.request().postDataJSON();
      const id = `job-${body.clientId}`;
      const now = new Date().toISOString();
      const job = { id, status: 'completed', stage: 'completed', result, createdAt: now, updatedAt: now };
      jobs.set(id, job);
      await route.fulfill({ status: 202, json: { job: { ...job, result: undefined, status: 'queued', stage: 'queued' }, pollAfterMs: 750 } });
    },
    async poll(route) {
      const id = new URL(route.request().url()).pathname.split('/').pop();
      await route.fulfill({ json: { job: jobs.get(id), pollAfterMs: 750 } });
    },
  };
}
