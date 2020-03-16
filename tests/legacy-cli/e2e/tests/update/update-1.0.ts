import { createProjectFromAsset } from '../../utils/assets';
import { ng, silentNpm } from '../../utils/process';
import { isPrereleaseCli, useBuiltPackages, useCIChrome, useCIDefaults } from '../../utils/project';
import { expectToFail } from '../../utils/utils';

export default async function() {
  const extraUpdateArgs = (await isPrereleaseCli()) ? ['--next', '--force'] : [];

  await createProjectFromAsset('1.0-project');

  await useCIChrome('.');
  await expectToFail(() => ng('build'));
  await ng('update', '@angular/cli');
  await useBuiltPackages();
  await silentNpm('install');
  await ng('update', '@angular/core', ...extraUpdateArgs);
  await useCIDefaults('one-oh-project');
  await ng('generate', 'component', 'my-comp');
  await ng('test', '--watch=false');
  await ng('lint');
  await ng('build');
  await ng('build', '--prod');
  await ng('e2e');
}
