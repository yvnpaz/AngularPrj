#!/usr/bin/env node
/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { logging, tags, terminal } from '@angular-devkit/core';
import { ProcessOutput } from '@angular-devkit/core/node';
import { appendFileSync, writeFileSync } from 'fs';
import * as minimist from 'minimist';
import { filter, map, toArray } from 'rxjs/operators';
import { Command } from '../src/command';
import { defaultReporter } from '../src/default-reporter';
import { defaultStatsCapture } from '../src/default-stats-capture';
import { runBenchmark } from '../src/run-benchmark';
import { runBenchmarkWatch } from './run-benchmark-watch';


export interface MainOptions {
  args: string[];
  stdout?: ProcessOutput;
  stderr?: ProcessOutput;
}

export async function main({
  args,
  stdout = process.stdout,
  stderr = process.stderr,
}: MainOptions): Promise<0 | 1> {

  // Show usage of the CLI tool, and exit the process.
  function usage(logger: logging.Logger) {
    logger.info(tags.stripIndent`
    benchmark [options] -- [command to benchmark]

    Collects process stats from running the command.

    Options:
        --help                    Show this message.
        --verbose                 Show more information while running.
        --exit-code               Expected exit code for the command. Default is 0.
        --iterations              Number of iterations to run the benchmark over. Default is 5.
        --retries                 Number of times to retry when process fails. Default is 5.
        --cwd                     Current working directory to run the process in.
        --output-file             File to output benchmark log to.
        --overwrite-output-file   If the output file should be overwritten rather than appended to.
        --prefix                  Logging prefix.
        --watch-matcher           Text to match in stdout to mark an iteration complete.
        --watch-timeout           The maximum time in 'ms' to wait for the text specified in the matcher to be matched. Default is 10000.
        --watch-script            Script to run before each watch iteration.

    Example:
        benchmark --iterations=3 -- node my-script.js
  `);
  }

  interface BenchmarkCliArgv {
    help: boolean;
    verbose: boolean;
    'overwrite-output-file': boolean;
    'exit-code': number;
    iterations: number;
    retries: number;
    'output-file': string | null;
    cwd: string;
    prefix: string;
    'watch-timeout': number;
    'watch-matcher'?: string;
    'watch-script'?: string;
    '--': string[] | null;
  }

  // Parse the command line.
  const argv = minimist(args, {
    boolean: ['help', 'verbose', 'overwrite-output-file'],
    string: [
      'watch-matcher',
      'watch-script',
    ],
    default: {
      'exit-code': 0,
      'iterations': 5,
      'retries': 5,
      'output-file': null,
      'cwd': process.cwd(),
      'prefix': '[benchmark]',
      'watch-timeout': 10000,
    },
    '--': true,
  }) as {} as BenchmarkCliArgv;

  // Create the DevKit Logger used through the CLI.
  const logger = new logging.TransformLogger(
    'benchmark-prefix-logger',
    stream => stream.pipe(map(entry => {
      if (argv['prefix']) { entry.message = `${argv['prefix']} ${entry.message}`; }

      return entry;
    })),
  );

  // Log to console.
  logger
    .pipe(filter(entry => (entry.level != 'debug' || argv['verbose'])))
    .subscribe(entry => {
      let color: (s: string) => string = x => terminal.dim(terminal.white(x));
      let output = stdout;
      switch (entry.level) {
        case 'info':
          color = s => s;
          break;
        case 'warn':
          color = terminal.yellow;
          output = stderr;
          break;
        case 'error':
          color = terminal.red;
          output = stderr;
          break;
        case 'fatal':
          color = (x: string) => terminal.bold(terminal.red(x));
          output = stderr;
          break;
      }

      output.write(color(entry.message) + '\n');
    });


  // Print help.
  if (argv['help']) {
    usage(logger);

    return 0;
  }

  const commandArgv = argv['--'];

  const {
    'watch-timeout': watchTimeout,
    'watch-matcher': watchMatcher,
    'watch-script': watchScript,
    'exit-code': exitCode,
    'output-file': outFile,
    iterations,
    retries,
   } = argv;

  // Exit early if we can't find the command to benchmark.
  if (watchMatcher && !watchScript) {
    logger.fatal(`Cannot use --watch-matcher without specifying --watch-script.`);

    return 1;
  }

  if (!watchMatcher && watchScript) {
    logger.fatal(`Cannot use --watch-script without specifying --watch-matcher.`);

    return 1;
  }

  // Exit early if we can't find the command to benchmark.
  if (!commandArgv || !Array.isArray(argv['--']) || (argv['--'] as Array<string>).length < 1) {
    logger.fatal(`Missing command, see benchmark --help for help.`);

    return 1;
  }

  // Setup file logging.
  if (outFile !== null) {
    if (argv['overwrite-output-file']) {
      writeFileSync(outFile, '');
    }
    logger.pipe(filter(entry => (entry.level != 'debug' || argv['verbose'])))
      .subscribe(entry => appendFileSync(outFile, `${entry.message}\n`));
  }

  // Run benchmark on given command, capturing stats and reporting them.
  const cmd = commandArgv[0];
  const cmdArgs = commandArgv.slice(1);
  const command = new Command(cmd, cmdArgs, argv['cwd'], exitCode);
  const captures = [defaultStatsCapture];
  const reporters = [defaultReporter(logger)];

  logger.info(`Benchmarking process over ${iterations} iterations, with up to ${retries} retries.`);
  logger.info(`  ${command.toString()}`);

  try {
    let res$;
    if (watchMatcher && watchScript) {
      res$ = runBenchmarkWatch({
        command, captures, reporters, iterations, retries, logger,
        watchCommand: new Command('node', [watchScript]), watchMatcher, watchTimeout,
      });
    } else {
      res$ = runBenchmark(
        { command, captures, reporters, iterations, retries, logger },
      );
    }

    const res = await res$.pipe(toArray()).toPromise();
    if (res.length === 0) {
      return 1;
    }

  } catch (error) {
    if (error.message) {
      logger.fatal(error.message);
    } else {
      logger.fatal(error);
    }

    return 1;
  }

  return 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  main({ args })
    .then(exitCode => process.exitCode = exitCode)
    .catch(e => { throw (e); });
}
