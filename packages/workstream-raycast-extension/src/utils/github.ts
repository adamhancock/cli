import { exec } from 'child_process';
import { promisify } from 'util';
import type { PRStatus, PRCheck } from '../types';

const execAsync = promisify(exec);

/**
 * Get PR status for a given repository path and branch
 */
export async function getPRStatus(repoPath: string, branch?: string): Promise<PRStatus | null> {
  try {
    // Check if this is a GitHub repository
    const { stdout: remoteUrl } = await execAsync(
      `/usr/bin/git -C "${repoPath}" remote get-url origin 2>/dev/null || true`
    );

    if (!remoteUrl || !remoteUrl.includes('github.com')) {
      return null;
    }

    // Get current branch if not provided
    if (!branch) {
      const { stdout: currentBranch } = await execAsync(
        `/usr/bin/git -C "${repoPath}" rev-parse --abbrev-ref HEAD`
      );
      branch = currentBranch.trim();
    }

    // Get basic PR information using branch name and repo URL
    const { stdout: prInfo } = await execAsync(
      `/opt/homebrew/bin/gh pr view "${branch}" --repo="$(/usr/bin/git -C "${repoPath}" remote get-url origin)" --json number,title,url,state,author,mergeable,labels 2>/dev/null`
    );

    if (!prInfo.trim()) {
      return null;
    }

    const pr = JSON.parse(prInfo);

    // Get PR check status for open PRs
    let checks: PRStatus['checks'] | undefined;
    if (pr.state === 'OPEN') {
      try {
        const { stdout: checksInfo } = await execAsync(
          `/opt/homebrew/bin/gh pr checks "${branch}" --repo="$(/usr/bin/git -C "${repoPath}" remote get-url origin)" --json bucket,name,state 2>/dev/null`
        );

        if (checksInfo.trim()) {
          const checkResults: PRCheck[] = JSON.parse(checksInfo);

          const passing = checkResults.filter((c) => c.bucket === 'pass').length;
          const failing = checkResults.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').length;
          const actuallyPending = checkResults.filter((c) => c.bucket === 'pending').length;
          const skipping = checkResults.filter((c) => c.bucket === 'skipping').length;

          // Total pending includes both pending and skipping for display
          const pending = actuallyPending + skipping;

          let conclusion: 'success' | 'failure' | 'pending';
          // Only consider 'pending' bucket as actually running, not 'skipping'
          if (actuallyPending > 0) {
            conclusion = 'pending';
          } else if (failing > 0) {
            conclusion = 'failure';
          } else {
            conclusion = 'success';
          }

          checks = {
            total: checkResults.length,
            passing,
            failing,
            pending,
            conclusion,
            runs: checkResults,
          };
        }
      } catch {
        // No checks available or gh pr checks failed
      }
    }

    // Fetch unresolved review comments and Copilot review status via GraphQL
    let unresolvedComments: number | undefined;
    let copilotReviewStatus: 'clean' | 'comments' | 'pending' | undefined;
    try {
      const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (match && pr.number) {
        const [, owner, name] = match;
        const { stdout: graphqlOut } = await execAsync(
          `/opt/homebrew/bin/gh api graphql -f query='query($number:Int!,$owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){databaseId reviewThreads(first:100){nodes{isResolved}}reviews(last:20){nodes{author{login}body state}}}}}' -F number=${pr.number} -F owner=${owner} -F name=${name} 2>/dev/null`
        );
        if (graphqlOut.trim()) {
          const graphqlData = JSON.parse(graphqlOut);
          const prData = graphqlData?.data?.repository?.pullRequest;

          // Unresolved comment threads
          const threads = prData?.reviewThreads?.nodes || [];
          const unresolved = threads.filter((t: { isResolved: boolean }) => !t.isResolved).length;
          if (unresolved > 0) {
            unresolvedComments = unresolved;
          }

          // Check Copilot Business API for in-progress review task first
          // (takes priority over historical review comments)
          const prDatabaseId = prData?.databaseId;
          if (prDatabaseId) {
            try {
              const { stdout: ghToken } = await execAsync('/opt/homebrew/bin/gh auth token 2>/dev/null');
              if (ghToken.trim()) {
                const { stdout: tasksOut } = await execAsync(
                  `curl -s -H "Authorization: Bearer ${ghToken.trim()}" -H "Accept: application/json" "https://api.business.githubcopilot.com/agents/repos/${owner}/${name}/tasks" 2>/dev/null`
                );
                if (tasksOut.trim()) {
                  const tasksData = JSON.parse(tasksOut);
                  const tasks = tasksData?.tasks || [];
                  const prTask = [...tasks].reverse().find((t: { name?: string; state?: string; artifacts?: Array<{ data?: { id?: number; type?: string } }> }) =>
                    t.name?.toLowerCase().includes('review') &&
                    t.artifacts?.some(a => a.data?.id === prDatabaseId && a.data?.type === 'pull')
                  );
                  if (prTask) {
                    if (prTask.state === 'in_progress' || prTask.state === 'queued') {
                      copilotReviewStatus = 'pending';
                    }
                  }
                }
              }
            } catch {
              // Copilot Business API failed, skip
            }
          }

          // Check completed Copilot reviews from GraphQL (only if not already pending)
          if (!copilotReviewStatus) {
            const reviews = prData?.reviews?.nodes || [];
            const copilotReview = [...reviews].reverse().find((r: { author?: { login?: string }; body?: string }) =>
              r.author?.login?.toLowerCase().includes('copilot')
            );
            if (copilotReview) {
              if (copilotReview.body?.includes('generated no new comments')) {
                copilotReviewStatus = 'clean';
              } else {
                // Only mark as 'comments' if there are unresolved comment threads
                // (resolved/outdated comments should not count)
                copilotReviewStatus = unresolved > 0 ? 'comments' : 'clean';
              }
            }
          }
        }
      }
    } catch {
      // GraphQL query failed, skip
    }

    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      author: pr.author?.login || pr.author?.name || 'Unknown',
      mergeable: pr.mergeable,
      labels: pr.labels?.map((label: { name: string }) => label.name) || [],
      unresolvedComments,
      copilotReviewStatus,
      checks,
    };
  } catch (error) {
    // No PR for this branch or gh command failed
    return null;
  }
}

/**
 * Check if gh CLI is installed and authenticated
 */
export async function isGitHubCLIAvailable(): Promise<boolean> {
  try {
    await execAsync('/opt/homebrew/bin/gh auth status 2>/dev/null');
    return true;
  } catch {
    return false;
  }
}
