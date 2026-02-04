/**
 * scripts/generate.js
 *
 * Fetches public GitHub data for a user and writes JSON/SVG files to ./data.
 * - profile.json
 * - repos.json (full list of public repos with languages & latest commit where possible)
 * - orgs.json
 * - summary.json
 * - contrib.svg (downloaded from ghchart)
 *
 * Designed to run in GitHub Actions. Use GITHUB_TOKEN or a Personal Access Token (PAT)
 * via env or --token. The script uses limited concurrency and retries where appropriate.
 *
 * Usage:
 *   node scripts/generate.js --token=XXX --user=ankit-chaubey
 *
 * Notes:
 * - The GitHub Stats API (contributors stats) may return 202 while computing; this script polls a few times.
 * - This is allowed to be as "full" as required (no artificial limits other than reasonable concurrency).
 */

const fs = require('fs').promises;
const path = require('path');
const { Octokit } = require("@octokit/rest");
const fetch = require('node-fetch');

const DATA_DIR = path.join(process.cwd(), 'data');

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function ensureDir(){
  try{ await fs.mkdir(DATA_DIR, { recursive: true }); } catch(e){ /* ignore */ }
}

function argvGet(name){
  const prefix = `--${name}=`;
  for(const a of process.argv){
    if(a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return process.env[name.toUpperCase()] || null;
}

async function fetchAllPages(octokit, requestOptions){
  // requestOptions: {method: octokit.repos.listForUser, params: {...}}
  // we will use octokit.paginate
  return octokit.paginate(requestOptions);
}

async function pollContribs(octokit, owner, repo, maxRetries = 8, delay = 1500){
  // The /stats/contributors endpoint sometimes returns 202 while computing; poll a few times.
  for(let i=0;i<maxRetries;i++){
    try{
      const res = await octokit.request('GET /repos/{owner}/{repo}/stats/contributors', {owner, repo});
      if(Array.isArray(res.data)) return res.data;
      // If it's not array, wait and retry
    }catch(e){
      // If 202, continue; otherwise break
      if(e.status === 202){ /* still computing */ }
      else return null;
    }
    await sleep(delay*(i+1));
  }
  return null;
}

(async function main(){
  const token = argvGet('token') || argvGet('GITHUB_TOKEN') || process.env.GITHUB_TOKEN || process.env.PERSONAL_TOKEN || null;
  const user = argvGet('user') || argvGet('USERNAME') || process.env.USERNAME || 'ankit-chaubey';

  if(!token){
    console.warn('No token provided. The script will still attempt to fetch public data but may be rate-limited.');
  }

  const octokit = new Octokit({ auth: token });

  await ensureDir();

  // PROFILE
  let profile = null;
  try{
    const r = await octokit.users.getByUsername({ username: user });
    profile = r.data;
    await fs.writeFile(path.join(DATA_DIR, 'profile.json'), JSON.stringify(profile, null, 2), 'utf8');
    console.log('Wrote profile.json');
  }catch(e){
    console.error('Failed fetching profile:', e.message || e);
  }

  // REPOS (paginated)
  let reposAll = [];
  try{
    console.log('Fetching repositories (paginated)');
    reposAll = await octokit.paginate(octokit.repos.listForUser, { username: user, per_page: 100, type: 'public', sort: 'pushed' });
    // normalize and pick fields we want but keep full object for completeness
    console.log(`Fetched ${reposAll.length} repositories`);
  }catch(e){
    console.error('Failed fetching repos:', e.message || e);
  }

  // ORGS
  let orgs = [];
  try{
    const o = await octokit.paginate(octokit.orgs.listForUser, { username: user, per_page: 100 });
    orgs = o;
    await fs.writeFile(path.join(DATA_DIR, 'orgs.json'), JSON.stringify(orgs, null, 2), 'utf8');
    console.log('Wrote orgs.json');
  }catch(e){
    console.error('Failed fetching orgs:', e.message || e);
  }

  // For each repo, fetch languages and latest commit (and contributors stats optionally)
  // We'll process with limited concurrency to be friendly.
  const CONCURRENCY = 8;
  const results = [];
  let idx = 0;

  async function worker(){
    while(true){
      const i = idx++;
      if(i >= reposAll.length) break;
      const repo = reposAll[i];
      const owner = repo.owner.login;
      const name = repo.name;
      console.log(`Processing repo ${i+1}/${reposAll.length}: ${owner}/${name}`);
      const out = { ...repo };

      // languages
      try{
        const langsRes = await octokit.repos.listLanguages({ owner, repo: name });
        out.languages = langsRes.data || {};
      }catch(e){
        out.languages = {};
        console.warn(`languages failed for ${name}:`, e.status || e.message || e);
      }

      // latest commit (default branch)
      try{
        const branch = repo.default_branch;
        const commitsRes = await octokit.repos.listCommits({ owner, repo: name, sha: branch, per_page: 1 });
        if(Array.isArray(commitsRes.data) && commitsRes.data.length){
          const c = commitsRes.data[0];
          out.latest_commit = {
            sha: c.sha,
            date: c.commit?.author?.date || c.commit?.committer?.date || null,
            message: c.commit?.message || null,
            url: c.html_url || null
          };
        } else {
          out.latest_commit = null;
        }
      }catch(e){
        out.latest_commit = null;
        console.warn(`latest commit failed for ${name}:`, e.status || e.message || e);
      }

      // contributors stats (best-effort) - can be heavy; poll if 202
      try{
        const stats = await pollContribs(octokit, owner, name, 6, 1500);
        if(Array.isArray(stats)){
          out.contributors_stats = stats.map(s => ({ total: s.total, author: s.author ? { login: s.author.login, url: s.author.html_url } : null }));
          // sum commits for repo
          out.commit_count_estimate = stats.reduce((s,x)=>s + (x.total || 0), 0);
        } else {
          out.contributors_stats = null;
          out.commit_count_estimate = null;
        }
      }catch(e){
        out.contributors_stats = null;
        out.commit_count_estimate = null;
      }

      results.push(out);
      // small delay to reduce burst
      await sleep(120);
    }
  }

  // start workers
  const workers = [];
  for(let w=0; w<CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);

  // sort results by pushed_at descending
  results.sort((a,b)=> new Date(b.pushed_at) - new Date(a.pushed_at));

  // write repos.json
  try{
    await fs.writeFile(path.join(DATA_DIR, 'repos.json'), JSON.stringify(results, null, 2), 'utf8');
    console.log('Wrote repos.json');
  }catch(e){
    console.error('Failed writing repos.json:', e);
  }

  // compute summary
  try{
    const sourceRepos = results.filter(r => !r.fork);
    const totalStars = sourceRepos.reduce((s,r)=> s + (r.stargazers_count || 0), 0);
    const totalForks = sourceRepos.reduce((s,r)=> s + (r.forks_count || 0), 0);
    const totalCommits = sourceRepos.reduce((s,r)=> s + (r.commit_count_estimate || 0), 0);
    const lastUpdatedRepo = results.reduce((m,r)=> r.pushed_at > m ? r.pushed_at : m, results[0]?.pushed_at || null);
    const summary = {
      generated_at: new Date().toISOString(),
      updated_at: lastUpdatedRepo,
      total_public_repos: reposAll.length,
      source_repos_count: sourceRepos.length,
      total_stars: totalStars,
      total_forks: totalForks,
      total_commits: totalCommits || null,
      followers: profile?.followers ?? null
    };
    await fs.writeFile(path.join(DATA_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log('Wrote summary.json');
  }catch(e){
    console.error('Failed writing summary:', e);
  }

  // download contribution image from ghchart.rshah.org (fast)
  try{
    const chartUrl = `https://ghchart.rshah.org/${encodeURIComponent(user)}`;
    const res = await fetch(chartUrl);
    if(res.ok){
      const buffer = await res.buffer();
      await fs.writeFile(path.join(DATA_DIR, 'contrib.svg'), buffer);
      console.log('Wrote contrib.svg from ghchart');
    } else {
      console.warn('Failed to fetch contrib.svg:', res.status);
    }
  }catch(e){
    console.warn('Failed fetching contrib.svg:', e.message || e);
  }

  console.log('Done generating data');
  process.exit(0);
})();