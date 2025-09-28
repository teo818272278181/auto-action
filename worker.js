// --- Worker for App Deployment Runner ---
// This worker handles all GitHub API interactions and job status polling
// to keep the main UI thread responsive.

let apiCache = {}; // ETag cache for high-speed polling
let trackedJobs = [];
let pollingTimeout = null;
const REPO_NAME = 'ci-build-env';
const WORKFLOW_NAME = 'build.yml';

// --- API Functions (Worker-side) ---
async function githubApi(endpoint, token, options = {}) {
    const url = `https://api.github.com${endpoint}`;
    const headers = { "Authorization": `token ${token}`, "Accept": "application/vnd.github.v3+json", ...options.headers };
    if ((options.method === 'GET' || !options.method) && apiCache[url]?.etag) { headers['If-None-Match'] = apiCache[url].etag; }
    
    try {
        const response = await fetch(url, { ...options, headers });
        
        if (response.status === 304) { 
            return { data: apiCache[url].data, error: null };
        }
        
        const responseBody = response.status === 204 || response.status === 202 ? null : await response.json();
        
        if (!response.ok) {
            const error = new Error(`API Error (${response.status}): ${responseBody.message || 'Unknown error'}`);
            error.status = response.status;
            return { data: null, error };
        }

        if (response.status === 200 && (options.method === 'GET' || !options.method)) {
            const etag = response.headers.get('ETag');
            if (etag) { apiCache[url] = { etag, data: responseBody }; }
        }
        return { data: responseBody, error: null };
    } catch (error) {
        return { data: null, error };
    }
}

// --- Polling Logic (Worker-side) ---
async function pollJobStatuses() {
    if (pollingTimeout) clearTimeout(pollingTimeout);
    pollingTimeout = null;

    const jobsToUpdate = trackedJobs.filter(j => !['completed', 'error'].includes(j.status));
    if (jobsToUpdate.length === 0) {
        postMessage({ type: 'POLLING_STOPPED' });
        return;
    }

    let changed = false;
    const pollToken = jobsToUpdate[0]?.token; // Use a token from an active job
    if (!pollToken) {
        pollingTimeout = setTimeout(pollJobStatuses, 10000);
        return;
    }
    
    const now = new Date();
    trackedJobs.forEach(job => {
        if (job.status === 'awaiting_confirmation' && (now - new Date(job.startTime)) > 3 * 60 * 1000) { // 3 minute timeout
            job.status = 'error';
            job.name = 'Error (Timeout)';
            job.errorMessage = 'Could not find corresponding workflow run after 3 minutes.';
            changed = true;
        }
    });

    const jobsByOwner = jobsToUpdate.reduce((acc, job) => {
        if (!acc[job.owner]) acc[job.owner] = [];
        acc[job.owner].push(job);
        return acc;
    }, {});

    const promises = Object.keys(jobsByOwner).map(async (owner) => {
        const ownerJobs = jobsByOwner[owner];
        const jobsAwaitingConfirmation = ownerJobs.filter(j => j.status === 'awaiting_confirmation' && j.commit_sha);
        const monitoringJobs = ownerJobs.filter(j => j.run_id);
        
        try {
            const oldestStartTime = ownerJobs.reduce((oldest, job) => new Date(job.startTime) < oldest ? new Date(job.startTime) : oldest, new Date());
            const searchDate = new Date(oldestStartTime - 30000).toISOString();
            const { data: runsData, error } = await githubApi(`/repos/${owner}/${REPO_NAME}/actions/workflows/${WORKFLOW_NAME}/runs?created:>=${searchDate}&per_page=100`, pollToken);
            if (error) throw error;
            const { workflow_runs } = runsData;

            if (jobsAwaitingConfirmation.length > 0) {
                const knownRunIds = new Set(trackedJobs.map(j => j.run_id).filter(Boolean));
                const commitSha = jobsAwaitingConfirmation[0].commit_sha;

                const potentialNewRuns = workflow_runs
                    .filter(run => run.head_sha === commitSha && !knownRunIds.has(run.id))
                    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

                const sortedAwaitingJobs = jobsAwaitingConfirmation.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

                for (let i = 0; i < sortedAwaitingJobs.length; i++) {
                    if (i < potentialNewRuns.length) {
                        const job = sortedAwaitingJobs[i];
                        const newRun = potentialNewRuns[i];
                        job.run_id = newRun.id;
                        job.status = newRun.status;
                        job.conclusion = newRun.conclusion;
                        job.html_url = newRun.html_url;
                        job.run_number = newRun.run_number;
                        job.name = `#${newRun.run_number} - Build by ${job.owner}`;
                        delete job.commit_sha;
                        changed = true;
                    }
                }
            }
            
            for (const job of monitoringJobs) {
                const remoteRun = workflow_runs.find(r => r.id === job.run_id);
                if (remoteRun) {
                     if (job.status !== remoteRun.status || job.conclusion !== remoteRun.conclusion) {
                        job.status = remoteRun.status;
                        job.conclusion = remoteRun.conclusion;
                        changed = true;
                    }
                } else {
                    const { data: finalRunData, error } = await githubApi(`/repos/${job.owner}/${REPO_NAME}/actions/runs/${job.run_id}`, job.token);
                    if (error) {
                        job.status = 'completed';
                        job.conclusion = 'failure';
                    } else {
                        job.status = finalRunData.status;
                        job.conclusion = finalRunData.conclusion;
                    }
                    changed = true;
                }
            }
        } catch (e) {
            console.error(`Polling error for owner ${owner}:`, e);
        }
    });

    await Promise.allSettled(promises);

    if (changed) {
        postMessage({ type: 'UPDATE_JOBS', payload: { jobs: trackedJobs } });
    }

    const hasActiveJobs = trackedJobs.some(j => !['completed', 'error'].includes(j.status));
    if (hasActiveJobs) {
        let interval = trackedJobs.some(j => j.status === 'awaiting_confirmation') ? 2000 : 5000;
        pollingTimeout = setTimeout(pollJobStatuses, interval);
    } else {
        postMessage({ type: 'POLLING_STOPPED' });
    }
}

// --- Worker Event Listener ---
self.onmessage = async (e) => {
    const { type, payload } = e.data;

    switch (type) {
        case 'INIT':
            trackedJobs = payload.jobs;
            if (trackedJobs.some(j => !['completed', 'error'].includes(j.status))) {
                pollJobStatuses();
            }
            break;
        case 'START_POLLING':
            trackedJobs = payload.jobs;
            if (!pollingTimeout) {
                pollJobStatuses();
            }
            break;
        case 'API_REQUEST':
            const { endpoint, token, options, requestId } = payload;
            const { data, error } = await githubApi(endpoint, token, options);
            postMessage({ type: 'API_RESPONSE', payload: { data, error, requestId } });
            break;
        case 'UPDATE_JOBS_IN_WORKER':
            trackedJobs = payload.jobs;
            break;
    }
};
