// This bootstrap is copied to the binary-only GitHub repository. Never copy product source there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export function releaseTag(tag) {
  if (typeof tag !== 'string' || tag !== tag.trim() || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw Error('Use a stable release tag: vMAJOR.MINOR.PATCH');
  return tag.slice(1);
}

// GitLab protects v* server-side (maintainer creation only). A deploy token has
// read_repository only: no API, write, user or group access. Do not use a personal token.
export async function resolveSource(tag, credentials, repository = 'https://gitlab.com/workspace2220840/pin2.git') {
  const version = releaseTag(tag);
  if (!credentials?.username || !credentials?.token) throw Error('PIN2_SOURCE_USERNAME and PIN2_SOURCE_TOKEN are required (project deploy token, read_repository only)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin2-release-source-'));
  const helper = path.join(dir, 'askpass.cjs');
  // The secret is read from the environment, never embedded in a URL, argv or file.
  fs.writeFileSync(helper, `#!/usr/bin/env node\nprocess.stdout.write(process.argv[2].startsWith('Username') ? process.env.PIN2_SOURCE_USERNAME : process.env.PIN2_SOURCE_TOKEN);\n`, {mode:0o700});
  const env = {...process.env, GIT_TERMINAL_PROMPT:'0', GIT_ASKPASS:helper, PIN2_SOURCE_USERNAME:credentials.username, PIN2_SOURCE_TOKEN:credentials.token};
  const git = args => {
    const r = spawnSync('git', ['-c','credential.helper=', '-C',dir,...args], {env, encoding:'utf8', timeout:300000, maxBuffer:16*1024*1024});
    if (r.status !== 0) throw Error(`GitLab release source: git ${args[0]} failed`);
    return r.stdout.trim();
  };
  const dispose = () => fs.rmSync(dir, {recursive:true, force:true});
  try {
    git(['init','--bare','.']);
    git(['remote','add','origin',repository]);
    git(['fetch','--no-tags','--filter=blob:none','origin','+refs/heads/main:refs/heads/main',`+refs/tags/${tag}:refs/tags/${tag}`]);
    const sha = git(['rev-parse',`refs/tags/${tag}^{commit}`]);
    if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Invalid release source commit');
    if (git(['merge-base',sha,'refs/heads/main']) !== sha) throw Error('The release tag is not on main');
    if (JSON.parse(git(['show',`${sha}:desktop/package.json`])).version !== version) throw Error('Tag and desktop/package.json version differ');
    return {sha, dispose, archive:async () => {
      const archive = path.join(dir,'source.tar');
      git(['archive','--format=tar',`--output=${archive}`,sha]);
      return new Response(fs.readFileSync(archive));
    }};
  } catch (e) { dispose(); throw e; }
}

async function main() {
  const tag = process.env.PIN2_RELEASE_TAG, expected = process.env.PIN2_SOURCE_SHA;
  const source = await resolveSource(tag, {username:process.env.PIN2_SOURCE_USERNAME,token:process.env.PIN2_SOURCE_TOKEN});
  try {
    if (expected && source.sha !== expected) throw Error('The source tag moved after preflight');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha=${source.sha}\ntag=${tag}\n`);
    if (process.argv.includes('--resolve-only')) return;
    const dest = path.resolve('source');
    if (fs.existsSync(dest)) throw Error('source/ already exists; use a clean runner');
    fs.mkdirSync(dest);
    const archive = path.resolve('pin2-source.tar');
    try {
      fs.writeFileSync(archive, Buffer.from(await (await source.archive()).arrayBuffer()), {mode:0o600});
      const r = spawnSync('tar', ['-xf', archive, '-C', dest], {stdio:'inherit'});
      if (r.status !== 0) throw Error('Source extraction failed');
      fs.writeFileSync(path.join(dest, '.release-source.json'), JSON.stringify({tag, sha:source.sha}) + '\n');
    } finally { fs.rmSync(archive, {force:true}); }
  } finally { source.dispose(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => {console.error(e.message);process.exitCode=1;});
