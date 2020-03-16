import { createProjectFromAsset } from '../../utils/assets';
import { ng, silentNpm } from '../../utils/process';
import { isPrereleaseCli, useBuiltPackages } from '../../utils/project';
import { expectToFail } from '../../utils/utils';

export default async function() {
  const extraUpdateArgs = (await isPrereleaseCli()) ? ['--next', '--force'] : [];

  await createProjectFromAsset('1.7-project');

  await expectToFail(() => ng('build'));
  await ng('update', '@angular/cli', '--migrate-only', '--from=1.7.1');
  await useBuiltPackages();
  await silentNpm('install');
  await ng('update', '@angular/core', ...extraUpdateArgs);
  await ng('build');
}
