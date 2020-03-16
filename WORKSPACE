workspace(
    name = "angular_cli",
    managed_directories = {"@npm": ["node_modules"]},
)

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")
load("@bazel_tools//tools/build_defs/repo:git.bzl", "git_repository")

http_archive(
    name = "build_bazel_rules_nodejs",
    sha256 = "b6670f9f43faa66e3009488bbd909bc7bc46a5a9661a33f6bc578068d1837f37",
    urls = ["https://github.com/bazelbuild/rules_nodejs/releases/download/1.3.0/rules_nodejs-1.3.0.tar.gz"],
)

# We use protocol buffers for the Build Event Protocol
git_repository(
    name = "com_google_protobuf",
    commit = "6263268b8c1b78a8a9b65acd6f5dd5c04dd9b0e1",
    remote = "https://github.com/protocolbuffers/protobuf",
    shallow_since = "1559159889 -0400",
)

load("@com_google_protobuf//:protobuf_deps.bzl", "protobuf_deps")

protobuf_deps()

# Check the bazel version and download npm dependencies
load("@build_bazel_rules_nodejs//:index.bzl", "check_bazel_version", "check_rules_nodejs_version", "node_repositories", "yarn_install")

# Bazel version must be at least the following version because:
#   - 0.26.0 managed_directories feature added which is required for nodejs rules 0.30.0
#   - 0.27.0 has a fix for managed_directories after `rm -rf node_modules`
check_bazel_version(
    message = """
You no longer need to install Bazel on your machine.
Angular has a dependency on the @bazel/bazel package which supplies it.
Try running `yarn bazel` instead.
    (If you did run that, check that you've got a fresh `yarn install`)
""",
    minimum_bazel_version = "0.27.0",
)

# The NodeJS rules version must be at least the following version because:
#   - 0.15.2 Re-introduced the prod_only attribute on yarn_install
#   - 0.15.3 Includes a fix for the `jasmine_node_test` rule ignoring target tags
#   - 0.16.8 Supports npm installed bazel workspaces
#   - 0.26.0 Fix for data files in yarn_install and npm_install
#   - 0.27.12 Adds NodeModuleSources provider for transtive npm deps support
#   - 0.30.0 yarn_install now uses symlinked node_modules with new managed directories Bazel 0.26.0 feature
#   - 0.31.1 entry_point attribute of nodejs_binary & rollup_bundle is now a label
#   - 0.32.0 yarn_install and npm_install no longer puts build files under symlinked node_modules
#   - 0.32.1 remove override of @bazel/tsetse & exclude typescript lib declarations in node_module_library transitive_declarations
#   - 0.32.2 resolves bug in @bazel/hide-bazel-files postinstall step
#   - 0.34.0 introduces protractor rule
check_rules_nodejs_version(minimum_version_string = "0.34.0")

# Setup the Node.js toolchain
node_repositories(
    node_repositories = {
        "10.16.0-darwin_amd64": ("node-v10.16.0-darwin-x64.tar.gz", "node-v10.16.0-darwin-x64", "6c009df1b724026d84ae9a838c5b382662e30f6c5563a0995532f2bece39fa9c"),
        "10.16.0-linux_amd64": ("node-v10.16.0-linux-x64.tar.xz", "node-v10.16.0-linux-x64", "1827f5b99084740234de0c506f4dd2202a696ed60f76059696747c34339b9d48"),
        "10.16.0-windows_amd64": ("node-v10.16.0-win-x64.zip", "node-v10.16.0-win-x64", "aa22cb357f0fb54ccbc06b19b60e37eefea5d7dd9940912675d3ed988bf9a059"),
    },
    node_version = "10.16.0",
    package_json = ["//:package.json"],
    yarn_repositories = {
        "1.17.3": ("yarn-v1.17.3.tar.gz", "yarn-v1.17.3", "e3835194409f1b3afa1c62ca82f561f1c29d26580c9e220c36866317e043c6f3"),
    },
    # yarn 1.13.0 under Bazel has a regression on Windows that causes build errors on rebuilds:
    # ```
    # ERROR: Source forest creation failed: C:/.../fyuc5c3n/execroot/angular/external (Directory not empty)
    # ```
    # See https://github.com/angular/angular/pull/29431 for more information.
    # It possible that versions of yarn past 1.13.0 do not have this issue, however, before
    # advancing this version we need to test manually on Windows that the above error does not
    # happen as the issue is not caught by CI.
    yarn_version = "1.17.3",
)

yarn_install(
    name = "npm",
    data = [
        "//:tools/yarn/check-yarn.js",
    ],
    package_json = "//:package.json",
    symlink_node_modules = False,
    yarn_lock = "//:yarn.lock",
)

load("@npm//:install_bazel_dependencies.bzl", "install_bazel_dependencies")

install_bazel_dependencies()

load("@npm_bazel_typescript//:index.bzl", "ts_setup_workspace")

ts_setup_workspace()

# Load karma dependencies
load("@npm_bazel_karma//:package.bzl", "npm_bazel_karma_dependencies")

npm_bazel_karma_dependencies()

# Load labs dependencies
load("@npm_bazel_labs//:package.bzl", "npm_bazel_labs_dependencies")

npm_bazel_labs_dependencies()

# Setup the rules_webtesting toolchain
load("@io_bazel_rules_webtesting//web:repositories.bzl", "web_test_repositories")

web_test_repositories()

##########################
# Remote Execution Setup #
##########################
# Bring in bazel_toolchains for RBE setup configuration.
http_archive(
    name = "bazel_toolchains",
    sha256 = "b5a8039df7119d618402472f3adff8a1bd0ae9d5e253f53fcc4c47122e91a3d2",
    strip_prefix = "bazel-toolchains-2.1.1",
    url = "https://github.com/bazelbuild/bazel-toolchains/archive/2.1.1.tar.gz",
)

load("@bazel_toolchains//rules:environments.bzl", "clang_env")
load("@bazel_toolchains//rules:rbe_repo.bzl", "rbe_autoconfig")

rbe_autoconfig(
    name = "rbe_ubuntu1604_angular",
    # Need to specify a base container digest in order to ensure that we can use the checked-in
    # platform configurations for the "ubuntu16_04" image. Otherwise the autoconfig rule would
    # need to pull the image and run it in order determine the toolchain configuration. See:
    # https://github.com/bazelbuild/bazel-toolchains/blob/1.1.2/configs/ubuntu16_04_clang/versions.bzl
    base_container_digest = "sha256:1ab40405810effefa0b2f45824d6d608634ccddbf06366760c341ef6fbead011",
    # Note that if you change the `digest`, you might also need to update the
    # `base_container_digest` to make sure marketplace.gcr.io/google/rbe-ubuntu16-04-webtest:<digest>
    # and marketplace.gcr.io/google/rbe-ubuntu16-04:<base_container_digest> have
    # the same Clang and JDK installed. Clang is needed because of the dependency on
    # @com_google_protobuf. Java is needed for the Bazel's test executor Java tool.
    digest = "sha256:0b8fa87db4b8e5366717a7164342a029d1348d2feea7ecc4b18c780bc2507059",
    env = clang_env(),
    registry = "marketplace.gcr.io",
    # We can't use the default "ubuntu16_04" RBE image provided by the autoconfig because we need
    # a specific Linux kernel that comes with "libx11" in order to run headless browser tests.
    repository = "google/rbe-ubuntu16-04-webtest",
)
