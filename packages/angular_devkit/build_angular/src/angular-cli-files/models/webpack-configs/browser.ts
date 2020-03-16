/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { LicenseWebpackPlugin } from 'license-webpack-plugin';
import * as webpack from 'webpack';
import { WebpackConfigOptions } from '../build-options';
import { getSourceMapDevTool, isPolyfillsEntry, normalizeExtraEntryPoints } from './utils';

const SubresourceIntegrityPlugin = require('webpack-subresource-integrity');


export function getBrowserConfig(wco: WebpackConfigOptions): webpack.Configuration {
  const { buildOptions } = wco;
  const {
    crossOrigin = 'none',
    subresourceIntegrity,
    evalSourceMap,
    extractLicenses,
    vendorChunk,
    commonChunk,
    styles,
  } = buildOptions;

  const extraPlugins = [];

  let isEval = false;
  const { styles: stylesOptimization, scripts: scriptsOptimization } = buildOptions.optimization;
  const {
    styles: stylesSourceMap,
    scripts: scriptsSourceMap,
    hidden: hiddenSourceMap,
  } = buildOptions.sourceMap;

  // See https://webpack.js.org/configuration/devtool/ for sourcemap types.
  if ((stylesSourceMap || scriptsSourceMap) &&
    evalSourceMap &&
    !stylesOptimization &&
    !scriptsOptimization) {
    // Produce eval sourcemaps for development with serve, which are faster.
    isEval = true;
  }

  if (subresourceIntegrity) {
    extraPlugins.push(new SubresourceIntegrityPlugin({
      hashFuncNames: ['sha384'],
    }));
  }

  if (extractLicenses) {
    extraPlugins.push(new LicenseWebpackPlugin({
      stats: {
        warnings: false,
        errors: false,
      },
      perChunkOutput: false,
      outputFilename: '3rdpartylicenses.txt',
    }));
  }

  if (!isEval && (scriptsSourceMap || stylesSourceMap)) {
    extraPlugins.push(getSourceMapDevTool(
      scriptsSourceMap,
      stylesSourceMap,
      wco.differentialLoadingMode ? true : hiddenSourceMap,
    ));
  }

  const globalStylesBundleNames = normalizeExtraEntryPoints(styles, 'styles')
    .map(style => style.bundleName);

  let crossOriginLoading: string | false = false;
  if (subresourceIntegrity && crossOrigin === 'none') {
    crossOriginLoading = 'anonymous';
  } else if (crossOrigin !== 'none') {
    crossOriginLoading = crossOrigin;
  }

  return {
    devtool: isEval ? 'eval' : false,
    resolve: {
      mainFields: [
        ...(wco.supportES2015 ? ['es2015'] : []),
        'browser', 'module', 'main',
      ],
    },
    output: {
      crossOriginLoading,
    },
    optimization: {
      runtimeChunk: 'single',
      splitChunks: {
        maxAsyncRequests: Infinity,
        cacheGroups: {
          default: !!commonChunk && {
            chunks: 'async',
            minChunks: 2,
            priority: 10,
          },
          common: !!commonChunk && {
            name: 'common',
            chunks: 'async',
            minChunks: 2,
            enforce: true,
            priority: 5,
          },
          vendors: false,
          vendor: !!vendorChunk && {
            name: 'vendor',
            chunks: 'initial',
            enforce: true,
            test: (module: { nameForCondition?: Function }, chunks: Array<{ name: string }>) => {
              const moduleName = module.nameForCondition ? module.nameForCondition() : '';

              return /[\\/]node_modules[\\/]/.test(moduleName)
                && !chunks.some(({ name }) => isPolyfillsEntry(name)
                  || globalStylesBundleNames.includes(name));
            },
          },
        },
      },
    },
    plugins: extraPlugins,
    node: false,
  };
}
