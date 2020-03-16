/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { BaseException } from '@angular-devkit/core';
import { SpawnOptions, spawn } from 'child_process';
import * as ora from 'ora';
import * as path from 'path';
import { Observable } from 'rxjs';
import { TaskExecutor, UnsuccessfulWorkflowExecution } from '../../src';
import { NodePackageTaskFactoryOptions, NodePackageTaskOptions } from './options';

interface PackageManagerProfile {
  quietArgument?: string;
  commands: {
    installAll?: string;
    installPackage: string;
  };
}

const packageManagers: { [name: string]: PackageManagerProfile } = {
  'npm': {
    quietArgument: '--quiet',
    commands: {
      installAll: 'install',
      installPackage: 'install',
    },
  },
  'cnpm': {
    commands: {
      installAll: 'install',
      installPackage: 'install',
    },
   },
  'yarn': {
    quietArgument: '--silent',
    commands: {
      installPackage: 'add',
    },
  },
  'pnpm': {
    quietArgument: '--silent',
    commands: {
      installAll: 'install',
      installPackage: 'install',
    },
  },
};

export class UnknownPackageManagerException extends BaseException {
  constructor(name: string) {
    super(`Unknown package manager "${name}".`);
  }
}

export default function(
  factoryOptions: NodePackageTaskFactoryOptions = {},
): TaskExecutor<NodePackageTaskOptions> {
  const packageManagerName = factoryOptions.packageManager || 'npm';
  const packageManagerProfile = packageManagers[packageManagerName];
  if (!packageManagerProfile) {
    throw new UnknownPackageManagerException(packageManagerName);
  }

  const rootDirectory = factoryOptions.rootDirectory || process.cwd();

  return (options: NodePackageTaskOptions) => {
    let taskPackageManagerProfile = packageManagerProfile;
    let taskPackageManagerName = packageManagerName;
    if (factoryOptions.allowPackageManagerOverride && options.packageManager) {
      taskPackageManagerProfile = packageManagers[options.packageManager];
      if (!taskPackageManagerProfile) {
        throw new UnknownPackageManagerException(options.packageManager);
      }
      taskPackageManagerName = options.packageManager;
    }

    const bufferedOutput: {stream: NodeJS.WriteStream, data: Buffer}[] = [];
    const spawnOptions: SpawnOptions = {
      stdio: !!options.hideOutput ? 'pipe' : 'inherit',
      shell: true,
      cwd: path.join(rootDirectory, options.workingDirectory || ''),
    };
    const args: string[] = [];

    if (options.packageName) {
      if (options.command === 'install') {
        args.push(taskPackageManagerProfile.commands.installPackage);
      }
      args.push(options.packageName);
    } else if (options.command === 'install' && taskPackageManagerProfile.commands.installAll) {
      args.push(taskPackageManagerProfile.commands.installAll);
    }

    if (options.quiet && taskPackageManagerProfile.quietArgument) {
      args.push(taskPackageManagerProfile.quietArgument);
    }

    if (factoryOptions.registry) {
      args.push(`--registry="${factoryOptions.registry}"`);
    }

    return new Observable(obs => {
      const spinner = ora({
        text: 'Installing packages...',
        // Workaround for https://github.com/sindresorhus/ora/issues/136.
        discardStdin: process.platform != 'win32',
      }).start();
      const childProcess = spawn(taskPackageManagerName, args, spawnOptions)
        .on('close', (code: number) => {
          if (code === 0) {
            spinner.succeed('Packages installed successfully.');
            spinner.stop();
            obs.next();
            obs.complete();
          } else {
            if (options.hideOutput) {
              bufferedOutput.forEach(({ stream, data }) => stream.write(data));
            }
            spinner.fail('Package install failed, see above.');
            obs.error(new UnsuccessfulWorkflowExecution());
          }
      });
      if (options.hideOutput) {
        childProcess.stdout.on('data', (data: Buffer) =>
          bufferedOutput.push({ stream: process.stdout, data: data }));
        childProcess.stderr.on('data', (data: Buffer) =>
          bufferedOutput.push({ stream: process.stderr, data: data }));
      }
    });

  };
}
