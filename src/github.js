import "./test-files.js";

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Parses `https://github.com/{owner}/{repo}/pull/{number}` (with any trailing path). */
export const parsePrUrl = (url) => {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url ?? "");
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
};

const request = async (path, token, init = {}) => {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new GitHubError(response.status, body.message ?? response.statusText);
  }
  return response.json();
};

const graphql = async (query, variables, token) => {
  const { data, errors } = await request("/graphql", token, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  if (errors) throw new GitHubError(200, errors[0].message);
  return data;
};

const toPr = (pr) => ({
  number: pr.number,
  title: pr.title,
  url: pr.html_url,
  branch: pr.head.ref,
  additions: pr.additions,
  deletions: pr.deletions,
  state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open",
});

// Linear's bot comments on linked PRs with this marker, then its "Review in Linear" link.
const LINEAR_REVIEW_LINK = /<!-- linear-review-link -->[\s\S]*?href="(https:\/\/linear\.app\/[^"]+\/review\/[^"]+)"/;

/**
 * Maps each PR number to its review decision ("approved", "changes_requested", or null)
 * and its Linear review URL (or null). Only GraphQL has both in one query, and it needs a
 * token, so without one the map is empty.
 */
const fetchPrDetails = async ({ owner, repo }, numbers, token) => {
  if (!token) return new Map();
  const fields = numbers
    .map((n) => `pr${n}: pullRequest(number: ${n}) { reviewDecision comments(first: 30) { nodes { body } } }`)
    .join(" ");
  const data = await graphql(
    `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`,
    { owner, repo },
    token,
  );
  return new Map(
    numbers.map((n) => {
      const pr = data.repository[`pr${n}`];
      const linearUrl = pr?.comments.nodes.map((c) => LINEAR_REVIEW_LINK.exec(c.body)?.[1]).find(Boolean);
      return [n, { review: pr?.reviewDecision?.toLowerCase() ?? null, linearUrl: linearUrl ?? null }];
    }),
  );
};

// Details only add to a copy, so a failed lookup must not block it.
const withDetails = (pr, details) => ({
  ...pr,
  review: details.get(pr.number)?.review ?? null,
  linearUrl: details.get(pr.number)?.linearUrl ?? null,
});

// GitHub lists a PR's files 100 a page, and no more than 3000 in all.
const fetchFiles = async ({ owner, repo, number }, token, count) => {
  const pages = Math.min(Math.ceil(count / 100), 30);
  const lists = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      request(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${i + 1}`, token),
    ),
  );
  return lists.flat();
};

const sum = (files, key) => files.reduce((total, file) => total + file[key], 0);

/**
 * Loads a PR. With `skipTests`, its diff stat leaves out test files, which takes one more
 * request per 100 files.
 */
export const fetchPr = async (ref, token, { skipTests = false } = {}) => {
  const pr = await request(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token);
  if (!skipTests) return toPr(pr);
  const files = (await fetchFiles(ref, token, pr.changed_files)).filter((file) => !isTestFile(file.filename));
  return { ...toPr(pr), additions: sum(files, "additions"), deletions: sum(files, "deletions") };
};

const FILES_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      files(first: 100, after: $after) { nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } }
    }
  }
}`;

const fetchViewedStates = async ({ owner, repo, number }, token) => {
  const files = [];
  let after = null;
  let id;
  do {
    const { pullRequest } = (await graphql(FILES_QUERY, { owner, repo, number, after }, token)).repository;
    id = pullRequest.id;
    files.push(...pullRequest.files.nodes);
    after = pullRequest.files.pageInfo.hasNextPage ? pullRequest.files.pageInfo.endCursor : null;
  } while (after);
  return { id, files };
};

const MARKS_PER_REQUEST = 50;

/**
 * Marks the PR's unviewed test files as viewed for the token's owner, and returns how many
 * it marked.
 */
export const markTestFilesViewed = async (ref, token) => {
  const { id, files } = await fetchViewedStates(ref, token);
  const paths = files
    .filter((file) => file.viewerViewedState !== "VIEWED" && isTestFile(file.path))
    .map((file) => file.path);
  for (let start = 0; start < paths.length; start += MARKS_PER_REQUEST) {
    const batch = paths.slice(start, start + MARKS_PER_REQUEST);
    const params = batch.map((_, i) => `$path${i}: String!`).join(", ");
    const marks = batch
      .map((_, i) => `mark${i}: markFileAsViewed(input: { pullRequestId: $id, path: $path${i} }) { clientMutationId }`)
      .join(" ");
    const variables = Object.fromEntries(batch.map((path, i) => [`path${i}`, path]));
    await graphql(`mutation($id: ID!, ${params}) { ${marks} }`, { id, ...variables }, token);
  }
  return paths.length;
};

/**
 * Returns the GitHub stack containing the PR, as its trunk branch and its PRs top of the
 * stack first, or null when the PR isn't in a stack.
 */
export const fetchStack = async ({ owner, repo, number }, token, options) => {
  const stacks = await request(`/repos/${owner}/${repo}/stacks?pull_request=${number}`, token);
  const stack = stacks.find((s) => s.pull_requests.some((pr) => pr.number === number));
  if (!stack) return null;

  // The API lists PRs bottom first; Graphite pastes the top of the stack first.
  const numbers = stack.pull_requests.map((pr) => pr.number).reverse();
  const [prs, details] = await Promise.all([
    Promise.all(numbers.map((n) => fetchPr({ owner, repo, number: n }, token, options))),
    fetchPrDetails({ owner, repo }, numbers, token).catch(() => new Map()),
  ]);
  return { trunk: stack.base.ref, prs: prs.map((pr) => withDetails(pr, details)) };
};

/**
 * Loads the PR and, when it sits in a stack of two or more PRs, that stack. `stackFailed`
 * tells a stack that couldn't load apart from a PR that has none. `options` go to fetchPr.
 */
export const fetchPrWithStack = async (ref, token, options) => {
  const [pr, details, stack] = await Promise.all([
    fetchPr(ref, token, options),
    fetchPrDetails(ref, [ref.number], token).catch(() => new Map()),
    // A missing stack must not block copying the PR itself. A 404 means the repo has no stacks.
    fetchStack(ref, token, options).catch((error) => (error.status === 404 ? null : undefined)),
  ]);
  return {
    pr: withDetails(pr, details),
    stack: stack && stack.prs.length > 1 ? stack : null,
    stackFailed: stack === undefined,
  };
};
