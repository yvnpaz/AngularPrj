/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
// tslint:disable:no-console
// tslint:disable:no-implicit-dependencies
import { JsonObject, logging } from '@angular-devkit/core';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { packages } from '../lib/packages';

const changelogTemplate = require('./templates/changelog').default;

const conventionalCommitsParser = require('conventional-commits-parser');
const gitRawCommits = require('git-raw-commits');
const ghGot = require('gh-got');
const through = require('through2');

export interface ChangelogOptions {
  from: string;
  to?: string;
  githubTokenFile?: string;
  githubToken?: string;

  stdout?: boolean;
}

function exec(command: string, input?: string): string {
  return execSync(command, {
    encoding: 'utf8',
    stdio: 'pipe',
    input,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

export default async function(args: ChangelogOptions, logger: logging.Logger) {
  const commits: JsonObject[] = [];
  let toSha: string | null = null;

  const githubToken = (
    args.githubToken ||
    (args.githubTokenFile && fs.readFileSync(args.githubTokenFile, 'utf-8')) ||
    ''
  ).trim();

  // Validate and scrub commit range options
  const from = exec(`git rev-parse --verify "${args.from.replace(/"/g, '')}"`);
  if (!from) {
    logger.error(`"from" value [${args.from}] is invalid.`);

    return;
  }
  const to = exec(`git rev-parse --verify "${args.to?.replace(/"/g, '') || 'HEAD'}"`);
  if (!to) {
    logger.error(`"to" value [${args.to}] is invalid.`);

    return;
  }

  // Collect patch identifiers for cherry-pick exclusion
  const cherryPicked = new Set<string>();
  const patchIds = new Map<string, string>();
  const hashes = exec(`git rev-list ${from}...${to}`).split(/\s+/);
  for (const hash of hashes) {
    const [patchId] = exec('git patch-id', exec('git show ' + hash)).split(/\s+/);
    const existing = patchIds.get(patchId);
    if (existing) {
      cherryPicked.add(existing);
      cherryPicked.add(hash);
    } else {
      patchIds.set(patchId, hash);
    }
  }

  return new Promise(resolve => {
    (gitRawCommits({
      from: args.from,
      to: args.to || 'HEAD',
      format: '%B%n-hash-%n%H%n-gitTags-%n%D%n-committerDate-%n%ci%n-authorName-%n%aN%n',
    }) as NodeJS.ReadStream)
      .on('error', err => {
        logger.fatal('An error happened: ' + err.message);
        process.exit(1);
      })
      .pipe(
        through((chunk: Buffer, enc: string, callback: Function) => {
          // Replace github URLs with `@XYZ#123`
          const commit = chunk
            .toString('utf-8')
            .replace(/https?:\/\/github.com\/(.*?)\/issues\/(\d+)/g, '@$1#$2');

          callback(undefined, Buffer.from(commit));
        }),
      )
      .pipe(
        conventionalCommitsParser({
          headerPattern: /^(\w*)(?:\(([^)]*)\))?: (.*)$/,
          headerCorrespondence: ['type', 'scope', 'subject'],
          noteKeywords: ['BREAKING CHANGE'],
          revertPattern: /^revert:\s([\s\S]*?)\s*This reverts commit (\w*)\./,
          revertCorrespondence: [`header`, `hash`],
        }),
      )
      .pipe(
        through.obj((chunk: JsonObject, _: string, cb: Function) => {
          try {
            const maybeTag = chunk.gitTags && (chunk.gitTags as string).match(/tag: (.*)/);
            const tags = maybeTag && maybeTag[1].split(/,/g);
            chunk['tags'] = tags;

            if (tags && tags.find(x => x == args.to)) {
              toSha = chunk.hash as string;
            }
            if (!cherryPicked.has(chunk.hash as string)) {
              commits.push(chunk);
            }
            cb();
          } catch (err) {
            cb(err);
          }
        }),
      )
      .on('finish', resolve);
  })
    .then(() => {
      const markdown: string = changelogTemplate({
        ...args,
        include: (x: string, v: {}) => require('./' + path.join('templates', x)).default(v),
        commits,
        packages,
      });

      if (args.stdout || !githubToken) {
        console.log(markdown);
        process.exit(0);
      }

      // Check if we need to edit or create a new one.
      return ghGot('repos/angular/angular-cli/releases').then((x: JsonObject) => [x, markdown]);
    })
    .then(([body, markdown]) => {
      const json = body.body;

      const maybeRelease = json.find((x: JsonObject) => x.tag_name == args.to);
      const id = maybeRelease ? `/${maybeRelease.id}` : '';

      const semversion = (args.to && semver.parse(args.to)) || { prerelease: '' };

      return ghGot('repos/angular/angular-cli/releases' + id, {
        body: {
          body: markdown,
          draft: !maybeRelease,
          name: args.to,
          prerelease: semversion.prerelease.length > 0,
          tag_name: args.to,
          ...(toSha ? { target_commitish: toSha } : {}),
        },
        token: githubToken,
      });
    });
}
