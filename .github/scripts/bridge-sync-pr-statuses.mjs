const SYNC_BRANCH = 'sync/master-into-dev';

const REQUIRED_CONTEXTS = Object.freeze({
  CI: ['security-lint', 'test-backend-node', 'test-frontend', 'test-backend-ai', 'test-mobile'],
  'Branch Policy': ['branch-policy'],
});

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function requireOption(name, value) {
  if (!value) {
    throw new Error(`Missing required option: ${name}`);
  }

  return value;
}

function truncateDescription(description) {
  return String(description).slice(0, 140);
}

function resolveStatusFromJob(job) {
  if (!job) {
    return {
      state: 'error',
      description: 'Required job is missing from the workflow run.',
    };
  }

  if (job.status !== 'completed') {
    return {
      state: 'pending',
      description: `${job.name} is still running.`,
    };
  }

  switch (job.conclusion) {
    case 'success':
      return {
        state: 'success',
        description: `${job.name} passed.`,
      };
    case 'cancelled':
      return {
        state: 'error',
        description: `${job.name} was cancelled.`,
      };
    case 'skipped':
      return {
        state: 'error',
        description: `${job.name} was skipped.`,
      };
    case 'neutral':
      return {
        state: 'error',
        description: `${job.name} finished without a decision.`,
      };
    case 'timed_out':
      return {
        state: 'failure',
        description: `${job.name} timed out.`,
      };
    case 'action_required':
      return {
        state: 'failure',
        description: `${job.name} requires manual action.`,
      };
    default:
      return {
        state: 'failure',
        description: `${job.name} failed.`,
      };
  }
}

function createApiClient(repo, token) {
  async function request(path, options = {}) {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'eisenhower-sync-pr-status-bridge',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new Error(`GitHub API ${response.status} ${response.statusText}: ${text}`);
    }

    return payload;
  }

  return {
    getRun(runId) {
      return request(`/actions/runs/${runId}`);
    },
    async getJobs(runId) {
      const jobs = [];
      let page = 1;

      while (true) {
        const payload = await request(`/actions/runs/${runId}/jobs?per_page=100&page=${page}`);
        jobs.push(...payload.jobs);

        if (jobs.length >= payload.total_count || payload.jobs.length === 0) {
          return jobs;
        }

        page += 1;
      }
    },
    createCommitStatus(sha, payload) {
      return request(`/statuses/${sha}`, {
        method: 'POST',
        body: payload,
      });
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = requireOption('repo', args.repo || process.env.GITHUB_REPOSITORY);
  const runId = requireOption('run-id', args['run-id']);
  const phase = String(args.phase || 'completed');
  const dryRun = Boolean(args['dry-run']);
  const force = Boolean(args.force);
  const token = requireOption('token', process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  const api = createApiClient(repo, token);
  const run = await api.getRun(runId);
  const contexts = REQUIRED_CONTEXTS[run.name] ?? [];

  if (!contexts.length) {
    console.log(`Skipping workflow '${run.name}' because it has no mapped required contexts.`);
    return;
  }

  if (!force && run.event !== 'workflow_dispatch') {
    console.log(`Skipping run ${run.id} because event is '${run.event}', not workflow_dispatch.`);
    return;
  }

  if (!force && run.head_branch !== SYNC_BRANCH) {
    console.log(`Skipping run ${run.id} because branch is '${run.head_branch}', not '${SYNC_BRANCH}'.`);
    return;
  }

  if (phase !== 'completed') {
    for (const context of contexts) {
      const payload = {
        context,
        state: 'pending',
        description: truncateDescription(`Waiting for ${context} in ${run.name}.`),
        target_url: run.html_url,
      };

      if (dryRun) {
        console.log(JSON.stringify({ sha: run.head_sha, ...payload }));
      } else {
        await api.createCommitStatus(run.head_sha, payload);
      }
    }

    return;
  }

  const jobs = await api.getJobs(runId);
  const jobsByName = new Map(jobs.map((job) => [job.name, job]));

  for (const context of contexts) {
    const job = jobsByName.get(context);
    const status = resolveStatusFromJob(job);
    const payload = {
      context,
      state: status.state,
      description: truncateDescription(status.description),
      target_url: job?.html_url || run.html_url,
    };

    if (dryRun) {
      console.log(JSON.stringify({ sha: run.head_sha, ...payload }));
    } else {
      await api.createCommitStatus(run.head_sha, payload);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
