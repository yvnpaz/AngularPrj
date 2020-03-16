/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  BuildOptimizerWebpackPlugin,
  buildOptimizerLoaderPath,
} from '@angular-devkit/build-optimizer';
import { tags } from '@angular-devkit/core';
import * as CopyWebpackPlugin from 'copy-webpack-plugin';
import { existsSync } from 'fs';
import * as path from 'path';
import { RollupOptions } from 'rollup';
import { ScriptTarget } from 'typescript';
import {
  ChunkData,
  Compiler,
  Configuration,
  ContextReplacementPlugin,
  HashedModuleIdsPlugin,
  Plugin,
  Rule,
  compilation,
  debug,
} from 'webpack';
import { RawSource } from 'webpack-sources';
import { AssetPatternClass } from '../../../browser/schema';
import { BuildBrowserFeatures, maxWorkers } from '../../../utils';
import { findCachePath } from '../../../utils/cache-path';
import {
  allowMangle,
  allowMinify,
  cachingDisabled,
  shouldBeautify,
} from '../../../utils/environment-options';
import { BundleBudgetPlugin } from '../../plugins/bundle-budget';
import { NamedLazyChunksPlugin } from '../../plugins/named-chunks-plugin';
import { OptimizeCssWebpackPlugin } from '../../plugins/optimize-css-webpack-plugin';
import { ScriptsWebpackPlugin } from '../../plugins/scripts-webpack-plugin';
import { WebpackRollupLoader } from '../../plugins/webpack';
import { findAllNodeModules } from '../../utilities/find-up';
import { WebpackConfigOptions } from '../build-options';
import { getEsVersionForFileName, getOutputHashFormat, normalizeExtraEntryPoints } from './utils';

const ProgressPlugin = require('webpack/lib/ProgressPlugin');
const CircularDependencyPlugin = require('circular-dependency-plugin');
const TerserPlugin = require('terser-webpack-plugin');


// tslint:disable-next-line:no-big-function
export function getCommonConfig(wco: WebpackConfigOptions): Configuration {
  const { root, projectRoot, buildOptions, tsConfig } = wco;
  const { styles: stylesOptimization, scripts: scriptsOptimization } = buildOptions.optimization;
  const {
    styles: stylesSourceMap,
    scripts: scriptsSourceMap,
    vendor: vendorSourceMap,
  } = buildOptions.sourceMap;

  const extraPlugins: Plugin[] = [];
  const extraRules: Rule[] = [];
  const entryPoints: { [key: string]: string[] } = {};

  // determine hashing format
  const hashFormat = getOutputHashFormat(buildOptions.outputHashing || 'none');

  const targetInFileName = getEsVersionForFileName(
    tsConfig.options.target,
    buildOptions.esVersionInFileName,
  );

  if (buildOptions.main) {
    const mainPath = path.resolve(root, buildOptions.main);
    entryPoints['main'] = [mainPath];

    if (buildOptions.experimentalRollupPass) {
      // NOTE: the following are known problems with experimentalRollupPass
      // - vendorChunk, commonChunk, namedChunks: these won't work, because by the time webpack
      // sees the chunks, the context of where they came from is lost.
      // - webWorkerTsConfig: workers must be imported via a root relative path (e.g.
      // `app/search/search.worker`) instead of a relative path (`/search.worker`) because
      // of the same reason as above.
      // - loadChildren string syntax: doesn't work because rollup cannot follow the imports.

      // Rollup options, except entry module, which is automatically inferred.
      const rollupOptions: RollupOptions = {};

      // Add rollup plugins/rules.
      extraRules.push({
        test: mainPath,
        // Ensure rollup loader executes after other loaders.
        enforce: 'post',
        use: [{
          loader: WebpackRollupLoader,
          options: rollupOptions,
        }],
      });

      // Rollup bundles will include the dynamic System.import that was inside Angular and webpack
      // will emit warnings because it can't resolve it. We just ignore it.
      // TODO: maybe use https://webpack.js.org/configuration/stats/#statswarningsfilter instead.

      // Ignore all "Critical dependency: the request of a dependency is an expression" warnings.
      extraPlugins.push(new ContextReplacementPlugin(/./));
      // Ignore "System.import() is deprecated" warnings for the main file and js files.
      // Might still get them if @angular/core gets split into a lazy module.
      extraRules.push({
        test: mainPath,
        enforce: 'post',
        parser: { system: true },
      });
      extraRules.push({
        test: /\.js$/,
        enforce: 'post',
        parser: { system: true },
      });
    }
  }

  const differentialLoadingMode = !!wco.differentialLoadingMode;
  if (wco.buildOptions.platform !== 'server') {
    if (differentialLoadingMode || tsConfig.options.target === ScriptTarget.ES5) {
      const buildBrowserFeatures = new BuildBrowserFeatures(
        projectRoot,
        tsConfig.options.target || ScriptTarget.ES5,
      );

      if (
        buildOptions.es5BrowserSupport ||
        (buildOptions.es5BrowserSupport === undefined && buildBrowserFeatures.isEs5SupportNeeded())
      ) {
        const polyfillsChunkName = 'polyfills-es5';
        entryPoints[polyfillsChunkName] = [path.join(__dirname, '..', 'es5-polyfills.js')];
        if (differentialLoadingMode) {
          // Add zone.js legacy support to the es5 polyfills
          // This is a noop execution-wise if zone-evergreen is not used.
          entryPoints[polyfillsChunkName].push('zone.js/dist/zone-legacy');

          // Since the chunkFileName option schema does not allow the function overload, add a plugin
          // that changes the name of the ES5 polyfills chunk to not include ES2015.
          extraPlugins.push({
            apply(compiler) {
              compiler.hooks.compilation.tap('build-angular', compilation => {
                // Webpack typings do not contain MainTemplate assetPath hook
                // The webpack.Compilation assetPath hook is a noop in 4.x so the template must be used
                // tslint:disable-next-line: no-any
                (compilation.mainTemplate.hooks as any).assetPath.tap(
                  'build-angular',
                (filename: string | ((data: ChunkData) => string), data: ChunkData) => {
                    const assetName = typeof filename === 'function' ? filename(data) : filename;
                    const isMap = assetName && assetName.endsWith('.map');

                    return data.chunk && data.chunk.name === 'polyfills-es5'
                      ? `polyfills-es5${hashFormat.chunk}.js${isMap ? '.map' : ''}`
                      : assetName;
                  },
                );
              });
            },
          });
        }
        if (!buildOptions.aot) {
          if (differentialLoadingMode) {
            entryPoints[polyfillsChunkName].push(path.join(__dirname, '..', 'jit-polyfills.js'));
          }
          entryPoints[polyfillsChunkName].push(path.join(__dirname, '..', 'es5-jit-polyfills.js'));
        }
        // If not performing a full differential build the polyfills need to be added to ES5 bundle
        if (buildOptions.polyfills) {
          entryPoints[polyfillsChunkName].push(path.resolve(root, buildOptions.polyfills));
        }
      }
    }

    if (buildOptions.polyfills) {
      entryPoints['polyfills'] = [
        ...(entryPoints['polyfills'] || []),
        path.resolve(root, buildOptions.polyfills),
      ];
    }

    if (!buildOptions.aot) {
      entryPoints['polyfills'] = [
        ...(entryPoints['polyfills'] || []),
        path.join(__dirname, '..', 'jit-polyfills.js'),
      ];
    }
  }

  if (buildOptions.profile || process.env['NG_BUILD_PROFILING']) {
    extraPlugins.push(
      new debug.ProfilingPlugin({
        outputPath: path.resolve(root, `chrome-profiler-events${targetInFileName}.json`),
      }),
    );
  }

  // process global scripts
  const globalScriptsByBundleName = normalizeExtraEntryPoints(
    buildOptions.scripts,
    'scripts',
  ).reduce((prev: { bundleName: string; paths: string[]; inject: boolean }[], curr) => {
    const { bundleName, inject, input } = curr;
    const resolvedPath = path.resolve(root, input);

    if (!existsSync(resolvedPath)) {
      throw new Error(`Script file ${input} does not exist.`);
    }

    const existingEntry = prev.find(el => el.bundleName === bundleName);
    if (existingEntry) {
      if (existingEntry.inject && !inject) {
        // All entries have to be lazy for the bundle to be lazy.
        throw new Error(
          `The ${bundleName} bundle is mixing injected and non-injected scripts.`,
        );
      }

      existingEntry.paths.push(resolvedPath);
    } else {
      prev.push({
        bundleName,
        inject,
        paths: [resolvedPath],
      });
    }

    return prev;
  }, []);

  if (globalScriptsByBundleName.length > 0) {
    // Add a new asset for each entry.
    globalScriptsByBundleName.forEach(script => {
      // Lazy scripts don't get a hash, otherwise they can't be loaded by name.
      const hash = script.inject ? hashFormat.script : '';
      const bundleName = script.bundleName;

      extraPlugins.push(
        new ScriptsWebpackPlugin({
          name: bundleName,
          sourceMap: scriptsSourceMap,
          filename: `${path.basename(bundleName)}${hash}.js`,
          scripts: script.paths,
          basePath: projectRoot,
        }),
      );
    });
  }

  // process asset entries
  if (buildOptions.assets.length) {
    const copyWebpackPluginPatterns = buildOptions.assets.map((asset: AssetPatternClass) => {
      // Resolve input paths relative to workspace root and add slash at the end.
      asset.input = path.resolve(root, asset.input).replace(/\\/g, '/');
      asset.input = asset.input.endsWith('/') ? asset.input : asset.input + '/';
      asset.output = asset.output.endsWith('/') ? asset.output : asset.output + '/';

      if (asset.output.startsWith('..')) {
        const message = 'An asset cannot be written to a location outside of the output path.';
        throw new Error(message);
      }

      return {
        context: asset.input,
        // Now we remove starting slash to make Webpack place it from the output root.
        to: asset.output.replace(/^\//, ''),
        ignore: asset.ignore,
        from: {
          glob: asset.glob,
          dot: true,
        },
      };
    });

    const copyWebpackPluginOptions = { ignore: ['.gitkeep', '**/.DS_Store', '**/Thumbs.db'] };

    const copyWebpackPluginInstance = new CopyWebpackPlugin(
      copyWebpackPluginPatterns,
      copyWebpackPluginOptions,
    );
    extraPlugins.push(copyWebpackPluginInstance);
  }

  if (buildOptions.progress) {
    extraPlugins.push(new ProgressPlugin({ profile: buildOptions.verbose }));
  }

  if (buildOptions.showCircularDependencies) {
    extraPlugins.push(
      new CircularDependencyPlugin({
        exclude: /([\\\/]node_modules[\\\/])|(ngfactory\.js$)/,
      }),
    );
  }

  if (buildOptions.statsJson) {
    extraPlugins.push(
      new (class {
        apply(compiler: Compiler) {
          compiler.hooks.emit.tap('angular-cli-stats', compilation => {
            const data = JSON.stringify(compilation.getStats().toJson('verbose'));
            compilation.assets[`stats${targetInFileName}.json`] = new RawSource(data);
          });
        }
      })(),
    );
  }

  if (buildOptions.namedChunks) {
    extraPlugins.push(new NamedLazyChunksPlugin());
  }

  let sourceMapUseRule;
  if ((scriptsSourceMap || stylesSourceMap) && vendorSourceMap) {
    sourceMapUseRule = {
      use: [
        {
          loader: require.resolve('source-map-loader'),
        },
      ],
    };
  }

  let buildOptimizerUseRule;
  if (buildOptions.buildOptimizer) {
    extraPlugins.push(new BuildOptimizerWebpackPlugin());
    buildOptimizerUseRule = {
      use: [
        {
          loader: buildOptimizerLoaderPath,
          options: { sourceMap: scriptsSourceMap },
        },
      ],
    };
  }

  // Allow loaders to be in a node_modules nested inside the devkit/build-angular package.
  // This is important in case loaders do not get hoisted.
  // If this file moves to another location, alter potentialNodeModules as well.
  const loaderNodeModules = findAllNodeModules(__dirname, projectRoot);
  loaderNodeModules.unshift('node_modules');

  // Load rxjs path aliases.
  // https://github.com/ReactiveX/rxjs/blob/master/doc/pipeable-operators.md#build-and-treeshaking
  let alias = {};
  try {
    const rxjsPathMappingImport = wco.supportES2015
      ? 'rxjs/_esm2015/path-mapping'
      : 'rxjs/_esm5/path-mapping';
    const rxPaths = require(require.resolve(rxjsPathMappingImport, { paths: [projectRoot] }));
    alias = rxPaths();
  } catch {}

  const extraMinimizers = [];
  if (stylesOptimization) {
    extraMinimizers.push(
      new OptimizeCssWebpackPlugin({
        sourceMap: stylesSourceMap,
        // component styles retain their original file name
        test: file => /\.(?:css|scss|sass|less|styl)$/.test(file),
      }),
    );
  }

  if (scriptsOptimization) {
    let angularGlobalDefinitions = {
      ngDevMode: false,
      ngI18nClosureMode: false,
    };

    // Try to load known global definitions from @angular/compiler-cli.
    const GLOBAL_DEFS_FOR_TERSER = require('@angular/compiler-cli').GLOBAL_DEFS_FOR_TERSER;
    if (GLOBAL_DEFS_FOR_TERSER) {
      angularGlobalDefinitions = GLOBAL_DEFS_FOR_TERSER;
    }

    if (buildOptions.aot) {
      // Also try to load AOT-only global definitions.
      const GLOBAL_DEFS_FOR_TERSER_WITH_AOT = require('@angular/compiler-cli')
        .GLOBAL_DEFS_FOR_TERSER_WITH_AOT;
      if (GLOBAL_DEFS_FOR_TERSER_WITH_AOT) {
        angularGlobalDefinitions = {
          ...angularGlobalDefinitions,
          ...GLOBAL_DEFS_FOR_TERSER_WITH_AOT,
        };
      }
    }

    // TODO: Investigate why this fails for some packages: wco.supportES2015 ? 6 : 5;
    const terserEcma = 5;

    const terserOptions = {
      warnings: !!buildOptions.verbose,
      safari10: true,
      output: {
        ecma: terserEcma,
        // For differential loading, this is handled in the bundle processing.
        // This should also work with just true but the experimental rollup support breaks without this check.
        ascii_only: !differentialLoadingMode,
        // default behavior (undefined value) is to keep only important comments (licenses, etc.)
        comments: !buildOptions.extractLicenses && undefined,
        webkit: true,
        beautify: shouldBeautify,
      },
      // On server, we don't want to compress anything. We still set the ngDevMode = false for it
      // to remove dev code, and ngI18nClosureMode to remove Closure compiler i18n code
      compress:
        allowMinify &&
        (buildOptions.platform == 'server'
          ? {
              ecma: terserEcma,
              global_defs: angularGlobalDefinitions,
              keep_fnames: true,
            }
          : {
              ecma: terserEcma,
              pure_getters: buildOptions.buildOptimizer,
              // PURE comments work best with 3 passes.
              // See https://github.com/webpack/webpack/issues/2899#issuecomment-317425926.
              passes: buildOptions.buildOptimizer ? 3 : 1,
              global_defs: angularGlobalDefinitions,
            }),
      // We also want to avoid mangling on server.
      // Name mangling is handled within the browser builder
      mangle: allowMangle && buildOptions.platform !== 'server' && !differentialLoadingMode,
    };

    extraMinimizers.push(
      new TerserPlugin({
        sourceMap: scriptsSourceMap,
        parallel: maxWorkers,
        cache: !cachingDisabled && findCachePath('terser-webpack'),
        extractComments: false,
        chunkFilter: (chunk: compilation.Chunk) =>
          !globalScriptsByBundleName.some(s => s.bundleName === chunk.name),
        terserOptions,
      }),
      // Script bundles are fully optimized here in one step since they are never downleveled.
      // They are shared between ES2015 & ES5 outputs so must support ES5.
      new TerserPlugin({
        sourceMap: scriptsSourceMap,
        parallel: maxWorkers,
        cache: !cachingDisabled && findCachePath('terser-webpack'),
        extractComments: false,
        chunkFilter: (chunk: compilation.Chunk) =>
          globalScriptsByBundleName.some(s => s.bundleName === chunk.name),
        terserOptions: {
          ...terserOptions,
          compress: allowMinify && {
            ...terserOptions.compress,
            ecma: 5,
          },
          output: {
            ...terserOptions.output,
            ecma: 5,
          },
          mangle: allowMangle && buildOptions.platform !== 'server',
        },
      }),
    );
  }

  if (
    wco.tsConfig.options.target !== undefined &&
    wco.tsConfig.options.target >= ScriptTarget.ES2017
  ) {
    wco.logger.warn(tags.stripIndent`
      WARNING: Zone.js does not support native async/await in ES2017.
      These blocks are not intercepted by zone.js and will not triggering change detection.
      See: https://github.com/angular/zone.js/pull/1140 for more information.
    `);
  }

  return {
    mode: scriptsOptimization || stylesOptimization ? 'production' : 'development',
    devtool: false,
    profile: buildOptions.statsJson,
    resolve: {
      extensions: ['.ts', '.tsx', '.mjs', '.js'],
      symlinks: !buildOptions.preserveSymlinks,
      modules: [wco.tsConfig.options.baseUrl || projectRoot, 'node_modules'],
      alias,
    },
    resolveLoader: {
      symlinks: !buildOptions.preserveSymlinks,
      modules: loaderNodeModules,
    },
    context: projectRoot,
    entry: entryPoints,
    output: {
      futureEmitAssets: true,
      path: path.resolve(root, buildOptions.outputPath as string),
      publicPath: buildOptions.deployUrl,
      filename: `[name]${targetInFileName}${hashFormat.chunk}.js`,
    },
    watch: buildOptions.watch,
    watchOptions: {
      poll: buildOptions.poll,
      ignored: buildOptions.poll === undefined ? undefined : /[\\\/]node_modules[\\\/]/,
    },
    performance: {
      hints: false,
    },
    module: {
      // Show an error for missing exports instead of a warning.
      strictExportPresence: true,
      rules: [
        {
          test: /\.(eot|svg|cur|jpg|png|webp|gif|otf|ttf|woff|woff2|ani)$/,
          loader: require.resolve('file-loader'),
          options: {
            name: `[name]${hashFormat.file}.[ext]`,
            // Re-use emitted files from browser builder on the server.
            emitFile: wco.buildOptions.platform !== 'server',
          },
        },
        {
          // Mark files inside `@angular/core` as using SystemJS style dynamic imports.
          // Removing this will cause deprecation warnings to appear.
          test: /[\/\\]@angular[\/\\]core[\/\\].+\.js$/,
          parser: { system: true },
        },
        {
          test: /\.js$/,
          // Factory files are processed by BO in the rules added in typescript.ts.
          exclude: /(ngfactory|ngstyle)\.js$/,
          ...buildOptimizerUseRule,
        },
        {
          test: /\.js$/,
          exclude: /(ngfactory|ngstyle)\.js$/,
          enforce: 'pre',
          ...sourceMapUseRule,
        },
        ...extraRules,
      ],
    },
    optimization: {
      noEmitOnErrors: true,
      minimizer: [
        new HashedModuleIdsPlugin(),
        ...extraMinimizers,
      ].concat(differentialLoadingMode ? [
        // Budgets are computed after differential builds, not via a plugin.
        // https://github.com/angular/angular-cli/blob/master/packages/angular_devkit/build_angular/src/browser/index.ts
      ] : [
        // Non differential builds should be computed here, as a plugin.
        new BundleBudgetPlugin({ budgets: buildOptions.budgets }),
      ]),
    },
    plugins: [
      // Always replace the context for the System.import in angular/core to prevent warnings.
      // https://github.com/angular/angular/issues/11580
      // With VE the correct context is added in @ngtools/webpack, but Ivy doesn't need it at all.
      new ContextReplacementPlugin(/\@angular(\\|\/)core(\\|\/)/),
      ...extraPlugins,
    ],
  };
}